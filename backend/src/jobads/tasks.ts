import { z } from "zod";
import type { Db } from "../db/client.js";
import type { JobStore, Summarizer } from "../jobs/store.js";
import { type JsonObject, RequeueTask, type TaskHandler } from "../jobs/types.js";
import { websiteDomain } from "../finder/domain.js";
import { companyKey } from "./detect.js";
import { fetchArbeitnow, fetchBa, type JobSource, type NormalizedAd, netGetJson, SOURCE_LABELS, SOURCES, type SourceDeps } from "./sources.js";

export const JOBADS_JOB = "jobads";

export const DEFAULT_KEYWORDS = [
  "Softwareentwickler",
  "Webentwickler",
  "Frontend Developer",
  "Full Stack Developer",
  "JavaScript",
  "TypeScript",
  "React",
  "Node.js",
];

export const jobAdsParamsSchema = z
  .object({
    sources: z.array(z.enum(SOURCES)).min(1).default([...SOURCES]),
    /** BA: search words (one search each). */
    keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(15).default(DEFAULT_KEYWORDS),
    /** BA: town or postcode; empty = all of Germany. */
    where: z.string().trim().max(80).optional(),
    radiusKm: z.number().int().min(0).max(200).default(50),
    /** BA: adverts published in the last N days. */
    days: z.number().int().min(1).max(100).default(30),
    /** Pages per BA search word (100 adverts each) and per Arbeitnow list. */
    maxPages: z.number().int().min(1).max(20).default(3),
    /** BA: read the full text of at most N new developer adverts. */
    details: z.number().int().min(0).max(300).default(100),
  })
  .strict();
export type JobAdsParams = z.infer<typeof jobAdsParamsSchema>;

export function jobAdsLabel(p: JobAdsParams): string {
  const parts = p.sources.map((s) => SOURCE_LABELS[s]);
  const ba = p.sources.includes("ba") ? `, ${p.where ? `${p.where} +${p.radiusKm} km` : "all of Germany"}, last ${p.days} days` : "";
  return `Job adverts: ${parts.join(" + ")}${ba}`;
}

export async function createJobAdsFetch(store: JobStore, input: unknown): Promise<bigint> {
  const p = jobAdsParamsSchema.parse(input ?? {});
  return store.createJob({
    kind: JOBADS_JOB,
    params: { ...p, label: jobAdsLabel(p) } satisfies JsonObject,
    tasks: p.sources.map((source) => ({ kind: "jobads.fetch", payload: { source }, maxAttempts: 2 })),
    message: "Job advert search created",
  });
}

/** Test hooks: answers from fixtures instead of the real APIs, no real waiting. */
let hooks: Partial<Pick<SourceDeps, "getJson" | "sleep" | "baBase" | "arbeitnowBase">> = {};
export function setJobAdsTestHooks(h: typeof hooks): void {
  hooks = h;
}

