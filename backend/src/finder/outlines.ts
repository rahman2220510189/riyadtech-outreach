import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { type BBox, OutlineIndex, type PolygonGeometry, geometryBBox } from "./geo.js";
import type { ByteCounter } from "./overture/http.js";
import { fetchOutline } from "./overture/divisions.js";

export interface StoredOutline {
  key: string;
  kind: "country" | "region";
  release: string;
  geometry: PolygonGeometry;
  bbox: BBox;
  pointCount: number;
}

/**
 * Outline of a country or region for this release: from the cache table, else from
 * Overture divisions (then cached). Null when Overture has no such area.
 */
export async function getOutline(
  db: Db,
  stacUrl: string,
  release: string,
  req: { key: string; kind: "country" | "region"; country: string; searchBox: BBox },
  counter?: ByteCounter,
): Promise<{ outline: StoredOutline | null; fromCache: boolean }> {
  const cached = await db.areaOutline.findUnique({ where: { key: req.key } });
  if (cached && cached.release === release) {
    return {
      outline: {
        key: cached.key,
        kind: cached.kind as "country" | "region",
        release: cached.release,
        geometry: cached.geometry as unknown as PolygonGeometry,
        bbox: cached.bbox as BBox,
        pointCount: cached.pointCount,
      },
      fromCache: true,
    };
  }
  const fetched = await fetchOutline(stacUrl, release, req, counter);
  if (!fetched) return { outline: null, fromCache: false };
  const bbox = geometryBBox(fetched.geometry);
  const data = {
    kind: req.kind,
    release,
    geometry: fetched.geometry as unknown as Prisma.InputJsonValue,
    bbox,
    pointCount: fetched.points,
    fetchedAt: new Date(),
  };
  await db.areaOutline.upsert({ where: { key: req.key }, create: { key: req.key, ...data }, update: data });
  return {
    outline: { key: req.key, kind: req.kind, release, geometry: fetched.geometry, bbox, pointCount: fetched.points },
    fromCache: false,
  };
}

const indexCache = new Map<string, OutlineIndex>();

/** Forgets the in-memory outline indexes (tests). */
export function clearOutlineIndexes(): void {
  indexCache.clear();
}

/** Point-in-outline index for import tasks, built once per process and release. */
export async function outlineIndex(db: Db, key: string, release: string): Promise<OutlineIndex | null> {
  const cacheKey = `${release}|${key}`;
  const hit = indexCache.get(cacheKey);
  if (hit) return hit;
  const row = await db.areaOutline.findUnique({ where: { key } });
  if (!row || row.release !== release) return null;
  const index = new OutlineIndex(row.geometry as unknown as PolygonGeometry);
  if (indexCache.size > 20) indexCache.clear();
  indexCache.set(cacheKey, index);
  return index;
}
