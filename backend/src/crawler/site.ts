import type { IncomingHttpHeaders } from "node:http";
import * as cheerio from "cheerio";
import { isPlatformDomain, websiteDomain } from "../finder/domain.js";
import { ATS_LABELS, detectBoard, type FeedUrlFor, jobsAsPageText, type JobBoard, parseJobs, realFeedUrl } from "./ats.js";
import { type FetchError, type FetchResult, type NetOptions, safeFetch } from "./net.js";
import { isDeveloperRole } from "./signals.js";
import { classifyUrl, findLinks, KIND_ORDER, type PageKind, pageText, sameSite, sitemapLocs } from "./pages.js";
import { parseRobots, type RobotsInfo } from "./robots.js";

export type CrawlStatus =
  | "ok"
  | "partial"
  | "robots_blocked"
  | "bot_blocked"
  | "unreachable"
  | "not_html"
  | "platform"
  | "error";

export const CRAWL_STATUSES: readonly CrawlStatus[] = [
  "ok",
  "partial",
  "robots_blocked",
  "bot_blocked",
  "unreachable",
  "not_html",
  "platform",
  "error",
];

export interface CrawlSettings {
  maxPagesPerDomain: number;
  minDelayMs: number;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  /** A robots.txt Crawl-delay above this means the site is skipped (we never crawl faster than asked). */
  maxCrawlDelaySeconds: number;
  /** Stop a site after this long (keeps what was read). */
  siteTimeLimitMs: number;
}

export interface CrawlDeps {
  net: Pick<NetOptions, "resolve" | "allowAddresses">;
  platforms: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  /** Called between requests so a long crawl keeps its task alive. */
  onProgress?: () => Promise<void> | void;
  /** Job platform feed addresses (tests point them to a local server). */
  feedUrlFor?: FeedUrlFor;
  /** Asked before every request; true (job paused or cancelled) stops the crawl at once. */
  shouldStop?: () => Promise<boolean> | boolean;
}

/** Thrown by crawlSite when `shouldStop` said so: nothing is saved, the site is crawled again later. */
export class CrawlInterrupted extends Error {
  constructor() {
    super("The job was paused or cancelled while this website was being read");
    this.name = "CrawlInterrupted";
  }
}

/** One request made for the site (shown in the lead drawer). */
export interface PageRecord {
  url: string;
  kind: PageKind | "robots" | "sitemap" | "jobs";
  status: number | null;
  bytes: number;
  ms: number;
  note?: string;
}

/** A page that was read (input for e-mails and signals). */
export interface FetchedPage {
  url: string;
  kind: PageKind;
  html: string;
  text: string;
  headers: IncomingHttpHeaders;
}

export interface CrawlOutcome {
  status: CrawlStatus;
  finalUrl: string | null;
  httpStatus: number | null;
  /** The domain the site lives on after redirects (usually the lead's domain). */
  siteDomain: string;
  pages: PageRecord[];
  fetched: FetchedPage[];
  robots: { status: RobotsInfo["status"] | "not_read"; crawlDelaySeconds: number | null; note: string };
  /** The company's job platform, when its careers page links to one. */
  jobBoard: { provider: string; boardUrl: string; jobs: number; developerJobs: number; note?: string } | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
}

const BLOCK_STATUSES = new Set([401, 403, 429, 451]);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Paths tried when no link to the page was found (German sites: the German words first). */
type Lang = "en" | "de" | "nl" | "fr" | "pl";
const GUESSES: Record<Lang, Partial<Record<PageKind, string[]>>> = {
  en: { contact: ["/contact", "/contact-us"], careers: ["/careers", "/jobs"] },
  de: { contact: ["/kontakt", "/contact"], careers: ["/karriere", "/jobs"] },
  nl: { contact: ["/contact"], careers: ["/vacatures", "/werken-bij"] },
  fr: { contact: ["/contact", "/nous-contacter"], careers: ["/carrieres", "/recrutement"] },
  pl: { contact: ["/kontakt", "/contact"], careers: ["/kariera", "/praca"] },
};

