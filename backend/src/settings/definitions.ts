import { STUDY_COUNTRIES } from "../study/directory.js";
import { z } from "zod";

/**
 * Every setting the app knows, grouped by key (one row in `settings` per key).
 * Each field has a default, so an empty or partial row still gives a full, valid value.
 * Values come from the prompt; the Settings page (later phase) edits them.
 */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM");

export const settingsSchemas = {
  company: z.object({
    name: z.string().min(1).default("Riyad Tech"),
    senderName: z.string().default(""),
    website: z.string().default("https://riyadtech.xyz"),
    /** Required by CAN-SPAM; campaigns refuse to launch while empty (Phase 5). */
    postalAddress: z.string().default(""),
  }),
  sending: z.object({
    globalDailyCap: z.number().int().min(0).max(1000).default(100),
    mailboxDailyCap: z.number().int().min(1).max(500).default(50),
    warmupStart: z.number().int().min(1).max(100).default(10),
    warmupStepPerDay: z.number().int().min(0).max(50).default(2),
    windowStart: time.default("09:00"),
    windowEnd: time.default("17:00"),
    weekdaysOnly: z.boolean().default(true),
    minGapMinutes: z.number().min(0).max(120).default(2),
    maxGapMinutes: z.number().min(0).max(240).default(6),
    followUp1Days: z.number().int().min(1).max(60).default(4),
    followUp2Days: z.number().int().min(1).max(60).default(7),
    recontactDays: z.number().int().min(0).max(3650).default(90),
    /** My own addresses: "send test to myself" may only go to these (plus the login and mailbox addresses). */
    testAddresses: z.array(z.email().transform((e) => e.toLowerCase())).max(10).default([]),
    /** Job applications sent per day at most (all mailboxes together). */
    applicationsPerDay: z.number().int().min(1).max(100).default(20),
  }),
  crawler: z.object({
    maxPagesPerDomain: z.number().int().min(1).max(30).default(8),
    concurrency: z.number().int().min(1).max(10).default(5),
    minDelayMs: z.number().int().min(1500).max(60_000).default(1500),
    timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
    maxBytes: z.number().int().min(100_000).max(10_000_000).default(5_000_000),
    maxRedirects: z.number().int().min(0).max(5).default(3),
    /** A robots.txt Crawl-delay above this skips the site (we never go faster than a site asks). */
    maxCrawlDelaySeconds: z.number().int().min(2).max(120).default(30),
    /** Stop one site after this long and keep what was read. */
    siteTimeLimitSeconds: z.number().int().min(30).max(900).default(180),
    /** "Only not crawled" also includes leads crawled longer ago than this. */
    recrawlDays: z.number().int().min(1).max(3650).default(90),
  }),
  scores: z.object({
    /** Signal weight overrides (signal key -> 0-100); empty = the weights in seed/signal-rules.json. */
    weights: z.record(z.string().regex(/^[a-z_]+$/), z.number().int().min(0).max(100)).default({}),
    /** Segment B: quote requests + manual paperwork + CRM weights at or above this = "agent" offer. */
    agentThreshold: z.number().int().min(1).max(100).default(20),
    /** "Ready now" leaves out crawled leads below this lead score (0 = none). Leads not crawled yet have no score and count. */
    readyMinLeadScore: z.number().int().min(0).max(100).default(0),
  }),
  finder: z.object({
    minConfidence: z.number().min(0).max(1).default(0.6),
    /** Row groups read per import task (about 20,000 places each in Overture files). */
    rowGroupsPerTask: z.number().int().min(1).max(32).default(4),
    /** Import tasks running at the same time in the worker. */
    concurrency: z.number().int().min(1).max(4).default(2),
    /**
     * Also download the area's border from Overture divisions (can be tens of MB for a country).
     * Off: the area is a box (city radius, or around the region's/country's GeoNames cities) and
     * the place's own address must name the country (and state). Either way the result is close.
     */
    useOutlines: z.boolean().default(false),
    /** Fixed Overture release ("2026-09-23.1"); empty = always the latest. */
    release: z.string().regex(/^(\d{4}-\d{2}-\d{2}\.\d+)?$/).default(""),
  }),
  study: z.object({
    /** Read university websites once a day while the worker runs. */
    autoCheck: z.boolean().default(true),
    /** New universities from the directory read per day. */
    newSitesPerDay: z.number().int().min(0).max(300).default(40),
    /** Admission pages read per university website at most. */
    maxPagesPerSite: z.number().int().min(1).max(20).default(8),
    /** Universities where nothing was found are tried again after this many days. */
    retryNothingDays: z.number().int().min(7).max(365).default(60),
    /** The university directory is refreshed from its sources after this many days. */
    directoryRefreshDays: z.number().int().min(7).max(365).default(30),
    /** Countries in the university directory and the daily check (ISO codes). */
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(250)
      .default([...STUDY_COUNTRIES]),
    /** Ask Groq (web search) for scholarships, a few countries a day; every proposal is checked on its official page. */
    aiSearch: z.boolean().default(true),
    /** Countries searched with AI per day (Groq's free limits are small). */
    aiCountriesPerDay: z.number().int().min(1).max(20).default(3),
    /** ROR client ID (free, not a secret): 2,000 instead of 50 requests per 5 minutes. */
    rorClientId: z.string().trim().max(100).default(""),
  }),
  /** Me as a job seeker: compared with each job advert (Job search → "Best match for me"). */
  jobProfile: z.object({
    skills: z
      .array(z.string().trim().min(1).max(40))
      .max(60)
      .default(["JavaScript", "TypeScript", "React", "Next.js", "Node.js", "Express", "Fastify", "Python", "HTML/CSS", "Tailwind", "REST APIs", "PostgreSQL", "MongoDB", "SQL", "Prisma", "Git", "Testing", "LLMs / AI", "Machine learning", "NLP"]),
    /** Years of professional experience (0.5 = six months). */
    yearsExperience: z.number().min(0).max(40).default(1),
    germanLevel: z.enum(["none", "a1", "a2", "b1", "b2", "c1", "c2"]).default("a1"),
  }),
  storage: z.object({
    limitMb: z.number().int().min(100).max(10_000).default(900),
  }),
} as const;

export type SettingsKey = keyof typeof settingsSchemas;
export type Settings = { [K in SettingsKey]: z.infer<(typeof settingsSchemas)[K]> };

export const SETTINGS_KEYS = Object.keys(settingsSchemas) as SettingsKey[];

export function defaultSettings(): Settings {
  const out = {} as Record<SettingsKey, unknown>;
  for (const key of SETTINGS_KEYS) out[key] = settingsSchemas[key].parse({});
  return out as Settings;
}
