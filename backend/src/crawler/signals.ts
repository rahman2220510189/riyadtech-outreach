import { readFileSync } from "node:fs";
import { z } from "zod";
import { isFirstName } from "./names.js";
import type { FetchedPage } from "./site.js";
import { renderSpintax } from "./spintax.js";

/* --------------------------------- rule file -------------------------------- */

const listItem = z.object({ name: z.string().min(1), pattern: z.string().min(1), js: z.boolean().default(false) });
const base = {
  key: z.string().regex(/^[a-z_]+$/),
  label: z.string().min(1),
  segment: z.enum(["A", "B", "*"]),
  score: z.enum(["need", "fit"]),
  weight: z.number().int().min(0).max(100),
  lines: z.array(z.string().min(1)).default([]),
};
const pagesField = z.array(z.string()).min(1);
const ruleSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("match"),
    pages: pagesField,
    source: z.enum(["text", "html"]).default("text"),
    patterns: z.array(z.string()).min(1),
    requireOnPage: z.array(z.string()).default([]),
    /** Outside careers pages, a requireOnPage phrase must be within this many characters of the match. */
    requireNear: z.number().int().min(50).max(5000).optional(),
    /** A match is ignored when the text just before it matches one of these (a staff bio: "career as a"). */
    skipBefore: z.array(z.string()).default([]),
    extract: z.literal("role").optional(),
    orLocationCountAtLeast: z.number().int().min(2).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("absent"),
    pages: pagesField,
    source: z.enum(["text", "html"]).default("text"),
    patterns: z.array(z.string()).min(1),
  }),
  z.object({ ...base, type: z.literal("page"), kinds: pagesField, patterns: z.array(z.string()).default([]) }),
  z.object({
    ...base,
    type: z.literal("list"),
    list: z.string(),
    flag: z.literal("js").optional(),
    patterns: z.array(z.string()).default([]),
  }),
  z.object({ ...base, type: z.literal("list_absent"), list: z.string() }),
  z.object({
    ...base,
    type: z.literal("ratio"),
    pages: pagesField,
    patterns: z.array(z.string()).min(1),
    against: z.array(z.string()).min(1),
    min: z.number().int().min(1),
    max: z.number().int().min(0),
  }),
  z.object({ ...base, type: z.literal("people"), pages: pagesField, min: z.number().int().min(1), max: z.number().int().min(1) }),
  z.object({ ...base, type: z.literal("derived") }),
]);
export type SignalRule = z.infer<typeof ruleSchema>;

const fileSchema = z.object({
  lists: z.record(z.string(), z.array(listItem)),
  rules: z.array(ruleSchema).min(1),
});

interface CompiledList {
  name: string;
  re: RegExp;
  js: boolean;
}
export interface SignalRules {
  rules: SignalRule[];
  lists: Record<string, CompiledList[]>;
  regex: Map<string, RegExp>;
}

let cachedRules: SignalRules | undefined;

/** Reads and checks seed/signal-rules.json once (every pattern must compile; lists must exist). */
export function loadSignalRules(): SignalRules {
  if (cachedRules) return cachedRules;
  const raw = fileSchema.parse(JSON.parse(readFileSync(new URL("../../seed/signal-rules.json", import.meta.url), "utf8")));
  const regex = new Map<string, RegExp>();
  const compile = (p: string, where: string) => {
    if (!regex.has(p)) {
      try {
        regex.set(p, new RegExp(p, "i"));
      } catch (err) {
        throw new Error(`seed/signal-rules.json: bad pattern in ${where}: ${(err as Error).message}`, { cause: err });
      }
    }
  };
  const lists: Record<string, CompiledList[]> = {};
  for (const [name, items] of Object.entries(raw.lists)) {
    lists[name] = items.map((i) => {
      compile(i.pattern, `lists.${name}.${i.name}`);
      return { name: i.name, re: regex.get(i.pattern)!, js: i.js };
    });
  }
  const keys = new Set<string>();
  for (const r of raw.rules) {
    if (keys.has(r.key)) throw new Error(`seed/signal-rules.json: duplicate key ${r.key}`);
    keys.add(r.key);
    if ("list" in r && !lists[r.list]) throw new Error(`seed/signal-rules.json: rule ${r.key} uses unknown list ${r.list}`);
    for (const field of ["patterns", "requireOnPage", "skipBefore", "against"] as const) {
      const v = (r as Record<string, unknown>)[field];
      if (Array.isArray(v)) for (const p of v as string[]) compile(p, `${r.key}.${field}`);
    }
  }
  cachedRules = { rules: raw.rules, lists, regex };
  return cachedRules;
}

