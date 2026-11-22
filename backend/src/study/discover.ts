import { chat } from "./ai.js";
import type { Extracted } from "./extract.js";
import { type ReaderDeps, type ReaderSettings, readPages } from "./reader.js";

/**
 * Scholarship search with Groq's built-in browser search (gpt-oss models). The AI only proposes:
 * every proposal must name an official page, the tool opens that page itself (robots.txt, honest
 * User-Agent) and keeps the proposal only if the page is readable and names the scholarship.
 */

export interface AiCandidate {
  name: string;
  url: string;
  /** YYYY-MM-DD or null when the AI did not know. */
  deadline: string | null;
  /** What the AI said about English proof: test, moi, none or unknown. */
  english: "test" | "moi" | "none" | "unknown";
  funding: string;
}

export interface CheckedCandidate extends AiCandidate {
  ok: boolean;
  reason: string;
  facts: Extracted | null;
  /** The AI's deadline was found on the page itself. */
  deadlineOnPage: boolean;
  /** An "Apply now" link found on the page. */
  applyLink?: string;
}

/** The model for the search: browser search needs a gpt-oss model. */
export function searchModel(configured: string | undefined): string {
  return configured && /^openai\/gpt-oss/.test(configured) ? configured : "openai/gpt-oss-120b";
}

export function searchPrompt(countryName: string, subject: string, level: string): string {
  return `Search the web for scholarships for the ${new Date().getUTCFullYear() + 1} intake that a citizen of Bangladesh can apply for, to study a ${level} in ${subject} (or a closely related field) in ${countryName}.
Include government scholarships, university scholarships for international students and tuition waivers. Leave out scholarships that exclude Bangladesh, loans, contests, and agent or blog pages.
For every scholarship give the URL of its OWN official page (the page about that scholarship on a government, scholarship-agency or university website) that you actually opened in this search. Never give a home page, a blog, a news site or an aggregator, and never guess a URL. Leave a scholarship out if you did not open its page.
Copy deadlines only from the page you opened; if the page shows no date for the next round, write "unknown".
Answer with one line per scholarship and nothing else, at most 8 lines, exactly in this form:
NAME | OFFICIAL_URL | DEADLINE | ENGLISH | FUNDING
- DEADLINE: the next application deadline as YYYY-MM-DD, or "unknown".
- ENGLISH: "test" if an English test (IELTS/TOEFL) is required, "moi" if an English-medium degree certificate is accepted, "none" if no English proof is needed, otherwise "unknown".
- FUNDING: what it pays, in under 15 words.
If you find nothing reliable, answer exactly: NONE`;
}

const URL_RE = /https?:\/\/[^\s|)\]>"'`]+/;

/** A site's home page (or its language home, "/en/") is not a scholarship's own page. */
export function isHomePage(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase().replace(/\/(index\.\w+)?$/, "");
    const parts = path.split("/").filter(Boolean);
    return parts.length === 0 || (parts.length === 1 && /^(en|eng|english|en-us|en-gb|main|home|intro)$/.test(parts[0]!));
  } catch {
    return true;
  }
}

/** Lines "NAME | URL | DEADLINE | ENGLISH | FUNDING" → candidates (citation marks and markdown removed). */
export function parseCandidates(text: string): AiCandidate[] {
  const out: AiCandidate[] = [];
  const seen = new Set<string>();
  const clean = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/【[^】]*】/g, "")
    .replace(/\*\*/g, "");
  for (const raw of clean.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2) continue;
    const urlMatch = URL_RE.exec(parts[1] ?? "") ?? URL_RE.exec(line);
    if (!urlMatch) continue;
    // Models sometimes write look-alike dashes and spaces inside URLs.
    const url = urlMatch[0].replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u00a0\u200b]/g, "").replace(/[.,;]+$/, "");
    const name = (parts[0] ?? "").replace(/^\[|\]$/g, "").trim();
    if (name.length < 4 || /^name$/i.test(name)) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    // Social media, blogs and aggregators are never the official page.
    if (/(facebook|linkedin|twitter|x\.com|youtube|instagram|medium|blogspot|wordpress|scholarshipsads|opportunitiescorner|scholarshipsfuture|scholarshiproar|mastersportal|leverageedu|studyportals)\./i.test(host)) continue;
    const key = url.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const d = (parts[2] ?? "").match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    const e = (parts[3] ?? "").toLowerCase();
    out.push({
      name: name.slice(0, 160),
      url,
      deadline: d ? d[0] : null,
      english: e.includes("moi") ? "moi" : e.includes("test") ? "test" : e.includes("none") ? "none" : "unknown",
      funding: (parts[4] ?? "").slice(0, 200),
    });
    if (out.length >= 8) break;
  }
  return out;
}

