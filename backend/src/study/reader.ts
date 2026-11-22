import * as cheerio from "cheerio";
import { FetchError, type FetchResult, type NetOptions, safeFetch } from "../crawler/net.js";
import { sameSite, sitemapLocs } from "../crawler/pages.js";
import { parseRobots, type RobotsInfo } from "../crawler/robots.js";
import { EMPTY, type Extracted, extractFacts } from "./extract.js";

/**
 * Reads university pages politely: robots.txt first, the site's Crawl-delay (or our minimum)
 * between requests, an honest User-Agent, no private addresses. Never pretends to be a person.
 */

export interface ReaderSettings {
  minDelayMs: number;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  maxCrawlDelaySeconds: number;
  /** Pages read per site at most (homepage and robots.txt not counted). */
  maxPages: number;
}

export interface ReaderDeps {
  net?: Partial<Pick<NetOptions, "resolve" | "allowAddresses">>;
  sleep?: (ms: number) => Promise<void>;
  /** Called before every request: throws to stop (Pause). */
  checkpoint?: () => Promise<void>;
  today?: Date;
}

export type PageStatus = "ok" | "blocked" | "not_found" | "error" | "no_text";

export interface ReadPage {
  url: string;
  status: PageStatus;
  error?: string;
  facts: Extracted;
  /** Text length (0 when nothing readable: often a JavaScript-only page). */
  textLength: number;
  /** The page text (first 40,000 characters), for checks such as "does this page name the scholarship". */
  text?: string;
  /** Links to the online application ("Apply now", DreamApply, …), best first. */
  applyLinks?: string[];
}

export interface SiteResult {
  /** ok: pages read; robots: robots.txt does not allow us; unreachable: the site did not answer. */
  status: "ok" | "robots" | "unreachable";
  note: string;
  pages: ReadPage[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Paths and link texts of admission-related pages, with a weight (higher = read first). */
const LINK_RULES: [RegExp, number][] = [
  [/english[-_ ]?(language[-_ ]?)?(requirement|proficiency)|language[-_ ]requirement|\bielts\b/i, 10],
  [/entry[-_ ]requirement|admission[-_ ]requirement|eligibility|how[-_ ]to[-_ ]apply/i, 8],
  [/international[-_ ]?(student|applicant|admission)s?|non[-_ ]?eu|foreign[-_ ]student|degree[-_ ]seeking/i, 7],
  [/deadline|application[-_ ]?(period|date)s?|important[-_ ]dates|key[-_ ]dates|apply/i, 6],
  [/admission|admissions|application/i, 5],
  [/master|postgraduate|graduate[-_ ]stud|msc\b|programmes?[-_ ]in[-_ ]english|english[-_ ]taught|study[-_ ]programmes|degree[-_ ]programmes/i, 4],
  [/international|study[-_ ]with[-_ ]us|future[-_ ]students|prospective/i, 2],
];
const SKIP = /\.(jpe?g|png|gif|svg|webp|ico|zip|rar|docx?|xlsx?|pptx?|mp[34]|mov|avi|css|js|json|xml|rss|txt|pdf)$/i;
const SKIP_PATH = /\/(news|events?|blog|press|media|staff|people|research|login|cart|shop|calendar|tag|author)(\/|$)/i;

function score(url: URL, text: string): number {
  const hay = `${decodeURIComponent(url.pathname).toLowerCase()} ${text.toLowerCase()}`;
  let s = 0;
  for (const [re, w] of LINK_RULES) if (re.test(hay)) s += w;
  if (s > 0 && /(^|\/)en(\/|$)|english/i.test(url.pathname)) s += 1;
  return s;
}

const APPLY_TEXT = /^(apply( now| online| here| today)?|online application|application (portal|system|form)|start (your |an )?application|submit (your |an )?application|apply for (admission|a programme|a program|this programme|this program|a place)|bewerben|jetzt bewerben)\b/i;
const APPLY_HREF = /dreamapply\.com|uni-assist\.de|studielink\.nl|universityadmissions\.se|opintopolku\.fi|campuschina\.org|apply\.[a-z0-9-]+\.|\/(apply|application|online-application|applicationportal|admission-portal)(\/|$|\?)/i;
const NOT_STUDY = /job|career|vacanc|staff|employ|recruit(ment)? of staff|tender|procurement|mailto:|\.pdf($|\?)|facebook|linkedin|twitter|instagram|youtube/i;

/** The page's links to an online application, best first (at most 3). */
export function applyLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const found = new Map<string, number>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#") || text.length > 60) return;
    let url: URL;
    try {
      url = new URL(href.trim(), pageUrl);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const full = url.toString();
    if (NOT_STUDY.test(full) || NOT_STUDY.test(text)) return;
    let score = 0;
    if (APPLY_TEXT.test(text)) score += 10;
    if (APPLY_HREF.test(full)) score += /dreamapply|uni-assist|studielink|universityadmissions|opintopolku|campuschina|apply\./i.test(url.hostname) ? 8 : 4;
    if (score === 0) return;
    url.hash = "";
    found.set(url.toString(), Math.max(found.get(url.toString()) ?? 0, score));
  });
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, 3)
    .map(([u]) => u);
}