/** True when a job title is a developer role (the same patterns as the hiring_dev rule). */
export function isDeveloperRole(title: string, rules = loadSignalRules()): boolean {
  const r = rules.rules.find((x) => x.key === "hiring_dev");
  if (!r || r.type !== "match") return false;
  return r.patterns.some((p) => rules.regex.get(p)!.test(title));
}

/* --------------------------------- detection -------------------------------- */

export interface DetectedSignal {
  key: string;
  label: string;
  score: "need" | "fit";
  weight: number;
  value: string | null;
  evidenceUrl: string | null;
  snippet: string | null;
}

export interface SignalContext {
  segment: "A" | "B";
  locationCount: number;
  /** Words of our stack (seed/offer.json), lower case. */
  stackWords: readonly string[];
  /** Weight overrides from Settings (key -> weight). */
  weights?: Record<string, number>;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function pagesOf(pages: FetchedPage[], kinds: readonly string[]): FetchedPage[] {
  return kinds.includes("any") ? pages : pages.filter((p) => kinds.includes(p.kind));
}

/** HTML plus response headers ("x-powered-by: Next.js"), for technology patterns. */
function codeOf(p: FetchedPage): string {
  const headers = Object.entries(p.headers)
    .filter(([k]) => ["x-powered-by", "server", "x-generator"].includes(k))
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("\n");
  return `${headers}\n${p.html}`;
}

function firstMatch(pages: FetchedPage[], patterns: RegExp[], source: "text" | "html") {
  for (const p of pages) {
    const hay = source === "text" ? p.text : codeOf(p);
    for (const re of patterns) {
      const m = re.exec(hay);
      if (m) return { page: p, match: m, hay };
    }
  }
  return null;
}

/**
 * Like firstMatch, but every occurrence is checked: one preceded by a skipBefore phrase (a staff
 * bio such as "started his career as a software engineer") is ignored, and outside careers pages a
 * gate phrase ("we're hiring", "join our team") must be within `near` characters of it.
 */
function guardedMatch(pages: FetchedPage[], patterns: RegExp[], source: "text" | "html", gates: RegExp[], near: number | undefined, skipBefore: RegExp[]) {
  for (const p of pages) {
    const hay = source === "text" ? p.text : codeOf(p);
    for (const pattern of patterns) {
      for (const m of hay.matchAll(new RegExp(pattern.source, "gi"))) {
        const before = hay.slice(Math.max(0, m.index - 60), m.index);
        if (skipBefore.some((b) => b.test(before))) continue;
        if (near && gates.length > 0 && p.kind !== "careers") {
          const around = hay.slice(Math.max(0, m.index - near), m.index + m[0].length + near);
          if (!gates.some((g) => g.test(around))) continue;
        }
        return { page: p, match: m, hay };
      }
    }
  }
  return null;
}

function countMatches(pages: FetchedPage[], patterns: RegExp[]): { count: number; sample: string | null; url: string | null } {
  let count = 0;
  let sample: string | null = null;
  let url: string | null = null;
  for (const p of pages) {
    for (const re of patterns) {
      const g = new RegExp(re.source, "gi");
      for (const m of p.text.matchAll(g)) {
        count++;
        if (!sample) {
          sample = snippetAround(p.text, m.index, m[0].length);
          url = p.url;
        }
      }
    }
  }
  return { count, sample, url };
}

/** Distinct "First Last" names (first name from the common-names list), a rough team size. */
function countPeople(pages: FetchedPage[]): { count: number; names: string[]; url: string | null } {
  const seen = new Set<string>();
  let url: string | null = null;
  for (const p of pages) {
    // Lookahead, so "Meet Sarah Jones" still finds "Sarah Jones".
    for (const m of p.text.matchAll(/\b([A-Z][a-z]{1,15})(?= ([A-Z][a-z'’-]{1,20})\b)/g)) {
      if (!isFirstName(m[1]!)) continue;
      const key = `${m[1]} ${m[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        url ??= p.url;
      }
    }
  }
  return { count: seen.size, names: [...seen].slice(0, 6), url };
}

/** Every signal of the lead's segment found on the pages, with evidence. */
export function detectSignals(pages: FetchedPage[], ctx: SignalContext, rules = loadSignalRules()): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  const re = (p: string) => rules.regex.get(p)!;
  const weightOf = (r: SignalRule) => ctx.weights?.[r.key] ?? r.weight;
  const home = pages.find((p) => p.kind === "home");
  const push = (r: SignalRule, value: string | null, evidenceUrl: string | null, snippet: string | null) =>
    out.push({ key: r.key, label: r.label, score: r.score, weight: weightOf(r), value, evidenceUrl, snippet: snippet?.slice(0, 300) ?? null });

  for (const r of rules.rules) {
    if (r.segment !== "*" && r.segment !== ctx.segment) continue;
    switch (r.type) {
      case "match": {
        let scope = pagesOf(pages, r.pages);
        const gates = r.requireOnPage.map(re);
        if (gates.length > 0) scope = scope.filter((p) => p.kind === "careers" || gates.some((g) => g.test(p.text)));
        const hit =
          r.requireNear || r.skipBefore.length > 0
            ? guardedMatch(scope, r.patterns.map(re), r.source, gates, r.requireNear, r.skipBefore.map(re))
            : firstMatch(scope, r.patterns.map(re), r.source);
        if (hit) {
          const value = r.extract === "role" ? (hit.match[1] ?? hit.match[0]).replace(/\s+/g, " ").trim() : null;
          push(r, value, hit.page.url, snippetAround(hit.hay, hit.match.index, hit.match[0].length));
        } else if (r.orLocationCountAtLeast && ctx.locationCount >= r.orLocationCountAtLeast) {
          push(r, String(ctx.locationCount), null, `Overture lists ${ctx.locationCount} places with this website`);
        }
        break;
      }
      case "absent": {
        const scope = pagesOf(pages, r.pages);
        if (scope.length === 0) break; // nothing read, nothing to decide
        if (!firstMatch(scope, r.patterns.map(re), r.source)) {
          push(r, null, scope[0]!.url, `None of the words were found on ${scope.length} page(s): ${scope.map((p) => p.kind).join(", ")}`);
        }
        break;
      }
      case "page": {
        const page = pages.find((p) => r.kinds.includes(p.kind));
        if (page) {
          push(r, null, page.url, `A ${page.kind} page exists`);
          break;
        }
        const hit = firstMatch(pages, r.patterns.map(re), "text");
        if (hit) push(r, null, hit.page.url, snippetAround(hit.hay, hit.match.index, hit.match[0].length));
        break;
      }
      case "list": {
        const items = (rules.lists[r.list] ?? []).filter((i) => !r.flag || i.js);
        const names: string[] = [];
        let evidenceUrl: string | null = null;
        let snippet: string | null = null;
        for (const item of items) {
          for (const p of pages) {
            const code = codeOf(p);
            const m = item.re.exec(code);
            if (m) {
              names.push(item.name);
              if (!evidenceUrl) {
                evidenceUrl = p.url;
                snippet = `${item.name}: ${m[0].slice(0, 80)}`;
              }
              break;
            }
          }
        }
        if (names.length > 0) {
          push(r, names.join(", "), evidenceUrl, snippet);
        } else if (r.patterns.length > 0) {
          const hit = firstMatch(pages, r.patterns.map(re), "text");
          if (hit) push(r, null, hit.page.url, snippetAround(hit.hay, hit.match.index, hit.match[0].length));
        }
        break;
      }
      case "list_absent": {
        if (!home) break;
        const items = rules.lists[r.list] ?? [];
        const found = items.some((i) => pages.some((p) => i.re.test(codeOf(p))));
        if (!found) push(r, null, home.url, `No known ${r.list === "chatWidgets" ? "chat widget" : r.list} in ${pages.length} page(s)`);
        break;
      }
      case "ratio": {
        const scope = pagesOf(pages, r.pages);
        if (scope.length === 0) break;
        const pro = countMatches(scope, r.patterns.map(re));
        const con = countMatches(scope, r.against.map(re));
        if (pro.count >= r.min && con.count <= r.max) {
          push(r, `${pro.count} design/marketing mentions, ${con.count} development`, pro.url, pro.sample);
        }
        break;
      }
      case "people": {
        const scope = pagesOf(pages, r.pages);
        if (scope.length === 0) break;
        const people = countPeople(scope);
        if (people.count >= r.min && people.count <= r.max) {
          push(r, String(people.count), people.url, `About ${people.count} people named, e.g. ${people.names.join(", ")}`);
        }
        break;
      }
      case "derived":
        break;
    }
  }

  // stack_match: the role they hire for is work we do (JS/TS, Node, React, Python, AI…), not WordPress/PHP.
  const hiring = out.find((s) => s.key === "hiring_dev");
  const stackRule = rules.rules.find((r) => r.key === "stack_match");
  if (hiring?.value && stackRule && (stackRule.segment === "*" || stackRule.segment === ctx.segment)) {
    const role = hiring.value.toLowerCase();
    const ours = ctx.stackWords.some((w) => role.includes(w));
    if (ours && !/wordpress|php|laravel/.test(role)) {
      push(stackRule, hiring.value, hiring.evidenceUrl, `"${hiring.value}" matches our stack`);
    }
  }
  return out;
}

/* ---------------------------------- scores ---------------------------------- */

export interface Scores {
  fit: number;
  need: number | null;
  lead: number | null;
  bestOffer: "chatbot" | "agent" | null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
export const AGENT_KEYS = ["quote_requests", "manual_ops", "crm_tools"] as const;

/**
 * fit = category value x 10 (10-50) + fit signals; need = need signals (both 0-100).
 * lead = fit x need / 100 (lists sort by it). Not crawled or unreadable: only fit.
 * Segment B: "agent" when quote requests, manual paperwork or CRM tools add up to the
 * agent threshold, otherwise "chatbot".
 */
export function computeScores(
  signals: DetectedSignal[],
  input: { segment: "A" | "B"; categoryValue: number; readable: boolean; agentThreshold: number },
): Scores {
  const fit = clamp(input.categoryValue * 10 + signals.filter((s) => s.score === "fit").reduce((a, s) => a + s.weight, 0));
  if (!input.readable) return { fit, need: null, lead: null, bestOffer: null };
  const need = clamp(signals.filter((s) => s.score === "need").reduce((a, s) => a + s.weight, 0));
  let bestOffer: Scores["bestOffer"] = null;
  if (input.segment === "B") {
    const agent = signals.filter((s) => (AGENT_KEYS as readonly string[]).includes(s.key)).reduce((a, s) => a + s.weight, 0);
    bestOffer = agent >= input.agentThreshold ? "agent" : "chatbot";
  }
  return { fit, need, lead: clamp((fit * need) / 100), bestOffer };
}

/* ------------------------------- signal line -------------------------------- */

const COMPANY_SUFFIX = /[\s,]+(ltd\.?|limited|llc|l\.l\.c\.|inc\.?|incorporated|plc|pty\.? ltd\.?|pty|llp|lp|co\.|corp\.?|gmbh|bv|sl)$/i;

/** "Smile Dental Ltd" -> "Smile Dental" (for e-mail sentences). */
export function cleanCompany(name: string): string {
  let n = name.trim();
  for (let i = 0; i < 2; i++) n = n.replace(COMPANY_SUFFIX, "").trim();
  return n || name.trim();
}

const FALLBACK: Record<"A" | "B", string[]> = {
  A: ["{I came across|I found} {company} while looking at agencies in {city}.", "{I came across|I found} {company}'s website{ recently|}."],
  B: ["{I came across|I found} {company} while looking at {category} websites in {city}.", "{I came across|I found} {company}'s website{ recently|}."],
};

function article(role: string): string {
  return /^[aeiou]/i.test(role) || /^(ai|ml|llm)\b/i.test(role) ? `an ${role}` : `a ${role}`;
}

/**
 * The best sentence for {signal_line}: from the strongest signal that has lines and fits
 * the lead's offer (agent signals only for "agent" leads, never for "chatbot" leads), else a
 * neutral fallback. Fixed per lead: the seed is the place id.
 */
export function signalLine(
  signals: DetectedSignal[],
  lead: { id: bigint | number | string; segment: "A" | "B"; company: string; city: string | null; categoryLabel: string; bestOffer: Scores["bestOffer"] },
  rules = loadSignalRules(),
): string {
  const byKey = new Map(rules.rules.map((r) => [r.key, r]));
  const agentKeys = AGENT_KEYS as readonly string[];
  const candidates = signals
    .filter((s) => (byKey.get(s.key)?.lines.length ?? 0) > 0)
    .filter((s) => (lead.bestOffer === "agent" ? agentKeys.includes(s.key) : lead.bestOffer === "chatbot" ? !agentKeys.includes(s.key) : true))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  const vars = (s?: DetectedSignal): Record<string, string | null> => ({
    company: cleanCompany(lead.company),
    city: lead.city,
    category: lead.categoryLabel.toLowerCase(),
    role: s?.key === "hiring_dev" ? (s.value ?? null) : null,
    a_role: s?.key === "hiring_dev" && s.value ? article(s.value) : null,
    tech: s?.value ?? null,
  });
  const seed = String(lead.id);
  for (const s of candidates) {
    for (const line of byKey.get(s.key)!.lines) {
      const text = renderSpintax(line, vars(s), `${seed}:${s.key}`);
      if (text) return text;
    }
  }
  for (const line of FALLBACK[lead.segment]) {
    const text = renderSpintax(line, vars(), `${seed}:fallback`);
    if (text) return text;
  }
  return `I came across ${cleanCompany(lead.company)}'s website.`;
}
