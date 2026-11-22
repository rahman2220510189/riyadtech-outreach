import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AsyncBuffer, type FileMetaData, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { BBox } from "../geo.js";
import { type ByteCounter, httpAsyncBuffer } from "./http.js";
import { type CachedSegment, coalesceRanges, columnChunkRanges, segmentBuffer } from "./ranges.js";

/** Unneeded bytes we accept downloading to save a request (slow, far-away links). */
const PREFETCH_GAP = 256 * 1024;

let footerCacheDir: string | null = null;

/**
 * Folder for cached file footers (the Parquet index, about 3 MB per Overture place file).
 * Footers never change within a release, so the next run reads them from disk. null = off.
 */
export function setFooterCacheDir(dir: string | null): void {
  footerCacheDir = dir;
}

interface FooterCacheFile {
  url: string;
  byteLength: number;
  segments: { start: number; data: string }[];
}

function cachePath(dir: string, url: string): string {
  return join(dir, `${createHash("sha1").update(url).digest("hex")}.json`);
}

async function readFooterCache(url: string, byteLength: number): Promise<CachedSegment[]> {
  if (!footerCacheDir) return [];
  try {
    const file = JSON.parse(await readFile(cachePath(footerCacheDir, url), "utf8")) as FooterCacheFile;
    if (file.url !== url || file.byteLength !== byteLength) return [];
    return file.segments.map((s) => ({ start: s.start, data: new Uint8Array(Buffer.from(s.data, "base64")) }));
  } catch {
    return [];
  }
}

async function writeFooterCache(url: string, byteLength: number, segments: CachedSegment[]): Promise<void> {
  if (!footerCacheDir || segments.length === 0) return;
  try {
    await mkdir(footerCacheDir, { recursive: true });
    const target = cachePath(footerCacheDir, url);
    const body: FooterCacheFile = {
      url,
      byteLength,
      segments: segments.map((s) => ({ start: s.start, data: Buffer.from(s.data).toString("base64") })),
    };
    await writeFile(`${target}.tmp`, JSON.stringify(body));
    await rename(`${target}.tmp`, target);
  } catch {
    // A cache that cannot be written only costs a download next time.
  }
}

/** AsyncBuffer that adds every downloaded byte to `counter`. */
function counting(inner: AsyncBuffer, counter?: ByteCounter): AsyncBuffer {
  if (!counter) return inner;
  return {
    byteLength: inner.byteLength,
    slice: async (start, end) => {
      const buf = await inner.slice(start, end);
      counter.bytes += buf.byteLength;
      return buf;
    },
  };
}

export interface OpenedFile {
  url: string;
  file: AsyncBuffer;
  metadata: FileMetaData;
}

export interface RowGroupInfo {
  index: number;
  rowStart: number;
  rowEnd: number;
  /** From the bbox.* column statistics; null when the file has no statistics (cannot prune). */
  bbox: BBox | null;
}

const opened = new Map<string, Promise<OpenedFile>>();
const MAX_OPEN = 8;

/** Reads only the file footer (metadata). Kept in memory for the next tasks on the same file. */
export function openParquet(url: string, byteLength?: number, counter?: ByteCounter): Promise<OpenedFile> {
  let p = opened.get(url);
  if (!p) {
    p = (async () => {
      const raw = await httpAsyncBuffer(url, byteLength);
      const cached = await readFooterCache(url, raw.byteLength);
      const downloaded: CachedSegment[] = [];
      const recording: AsyncBuffer = {
        byteLength: raw.byteLength,
        slice: async (start, end) => {
          const buf = await raw.slice(start, end);
          if (counter) counter.bytes += buf.byteLength;
          downloaded.push({ start, data: new Uint8Array(buf) });
          return buf;
        },
      };
      const metadata = await parquetMetadataAsync(cachedAsyncBuffer(segmentBuffer(recording, cached)));
      if (downloaded.length > 0) await writeFooterCache(url, raw.byteLength, [...cached, ...downloaded]);
      return { url, file: raw, metadata };
    })();
    p.catch(() => opened.delete(url));
    opened.set(url, p);
    if (opened.size > MAX_OPEN) {
      const oldest = opened.keys().next().value;
      if (oldest !== undefined) opened.delete(oldest);
    }
  }
  return p;
}

export function clearOpenFiles(): void {
  opened.clear();
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

/** Row ranges and bounding boxes of every row group, from the bbox.xmin/ymin/xmax/ymax statistics. */
export function rowGroupInfos(metadata: FileMetaData): RowGroupInfo[] {
  const out: RowGroupInfo[] = [];
  let start = 0;
  metadata.row_groups.forEach((rg, index) => {
    const rows = Number(rg.num_rows);
    const stat = (path: string, which: "min" | "max") => {
      const col = rg.columns.find((c) => c.meta_data?.path_in_schema.join(".") === path);
      const s = col?.meta_data?.statistics;
      return num(which === "min" ? (s?.min_value ?? s?.min) : (s?.max_value ?? s?.max));
    };
    const xmin = stat("bbox.xmin", "min");
    const ymin = stat("bbox.ymin", "min");
    const xmax = stat("bbox.xmax", "max");
    const ymax = stat("bbox.ymax", "max");
    const bbox: BBox | null =
      xmin !== undefined && ymin !== undefined && xmax !== undefined && ymax !== undefined ? [xmin, ymin, xmax, ymax] : null;
    out.push({ index, rowStart: start, rowEnd: start + rows, bbox });
    start += rows;
  });
  return out;
}

/** Groups consecutive row group indexes into units of at most `size` (one task each). */
export function groupConsecutive(groups: readonly RowGroupInfo[], size: number): RowGroupInfo[][] {
  const units: RowGroupInfo[][] = [];
  let current: RowGroupInfo[] = [];
  for (const g of groups) {
    const prev = current[current.length - 1];
    if (current.length > 0 && (current.length >= size || !prev || g.index !== prev.index + 1)) {
      units.push(current);
      current = [];
    }
    current.push(g);
  }
  if (current.length > 0) units.push(current);
  return units;
}

/**
 * Reads the given columns for rows [rowStart, rowEnd) as plain objects; downloaded bytes go to `counter`.
 * The needed column chunks are first downloaded in a few large requests (gaps under 256 KB are
 * included), then parsed from memory: one or two requests per row group instead of dozens.
 */
export async function readRows(
  f: OpenedFile,
  rowStart: number,
  rowEnd: number,
  columns: string[],
  counter?: ByteCounter,
  opts: { useOffsetIndex?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  let file = counting(f.file, counter);
  if (!opts.useOffsetIndex) {
    const ranges = coalesceRanges(columnChunkRanges(f.metadata, rowStart, rowEnd, columns), PREFETCH_GAP);
    const segments = await Promise.all(
      ranges.map(async (r) => ({ start: r.start, data: new Uint8Array(await file.slice(r.start, r.end)) })),
    );
    file = segmentBuffer(file, segments);
  }
  return parquetReadObjects({
    file,
    metadata: f.metadata,
    columns,
    rowStart,
    rowEnd,
    compressors,
    ...(opts.useOffsetIndex ? { useOffsetIndex: true } : {}),
  });
}
