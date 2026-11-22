import { type NetOptions, safeFetch } from "../crawler/net.js";
import { companyKey, flagsOf, htmlToText, isDevTitle, roleOf, stackMatch } from "./detect.js";

/**
 * The two public job APIs, read politely (one request at a time, a pause between requests):
 * - Bundesagentur für Arbeit Jobsuche (rest.arbeitsagentur.de, public key "jobboerse-jobsuche")
 * - Arbeitnow job board API (no key; jobs in Germany, many from ATS like Greenhouse and Recruitee)
 */

export const SOURCES = ["ba", "arbeitnow"] as const;
export type JobSource = (typeof SOURCES)[number];
export const SOURCE_LABELS: Record<JobSource, string> = { ba: "Bundesagentur für Arbeit", arbeitnow: "Arbeitnow" };

export const BA_BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service";
export const ARBEITNOW_BASE = "https://www.arbeitnow.com/api/job-board-api";

export interface NormalizedAd {
  source: JobSource;
  externalId: string;
  title: string;
  company: string;
  companyKey: string;
  location: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  url: string;
  externalUrl: string | null;
  description: string | null;
  tags: string[];
  jobTypes: string[];
  role: string | null;
  isDev: boolean;
  stackMatch: boolean;
  flags: string[];
  postedAt: Date | null;
}

export interface SourceDeps {
  /** GET a JSON document (tests answer from fixtures). */
  getJson: (url: string, headers?: Record<string, string>) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  /** Pause between two requests to the same API. */
  delayMs: number;
  /** Called between requests (keeps the task alive; may throw to stop). */
  onProgress?: (note: string) => Promise<void>;
  /** Base URLs (tests point them to a local server). */
  baBase?: string;
  arbeitnowBase?: string;
}

const DESCRIPTION_CHARS = 3000;

/** An API answered with an error status (the message includes the start of its answer). */
export class ApiStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiStatusError";
  }
}

/** The first characters of an error answer, as plain text (helps to see why an API refused). */
export function answerSnippet(body: string | null): string {
  if (!body) return "";
  const text = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  return text ? `: "${text}"` : "";
}

/** A real network GET through the crawler's safe HTTP client (no private addresses, size limit). */
export function netGetJson(net: Partial<NetOptions> = {}): SourceDeps["getJson"] {
  return async (url, headers = {}) => {
    const host = new URL(url).host;
    const res = await safeFetch(
      url,
      { timeoutMs: 30_000, maxBytes: 15_000_000, maxRedirects: 3, ...net },
      { accept: /json|text|html|xml/i, headers: { accept: "application/json", ...headers } },
    );
    if (res.status === 429) throw new ApiStatusError(429, `${host} asks us to slow down (HTTP 429); try again later`);
    if (res.status >= 400) throw new ApiStatusError(res.status, `${host} answered HTTP ${res.status}${answerSnippet(res.body)}`);
    if (!res.body || !/json/i.test(res.contentType)) throw new Error(`${host} did not answer with JSON (${res.contentType || "no type"})`);
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new Error(`${host} sent JSON that could not be read`);
    }
  };
}

function finish(ad: RawAd, apiRemote: boolean, extraText = ""): NormalizedAd {
  const isDev = isDevTitle(ad.title);
  const text = `${ad.title}\n${ad.tags.join(", ")}\n${ad.jobTypes.join(", ")}\n${ad.description ?? ""}\n${extraText}`;
  return {
    ...ad,
    companyKey: companyKey(ad.company),
    role: isDev ? roleOf(ad.title) : null,
    isDev,
    stackMatch: isDev && stackMatch(`${ad.title}\n${ad.tags.join(" ")}\n${ad.description ?? ""}`),
    flags: flagsOf(text, apiRemote),
  };
}

type RawAd = Omit<NormalizedAd, "role" | "isDev" | "stackMatch" | "flags" | "companyKey">;
function rawFields(a: NormalizedAd): RawAd {
  return {
    source: a.source, externalId: a.externalId, title: a.title, company: a.company, location: a.location, city: a.city,
    postcode: a.postcode, country: a.country, lat: a.lat, lng: a.lng, url: a.url, externalUrl: a.externalUrl,
    description: a.description, tags: a.tags, jobTypes: a.jobTypes, postedAt: a.postedAt,
  };
}

/* ------------------------------ Bundesagentur ------------------------------ */

export interface BaParams {
  keywords: string[];
  /** Town or postcode; empty = all of Germany. */
  where?: string | undefined;
  radiusKm: number;
  days: number;
  maxPages: number;
  /** Read the full text of at most this many new developer adverts (flags need it). */
  details: number;
}

