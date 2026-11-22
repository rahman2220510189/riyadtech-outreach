import { type BBox, type PolygonGeometry, bboxIntersects, simplifyGeometry } from "../geo.js";
import type { ByteCounter } from "./http.js";
import { openParquet, readRows, rowGroupInfos } from "./parquet.js";
import { releaseFiles } from "./stac.js";
import { polygonFromWkb } from "./wkb.js";

/** GeoJSON from hyparquet (GeoParquet metadata) or raw WKB bytes (no metadata). */
function toPolygonGeometry(value: unknown): PolygonGeometry | null {
  if (value instanceof Uint8Array) return polygonFromWkb(value);
  const g = value as PolygonGeometry | undefined;
  return g && (g.type === "Polygon" || g.type === "MultiPolygon") ? g : null;
}

/** About 50 m: plenty for "is this business inside the state", small to store. */
export const OUTLINE_TOLERANCE_DEG = 0.0005;

export interface OutlineRequest {
  /** "GB" for a country, "US-TX" for a region (ISO 3166-2). */
  key: string;
  kind: "country" | "region";
  country: string;
  /** Rough box of the country, to skip division files and row groups elsewhere in the world. */
  searchBox: BBox;
}

export interface FetchedOutline {
  geometry: PolygonGeometry;
  points: number;
  rowGroupsRead: number;
}

interface DivisionRow {
  subtype?: string | null;
  country?: string | null;
  region?: string | null;
  is_land?: boolean | null;
  is_territorial?: boolean | null;
}

/**
 * Finds the outline of a country or region in Overture divisions/division_area.
 * Prefers the territorial outline (includes coastal water, so harbour-side businesses
 * stay inside); falls back to the land outline. Returns null when the area is not found.
 */
export async function fetchOutline(
  stacUrl: string,
  release: string,
  req: OutlineRequest,
  counter?: ByteCounter,
): Promise<FetchedOutline | null> {
  const files = (await releaseFiles(stacUrl, release, "divisions", "division_area")).filter((f) =>
    bboxIntersects(f.bbox, req.searchBox),
  );
  const matches: { geometry: PolygonGeometry; territorial: boolean }[] = [];
  let rowGroupsRead = 0;

  for (const f of files) {
    const opened = await openParquet(f.url, f.byteLength, counter);
    const groups = rowGroupInfos(opened.metadata).filter((g) => !g.bbox || bboxIntersects(g.bbox, req.searchBox));
    for (const g of groups) {
      rowGroupsRead++;
      const rows = (await readRows(opened, g.rowStart, g.rowEnd, [
        "subtype",
        "country",
        "region",
        "is_land",
        "is_territorial",
      ], counter)) as DivisionRow[];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const hit =
          req.kind === "country"
            ? r.subtype === "country" && r.country === req.country
            : r.subtype === "region" && r.region === req.key;
        if (!hit) continue;
        // Offset index (when the file has one): fetch only the pages holding this row's geometry.
        const [geomRow] = await readRows(opened, g.rowStart + i, g.rowStart + i + 1, ["geometry"], counter, {
          useOffsetIndex: true,
        });
        const geometry = toPolygonGeometry(geomRow?.geometry);
        if (geometry) matches.push({ geometry, territorial: r.is_territorial === true });
      }
    }
  }

  if (matches.length === 0) return null;
  const preferred = matches.some((m) => m.territorial) ? matches.filter((m) => m.territorial) : matches;
  // Several rows (rare): combine them into one MultiPolygon.
  const coordinates = preferred.flatMap((m) =>
    m.geometry.type === "Polygon"
      ? [m.geometry.coordinates as number[][][]]
      : (m.geometry.coordinates as number[][][][]),
  );
  const { geometry, points } = simplifyGeometry({ type: "MultiPolygon", coordinates }, OUTLINE_TOLERANCE_DEG);
  return { geometry, points, rowGroupsRead };
}
