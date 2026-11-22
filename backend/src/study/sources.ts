import { answerSnippet, ApiStatusError } from "../jobads/sources.js";
import { type NetOptions, safeFetch } from "../crawler/net.js";
import {
  type DirectoryEntry,
  type DirectorySource,
  STUDY_COUNTRIES,
  parseHipo,
  parseRorPage,
  parseWikidata,
  rorUrl,
  wikidataUrl,
} from "./directory.js";

export interface DirectoryDeps {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  hipoUrl: string;
  rorBase: string;
  wikidataBase: string;
  /** Optional ROR client ID (not a secret): 2,000 instead of 50 requests per 5 minutes. */
  rorClientId?: string;
  /** Called between requests (keeps the task alive, stops when paused). */
  progress?(message: string): Promise<void>;
  countries?: readonly string[];
  /** Every chosen country (entries of other countries are dropped); defaults to `countries`. */
  allCountries?: readonly string[];
  /**
   * Called after each country with that country's entries. When set, entries are handed over
   * here (saved at once) instead of being collected, so a stopped task loses at most one country.
   */
  countryDone?(country: string, entries: DirectoryEntry[]): Promise<void>;
}

export const DIRECTORY_DEFAULTS = {
  hipoUrl: "https://raw.githubusercontent.com/Hipo/university-domains-list/master/world_universities_and_domains.json",
  rorBase: "https://api.ror.org",
  wikidataBase: "https://query.wikidata.org/sparql",
};

/** GET through the crawler's safe client; accepts JSON served as text (GitHub raw files). */
export function directoryGetJson(net: Partial<NetOptions> = {}): DirectoryDeps["getJson"] {
  return async (url, headers = {}) => {
    const host = new URL(url).host;
    const res = await safeFetch(
      url,
      { timeoutMs: 90_000, maxBytes: 25_000_000, maxRedirects: 3, ...net },
      { accept: /json|text/i, headers: { accept: "application/json, application/sparql-results+json;q=0.9", "accept-encoding": "gzip, deflate", ...headers } },
    );
    if (res.status === 429) throw new ApiStatusError(429, `${host} asks us to slow down (HTTP 429); the next run tries again`);
    if (res.status >= 400) throw new ApiStatusError(res.status, `${host} answered HTTP ${res.status}${answerSnippet(res.body)}`);
    if (!res.body) throw new Error(`${host} sent no readable answer (${res.contentType || "no type"})`);
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new Error(`${host} did not answer with JSON${answerSnippet(res.body)}`);
    }
  };
}

/** Reads one source completely. Errors for single countries are collected, not thrown. */
export async function fetchDirectory(source: DirectorySource, deps: DirectoryDeps): Promise<{ entries: DirectoryEntry[]; problems: string[] }> {
  const countries = deps.countries ?? STUDY_COUNTRIES;
  const problems: string[] = [];
  if (source === "hipo") {
    return { entries: parseHipo(await deps.getJson(deps.hipoUrl), new Set(countries)), problems };
  }
  const entries: DirectoryEntry[] = [];
  if (source === "ror") {
    // Without a client ID ROR allows 50 requests per 5 minutes: one every 6.5 s.
    const gap = deps.rorClientId ? 400 : 6_500;
    const headers = deps.rorClientId ? { "Client-Id": deps.rorClientId } : undefined;
    let first = true;
    let failedInRow = 0;
    const allowed = new Set(deps.allCountries ?? countries);
    for (const c of countries) {
      // The source is down or unreachable: stop instead of trying every country.
      if (failedInRow >= 3) {
        problems.push("ROR: 3 countries in a row failed; stopped (the next refresh tries again)");
        break;
      }
      try {
        const mine: DirectoryEntry[] = [];
        for (let page = 1; page <= 50; page++) {
          if (!first) await deps.sleep(gap);
          first = false;
          await deps.progress?.(`ROR ${c} page ${page}`);
          const r = parseRorPage(await deps.getJson(rorUrl(deps.rorBase, c, page), headers), allowed);
          mine.push(...r.entries);
          if (r.count === 0 || page * 20 >= r.total) break;
        }
        if (deps.countryDone) await deps.countryDone(c, mine);
        else entries.push(...mine);
        failedInRow = 0;
      } catch (err) {
        failedInRow++;
        if (err instanceof ApiStatusError && err.status === 429) {
          problems.push(`ROR: ${err.message}`);
          break;
        }
        problems.push(`ROR ${c}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { entries, problems };
  }
  // Wikidata: one query per country, a pause between them.
  let first = true;
  let failedInRow = 0;
  for (const c of countries) {
    if (failedInRow >= 3) {
      problems.push("Wikidata: 3 countries in a row failed; stopped (the next refresh tries again)");
      break;
    }
    if (!first) await deps.sleep(2_000);
    first = false;
    await deps.progress?.(`Wikidata ${c}`);
    try {
      const mine = parseWikidata(await deps.getJson(wikidataUrl(deps.wikidataBase, c)), c);
      if (deps.countryDone) await deps.countryDone(c, mine);
      else entries.push(...mine);
      failedInRow = 0;
    } catch (err) {
      failedInRow++;
      if (err instanceof ApiStatusError && err.status === 429) {
        problems.push(`Wikidata: ${err.message}`);
        break;
      }
      problems.push(`Wikidata ${c}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { entries, problems };
}
