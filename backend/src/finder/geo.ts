/** [west, south, east, north] in degrees (WGS84). */
export type BBox = [number, number, number, number];
type Ring = [number, number][];

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function bboxContains(b: BBox, lng: number, lat: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

export function bboxIntersection(a: BBox, b: BBox): BBox | null {
  const out: BBox = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return out[0] <= out[2] && out[1] <= out[3] ? out : null;
}

const KM_PER_DEG_LAT = 111.32;

/** Square box of `radiusKm` around a point. */
export function boxAround(lat: number, lng: number, radiusKm: number): BBox {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/** Default search radius for a city: grows slowly with population, 5 to 30 km. */
export function radiusForPopulation(population: number): number {
  const r = 4 + 2 * Math.sqrt(Math.max(0, population) / 10_000);
  return Math.round(Math.min(30, Math.max(5, r)) * 10) / 10;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// --- Outline (Polygon / MultiPolygon) -------------------------------------------------

export interface PolygonGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

function toPolygons(g: PolygonGeometry): Ring[][] {
  const polys = g.type === "Polygon" ? [g.coordinates as number[][][]] : (g.coordinates as number[][][][]);
  return polys.map((rings) => rings.map((ring) => ring.map((p) => [p[0] ?? 0, p[1] ?? 0] as [number, number])));
}

export function geometryBBox(g: PolygonGeometry): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of toPolygons(g)) {
    for (const [x, y] of poly[0] ?? []) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}

function perpDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker for one ring (iterative, safe for very long rings). */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxD = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistance(ring[i]!, ring[first]!, ring[last]!);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (index !== -1 && maxD > tolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return ring.filter((_, i) => keep[i] === 1);
}

/** True when a ring is smaller than `size` in both directions (an islet or a rock). */
function isTiny(ring: Ring, size: number): boolean {
  let w = Infinity;
  let e = -Infinity;
  let s = Infinity;
  let n = -Infinity;
  for (const [x, y] of ring) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return e - w < size && n - s < size;
}

/**
 * Simplify an outline for storage. Rings that collapse (fewer than 4 points) or are tiny
 * (under 4 x tolerance, about 200 m) are dropped; places on such islets still pass
 * when their address names the country.
 */
export function simplifyGeometry(g: PolygonGeometry, tolerance: number): { geometry: PolygonGeometry; points: number } {
  let points = 0;
  const polys: Ring[][] = [];
  for (const poly of toPolygons(g)) {
    // If the outer ring collapses, drop the whole polygon (its holes mean nothing alone).
    const outer = simplifyRing(poly[0] ?? [], tolerance);
    if (outer.length < 4 || isTiny(outer, tolerance * 4)) continue;
    const holes = poly
      .slice(1)
      .map((r) => simplifyRing(r, tolerance))
      .filter((r) => r.length >= 4 && !isTiny(r, tolerance * 4));
    const kept = [outer, ...holes];
    for (const r of kept) points += r.length;
    polys.push(kept);
  }
  return { geometry: { type: "MultiPolygon", coordinates: polys }, points };
}

interface Edge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Fast point-in-outline test. Edges are bucketed by latitude band, so a test only
 * looks at the edges crossing the point's band (ray casting, even-odd rule over all rings).
 */
export class OutlineIndex {
  readonly bbox: BBox;
  private readonly bands: Edge[][];
  private readonly south: number;
  private readonly bandHeight: number;

  constructor(geometry: PolygonGeometry, bandCount = 2048) {
    this.bbox = geometryBBox(geometry);
    this.south = this.bbox[1];
    const height = Math.max(1e-9, this.bbox[3] - this.bbox[1]);
    this.bandHeight = height / bandCount;
    this.bands = Array.from({ length: bandCount }, () => []);
    for (const poly of toPolygons(geometry)) {
      for (const ring of poly) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i]!;
          const b = ring[j]!;
          if (a[1] === b[1]) continue; // horizontal edges never cross a horizontal ray
          const edge = { x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
          const lo = this.band(Math.min(a[1], b[1]));
          const hi = this.band(Math.max(a[1], b[1]));
          for (let k = lo; k <= hi; k++) this.bands[k]!.push(edge);
        }
      }
    }
  }

  private band(y: number): number {
    return Math.min(this.bands.length - 1, Math.max(0, Math.floor((y - this.south) / this.bandHeight)));
  }

  contains(lng: number, lat: number): boolean {
    if (!bboxContains(this.bbox, lng, lat)) return false;
    let inside = false;
    for (const e of this.bands[this.band(lat)]!) {
      if (e.y1 > lat !== e.y2 > lat) {
        const x = ((e.x2 - e.x1) * (lat - e.y1)) / (e.y2 - e.y1) + e.x1;
        if (lng < x) inside = !inside;
      }
    }
    return inside;
  }
}

// --- Nearest city (time zone and city name for places) --------------------------------

export interface CityPoint {
  name: string;
  lat: number;
  lng: number;
  timezone: string | null;
  regionCode: string | null;
}

/** Grid of 1-degree cells; nearest search looks at growing rings of cells. */
export class NearestCity {
  private readonly cells = new Map<string, CityPoint[]>();
  private readonly count: number;

  constructor(cities: readonly CityPoint[]) {
    for (const c of cities) {
      const key = `${Math.floor(c.lat)}:${Math.floor(c.lng)}`;
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(c);
    }
    this.count = cities.length;
  }

  nearest(lat: number, lng: number, maxRings = 6): CityPoint | null {
    if (this.count === 0) return null;
    const cy = Math.floor(lat);
    const cx = Math.floor(lng);
    let best: CityPoint | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= maxRings; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          for (const c of this.cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
            const d = haversineKm(lat, lng, c.lat, c.lng);
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
        }
      }
      // A city found in ring r can still be beaten by one in ring r+1 only if it is farther than ~r cells.
      if (best && bestD < r * 55) break;
    }
    return best;
  }
}
