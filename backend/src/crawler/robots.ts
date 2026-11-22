import { createRequire } from "node:module";
import { BOT_TOKEN, type FetchResult } from "./net.js";

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}
// robots-parser is a CommonJS module whose type file declares an ES default export; load it the CommonJS way.
const robotsParser = createRequire(import.meta.url)("robots-parser") as (url: string, contents: string) => Robot;

export interface RobotsInfo {
  /** ok = robots.txt read; none = no robots.txt (4xx): everything allowed; unavailable = 5xx or no answer: nothing allowed (RFC 9309). */
  status: "ok" | "none" | "unavailable";
  httpStatus: number | null;
  crawlDelaySeconds: number | null;
  sitemaps: string[];
  isAllowed(url: string): boolean;
  note: string;
}

/**
 * Reads the answer to GET /robots.txt. `fetched` is null when the request itself failed.
 * RFC 9309: 4xx means "no rules"; 5xx or unreachable means "assume everything is disallowed".
 */
export function parseRobots(robotsUrl: string, fetched: FetchResult | null): RobotsInfo {
  if (!fetched || fetched.status >= 500) {
    return {
      status: "unavailable",
      httpStatus: fetched?.status ?? null,
      crawlDelaySeconds: null,
      sitemaps: [],
      isAllowed: () => false,
      note: fetched ? `robots.txt answered HTTP ${fetched.status}; treated as "do not crawl"` : "robots.txt could not be read; treated as \"do not crawl\"",
    };
  }
  if (fetched.status >= 400 || fetched.body === null) {
    return {
      status: "none",
      httpStatus: fetched.status,
      crawlDelaySeconds: null,
      sitemaps: [],
      isAllowed: () => true,
      note: fetched.status >= 400 ? `No robots.txt (HTTP ${fetched.status})` : "robots.txt is not text; no rules",
    };
  }
  // A robots.txt that is really an HTML page (some hosts answer 200 with their 404 page) has no rules.
  const text = /<html|<!doctype/i.test(fetched.body.slice(0, 500)) ? "" : fetched.body;
  const robots = robotsParser(robotsUrl, text);
  const delay = robots.getCrawlDelay(BOT_TOKEN);
  return {
    status: "ok",
    httpStatus: fetched.status,
    crawlDelaySeconds: typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : null,
    sitemaps: robots.getSitemaps().slice(0, 3),
    isAllowed: (url) => robots.isAllowed(url, BOT_TOKEN) !== false,
    note: "robots.txt read",
  };
}