/** Text from a field that may be a string or an object with a name ({ name: "ACME GmbH" }). */
function textOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "firmenname", "bezeichnung", "titel", "value"]) {
      const t = textOf(o[k]);
      if (t) return t;
    }
  }
  return null;
}

function numOf(...vs: unknown[]): number | null {
  for (const v of vs) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

interface BaPlaceParsed {
  plz: string | null;
  ort: string | null;
  land: string | null;
  lat: number | null;
  lon: number | null;
}

/** The work place, from v4 (`arbeitsort`) or v6 (`stellenlokationen[]`, address possibly nested in `adresse`). */
function baPlace(it: Record<string, unknown>): BaPlaceParsed {
  const first = (v: unknown) => (Array.isArray(v) ? (v[0] as unknown) : v);
  const c = (first(it.arbeitsort) ?? first(it.arbeitsorte) ?? first(it.stellenlokationen) ?? {}) as Record<string, unknown>;
  const addr = (c.adresse ?? c.anschrift ?? c) as Record<string, unknown>;
  const k = (c.koordinaten ?? addr.koordinaten ?? c.geoKoordinaten ?? {}) as Record<string, unknown>;
  return {
    plz: textOf(addr.plz ?? addr.postleitzahl),
    ort: textOf(addr.ort ?? addr.stadt ?? addr.ortsname),
    land: textOf(addr.land ?? addr.landName ?? addr.staat),
    lat: numOf(k.lat, k.breite, c.breite, c.lat),
    lon: numOf(k.lon, k.lng, k.laenge, c.laenge, c.lon),
  };
}

/** Publication date: current publication period, first publication, or last change. */
function baPosted(it: Record<string, unknown>): Date | null {
  const period = it.veroeffentlichungszeitraum;
  const from = period && typeof period === "object" ? textOf((period as Record<string, unknown>).von) : textOf(period);
  return baDate(from ?? textOf(it.aktuelleVeroeffentlichungsdatum) ?? textOf(it.datumErsteVeroeffentlichung) ?? textOf(it.aenderungsdatum) ?? textOf(it.modifikationsTimestamp) ?? undefined);
}

/** One search result (v4 or v6 field names) -> advert. */
export function baAdvert(it: Record<string, unknown>): NormalizedAd | null {
  const refnr = textOf(it.refnr) ?? textOf(it.referenznummer) ?? textOf(it.hashId);
  const title = textOf(it.titel) ?? textOf(it.stellenangebotsTitel) ?? textOf(it.beruf) ?? textOf(it.hauptberuf);
  if (!refnr || !title) return null;
  const o = baPlace(it);
  const jobs = [textOf(it.hauptberuf), textOf(it.beruf), ...(Array.isArray(it.alleBerufe) ? it.alleBerufe.map(textOf) : [])].filter(
    (x): x is string => !!x && x !== title,
  );
  return finish(
    {
      source: "ba",
      externalId: refnr,
      title,
      company: textOf(it.arbeitgeber) ?? textOf(it.firma) ?? textOf(it.arbeitgeberName) ?? "Unknown employer",
      location: [o.plz, o.ort].filter(Boolean).join(" ") || null,
      city: o.ort,
      postcode: o.plz,
      country: baCountry(o.land ?? undefined),
      lat: o.lat,
      lng: o.lon,
      url: baAdUrl(refnr),
      externalUrl: textOf(it.externeURL) ?? textOf(it.externeUrl),
      description: null,
      tags: [...new Set(jobs)].slice(0, 5),
      jobTypes: it.arbeitszeitVollzeit === true ? ["Full time"] : [],
      postedAt: baPosted(it),
    },
    it.homeofficemoeglich === true,
  );
}

const AD_KEYS = ["refnr", "referenznummer", "hashId", "titel", "stellenangebotsTitel", "beruf", "arbeitgeber"];

/**
 * The list of adverts in a search answer. The documented name is `stellenangebote`; the v6 search
 * answers with another name, so the first array of objects that look like adverts is taken.
 */
export function findAdArray(body: unknown): { key: string | null; items: Record<string, unknown>[] } {
  if (!body || typeof body !== "object") return { key: null, items: [] };
  const o = body as Record<string, unknown>;
  const looksLikeAds = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && AD_KEYS.filter((k) => k in (v[0] as object)).length >= 2;
  if (looksLikeAds(o.stellenangebote)) return { key: "stellenangebote", items: o.stellenangebote };
  for (const [k, v] of Object.entries(o)) if (looksLikeAds(v)) return { key: k, items: v };
  // One level down ({ "ergebnis": { "stellenangebote": [...] } }).
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = findAdArray(v);
      if (inner.key) return { key: `${k}.${inner.key}`, items: inner.items };
    }
  }
  return { key: null, items: [] };
}