/** Visible text with line breaks at block ends (sentences stay apart). */
export function htmlText(html: string): string {
  const $ = cheerio.load(html);
  const body = $("body").length ? $("body") : $("html");
  body.find("script, style, noscript, template, svg, iframe, nav, form").remove();
  body.find("br, p, div, li, h1, h2, h3, h4, h5, h6, td, th, tr, section, article, dt, dd").after("\n");
  return body
    .text()
    .replace(/[ \t\r\f\v\u00a0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Same-site candidate links (best first), the English version of the site first. */
export function candidateLinks(html: string, pageUrl: string, domain: string): { url: string; score: number }[] {
  const $ = cheerio.load(html);
  const found = new Map<string, number>();
  const add = (href: string | undefined, text: string, bonus = 0) => {
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) return;
    let url: URL;
    try {
      url = new URL(href.trim(), pageUrl);
    } catch {
      return;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !sameSite(url.hostname, domain)) return;
    if (SKIP.test(url.pathname) || SKIP_PATH.test(url.pathname)) return;
    url.hash = "";
    const s = score(url, text) + bonus;
    if (s <= 0) return;
    const key = url.toString();
    found.set(key, Math.max(found.get(key) ?? 0, s));
  };
  // The English version of a site in another language.
  $('link[rel="alternate"][hreflang^="en"], a[hreflang^="en"]').each((_, el) => add($(el).attr("href"), "english", 20));
  $("a[href]").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (/^(en|eng|english)$/i.test(text)) add($(el).attr("href"), "english", 20);
    else if (text.length <= 80) add($(el).attr("href"), text);
  });
  return [...found.entries()].map(([url, s]) => ({ url, score: s })).sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

export class Reader {
  private lastAt = 0;
  private delayMs: number;
  private robots: RobotsInfo | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly settings: ReaderSettings,
    private readonly deps: ReaderDeps = {},
  ) {
    this.delayMs = settings.minDelayMs;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  private net(): NetOptions {
    return { timeoutMs: this.settings.timeoutMs, maxBytes: this.settings.maxBytes, maxRedirects: this.settings.maxRedirects, ...this.deps.net };
  }

  private async get(url: string, accept?: RegExp): Promise<FetchResult> {
    await this.deps.checkpoint?.();
    const wait = this.lastAt + this.delayMs - Date.now();
    if (this.lastAt > 0 && wait > 0) await this.sleep(wait);
    this.lastAt = Date.now();
    return safeFetch(url, this.net(), accept ? { accept } : {});
  }

  /** robots.txt of the site; false when we may not read it at all. */
  async loadRobots(origin: string): Promise<{ ok: boolean; note: string }> {
    let fetched: FetchResult | null = null;
    let why = "";
    // One retry: a single dropped connection should not keep a whole site out until next month.
    for (let attempt = 0; attempt < 2 && fetched === null; attempt++) {
      try {
        fetched = await this.get(`${origin}/robots.txt`, /text|plain|octet/i);
      } catch (err) {
        why = err instanceof Error ? err.message : String(err);
        if (attempt === 0 && !(err instanceof FetchError && (err.kind === "tls" || err.kind === "dns" || err.kind === "blocked_address"))) await this.sleep(5_000);
        else break;
      }
    }
    this.robots = parseRobots(`${origin}/robots.txt`, fetched);
    // Say why, so a certificate or network problem is not mistaken for a "no".
    if (fetched === null && why) return { ok: false, note: `robots.txt could not be read (${why}); treated as "do not crawl"` };
    if (this.robots.crawlDelaySeconds !== null) {
      if (this.robots.crawlDelaySeconds > this.settings.maxCrawlDelaySeconds) return { ok: false, note: `robots.txt asks for ${this.robots.crawlDelaySeconds} s between requests` };
      this.delayMs = Math.max(this.settings.minDelayMs, this.robots.crawlDelaySeconds * 1000);
    }
    return { ok: this.robots.status !== "unavailable", note: this.robots.note };
  }

  allowed(url: string): boolean {
    return this.robots?.isAllowed(url) ?? true;
  }

  /** One page: status, text facts and the HTML (for links). */
  async readPage(url: string): Promise<ReadPage & { html: string | null; finalUrl: string }> {
    if (!this.allowed(url)) return { url, finalUrl: url, status: "blocked", error: "robots.txt does not allow this page", facts: EMPTY, textLength: 0, html: null };
    let res: FetchResult;
    try {
      res = await this.get(url);
    } catch (err) {
      const msg = err instanceof FetchError ? err.message : err instanceof Error ? err.message : String(err);
      return { url, finalUrl: url, status: "error", error: msg, facts: EMPTY, textLength: 0, html: null };
    }
    if (res.status === 401 || res.status === 403 || res.status === 429)
      return { url, finalUrl: res.url, status: "blocked", error: `HTTP ${res.status}: the site refused our reader`, facts: EMPTY, textLength: 0, html: null };
    if (res.status === 404 || res.status === 410) return { url, finalUrl: res.url, status: "not_found", error: `HTTP ${res.status}`, facts: EMPTY, textLength: 0, html: null };
    if (res.status >= 400 || !res.body) return { url, finalUrl: res.url, status: "error", error: `HTTP ${res.status}${res.body ? "" : " (not a web page)"}`, facts: EMPTY, textLength: 0, html: null };
    const text = htmlText(res.body);
    if (text.length < 200) return { url, finalUrl: res.url, status: "no_text", error: "Almost no text: the page is probably built by JavaScript", facts: EMPTY, textLength: text.length, html: res.body };
    return {
      url,
      finalUrl: res.url,
      status: "ok",
      facts: extractFacts(text, this.deps.today),
      textLength: text.length,
      text: text.slice(0, 40_000),
      applyLinks: applyLinks(res.body, res.url),
      html: res.body,
    };
  }

  /** Sitemap URLs that look like admission pages (one sitemap, or the first child of an index). */
  async sitemapCandidates(domain: string): Promise<string[]> {
    const maps = this.robots?.sitemaps ?? [];
    if (maps.length === 0) return [];
    try {
      let res = await this.get(maps[0]!, /xml|text/i);
      if (!res.body) return [];
      let locs = sitemapLocs(res.body);
      if (locs.isIndex) {
        const child = locs.urls.find((u) => /page|en|study|program/i.test(u)) ?? locs.urls[0];
        if (!child) return [];
        res = await this.get(child, /xml|text/i);
        if (!res.body) return [];
        locs = sitemapLocs(res.body);
      }
      return locs.urls
        .map((u) => {
          try {
            const url = new URL(u);
            return sameSite(url.hostname, domain) && !SKIP.test(url.pathname) && !SKIP_PATH.test(url.pathname) ? { u, s: score(url, "") } : null;
          } catch {
            return null;
          }
        })
        .filter((x): x is { u: string; s: number } => !!x && x.s >= 5)
        .sort((a, b) => b.s - a.s || a.u.length - b.u.length)
        .slice(0, 10)
        .map((x) => x.u);
    } catch {
      return [];
    }
  }
}

/** Finds and reads the admission pages of one university website. */
export async function readUniversitySite(website: string, domain: string, settings: ReaderSettings, deps: ReaderDeps = {}): Promise<SiteResult> {
  const reader = new Reader(settings, deps);
  const origin = new URL(website).origin;
  const robots = await reader.loadRobots(origin);
  if (!robots.ok) return { status: "robots", note: robots.note, pages: [] };
  const home = await reader.readPage(website);
  if (home.status === "error" && !home.html) return { status: "unreachable", note: home.error ?? "No answer", pages: [] };
  if (home.status === "blocked") return { status: "robots", note: home.error ?? "Blocked", pages: [home] };
  const pages: ReadPage[] = [];
  const queue: { url: string; score: number }[] = [];
  const seen = new Set<string>([website, home.finalUrl]);
  const push = (list: { url: string; score: number }[]) => {
    for (const l of list) if (!seen.has(l.url) && !queue.some((q) => q.url === l.url)) queue.push(l);
    queue.sort((a, b) => b.score - a.score);
  };
  if (home.html) push(candidateLinks(home.html, home.finalUrl, domain));
  if (home.status === "ok") pages.push(strip(home));
  push((await reader.sitemapCandidates(domain)).map((u) => ({ url: u, score: 5 })));
  let read = 0;
  while (queue.length > 0 && read < settings.maxPages) {
    const next = queue.shift()!;
    seen.add(next.url);
    const p = await reader.readPage(next.url);
    read++;
    seen.add(p.finalUrl);
    pages.push(strip(p));
    // Links from the English home page and from admission pages lead further in (two levels).
    if (p.html && next.score >= 5) push(candidateLinks(p.html, p.finalUrl, domain).map((l) => ({ ...l, score: l.score - 1 })));
  }
  return { status: "ok", note: `${pages.length} page${pages.length === 1 ? "" : "s"} read`, pages };
}

/** Reads given pages (a programme's own links), robots.txt per site. */
export async function readPages(urls: string[], settings: ReaderSettings, deps: ReaderDeps = {}): Promise<ReadPage[]> {
  const out: ReadPage[] = [];
  const byOrigin = new Map<string, string[]>();
  for (const u of urls) {
    const o = new URL(u).origin;
    byOrigin.set(o, [...(byOrigin.get(o) ?? []), u]);
  }
  for (const [origin, list] of byOrigin) {
    const reader = new Reader(settings, deps);
    const robots = await reader.loadRobots(origin);
    for (const u of list) {
      if (!robots.ok) {
        out.push({ url: u, status: "blocked", error: robots.note, facts: EMPTY, textLength: 0 });
        continue;
      }
      out.push(strip(await reader.readPage(u)));
    }
  }
  return out;
}

function strip(p: ReadPage & { html?: string | null; finalUrl?: string }): ReadPage {
  return {
    url: p.url,
    status: p.status,
    ...(p.error ? { error: p.error } : {}),
    facts: p.facts,
    textLength: p.textLength,
    ...(p.text ? { text: p.text } : {}),
    ...(p.applyLinks?.length ? { applyLinks: p.applyLinks } : {}),
  };
}
