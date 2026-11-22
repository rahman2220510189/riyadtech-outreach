import type { Db } from "../db/client.js";

/**
 * University directory (Europe, South Korea, Malaysia): three open sources, merged by website domain.
 * - hipo: GitHub "university-domains-list" (MIT licence), one JSON file for the world
 * - ror: Research Organization Registry API v2 (CC0), type "education", per country
 * - wikidata: Wikidata Query Service (CC0), universities with an official website, per country
 */

export const DIRECTORY_SOURCES = ["hipo", "ror", "wikidata"] as const;
export type DirectorySource = (typeof DIRECTORY_SOURCES)[number];

export const SOURCE_NAMES: Record<DirectorySource, string> = {
  hipo: "University domains list (GitHub)",
  ror: "Research Organization Registry (ROR)",
  wikidata: "Wikidata",
};

/** Europe: EU, EEA, Switzerland, UK, Western Balkans, Türkiye, Ukraine, Moldova and the micro-states. */
export const EUROPE = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "NO", "LI", "CH", "GB", "AL", "BA", "ME", "MK", "RS", "XK", "TR", "UA", "MD", "AD", "MC", "SM",
] as const;

/** Default countries: Europe plus Asian, Oceanian and North American scholarship countries. Changed in Settings (study.countries). */
export const STUDY_COUNTRIES = [...EUROPE, "KR", "MY", "JP", "CN", "TW", "CA", "US", "AU", "NZ"] as const;

const NAME_OVERRIDES: Record<string, string> = { KR: "South Korea", CZ: "Czech Republic", TR: "Türkiye", GB: "United Kingdom", XK: "Kosovo", MK: "North Macedonia", MD: "Moldova", BA: "Bosnia and Herzegovina" };
const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

/** English country name, matching the names used for programmes ("Czech Republic", "Türkiye"). */
export function countryName(code: string): string {
  return NAME_OVERRIDES[code] ?? displayNames.of(code) ?? code;
}

export interface DirectoryEntry {
  name: string;
  countryCode: string;
  website: string;
  domain: string;
  source: DirectorySource;
  rorId?: string;
  wikidataId?: string;
}

/** "https://www.uni-szeged.hu/en/" -> "u-szeged.hu"; null for anything that is not a usable public website. */
export function siteDomain(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\d?\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  // Social pages and website builders are not a university's own site.
  if (/(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|wikipedia|google|blogspot|wordpress|wix)\.[a-z.]+$/.test(host)) return null;
  return host;
}

function homepage(raw: string): string {
  const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  return `${u.protocol}//${u.host}${u.pathname === "" ? "/" : u.pathname}`;
}

const defaultAllowed = new Set<string>(STUDY_COUNTRIES);

/** Northern Cyprus institutions are listed under Cyprus but use .tr domains; their degrees are often not recognised in the EU. */
export function skipReason(e: Pick<DirectoryEntry, "countryCode" | "domain">): string | null {
  if (e.countryCode === "CY" && /\.tr$/.test(e.domain)) return "Northern Cyprus: degrees are often not recognised in the EU";
  return null;
}

// ---- hipo -------------------------------------------------------------------------------------

interface HipoRow {
  name?: unknown;
  alpha_two_code?: unknown;
  web_pages?: unknown;
  domains?: unknown;
}

export function parseHipo(json: unknown, allowed: ReadonlySet<string> = defaultAllowed): DirectoryEntry[] {
  if (!Array.isArray(json)) throw new Error("GitHub list: expected a JSON array");
  const out: DirectoryEntry[] = [];
  for (const r of json as HipoRow[]) {
    const code = typeof r.alpha_two_code === "string" ? r.alpha_two_code.toUpperCase() : "";
    if (!allowed.has(code) || typeof r.name !== "string") continue;
    const pages = Array.isArray(r.web_pages) ? r.web_pages.filter((p): p is string => typeof p === "string") : [];
    const domains = Array.isArray(r.domains) ? r.domains.filter((p): p is string => typeof p === "string") : [];
    const site = pages[0] ?? (domains[0] ? `https://${domains[0]}/` : undefined);
    const domain = siteDomain(site);
    if (!site || !domain) continue;
    out.push({ name: r.name.trim(), countryCode: code, website: homepage(site), domain, source: "hipo" });
  }
  return out;
}

// ---- ROR --------------------------------------------------------------------------------------

interface RorItem {
  id?: unknown;
  status?: unknown;
  names?: { value?: unknown; types?: unknown }[];
  links?: { type?: unknown; value?: unknown }[];
  locations?: { geonames_details?: { country_code?: unknown } }[];
}