const BA_HEADERS = { "X-API-Key": "jobboerse-jobsuche" };
/** Search paths, newest first (bund.dev lists v6 and v4/app; older examples use v4). The first that answers is kept. */
export const BA_SEARCH_PATHS = ["/pc/v6/jobs", "/pc/v4/app/jobs", "/pc/v4/jobs"] as const;
/** Advert text paths (bund.dev recommends v4, v3 as the alternative). */
export const BA_DETAIL_PATHS = ["/pc/v4/jobdetails", "/pc/v3/jobdetails"] as const;

export function baAdUrl(refnr: string): string {
  return `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(refnr)}`;
}

function baCountry(land: string | undefined): string | null {
  if (!land) return "DE";
  const l = land.toLowerCase();
  if (l.startsWith("deutsch")) return "DE";
  if (l.startsWith("österreich") || l.startsWith("oesterreich")) return "AT";
  if (l.startsWith("schweiz")) return "CH";
  if (l.startsWith("niederlande")) return "NL";
  return null;
}

function baDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Searches every keyword (newest first), page by page. Returns the adverts (deduplicated by refnr). */
export async function fetchBa(p: BaParams, deps: SourceDeps, known: (refnrs: string[]) => Promise<Set<string>>): Promise<{ ads: NormalizedAd[]; requests: number; notes: string[] }> {
  const base = deps.baBase ?? BA_BASE;
  const byRef = new Map<string, NormalizedAd>();
  const notes: string[] = [];
  let requests = 0;
  let pathIndex = 0;
  let pathFound = false;
  const refusals: string[] = [];
  for (const kw of p.keywords) {
    for (let page = 1; page <= p.maxPages; page++) {
      const q = new URLSearchParams({
        was: kw,
        angebotsart: "1",
        veroeffentlichtseit: String(p.days),
        page: String(page),
        size: "100",
      });
      if (p.where) {
        q.set("wo", p.where);
        q.set("umkreis", String(p.radiusKm));
      }
      if (requests > 0) await deps.sleep(deps.delayMs);
      await deps.onProgress?.(`BA: "${kw}" page ${page}`);
      requests++;
      let body: { maxErgebnisse?: number | string } | undefined;
      for (;;) {
        try {
          body = (await deps.getJson(`${base}${BA_SEARCH_PATHS[pathIndex]}?${q.toString()}`, BA_HEADERS)) as typeof body;
          break;
        } catch (err) {
          // Another search path may work when this one is refused or gone (only until one has answered).
          const status = err instanceof ApiStatusError ? err.status : 0;
          if (!pathFound && (status === 403 || status === 404 || status === 410) && pathIndex < BA_SEARCH_PATHS.length - 1) {
            refusals.push(`${BA_SEARCH_PATHS[pathIndex]}: ${(err as Error).message}`);
            pathIndex++;
            await deps.sleep(deps.delayMs);
            requests++;
            continue;
          }
          if (refusals.length > 0) throw new Error(`${(err as Error).message} (also tried ${refusals.join("; ")})`, { cause: err });
          throw err;
        }
      }
      if (!pathFound && pathIndex > 0) notes.push(`Search path ${BA_SEARCH_PATHS[pathIndex]} used (${refusals.join("; ")})`);
      pathFound = true;
      const found = findAdArray(body);
      const items = found.items;
      if (items.length === 0 && Number(body?.maxErgebnisse ?? 0) > 0 && notes.length < 3) {
        notes.push(`The answer says ${body?.maxErgebnisse} results but no list of adverts was found (keys: ${Object.keys(body ?? {}).join(", ")})`);
      }
      for (const raw of items) {
        const ad = baAdvert(raw);
        if (ad && !byRef.has(ad.externalId)) byRef.set(ad.externalId, ad);
      }
      const max = Number(body?.maxErgebnisse ?? 0);
      if (items.length === 0 || items.length < 100 || page * 100 >= max) break;
    }
  }

  // Full text for new developer adverts (remote, visa, English, our stack are in the text).
  let detailed = 0;
  let detailPath = 0;
  let detailWorks = false;
  if (p.details > 0) {
    const devRefs = [...byRef.values()].filter((a) => a.isDev).map((a) => a.externalId);
    const already = await known(devRefs);
    for (const refnr of devRefs) {
      if (detailed >= p.details) break;
      if (already.has(refnr)) continue;
      detailed++;
      const code = Buffer.from(refnr, "utf8").toString("base64");
      let d: Record<string, unknown> | null = null;
      for (;;) {
        await deps.sleep(deps.delayMs);
        await deps.onProgress?.(`BA: advert text ${detailed}`);
        requests++;
        try {
          d = (await deps.getJson(`${base}${BA_DETAIL_PATHS[detailPath]}/${code}`, BA_HEADERS)) as Record<string, unknown>;
          detailWorks = true;
          break;
        } catch (err) {
          const refused = err instanceof ApiStatusError && (err.status === 403 || err.status === 404 || err.status === 410);
          if (refused && !detailWorks && detailPath < BA_DETAIL_PATHS.length - 1) {
            detailPath++;
            continue;
          }
          if (refused && !detailWorks) {
            notes.push(`Advert texts are not available (${(err as Error).message}); remote comes from the search, visa and English only from titles`);
            detailed = p.details; // stop asking
          } else if (notes.length < 3) {
            notes.push(`An advert text could not be read: ${(err as Error).message}`);
          }
          break;
        }
      }
      if (!d) continue;
      const ad = byRef.get(refnr)!;
      const text = htmlToText(textOf(d.stellenangebotsBeschreibung) ?? textOf(d.stellenbeschreibung) ?? textOf(d.beschreibung) ?? "");
      if (text) byRef.set(refnr, finish({ ...rawFields(ad), description: text.slice(0, DESCRIPTION_CHARS) }, ad.flags.includes("remote"), text));
    }
  }
  return { ads: [...byRef.values()], requests, notes };
}

