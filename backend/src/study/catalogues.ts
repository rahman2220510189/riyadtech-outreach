import * as cheerio from "cheerio";
import { type ReaderDeps, type ReaderSettings, Reader } from "./reader.js";

/**
 * Official programme catalogues — the lists agencies work from, read at the source.
 * Erasmus Mundus: the EACEA catalogue of all Erasmus Mundus Joint Masters (each a fully funded
 * scholarship), 20 per page, every title linking to the programme's own website.
 */

export const ERASMUS_CATALOGUE = "https://www.eacea.ec.europa.eu/scholarships/erasmus-mundus-catalogue_en";

export interface CatalogueEntry {
  name: string;
  website: string;
}

/** Links that are site furniture, not a programme. */
const NOT_PROGRAMME = /europa\.eu|erasmus-plus|eacea|facebook|twitter|x\.com|linkedin|instagram|youtube|cookie|privacy|legal|contact|rss|mailto:|javascript:/i;

/** Programme titles linking to their own websites on one catalogue page. */
export function parseErasmusPage(html: string, pageUrl: string): CatalogueEntry[] {
  const $ = cheerio.load(html);
  $("header, footer, nav").remove();
  const out = new Map<string, CatalogueEntry>();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    const name = $(el).text().replace(/\s+/g, " ").trim();
    if (name.length < 12 || name.length > 250 || NOT_PROGRAMME.test(href) || NOT_PROGRAMME.test(name)) return;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    // The catalogue's own pages (pagination, filters) are not programmes.
    if (url.hostname === new URL(pageUrl).hostname) return;
    url.hash = "";
    const key = url.toString().toLowerCase().replace(/\/$/, "");
    if (!out.has(key)) out.set(key, { name, website: url.toString() });
  });
  return [...out.values()];
}

/** Subjects close to Computer Science / AI (used when my target subjects are not set). */
export const CS_WORDS = /comput|informat|software|data|artificial intelligence|\bai\b|machine learning|cyber|robot|digital|quantum|intelligent|network|security|smart|information|algorithm|language technolog|imaging|automation|photonics|mathemat/i;

/** Does a programme name match my subjects? Words of my target fields, or the CS list. */
export function matchesSubjects(name: string, fields: string[]): boolean {
  const words = fields
    .flatMap((f) => f.toLowerCase().split(/[^a-z]+/))
    .filter((w) => w.length >= 4 && !["science", "engineering", "studies", "master", "management"].includes(w));
  if (words.some((w) => name.toLowerCase().includes(w.slice(0, Math.max(5, w.length - 2))))) return true;
  return CS_WORDS.test(name);
}

/** Reads every catalogue page (until a page brings nothing new, at most 25). */
export async function readErasmusCatalogue(settings: ReaderSettings, deps: ReaderDeps = {}, base = ERASMUS_CATALOGUE): Promise<{ entries: CatalogueEntry[]; pages: number; problem?: string }> {
  const reader = new Reader({ ...settings, maxPages: 1 }, deps);
  const robots = await reader.loadRobots(new URL(base).origin);
  if (!robots.ok) return { entries: [], pages: 0, problem: robots.note };
  const all = new Map<string, CatalogueEntry>();
  let pages = 0;
  for (let page = 0; page < 25; page++) {
    const url = `${base}${base.includes("?") ? "&" : "?"}page=${page}`;
    const p = await reader.readPage(url);
    pages++;
    if (!p.html || p.status === "not_found") {
      if (page === 0) return { entries: [], pages, problem: p.error ?? `The catalogue could not be read (${p.status})` };
      break;
    }
    const before = all.size;
    for (const e of parseErasmusPage(p.html, p.finalUrl)) {
      const key = e.website.toLowerCase().replace(/\/$/, "");
      if (!all.has(key)) all.set(key, e);
    }
    if (all.size === before) break;
  }
  return { entries: [...all.values()], pages };
}

/* ------------------------- Hungary: Tempus Public Foundation Study Finder ------------------------- */

export const HU_STUDY_FINDER = "https://tempus.tpf.hu/studyfinder/index/show/";