/** One page of GET /v2/organizations. */
export function parseRorPage(json: unknown, allowed: ReadonlySet<string> = defaultAllowed): { entries: DirectoryEntry[]; total: number; count: number } {
  const o = json as { number_of_results?: unknown; items?: unknown };
  if (!o || !Array.isArray(o.items)) throw new Error("ROR: expected an object with an items list");
  const entries: DirectoryEntry[] = [];
  for (const it of o.items as RorItem[]) {
    if (it.status !== undefined && it.status !== "active") continue;
    const names = Array.isArray(it.names) ? it.names : [];
    const display =
      names.find((n) => Array.isArray(n.types) && n.types.includes("ror_display")) ?? names.find((n) => Array.isArray(n.types) && n.types.includes("label")) ?? names[0];
    const site = (Array.isArray(it.links) ? it.links : []).find((l) => l.type === "website")?.value;
    const code = it.locations?.[0]?.geonames_details?.country_code;
    const domain = typeof site === "string" ? siteDomain(site) : null;
    if (typeof display?.value !== "string" || typeof code !== "string" || !domain || typeof site !== "string") continue;
    if (!allowed.has(code.toUpperCase())) continue;
    entries.push({
      name: display.value.trim(),
      countryCode: code.toUpperCase(),
      website: homepage(site),
      domain,
      source: "ror",
      ...(typeof it.id === "string" ? { rorId: it.id } : {}),
    });
  }
  return { entries, total: typeof o.number_of_results === "number" ? o.number_of_results : entries.length, count: o.items.length };
}

export function rorUrl(base: string, country: string, page: number): string {
  return `${base}/v2/organizations?filter=types:education,status:active,country.country_code:${country}&page=${page}`;
}

// ---- Wikidata ---------------------------------------------------------------------------------

/** Universities and similar institutions in one country that have an official website and were not dissolved. */
export function wikidataQuery(country: string): string {
  return `SELECT ?item ?itemLabel ?website WHERE {
  VALUES ?type { wd:Q3918 wd:Q875538 wd:Q902104 wd:Q15936437 wd:Q1371037 wd:Q23002054 wd:Q38723 }
  ?item wdt:P31 ?type; wdt:P17 ?c; wdt:P856 ?website.
  ?c wdt:P297 "${country}".
  FILTER NOT EXISTS { ?item wdt:P576 ?ended }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`;
}

export function wikidataUrl(base: string, country: string): string {
  return `${base}?format=json&query=${encodeURIComponent(wikidataQuery(country))}`;
}

export function parseWikidata(json: unknown, country: string): DirectoryEntry[] {
  const o = json as { results?: { bindings?: unknown } };
  if (!o?.results || !Array.isArray(o.results.bindings)) throw new Error("Wikidata: expected SPARQL JSON results");
  const out: DirectoryEntry[] = [];
  for (const b of o.results.bindings as Record<string, { value?: unknown } | undefined>[]) {
    const name = b.itemLabel?.value;
    const site = b.website?.value;
    const item = b.item?.value;
    const domain = typeof site === "string" ? siteDomain(site) : null;
    // An unlabelled item comes back as its Q-number.
    if (typeof name !== "string" || /^Q\d+$/.test(name) || typeof site !== "string" || !domain) continue;
    out.push({
      name: name.trim(),
      countryCode: country,
      website: homepage(site),
      domain,
      source: "wikidata",
      ...(typeof item === "string" ? { wikidataId: item.replace(/^.*\//, "") } : {}),
    });
  }
  return out;
}

// ---- merge ------------------------------------------------------------------------------------

/**
 * Saves entries: a new domain becomes a new university; a known domain gets the source added
 * (and the ROR / Wikidata id). Names and websites already saved are kept. Returns how many are new.
 */
export async function saveDirectoryEntries(db: Db, entries: DirectoryEntry[]): Promise<{ added: number; updated: number }> {
  // One entry per domain (the first wins).
  const byDomain = new Map<string, DirectoryEntry>();
  for (const e of entries) if (!byDomain.has(e.domain)) byDomain.set(e.domain, e);
  const list = [...byDomain.values()];
  let added = 0;
  let updated = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const rows = chunk.map((e) => ({
      name: e.name.slice(0, 300),
      country_code: e.countryCode,
      website: e.website.slice(0, 500),
      domain: e.domain,
      source: e.source,
      ror_id: e.rorId ?? null,
      wikidata_id: e.wikidataId ?? null,
      status: skipReason(e) ? "skipped" : "new",
      note: skipReason(e),
    }));
    const res = await db.$queryRaw<{ inserted: boolean }[]>`
      INSERT INTO study_universities (name, country_code, website, domain, sources, ror_id, wikidata_id, status, note, updated_at)
      SELECT r.name, r.country_code, r.website, r.domain, ARRAY[r.source], r.ror_id, r.wikidata_id, r.status, r.note, now()
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS r(name text, country_code text, website text, domain text, source text, ror_id text, wikidata_id text, status text, note text)
      ON CONFLICT (domain) DO UPDATE SET
        sources = CASE WHEN EXCLUDED.sources[1] = ANY(study_universities.sources) THEN study_universities.sources
                       ELSE study_universities.sources || EXCLUDED.sources END,
        ror_id = COALESCE(study_universities.ror_id, EXCLUDED.ror_id),
        wikidata_id = COALESCE(study_universities.wikidata_id, EXCLUDED.wikidata_id),
        updated_at = now()
      RETURNING (xmax = 0) AS inserted`;
    for (const r of res) {
      if (r.inserted) added++;
      else updated++;
    }
  }
  return { added, updated };
}