/** Same company as a found lead: by the employer's own website domain, else by name (same country, one match only). */
async function linkPlaces(db: Db, ads: NormalizedAd[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const domains = [...new Set(ads.map((a) => websiteDomain(a.externalUrl)).filter((d): d is string => !!d))];
  if (domains.length > 0) {
    const rows = await db.place.findMany({ where: { websiteDomain: { in: domains } }, select: { id: true, websiteDomain: true } });
    const byDomain = new Map(rows.map((r) => [r.websiteDomain, r.id]));
    for (const a of ads) {
      const d = websiteDomain(a.externalUrl);
      const id = d ? byDomain.get(d) : undefined;
      if (id) out.set(a.externalId, id);
    }
  }
  const keys = [...new Set(ads.filter((a) => !out.has(a.externalId) && a.companyKey.length >= 3).map((a) => a.companyKey))];
  if (keys.length > 0) {
    // Names are compared in JavaScript (legal forms removed); only countries the adverts are in.
    const countries = [...new Set(ads.map((a) => a.country ?? "DE"))];
    const places = await db.place.findMany({ where: { country: { in: countries } }, select: { id: true, name: true, country: true } });
    const byKey = new Map<string, bigint[]>();
    for (const p of places) {
      const k = `${p.country}|${companyKey(p.name)}`;
      byKey.set(k, [...(byKey.get(k) ?? []), p.id]);
    }
    for (const a of ads) {
      if (out.has(a.externalId)) continue;
      const hit = byKey.get(`${a.country ?? "DE"}|${a.companyKey}`);
      if (hit && hit.length === 1) out.set(a.externalId, hit[0]!);
    }
  }
  return out;
}

/**
 * Saves the adverts in large single statements (INSERT … ON CONFLICT), 500 at a time: one round trip
 * per chunk, so a slow database connection (Neon from far away) does not time out.
 * A search result without text never wipes the text (and its flags) read earlier.
 */
async function saveAds(db: Db, ads: NormalizedAd[], places: Map<string, bigint>): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (let i = 0; i < ads.length; i += 500) {
    const rows = ads.slice(i, i + 500).map((a) => ({
      source: a.source,
      external_id: a.externalId,
      title: a.title,
      company: a.company,
      company_key: a.companyKey,
      location: a.location,
      city: a.city,
      postcode: a.postcode,
      country: a.country,
      lat: a.lat,
      lng: a.lng,
      url: a.url,
      external_url: a.externalUrl,
      description: a.description,
      tags: a.tags,
      job_types: a.jobTypes,
      role: a.role,
      is_dev: a.isDev,
      stack_match: a.stackMatch,
      flags: a.flags,
      posted_at: a.postedAt?.toISOString() ?? null,
      place_id: places.get(a.externalId)?.toString() ?? null,
    }));
    const result = await db.$queryRaw<{ inserted: boolean }[]>`
      INSERT INTO job_ads (source, external_id, title, company, company_key, location, city, postcode, country, lat, lng, url, external_url,
                           description, tags, job_types, role, is_dev, stack_match, flags, posted_at, place_id, first_seen_at, last_seen_at, updated_at)
      SELECT x.source, x.external_id, x.title, x.company, x.company_key, x.location, x.city, x.postcode, x.country, x.lat, x.lng, x.url, x.external_url,
             x.description,
             ARRAY(SELECT jsonb_array_elements_text(x.tags)), ARRAY(SELECT jsonb_array_elements_text(x.job_types)),
             x.role, x.is_dev, x.stack_match, ARRAY(SELECT jsonb_array_elements_text(x.flags)),
             x.posted_at, x.place_id, now(), now(), now()
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
             source text, external_id text, title text, company text, company_key text, location text, city text, postcode text, country text,
             lat double precision, lng double precision, url text, external_url text, description text, tags jsonb, job_types jsonb,
             role text, is_dev boolean, stack_match boolean, flags jsonb, posted_at timestamptz, place_id bigint)
      ON CONFLICT (source, external_id) DO UPDATE SET
        title = EXCLUDED.title, company = EXCLUDED.company, company_key = EXCLUDED.company_key, location = EXCLUDED.location,
        city = EXCLUDED.city, postcode = EXCLUDED.postcode, country = EXCLUDED.country, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
        url = EXCLUDED.url, external_url = EXCLUDED.external_url, tags = EXCLUDED.tags, job_types = EXCLUDED.job_types,
        posted_at = EXCLUDED.posted_at, place_id = EXCLUDED.place_id, last_seen_at = now(), updated_at = now(),
        description = COALESCE(EXCLUDED.description, job_ads.description),
        role = CASE WHEN EXCLUDED.description IS NOT NULL OR job_ads.description IS NULL THEN EXCLUDED.role ELSE job_ads.role END,
        is_dev = CASE WHEN EXCLUDED.description IS NOT NULL OR job_ads.description IS NULL THEN EXCLUDED.is_dev ELSE job_ads.is_dev END,
        stack_match = CASE WHEN EXCLUDED.description IS NOT NULL OR job_ads.description IS NULL THEN EXCLUDED.stack_match ELSE job_ads.stack_match END,
        flags = CASE WHEN EXCLUDED.description IS NOT NULL OR job_ads.description IS NULL THEN EXCLUDED.flags ELSE job_ads.flags END
      RETURNING (xmax = 0) AS inserted`;
    for (const r of result) {
      if (r.inserted) added++;
      else updated++;
    }
  }
  return { added, updated };
}