export interface StudyFinderEntry {
  id: number;
  name: string;
  university: string | null;
  level: string | null;
  language: string | null;
  requirements: string | null;
  englishTests: string | null;
  minIelts: number | null;
  website: string | null;
  url: string;
}

/** The value after a label ("Language of instruction: English") in the page text. */
function field(text: string, label: RegExp): string | null {
  const m = new RegExp(`(?:${label.source})\\s*:?\\s*([^\\n]{2,400})`, "i").exec(text);
  return m ? m[1]!.trim() : null;
}

/** One Study Finder page → its programme, or null when the page holds none. */
export function parseStudyFinder(html: string, text: string, id: number, url: string): StudyFinderEntry | null {
  const name = field(text, /course\s*\/\s*programme name/);
  if (!name) return null;
  const university = field(text, /name of (?:the )?(?:higher education )?institution|institution|university/);
  const level = field(text, /level of (?:the )?programme|level|type of programme/);
  const language = field(text, /language of instruction/);
  const requirements = field(text, /entry requirements?|admission requirements?/);
  const tests = field(text, /accepted (?:language )?(?:certificates|tests|exams?)|language (?:certificates|exams?) accepted/);
  const allEnglish = `${tests ?? ""} ${requirements ?? ""}`;
  const ielts = /IELTS[^0-9]{0,15}([4-8](?:[.,]\d)?)/i.exec(allEnglish);
  // The programme's own site: the "Contact website" link (else the first link that is not Study in Hungary or social media).
  const $ = cheerio.load(html);
  let website: string | null = null;
  $("a[href]").each((_, el) => {
    if (website) return;
    const href = ($(el).attr("href") ?? "").trim();
    // The label sits next to the link: in the same row or item, or just before it.
    const holder = $(el).closest("tr, li, dd, p, div");
    const label = `${holder.text()} ${holder.prev().text()} ${$(el).parent().prev().text()}`.toLowerCase();
    if (/^https?:\/\//.test(href) && !/studyinhungary|tempus|tpf\.hu|facebook|instagram|linkedin|youtube|twitter/i.test(href) && /website|web page|homepage|contact/.test(label)) website = href;
  });
  return {
    id,
    name: name.slice(0, 160),
    university: university?.slice(0, 160) ?? null,
    level,
    language,
    requirements: requirements?.slice(0, 1000) ?? null,
    englishTests: tests?.slice(0, 300) ?? null,
    minIelts: ielts ? Number(ielts[1]!.replace(",", ".")) : null,
    website,
    url,
  };
}

/**
 * Goes through the Study Finder pages by number, politely (robots.txt, the crawl delay), and keeps
 * English-taught programmes. Stops after `maxMisses` empty numbers in a row once programmes were found.
 */
export async function readStudyFinder(
  settings: ReaderSettings,
  deps: ReaderDeps = {},
  opts: { base?: string; from?: number; to?: number; maxMisses?: number; onProgress?: (id: number) => Promise<void> } = {},
): Promise<{ entries: StudyFinderEntry[]; read: number; problem?: string }> {
  const base = opts.base ?? HU_STUDY_FINDER;
  const reader = new Reader({ ...settings, maxPages: 1 }, deps);
  const robots = await reader.loadRobots(new URL(base).origin);
  if (!robots.ok) return { entries: [], read: 0, problem: robots.note };
  const entries: StudyFinderEntry[] = [];
  let misses = 0;
  let read = 0;
  for (let id = opts.from ?? 1; id <= (opts.to ?? 3000); id++) {
    await opts.onProgress?.(id);
    const url = `${base}${id}`;
    const p = await reader.readPage(url);
    read++;
    const e = p.html ? parseStudyFinder(p.html, p.text ?? "", id, url) : null;
    if (e) {
      misses = 0;
      if (/english/i.test(e.language ?? "")) entries.push(e);
    } else if (++misses >= (opts.maxMisses ?? 80) && (entries.length > 0 || id > 200)) break;
    if (p.status === "blocked") return { entries, read, problem: p.error ?? "The site refused our reader" };
  }
  return { entries, read };
}
