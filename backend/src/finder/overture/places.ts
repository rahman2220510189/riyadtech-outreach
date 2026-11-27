import { type CategoryRule, matchCategory, placeNodes, type Taxonomy } from "../categories.js";
import { cleanSocials, firstValidPhone } from "../contacts.js";
import { pickOwnWebsite } from "../domain.js";
import { type BBox, type NearestCity, type OutlineIndex, bboxContains } from "../geo.js";

/** Columns read from places/place (schema v2.0.0). Geometry is not needed: the bbox of a point is the point. */
export const PLACE_COLUMNS = [
  "id",
  "bbox",
  "names",
  "taxonomy",
  "basic_category",
  "confidence",
  "websites",
  "socials",
  "emails",
  "phones",
  "addresses",
  "operating_status",
];

interface Address {
  freeform?: string | null;
  locality?: string | null;
  postcode?: string | null;
  region?: string | null;
  country?: string | null;
}

export interface PlaceRow {
  id?: string | null;
  bbox?: { xmin?: number; ymin?: number; xmax?: number; ymax?: number } | null;
  names?: { primary?: string | null } | null;
  taxonomy?: Taxonomy | null;
  basic_category?: string | null;
  confidence?: number | null;
  websites?: (string | null)[] | null;
  socials?: (string | null)[] | null;
  emails?: (string | null)[] | null;
  phones?: (string | null)[] | null;
  addresses?: (Address | null)[] | null;
  operating_status?: string | null;
}

export interface Candidate {
  overtureId: string;
  segment: "A" | "B";
  categoryKey: string;
  name: string;
  website: string;
  websiteDomain: string;
  country: string;
  regionCode: string | null;
  city: string | null;
  postcode: string | null;
  address: string | null;
  lat: number;
  lng: number;
  timezone: string | null;
  /** E.164, or null when Overture has no valid number for the country. */
  phone: string | null;
  emails: string[];
  socials: string[];
  confidence: number;
}

export type SkipReason =
  | "outside_area"
  | "outside_outline"
  | "closed"
  | "low_confidence"
  | "unmapped"
  | "other_category"
  | "no_website"
  | "platform_website"
  | "no_name";

export interface FilterContext {
  box: BBox;
  outline: OutlineIndex | null;
  /** "country" outlines accept a matching address country; "region" ones also need the region. */
  outlineKind: "country" | "region" | null;
  country: string;
  /** ISO region (US-TX) when the import is for one region. */
  regionCode: string | null;
  /**
   * Without an outline: the place's own address must name this country (and region, for a
   * region import). Places with no country in their address are kept (they are inside the box).
   */
  addressCheck: boolean;
  minConfidence: number;
  rules: readonly CategoryRule[];
  allowedKeys: ReadonlySet<string>;
  platforms: readonly string[];
  nearest: NearestCity | null;
}

export type FilterResult = { kept: Candidate } | { skipped: SkipReason; category?: string };

const CLOSED = new Set(["permanently_closed", "temporarily_closed", "closed"]);

function clean(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function addressMatches(addresses: PlaceRow["addresses"], country: string, regionCode: string | null): boolean {
  const regionShort = regionCode?.split("-")[1]?.toLowerCase();
  return (addresses ?? []).some((a) => {
    if (a?.country?.toUpperCase() !== country) return false;
    if (!regionShort) return true;
    const r = a.region?.trim().toLowerCase();
    return r === regionShort || r === regionCode?.toLowerCase();
  });
}

/** True when the address clearly names another country, or another region of the same country. */
function addressContradicts(addresses: PlaceRow["addresses"], country: string, regionCode: string | null): boolean {
  const withCountry = (addresses ?? []).filter((a) => a?.country?.trim());
  if (withCountry.length === 0) return false;
  const inCountry = withCountry.filter((a) => a!.country!.trim().toUpperCase() === country);
  if (inCountry.length === 0) return true;
  if (!regionCode) return false;
  const short = regionCode.split("-")[1]?.toLowerCase();
  const withRegion = inCountry.filter((a) => a!.region?.trim());
  if (withRegion.length === 0) return false;
  return !withRegion.some((a) => {
    const r = a!.region!.trim().toLowerCase();
    return r === short || r === regionCode.toLowerCase();
  });
}

/** Decides whether one Overture place becomes a lead, and why not. Cheap checks first. */
export function filterPlace(row: PlaceRow, ctx: FilterContext): FilterResult {
  const b = row.bbox;
  if (!b || b.xmin === undefined || b.ymin === undefined) return { skipped: "outside_area" };
  const lng = (b.xmin + (b.xmax ?? b.xmin)) / 2;
  const lat = (b.ymin + (b.ymax ?? b.ymin)) / 2;
  if (!bboxContains(ctx.box, lng, lat)) return { skipped: "outside_area" };

  if (row.operating_status && CLOSED.has(row.operating_status)) return { skipped: "closed" };
  if ((row.confidence ?? 0) < ctx.minConfidence) return { skipped: "low_confidence" };

  const nodes = placeNodes(row.taxonomy, row.basic_category);
  const anyRule = matchCategory(ctx.rules, nodes);
  if (!anyRule) {
    return { skipped: "unmapped", category: row.taxonomy?.primary ?? row.basic_category ?? "(none)" };
  }
  const rule = ctx.allowedKeys.has(anyRule.key) ? anyRule : matchCategory(ctx.rules, nodes, ctx.allowedKeys);
  if (!rule) return { skipped: "other_category" };

  const hasAnyWebsite = (row.websites ?? []).some((w) => !!w?.trim());
  if (!hasAnyWebsite) return { skipped: "no_website" };
  const own = pickOwnWebsite(row.websites, ctx.platforms);
  if (!own) return { skipped: "platform_website" };

  if (ctx.outline) {
    if (!ctx.outline.contains(lng, lat)) {
      const fallbackRegion = ctx.outlineKind === "region" ? ctx.regionCode : null;
      if (!addressMatches(row.addresses, ctx.country, fallbackRegion)) return { skipped: "outside_outline" };
    }
  } else if (ctx.addressCheck && addressContradicts(row.addresses, ctx.country, ctx.regionCode)) {
    return { skipped: "outside_outline" };
  }

  const name = clean(row.names?.primary);
  if (!name) return { skipped: "no_name" };

  const addr = (row.addresses ?? []).find((a) => a) ?? null;
  const near = ctx.nearest?.nearest(lat, lng) ?? null;
  return {
    kept: {
      overtureId: String(row.id),
      segment: rule.segment,
      categoryKey: rule.key,
      name: name.slice(0, 300),
      website: own.website.slice(0, 500),
      websiteDomain: own.domain,
      country: ctx.country,
      regionCode: ctx.regionCode ?? near?.regionCode ?? null,
      city: clean(addr?.locality) ?? near?.name ?? null,
      postcode: clean(addr?.postcode),
      address: clean(addr?.freeform)?.slice(0, 500) ?? null,
      lat,
      lng,
      timezone: near?.timezone ?? null,
      phone: firstValidPhone(row.phones, ctx.country),
      emails: [...new Set((row.emails ?? []).map((e) => e?.trim().toLowerCase()).filter((e): e is string => !!e))].slice(0, 10),
      socials: cleanSocials(row.socials),
      confidence: row.confidence ?? 0,
    },
  };
}