/** Words of a scholarship name worth looking for on its page. */
function nameWords(name: string): string[] {
  const stop = new Set(["scholarship", "scholarships", "programme", "program", "the", "and", "for", "of", "in", "university", "international", "students", "student", "award", "awards", "fund", "grant"]);
  return name
    .toLowerCase()
    .replace(/[()–—-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length >= 3 && !stop.has(w));
}

/** The page must be readable and talk about a scholarship with (most of) this name. */
export function pageMatches(name: string, text: string): { ok: boolean; reason: string } {
  const lower = text.toLowerCase();
  if (!/scholarship|fellowship|stipend|tuition (fee )?waiver|grant|funding|award/i.test(text)) return { ok: false, reason: "The page does not mention a scholarship" };
  const words = nameWords(name);
  if (words.length === 0) return { ok: true, reason: "The page mentions a scholarship" };
  const found = words.filter((w) => lower.includes(w)).length;
  return found / words.length >= 0.5 ? { ok: true, reason: `The page names it (${found}/${words.length} words)` } : { ok: false, reason: `The page does not name “${name}”` };
}

/** Asks Groq (with web search) for one country. */
export async function searchScholarships(
  env: { GROQ_API_KEY?: string | undefined; GROQ_MODEL?: string | undefined },
  countryName: string,
  subject: string,
  level: string,
): Promise<{ candidates: AiCandidate[]; raw: string }> {
  const raw = await chat(
    { GROQ_API_KEY: env.GROQ_API_KEY, GROQ_MODEL: searchModel(env.GROQ_MODEL) },
    [
      { role: "system", content: "You are a careful research assistant. Use web search. Report only what you found on real pages; never invent names, links or dates." },
      { role: "user", content: searchPrompt(countryName, subject, level) },
    ],
    { browserSearch: true, timeoutMs: 180_000, maxTokens: 4000 },
  );
  return { candidates: /^\s*NONE\s*$/i.test(raw) ? [] : parseCandidates(raw), raw };
}

/** Opens each proposed official page and keeps only those that name the scholarship. */
export async function checkCandidates(list: AiCandidate[], settings: ReaderSettings, deps: ReaderDeps = {}): Promise<CheckedCandidate[]> {
  const out: CheckedCandidate[] = [];
  for (const c of list) {
    const [p] = await readPages([c.url], { ...settings, maxPages: 1 }, deps);
    if (!p || p.status !== "ok" || !p.text) {
      out.push({ ...c, ok: false, reason: p?.error ?? `The page could not be read (${p?.status ?? "no answer"})`, facts: null, deadlineOnPage: false });
      continue;
    }
    if (isHomePage(c.url)) {
      out.push({ ...c, ok: false, reason: "A home page, not the scholarship's own page", facts: p.facts, deadlineOnPage: false });
      continue;
    }
    const m = pageMatches(c.name, p.text);
    out.push({
      ...c,
      ok: m.ok,
      reason: m.reason,
      facts: p.facts,
      deadlineOnPage: !!c.deadline && p.facts.deadlines.some((d) => d.date === c.deadline),
      ...(p.applyLinks?.[0] ? { applyLink: p.applyLinks[0] } : {}),
    });
  }
  return out;
}
