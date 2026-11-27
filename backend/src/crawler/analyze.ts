import { readFileSync } from "node:fs";
import { type ClassifiedEmail, classifyEmail, extractEmails, pickPrimary, type SeenEmail } from "./emails.js";
import { computeScores, type DetectedSignal, detectSignals, type Scores, signalLine } from "./signals.js";
import { shortCompany } from "../mail/compose.js";
import type { CrawlOutcome } from "./site.js";

export interface LeadInput {
  id: bigint;
  segment: "A" | "B";
  name: string;
  websiteDomain: string;
  city: string | null;
  categoryLabel: string;
  categoryValue: number;
  locationCount: number;
  overtureEmails: string[];
  genericOnly: boolean;
}

export interface EmailWithMx extends ClassifiedEmail {
  mxValid: boolean | null;
}

export interface Analysis {
  emails: EmailWithMx[];
  primary: EmailWithMx | null;
  signals: DetectedSignal[];
  scores: Scores;
  signalLine: string | null;
  /** Overture listed these, but they were not on the website (kept as Overture-only addresses; used only where the country allows). */
  overtureOnly: string[];
  tech: string[];
}

const MAX_EMAILS = 20;

let stackWordsCache: string[] | undefined;
/** Words of our stack from seed/offer.json (plus common role words for JS/Node/AI work). */
export function stackWords(): string[] {
  if (!stackWordsCache) {
    const offer = JSON.parse(readFileSync(new URL("../../seed/offer.json", import.meta.url), "utf8")) as {
      stack: Record<string, string[]>;
    };
    const words = new Set<string>(["full stack", "full-stack", "fullstack", "front end", "front-end", "frontend", "back end", "back-end", "backend", "machine learning", "ml ", "llm", "ai "]);
    for (const list of Object.values(offer.stack)) {
      for (const w of list) {
        const lw = w.toLowerCase();
        words.add(lw);
        if (lw.endsWith(".js")) words.add(lw.slice(0, -3));
      }
    }
    stackWordsCache = [...words];
  }
  return stackWordsCache;
}

/** E-mails from every page read, classified (first page where an address appears is its source). */
export function collectEmails(outcome: CrawlOutcome, leadDomain: string): ClassifiedEmail[] {
  const seen = new Map<string, SeenEmail>();
  for (const page of outcome.fetched) {
    for (const e of extractEmails(page.html, page.text, page.url)) {
      const prev = seen.get(e.email);
      // Prefer the contact page as proof, and a context with a name in it.
      if (!prev || (page.kind === "contact" && !prev.sourceUrl.includes("contact"))) seen.set(e.email, e);
    }
  }
  const classified = [...seen.values()].map((e) => {
    const c = classifyEmail(e, outcome.siteDomain);
    // An address on the lead's original domain is also "own" when the site moved to another domain.
    if (c.domainMatch !== "own" && leadDomain !== outcome.siteDomain) {
      const alt = classifyEmail(e, leadDomain);
      if (alt.domainMatch === "own") return alt;
    }
    return c;
  });
  return classified.slice(0, MAX_EMAILS);
}

/** Everything the crawl tells us about one lead (no database access; MX results come in). */
export function analyze(
  lead: LeadInput,
  outcome: CrawlOutcome,
  emails: EmailWithMx[],
  opts: { weights?: Record<string, number>; agentThreshold: number },
): Analysis {
  const readable = outcome.status === "ok" || outcome.status === "partial";
  const signals = readable
    ? detectSignals(outcome.fetched, {
        segment: lead.segment,
        locationCount: lead.locationCount,
        stackWords: stackWords(),
        ...(opts.weights ? { weights: opts.weights } : {}),
      })
    : [];
  const scores = computeScores(signals, {
    segment: lead.segment,
    categoryValue: lead.categoryValue,
    readable,
    agentThreshold: opts.agentThreshold,
  });
  const primary = pickPrimary(emails, lead.segment, lead.genericOnly) as EmailWithMx | null;
  const onSite = new Set(emails.map((e) => e.email));
  const overtureOnly = lead.overtureEmails.map((e) => e.trim().toLowerCase()).filter((e) => e && !onSite.has(e));
  const tech = signals.find((s) => s.key === "tech_stack")?.value?.split(", ") ?? [];
  return {
    emails,
    primary,
    signals,
    scores,
    signalLine: readable
      ? signalLine(signals, {
          id: lead.id,
          segment: lead.segment,
          company: shortCompany(lead.name, lead.city),
          city: lead.city,
          categoryLabel: lead.categoryLabel,
          bestOffer: scores.bestOffer,
        })
      : null,
    overtureOnly,
    tech,
  };
}
