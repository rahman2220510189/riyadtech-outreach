import type { Db } from "../db/client.js";
import { FatalTaskError } from "../jobs/types.js";
import { type BBox, boxAround, radiusForPopulation } from "./geo.js";

/**
 * Where to look for a country's outline: the rough box from seed/countries.json, widened to
 * cover every GeoNames city of the country (plus a margin), in case the rough box is too small.
 */
async function searchBox(db: Db, country: string, seedBox: BBox): Promise<BBox> {
  const [r] = await db.$queryRaw<{ w: number | null; s: number | null; e: number | null; n: number | null }[]>`
    SELECT min(lng) AS w, min(lat) AS s, max(lng) AS e, max(lat) AS n
      FROM locations WHERE country = ${country} AND kind = 'city'`;
  if (!r || r.w === null || r.s === null || r.e === null || r.n === null) return seedBox;
  const m = 0.5;
  return [
    Math.max(-180, Math.min(seedBox[0], r.w - m)),
    Math.max(-90, Math.min(seedBox[1], r.s - m)),
    Math.min(180, Math.max(seedBox[2], r.e + m)),
    Math.min(90, Math.max(seedBox[3], r.n + m)),
  ];
}
import type { FinderParams } from "./params.js";

/** Box around every GeoNames city of a country (or one region), plus a margin; null when none are loaded. */
export async function citiesBox(db: Db, country: string, regionCode: string | null, marginDeg = 0.25): Promise<BBox | null> {
  const [r] = regionCode
    ? await db.$queryRaw<{ w: number | null; s: number | null; e: number | null; n: number | null }[]>`
        SELECT min(lng) AS w, min(lat) AS s, max(lng) AS e, max(lat) AS n
          FROM locations WHERE country = ${country} AND kind = 'city' AND region_code = ${regionCode}`
    : await db.$queryRaw<{ w: number | null; s: number | null; e: number | null; n: number | null }[]>`
        SELECT min(lng) AS w, min(lat) AS s, max(lng) AS e, max(lat) AS n
          FROM locations WHERE country = ${country} AND kind = 'city'`;
  if (!r || r.w === null || r.s === null || r.e === null || r.n === null) return null;
  return [
    Math.max(-180, r.w - marginDeg),
    Math.max(-90, r.s - marginDeg),
    Math.min(180, r.e + marginDeg),
    Math.min(90, r.n + marginDeg),
  ];
}

export interface ResolvedArea {
  kind: "country" | "region" | "city";
  country: string;
  countryName: string;
  /** Human label: "Manchester, United Kingdom (18.8 km)". */
  label: string;
  outlineKey: string;
  outlineKind: "country" | "region";
  /** Region stored on every place of a region import (US-TX); null otherwise. */
  regionCode: string | null;
  countryBox: BBox;
  /** Only for city imports: square around the city centre. */
  cityBox: BBox | null;
  radiusKm: number | null;
}

export async function resolveArea(db: Db, p: FinderParams): Promise<ResolvedArea> {
  const country = await db.country.findUnique({ where: { code: p.country } });
  if (!country) throw new FatalTaskError(`Unknown country ${p.country}`);
  // Job search only: leads may be found and crawled (to apply for jobs), never e-mailed for sales.
  if (!country.enabled && !country.jobSearch) {
    throw new FatalTaskError(
      country.blocked
        ? `${country.name} is blocked by default (strict cold-email rules). Turn on "Job search" for it in Settings to find companies to apply to, or enable outreach after checking the rules.`
        : `${country.name} is not enabled. Enable it (or "Job search") in Settings first.`,
    );
  }
  const countryBox = await searchBox(db, p.country, country.bbox as BBox);

  if (p.cityGeonameId) {
    const city = await db.location.findUnique({ where: { geonameId: p.cityGeonameId } });
    if (!city || city.kind !== "city" || city.country !== p.country || city.lat === null || city.lng === null) {
      throw new FatalTaskError("That city is not in the GeoNames list for this country");
    }
    const radiusKm = p.radiusKm ?? radiusForPopulation(city.population);
    const byRegion = country.regionImports && !!city.regionCode;
    return {
      kind: "city",
      country: p.country,
      countryName: country.name,
      label: `${city.name}, ${country.name} (${radiusKm} km around the centre)`,
      outlineKey: byRegion ? city.regionCode! : p.country,
      outlineKind: byRegion ? "region" : "country",
      regionCode: null,
      countryBox,
      cityBox: boxAround(city.lat, city.lng, radiusKm),
      radiusKm,
    };
  }

  if (p.regionCode) {
    if (!country.regionImports) {
      throw new FatalTaskError(`Region imports are not available for ${country.name}; choose a city.`);
    }
    const region = await db.location.findFirst({ where: { kind: "region", country: p.country, regionCode: p.regionCode } });
    if (!region) throw new FatalTaskError(`Unknown region ${p.regionCode}`);
    return {
      kind: "region",
      country: p.country,
      countryName: country.name,
      label: `${region.name}, ${country.name}`,
      outlineKey: p.regionCode,
      outlineKind: "region",
      regionCode: p.regionCode,
      countryBox,
      cityBox: null,
      radiusKm: null,
    };
  }

  if (!country.allowWholeCountry) {
    throw new FatalTaskError(`${country.name} is too large to import at once. Choose a region or a city.`);
  }
  return {
    kind: "country",
    country: p.country,
    countryName: country.name,
    label: country.name,
    outlineKey: p.country,
    outlineKind: "country",
    regionCode: null,
    countryBox,
    cityBox: null,
    radiusKm: null,
  };
}
