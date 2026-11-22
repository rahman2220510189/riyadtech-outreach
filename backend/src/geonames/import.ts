import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { Db } from "../db/client.js";
import { withTxRetry } from "../db/retry.js";
import { download } from "../finder/overture/http.js";
import type { TaskHandler } from "../jobs/types.js";
import { loadSeedData } from "../seed/files.js";
import { type CityRecord, type RegionRecord, parseAdmin1, parseCities } from "./parse.js";

export interface GeonamesSource {
  /** Download from this base URL... */
  baseUrl?: string;
  /** ...or read cities5000.zip (or .txt) and admin1CodesASCII.txt from this folder. */
  dir?: string;
}

async function getFile(src: GeonamesSource, name: string): Promise<Uint8Array> {
  if (src.dir) return new Uint8Array(await readFile(join(src.dir, name)));
  const url = `${(src.baseUrl ?? "").replace(/\/+$/, "")}/${name}`;
  return (await download(url)).body;
}

async function citiesText(src: GeonamesSource): Promise<string> {
  if (src.dir) {
    try {
      return await readFile(join(src.dir, "cities5000.txt"), "utf8");
    } catch {
      // fall through to the zip
    }
  }
  const zip = unzipSync(await getFile(src, "cities5000.zip"), { filter: (f) => f.name === "cities5000.txt" });
  const data = zip["cities5000.txt"];
  if (!data) throw new Error("cities5000.zip does not contain cities5000.txt");
  return new TextDecoder().decode(data);
}

type Row = RegionRecord | CityRecord;
const BATCH = 2000;

async function upsert(db: Db, kind: "region" | "city", rows: Row[]): Promise<void> {
  // Fixed order + retry: safe if two imports overlap.
  const sorted = [...rows].sort((a, b) => a.geonameId - b.geonameId);
  for (let i = 0; i < sorted.length; i += BATCH) {
    const part = sorted.slice(i, i + BATCH);
    const col = <T>(f: (r: Row) => T) => part.map(f);
    await withTxRetry(() =>
      db.$executeRaw`
        INSERT INTO locations (geoname_id, country, kind, name, ascii_name, admin1_code, region_code, lat, lng, population, timezone)
        SELECT u.geoname_id, u.country, ${kind}, u.name, u.ascii_name, u.admin1_code, u.region_code, u.lat, u.lng, u.population, u.timezone
          FROM unnest(
            ${col((r) => r.geonameId)}::int[],
            ${col((r) => r.country)}::text[],
            ${col((r) => r.name)}::text[],
            ${col((r) => r.asciiName)}::text[],
            ${col((r) => r.admin1Code)}::text[],
            ${col((r) => r.regionCode)}::text[],
            ${col((r) => ("lat" in r ? r.lat : null))}::float8[],
            ${col((r) => ("lng" in r ? r.lng : null))}::float8[],
            ${col((r) => ("population" in r ? r.population : 0))}::int[],
            ${col((r) => ("timezone" in r ? r.timezone : null))}::text[]
          ) AS u(geoname_id, country, name, ascii_name, admin1_code, region_code, lat, lng, population, timezone)
        ON CONFLICT (geoname_id) DO UPDATE SET
          country = EXCLUDED.country, kind = EXCLUDED.kind, name = EXCLUDED.name, ascii_name = EXCLUDED.ascii_name,
          admin1_code = EXCLUDED.admin1_code, region_code = EXCLUDED.region_code, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
          population = EXCLUDED.population, timezone = EXCLUDED.timezone`,
    );
  }
}

export interface GeonamesResult {
  countries: Record<string, { regions: number; cities: number }>;
}

/** Downloads (or reads) GeoNames files and upserts regions and cities for the given countries. */
export async function importGeonames(db: Db, countries: string[], src: GeonamesSource): Promise<GeonamesResult> {
  const wanted = new Set(countries.map((c) => c.toUpperCase()));
  const isoMap = loadSeedData().geonamesAdmin1ToIso;
  const admin1 = new TextDecoder().decode(await getFile(src, "admin1CodesASCII.txt"));
  const regions = parseAdmin1(admin1, wanted, isoMap);
  const cities = parseCities(await citiesText(src), wanted, isoMap);
  await upsert(db, "region", regions);
  await upsert(db, "city", cities);

  const result: GeonamesResult = { countries: {} };
  for (const c of wanted) {
    result.countries[c] = {
      regions: regions.filter((r) => r.country === c).length,
      cities: cities.filter((r) => r.country === c).length,
    };
  }
  return result;
}

/** Job task "geonames.import": payload { countries: ["GB", ...] }. */
export const geonamesImportTask: TaskHandler = async (ctx) => {
  const countries = (ctx.task.payload.countries as string[] | undefined) ?? [];
  await ctx.event("info", `Downloading GeoNames regions and cities for ${countries.join(", ")}`);
  const result = await importGeonames(ctx.db, countries, { baseUrl: ctx.env.GEONAMES_BASE_URL });
  const summary = Object.entries(result.countries)
    .map(([c, n]) => `${c}: ${n.regions} regions, ${n.cities} cities`)
    .join("; ");
  await ctx.event("info", `GeoNames loaded. ${summary}`);
  return { result: { countries: result.countries } };
};