/** The site's language from <html lang="…"> (only the languages we have guesses for). */
function siteLang(html: string): Lang {
  const m = /<html[^>]*\blang=["']?([a-z]{2})/i.exec(html.slice(0, 2000))?.[1]?.toLowerCase();
  return m === "de" || m === "nl" || m === "fr" || m === "pl" ? m : "en";
}

function looksLikeBotWall(r: FetchResult): boolean {
  if (BLOCK_STATUSES.has(r.status)) return true;
  // Cloudflare and similar "checking your browser" pages: we do not try to get past them.
  if (r.status === 503 && (r.headers["cf-mitigated"] !== undefined || /cloudflare/i.test(String(r.headers.server ?? "")))) return true;
  return r.headers["cf-mitigated"] === "challenge";
}

class StopCrawl extends Error {
  constructor(
    readonly status: CrawlStatus,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Crawls one website politely: robots.txt first, the home page, then up to
 * `maxPagesPerDomain - 1` pages chosen by kind (contact, careers, about…), found
 * through links, the sitemap, or a few common paths. One request at a time, with
 * at least `minDelayMs` (or the site's Crawl-delay) between requests.
 */
export async function crawlSite(
  input: { website: string; domain: string; segment: "A" | "B" },
  settings: CrawlSettings,
  deps: CrawlDeps,
): Promise<CrawlOutcome> {
  const startedAt = new Date();
  const sleep = deps.sleep ?? defaultSleep;
  const netOpts: NetOptions = {
    ...deps.net,
    timeoutMs: settings.timeoutMs,
    maxBytes: settings.maxBytes,
    maxRedirects: settings.maxRedirects,
  };
  const pages: PageRecord[] = [];
  const fetched: FetchedPage[] = [];
  const robotsByOrigin = new Map<string, RobotsInfo>();
  let robotsSummary: CrawlOutcome["robots"] = { status: "not_read", crawlDelaySeconds: null, note: "" };
  let delayMs = settings.minDelayMs;
  let lastRequestAt = 0;
  let siteDomain = input.domain;
  let finalUrl: string | null = null;
  let httpStatus: number | null = null;
  let jobBoard: CrawlOutcome["jobBoard"] = null;

  const deadline = startedAt.getTime() + settings.siteTimeLimitMs;

  let interrupted = false;
  async function polite(): Promise<void> {
    if (interrupted) throw new StopCrawl("partial", "Interrupted");
    if (deps.shouldStop && (await deps.shouldStop())) {
      interrupted = true;
      throw new StopCrawl("partial", "Interrupted");
    }
    const wait = lastRequestAt + delayMs - Date.now();
    if (lastRequestAt > 0 && wait > 0) await sleep(wait);
    await deps.onProgress?.();
    lastRequestAt = Date.now();
  }

  async function request(url: string, accept?: RegExp): Promise<FetchResult> {
    for (let attempt = 0; ; attempt++) {
      await polite();
      try {
        return await safeFetch(url, netOpts, accept ? { accept } : {});
      } catch (err) {
        // A temporary DNS failure (EAI_AGAIN, common with several lookups at once on Windows): try twice more.
        if ((err as FetchError).kind !== "dns_temp" || attempt >= 2) throw err;
        await sleep(3000 * (attempt + 1));
      } finally {
        lastRequestAt = Date.now();
      }
    }
  }

  async function robotsFor(origin: string): Promise<RobotsInfo> {
    const known = robotsByOrigin.get(origin);
    if (known) return known;
    const robotsUrl = `${origin}/robots.txt`;
    let res: FetchResult;
    try {
      res = await request(robotsUrl, /./);
      pages.push({ url: robotsUrl, kind: "robots", status: res.status, bytes: res.bytes, ms: res.ms });
    } catch (err) {
      const e = err as FetchError;
      pages.push({ url: robotsUrl, kind: "robots", status: null, bytes: 0, ms: 0, note: e.message });
      if (e.kind === "blocked_address") throw new StopCrawl("error", e.message);
      if (["dns", "dns_temp", "refused", "timeout", "tls", "network"].includes(e.kind)) throw new StopCrawl("unreachable", e.message);
      throw new StopCrawl("error", e.message);
    }
    if (res.status === 429) throw new StopCrawl("bot_blocked", "robots.txt answered HTTP 429 (too many requests)");
    const info = parseRobots(robotsUrl, res);
    robotsByOrigin.set(origin, info);
    robotsSummary = { status: info.status, crawlDelaySeconds: info.crawlDelaySeconds, note: info.note };
    if (info.status === "unavailable") throw new StopCrawl("robots_blocked", info.note);
    if (info.crawlDelaySeconds !== null) {
      if (info.crawlDelaySeconds > settings.maxCrawlDelaySeconds) {
        throw new StopCrawl(
          "robots_blocked",
          `robots.txt asks for ${info.crawlDelaySeconds} s between requests (more than ${settings.maxCrawlDelaySeconds} s); skipped`,
        );
      }
      delayMs = Math.max(settings.minDelayMs, info.crawlDelaySeconds * 1000);
    }
    return info;
  }

  /** Reads one page if robots.txt allows it. Returns null when not read. */
  async function getPage(url: string, kind: PageKind): Promise<FetchedPage | null> {
    if (Date.now() > deadline) throw new StopCrawl("partial", "Time limit for one site reached");
    const origin = new URL(url).origin;
    const robots = await robotsFor(origin);
    if (!robots.isAllowed(url)) {
      pages.push({ url, kind, status: null, bytes: 0, ms: 0, note: "Disallowed by robots.txt" });
      return null;
    }
    let res: FetchResult;
    try {
      res = await request(url);
    } catch (err) {
      const e = err as FetchError;
      pages.push({ url, kind, status: null, bytes: 0, ms: 0, note: e.message });
      if (kind === "home") {
        throw new StopCrawl(e.kind === "blocked_address" || e.kind === "bad_url" ? "error" : "unreachable", e.message);
      }
      return null;
    }
    const note = res.truncated ? `Cut at ${Math.round(settings.maxBytes / 1e6)} MB` : res.url !== url ? `Redirected to ${res.url}` : undefined;
    pages.push({ url, kind, status: res.status, bytes: res.bytes, ms: res.ms, ...(note ? { note } : {}) });
    if (looksLikeBotWall(res)) {
      throw new StopCrawl(
        kind === "home" ? "bot_blocked" : "partial",
        `The site blocks automated visits (HTTP ${res.status}); we stopped there`,
      );
    }
    if (kind === "home") {
      finalUrl = res.url;
      httpStatus = res.status;
      if (res.status >= 400) throw new StopCrawl("unreachable", `Home page answered HTTP ${res.status}`);
      const finalDomain = websiteDomain(res.url);
      if (finalDomain && isPlatformDomain(finalDomain, deps.platforms)) {
        throw new StopCrawl("platform", `The website forwards to ${finalDomain} (a platform, not their own site)`);
      }
      if (res.body === null) throw new StopCrawl("not_html", `Home page is not a web page (${res.contentType || "no type"})`);
      if (finalDomain && !sameSite(finalDomain, siteDomain)) siteDomain = finalDomain;
      // The home page may have moved to another host (www., a new domain): its robots.txt counts too.
      const finalOrigin = new URL(res.url).origin;
      if (finalOrigin !== origin) {
        const r2 = await robotsFor(finalOrigin);
        if (!r2.isAllowed(res.url)) throw new StopCrawl("robots_blocked", "robots.txt does not allow our crawler");
      }
    }
    if (res.status >= 400 || res.body === null) return null;
    if (!sameSite(new URL(res.url).hostname, siteDomain)) return null; // a link that left the site
    const $ = cheerio.load(res.body);
    const page: FetchedPage = { url: res.url, kind, html: res.body, text: pageText($), headers: res.headers };
    fetched.push(page);
    return page;
  }

  /** Reads the platform's public job feed once; a problem there never changes the site's result. */
  async function readJobBoard(board: JobBoard): Promise<CrawlOutcome["jobBoard"]> {
    const label = ATS_LABELS[board.provider];
    const base = { provider: label, boardUrl: board.boardUrl, jobs: 0, developerJobs: 0 };
    if (Date.now() > deadline) return { ...base, note: "Not read: time limit for the site reached" };
    let robots: RobotsInfo;
    // The platform's robots.txt must not replace the site's own robots result or pace.
    const siteRobots = robotsSummary;
    const siteDelay = delayMs;
    try {
      robots = await robotsFor(new URL(board.feedUrl).origin);
    } catch (err) {
      return { ...base, note: `Not read: ${(err as Error).message}` };
    } finally {
      robotsSummary = siteRobots;
      delayMs = Math.max(siteDelay, delayMs);
    }
    if (!robots.isAllowed(board.feedUrl)) {
      pages.push({ url: board.feedUrl, kind: "jobs", status: null, bytes: 0, ms: 0, note: "Disallowed by robots.txt" });
      return { ...base, note: "Not read: robots.txt" };
    }
    let res: FetchResult;
    try {
      res = await request(board.feedUrl, /json|xml|text/i);
    } catch (err) {
      pages.push({ url: board.feedUrl, kind: "jobs", status: null, bytes: 0, ms: 0, note: (err as Error).message });
      return { ...base, note: (err as Error).message };
    }
    if (res.status >= 400 || !res.body) {
      pages.push({ url: board.feedUrl, kind: "jobs", status: res.status, bytes: res.bytes, ms: res.ms, note: `${label} feed not available` });
      return { ...base, note: `${label} answered HTTP ${res.status}` };
    }
    const jobs = parseJobs(board, res.body);
    const dev = jobs.filter((j) => isDeveloperRole(j.title));
    const note = `${label}: ${jobs.length} open job(s), ${dev.length} for developers`;
    pages.push({ url: board.feedUrl, kind: "jobs", status: res.status, bytes: res.bytes, ms: res.ms, note });
    if (dev.length > 0) {
      // Read like a careers page by the signal rules (role, remote, visa, English team, local language).
      fetched.push({ url: dev[0]!.url, kind: "careers", html: "", text: jobsAsPageText(board.provider, dev), headers: {} });
    }
    return { ...base, jobs: jobs.length, developerJobs: dev.length };
  }

  let status: CrawlStatus = "ok";
  let error: string | null = null;
  try {
    let start = new URL(input.website);
    start = new URL("/", start.origin);
    let home: FetchedPage | null;
    try {
      const origin = start.origin;
      const robots = await robotsFor(origin);
      if (!robots.isAllowed(start.toString())) throw new StopCrawl("robots_blocked", "robots.txt does not allow our crawler");
      home = await getPage(start.toString(), "home");
    } catch (err) {
      // Broken HTTPS on a small business site is common: try plain http once (not a way around a block).
      if (err instanceof StopCrawl && err.status === "unreachable" && start.protocol === "https:" && /TLS/i.test(err.message)) {
        start = new URL(`http://${start.host}/`);
        const robots = await robotsFor(start.origin);
        if (!robots.isAllowed(start.toString())) throw new StopCrawl("robots_blocked", "robots.txt does not allow our crawler");
        home = await getPage(start.toString(), "home");
      } else {
        throw err;
      }
    }
    if (!home) throw new StopCrawl("robots_blocked", "robots.txt does not allow the home page");

    const wanted = KIND_ORDER[input.segment];
    const candidates = new Map<PageKind, string>();
    const addLinks = (p: FetchedPage) => {
      for (const l of findLinks(p.html, p.url, siteDomain)) if (!candidates.has(l.kind)) candidates.set(l.kind, l.url);
    };
    addLinks(home);

    // Key pages missing from the menu: look in the sitemap once.
    const key: PageKind[] = ["contact", "careers", "about"];
    if (key.some((k) => !candidates.has(k))) {
      const origin = new URL(home.url).origin;
      const robots = robotsByOrigin.get(origin);
      const sitemapUrls = robots?.sitemaps.length ? robots.sitemaps.slice(0, 1) : [`${origin}/sitemap.xml`];
      for (let i = 0, url = sitemapUrls[0]; url && i < 2; i++) {
        if (!sameSite(new URL(url).hostname, siteDomain) || !(robots?.isAllowed(url) ?? true)) break;
        let res: FetchResult;
        try {
          res = await request(url, /xml|text\/plain|^$/i);
        } catch (err) {
          pages.push({ url, kind: "sitemap", status: null, bytes: 0, ms: 0, note: (err as Error).message });
          break;
        }
        pages.push({ url, kind: "sitemap", status: res.status, bytes: res.bytes, ms: res.ms });
        if (looksLikeBotWall(res) || res.status >= 400 || !res.body) break;
        const { urls, isIndex } = sitemapLocs(res.body);
        if (isIndex) {
          url = urls.find((u) => /page/i.test(u)) ?? urls[0];
          continue;
        }
        const best = new Map<PageKind, URL>();
        for (const u of urls) {
          let parsed: URL;
          try {
            parsed = new URL(u);
          } catch {
            continue;
          }
          if (!sameSite(parsed.hostname, siteDomain)) continue;
          const kind = classifyUrl(parsed);
          if (!kind) continue;
          const prev = best.get(kind);
          if (!prev || parsed.pathname.length < prev.pathname.length) best.set(kind, parsed);
        }
        for (const [kind, u] of best) if (!candidates.has(kind)) candidates.set(kind, u.toString());
        break;
      }
    }

    const done = new Set<string>([home.url, start.toString()]);
    let budget = settings.maxPagesPerDomain - 1;
    for (const kind of wanted) {
      if (budget <= 0) break;
      let url = candidates.get(kind);
      if (url && done.has(url)) continue;
      const guesses = GUESSES[siteLang(home.html)][kind];
      if (!url && guesses) {
        // No link anywhere: try the usual paths, stop at the first that exists.
        for (const path of guesses) {
          if (budget <= 0) break;
          const guess = new URL(path, home.url).toString();
          if (done.has(guess)) continue;
          done.add(guess);
          budget--;
          const p = await getPage(guess, kind);
          if (p) {
            addLinks(p);
            break;
          }
        }
        continue;
      }
      if (!url) continue;
      done.add(url);
      budget--;
      const p = await getPage(url, kind);
      if (p) addLinks(p);
      url = undefined;
    }

    // Job platform: careers pages first, then every other page read.
    const ordered = [...fetched].sort((a, b) => Number(b.kind === "careers") - Number(a.kind === "careers"));
    const board = detectBoard(
      ordered.map((p) => p.html),
      deps.feedUrlFor ?? realFeedUrl,
    );
    if (board) jobBoard = await readJobBoard(board);
  } catch (err) {
    if (interrupted) throw new CrawlInterrupted();
    if (err instanceof StopCrawl) {
      status = err.status;
      error = err.message;
    } else {
      status = fetched.length > 0 ? "partial" : "error";
      error = err instanceof Error ? err.message : String(err);
    }
  }

  if (interrupted) throw new CrawlInterrupted();
  return {
    status,
    finalUrl,
    httpStatus,
    siteDomain,
    pages,
    fetched,
    robots: robotsSummary,
    jobBoard,
    error,
    startedAt,
    finishedAt: new Date(),
  };
}