/** One source: fetch, save, link to leads, forget old untouched adverts. */
export const jobAdsFetchTask: TaskHandler = async (ctx) => {
  const { source } = ctx.task.payload as { source: JobSource };
  const raw = { ...ctx.job.params };
  delete raw.label;
  const p = jobAdsParamsSchema.parse(raw);
  const deps: SourceDeps = {
    getJson: hooks.getJson ?? netGetJson(),
    sleep: hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    delayMs: 1000,
    onProgress: async () => {
      await ctx.touch();
      const j = await ctx.db.job.findUnique({ where: { id: ctx.job.id }, select: { status: true } });
      if (j?.status !== "running") throw new RequeueTask("The search was paused or cancelled");
    },
    ...(hooks.baBase ? { baBase: hooks.baBase } : {}),
    ...(hooks.arbeitnowBase ? { arbeitnowBase: hooks.arbeitnowBase } : {}),
  };
  const started = new Date();
  let out: { ads: NormalizedAd[]; requests: number; notes: string[] };
  try {
    out =
      source === "ba"
        ? await fetchBa(
            { keywords: p.keywords, where: p.where, radiusKm: p.radiusKm, days: p.days, maxPages: p.maxPages, details: p.details },
            deps,
            async (refnrs) =>
              new Set(
                (await ctx.db.jobAd.findMany({ where: { source: "ba", externalId: { in: refnrs }, description: { not: null } }, select: { externalId: true } })).map(
                  (r) => r.externalId,
                ),
              ),
          )
        : await fetchArbeitnow({ maxPages: p.maxPages, visaPass: true }, deps);
  } catch (err) {
    if (err instanceof RequeueTask) throw err;
    throw new Error(`${SOURCE_LABELS[source]}: ${(err as Error).message}`, { cause: err });
  }
  const places = await linkPlaces(ctx.db, out.ads);
  const saved = await saveAds(ctx.db, out.ads, places);
  // Adverts nobody kept and that no search has returned for 60 days are removed (storage).
  const removed = await ctx.db.jobAd.deleteMany({
    where: { source, status: { in: ["new", "hidden"] }, lastSeenAt: { lt: new Date(started.getTime() - 60 * 24 * 3600_000) } },
  });
  const dev = out.ads.filter((a) => a.isDev);
  for (const n of out.notes) await ctx.event("warn", `${SOURCE_LABELS[source]}: ${n}`);
  await ctx.event(
    "info",
    `${SOURCE_LABELS[source]}: ${out.ads.length} advert(s), ${dev.length} for developers (${dev.filter((a) => a.stackMatch).length} with our stack), ${saved.added} new; ${out.requests} request(s).`,
  );
  return {
    result: {
      source,
      ads: out.ads.length,
      dev: dev.length,
      stack: dev.filter((a) => a.stackMatch).length,
      remote: dev.filter((a) => a.flags.includes("remote")).length,
      visa: dev.filter((a) => a.flags.includes("visa")).length,
      english: dev.filter((a) => a.flags.includes("ad_english") || a.flags.includes("english_team")).length,
      linked: dev.filter((a) => places.has(a.externalId)).length,
      added: saved.added,
      updated: saved.updated,
      removed: removed.count,
      requests: out.requests,
    },
  };
};

export const summarizeJobAds: Summarizer = (tasks) => {
  const sum = { ads: 0, dev: 0, stack: 0, remote: 0, visa: 0, english: 0, linked: 0, added: 0, requests: 0, failed: 0 };
  for (const t of tasks) {
    if (t.status === "failed") sum.failed++;
    const r = t.result ?? {};
    for (const k of ["ads", "dev", "stack", "remote", "visa", "english", "linked", "added", "requests"] as const) {
      sum[k] += typeof r[k] === "number" ? r[k] : 0;
    }
  }
  return sum;
};
