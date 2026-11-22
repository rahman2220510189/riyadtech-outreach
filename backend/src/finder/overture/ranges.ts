import type { AsyncBuffer, FileMetaData } from "hyparquet";

export interface ByteRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Byte ranges of the given top-level columns in the row groups that cover [rowStart, rowEnd).
 * Same rule as hyparquet: a column chunk starts at its dictionary page (or first data page).
 */
export function columnChunkRanges(metadata: FileMetaData, rowStart: number, rowEnd: number, columns: readonly string[]): ByteRange[] {
  const out: ByteRange[] = [];
  const wanted = new Set(columns);
  let groupStart = 0;
  for (const rg of metadata.row_groups) {
    const groupEnd = groupStart + Number(rg.num_rows);
    if (groupEnd > rowStart && groupStart < rowEnd) {
      for (const chunk of rg.columns) {
        const meta = chunk.meta_data;
        if (!meta || !wanted.has(meta.path_in_schema[0] ?? "")) continue;
        const start = Number(meta.dictionary_page_offset || meta.data_page_offset);
        out.push({ start, end: start + Number(meta.total_compressed_size) });
      }
    }
    groupStart = groupEnd;
  }
  return out;
}

/**
 * Merges ranges that are at most `maxGap` bytes apart (downloading a small unneeded gap
 * is cheaper than another request on a slow, far-away connection).
 */
export function coalesceRanges(ranges: readonly ByteRange[], maxGap: number): ByteRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: ByteRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= maxGap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export interface CachedSegment {
  start: number;
  data: Uint8Array;
}

/**
 * AsyncBuffer that answers from downloaded segments and falls back to `inner`
 * for anything outside them.
 */
export function segmentBuffer(inner: AsyncBuffer, segments: readonly CachedSegment[]): AsyncBuffer {
  return {
    byteLength: inner.byteLength,
    slice(start: number, end?: number) {
      const stop = end ?? inner.byteLength;
      for (const s of segments) {
        if (start >= s.start && stop <= s.start + s.data.byteLength) {
          const from = s.data.byteOffset + (start - s.start);
          return s.data.buffer.slice(from, from + (stop - start)) as ArrayBuffer;
        }
      }
      return inner.slice(start, end);
    },
  };
}

/** Limits how many downloads run at once. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
