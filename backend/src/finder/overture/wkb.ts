import type { PolygonGeometry } from "../geo.js";

/**
 * Minimal WKB reader for Polygon and MultiPolygon (2D; Z/M values skipped).
 * Fallback for when a Parquet geometry column arrives as raw bytes instead of GeoJSON.
 */
export function polygonFromWkb(bytes: Uint8Array): PolygonGeometry | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  function header(): { le: boolean; type: number; dims: number } {
    const le = view.getUint8(pos) === 1;
    pos += 1;
    let raw = view.getUint32(pos, le);
    pos += 4;
    let dims = 2;
    // ISO WKB: 1000 = Z, 2000 = M, 3000 = ZM. EWKB: high bits.
    if (raw & 0x80000000 || raw & 0x40000000) {
      dims += (raw & 0x80000000 ? 1 : 0) + (raw & 0x40000000 ? 1 : 0);
      if (raw & 0x20000000) pos += 4; // SRID
      raw &= 0x0fffffff;
    } else if (raw > 1000) {
      const flag = Math.floor(raw / 1000);
      dims += flag === 3 ? 2 : 1;
      raw %= 1000;
    }
    return { le, type: raw, dims };
  }

  function rings(le: boolean, dims: number): number[][][] {
    const n = view.getUint32(pos, le);
    pos += 4;
    const out: number[][][] = [];
    for (let r = 0; r < n; r++) {
      const points = view.getUint32(pos, le);
      pos += 4;
      const ring: number[][] = [];
      for (let i = 0; i < points; i++) {
        ring.push([view.getFloat64(pos, le), view.getFloat64(pos + 8, le)]);
        pos += 8 * dims;
      }
      out.push(ring);
    }
    return out;
  }

  try {
    const h = header();
    if (h.type === 3) return { type: "Polygon", coordinates: rings(h.le, h.dims) };
    if (h.type === 6) {
      const count = view.getUint32(pos, h.le);
      pos += 4;
      const polys: number[][][][] = [];
      for (let i = 0; i < count; i++) {
        const ph = header();
        if (ph.type !== 3) return null;
        polys.push(rings(ph.le, ph.dims));
      }
      return { type: "MultiPolygon", coordinates: polys };
    }
    return null;
  } catch {
    return null; // truncated or not WKB
  }
}