/* -------------------------------- Arbeitnow -------------------------------- */

export interface ArbeitnowParams {
  maxPages: number;
  /** Also read the "visa sponsorship" list and mark those adverts. */
  visaPass: boolean;
}

interface ArbeitnowItem {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  tags?: unknown[];
  job_types?: unknown[];
  location?: string;
  created_at?: number;
}

function arbeitnowAd(it: ArbeitnowItem, visa: boolean): NormalizedAd | null {
  if (!it.slug || !it.title || !it.url) return null;
  const text = htmlToText(it.description ?? "");
  const ad = finish(
    {
      source: "arbeitnow",
      externalId: it.slug,
      title: it.title.trim(),
      company: (it.company_name ?? "Unknown employer").trim(),
      location: it.location?.trim() || null,
      city: it.location?.split(",")[0]?.trim() || null,
      postcode: null,
      country: null,
      lat: null,
      lng: null,
      url: it.url,
      externalUrl: null,
      description: text.slice(0, DESCRIPTION_CHARS) || null,
      tags: (it.tags ?? []).filter((t): t is string => typeof t === "string").slice(0, 20),
      jobTypes: (it.job_types ?? []).filter((t): t is string => typeof t === "string").slice(0, 10),
      postedAt: typeof it.created_at === "number" ? new Date(it.created_at * 1000) : null,
    },
    it.remote === true,
    text,
  );
  if (visa && !ad.flags.includes("visa")) ad.flags = [...ad.flags, "visa"].sort();
  return ad;
}

/** Reads the newest pages of the feed (and the visa-sponsorship list). */
export async function fetchArbeitnow(p: ArbeitnowParams, deps: SourceDeps): Promise<{ ads: NormalizedAd[]; requests: number; notes: string[] }> {
  const base = deps.arbeitnowBase ?? ARBEITNOW_BASE;
  const bySlug = new Map<string, NormalizedAd>();
  let requests = 0;
  for (const visa of p.visaPass ? [false, true] : [false]) {
    for (let page = 1; page <= p.maxPages; page++) {
      const q = new URLSearchParams({ page: String(page) });
      if (visa) q.set("visa_sponsorship", "true");
      if (requests > 0) await deps.sleep(deps.delayMs);
      await deps.onProgress?.(`Arbeitnow${visa ? " (visa)" : ""}: page ${page}`);
      requests++;
      const body = (await deps.getJson(`${base}?${q.toString()}`)) as { data?: ArbeitnowItem[]; links?: { next?: string | null } };
      const items = Array.isArray(body.data) ? body.data : [];
      for (const it of items) {
        const ad = arbeitnowAd(it, visa);
        if (!ad) continue;
        const prev = bySlug.get(ad.externalId);
        if (prev && visa && !prev.flags.includes("visa")) prev.flags = [...prev.flags, "visa"].sort();
        else if (!prev) bySlug.set(ad.externalId, ad);
      }
      if (items.length === 0 || (body.links && !body.links.next)) break;
    }
  }
  return { ads: [...bySlug.values()], requests, notes: [] };
}
