/** Counts each import task returns; the job summary adds them up. */
export interface ImportCounts {
  rowGroups: number;
  scanned: number;
  kept: number;
  inserted: number;
  updated: number;
  bytes: number;
  skipped: Record<string, number>;
  bySegment: Record<string, number>;
  byCategory: Record<string, number>;
  unmapped: Record<string, number>;
}

export function emptyCounts(): ImportCounts {
  return { rowGroups: 0, scanned: 0, kept: 0, inserted: 0, updated: 0, bytes: 0, skipped: {}, bySegment: {}, byCategory: {}, unmapped: {} };
}

export function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function addMap(into: Record<string, number>, from: unknown): void {
  if (!from || typeof from !== "object") return;
  for (const [k, v] of Object.entries(from as Record<string, unknown>)) if (typeof v === "number") bump(into, k, v);
}

/** Keeps only the `n` largest entries (the unmapped list can be long). */
export function topN(map: Record<string, number>, n: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n),
  );
}

export function addCounts(total: ImportCounts, r: Record<string, unknown> | null | undefined): void {
  if (!r) return;
  for (const k of ["rowGroups", "scanned", "kept", "inserted", "updated", "bytes"] as const) {
    if (typeof r[k] === "number") total[k] += r[k];
  }
  addMap(total.skipped, r.skipped);
  addMap(total.bySegment, r.bySegment);
  addMap(total.byCategory, r.byCategory);
  addMap(total.unmapped, r.unmapped);
}
