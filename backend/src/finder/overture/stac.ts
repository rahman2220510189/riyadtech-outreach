import type { BBox } from "../geo.js";
import { fetchJson } from "./http.js";

/**
 * Overture publishes a STAC catalog per release. Each data file is one STAC item with
 * its bounding box and download URLs, so we can choose files without listing S3.
 * Verified 2026-10-14 against https://stac.overturemaps.org (latest 2026-09-23.1).
 */

export interface DataFile {
  id: string;
  bbox: BBox;
  url: string;
  byteLength?: number;
  numRows?: number;
}

interface StacLink {
  rel: string;
  href: string;
  latest?: boolean;
}
interface StacCatalog {
  latest?: string;
  links?: StacLink[];
}
interface StacItem {
  id?: string;
  bbox?: number[];
  properties?: { num_rows?: number; "file:size"?: number };
  assets?: Record<string, { href?: string; alternate?: Record<string, { href?: string }>; "file:size"?: number }>;
}

const base = (stacUrl: string) => stacUrl.replace(/\/+$/, "");

export async function latestRelease(stacUrl: string): Promise<string> {
  const root = await fetchJson<StacCatalog>(`${base(stacUrl)}/catalog.json`);
  if (typeof root.latest === "string") return root.latest;
  const link = root.links?.find((l) => l.rel === "child" && l.latest);
  const fromHref = link && /\/([^/]+)\/catalog\.json$/.exec(link.href)?.[1];
  if (fromHref) return fromHref;
  throw new Error("The Overture STAC catalog does not name a latest release");
}

const itemsCache = new Map<string, Promise<DataFile[]>>();

/** Data files of one theme/type in a release, e.g. ("places", "place"). Cached per process. */
export function releaseFiles(stacUrl: string, release: string, theme: string, type: string): Promise<DataFile[]> {
  const key = `${base(stacUrl)}|${release}|${theme}|${type}`;
  let p = itemsCache.get(key);
  if (!p) {
    p = loadFiles(stacUrl, release, theme, type);
    p.catch(() => itemsCache.delete(key));
    itemsCache.set(key, p);
  }
  return p;
}

async function loadFiles(stacUrl: string, release: string, theme: string, type: string): Promise<DataFile[]> {
  const collectionUrl = `${base(stacUrl)}/${release}/${theme}/${type}/collection.json`;
  const collection = await fetchJson<StacCatalog>(collectionUrl);
  const itemUrls = (collection.links ?? [])
    .filter((l) => l.rel === "item")
    .map((l) => new URL(l.href, collectionUrl).toString());
  if (itemUrls.length === 0) throw new Error(`No data files listed for ${theme}/${type} in release ${release}`);

  const files: DataFile[] = [];
  // A few at a time: there are about 16 place files per release.
  for (let i = 0; i < itemUrls.length; i += 4) {
    const items = await Promise.all(itemUrls.slice(i, i + 4).map((u) => fetchJson<StacItem>(u)));
    for (const item of items) files.push(toDataFile(item));
  }
  return files;
}

function toDataFile(item: StacItem): DataFile {
  const bbox = item.bbox;
  if (!bbox || bbox.length < 4) throw new Error(`STAC item ${item.id ?? "?"} has no bounding box`);
  const assets = item.assets ?? {};
  const asset = assets.aws ?? Object.values(assets).find((a) => a.href?.startsWith("http"));
  const url = asset?.href?.startsWith("http") ? asset.href : undefined;
  if (!url) throw new Error(`STAC item ${item.id ?? "?"} has no https download link`);
  const size = asset?.["file:size"] ?? item.properties?.["file:size"];
  return {
    id: item.id ?? url,
    bbox: [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!],
    url,
    ...(typeof size === "number" ? { byteLength: size } : {}),
    ...(typeof item.properties?.num_rows === "number" ? { numRows: item.properties.num_rows } : {}),
  };
}

/** For tests: forget cached file lists. */
export function clearStacCache(): void {
  itemsCache.clear();
}
