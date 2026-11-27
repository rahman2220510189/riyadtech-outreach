import { z } from "zod";
import { addressRules, clearAddressRulesCache } from "../leads/country-rules.js";
import { choosePrimary, storedEmail } from "../leads/overture-emails.js";
import { withTxRetry } from "../db/retry.js";
import { Prisma } from "../generated/prisma/client.js";
import type { JobStore, Summarizer } from "../jobs/store.js";
import { type JsonObject, RequeueTask, type TaskHandler } from "../jobs/types.js";
import { loadSeedData } from "../seed/files.js";
import type { Settings } from "../settings/definitions.js";
import { type Analysis, analyze, collectEmails, type EmailWithMx, type LeadInput } from "./analyze.js";
import type { FeedUrlFor } from "./ats.js";
import { refreshSuppressed } from "../leads/suppression.js";
import { checkMx, type MxResolver } from "./mx.js";
import type { Resolver } from "./net.js";
import { CrawlInterrupted, type CrawlOutcome, crawlSite, type CrawlSettings } from "./site.js";

export const CRAWL_JOB = "crawl";

export const crawlParamsSchema = z
  .object({
    segment: z.enum(["A", "B"]).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    regionCode: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,4}$/).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    categoryKeys: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(50).optional(),
    /** Only the leads saved (or updated) by this finder import. */
    finderJobId: z.number().int().positive().optional(),
    /** Exactly these leads (a campaign crawls its leads before the first e-mail). */
    placeIds: z.array(z.number().int().positive()).max(5000).optional(),
    /** true: only leads never crawled, or crawled longer ago than Settings → recrawl days. */
    onlyNew: z.boolean().default(true),
    /** Only websites that could be read last time (to crawl them again, e.g. after new rules). */
    onlyReadable: z.boolean().default(false),
    /** Only leads that currently show a developer job (to check them again after new job rules). */
    onlyHiring: z.boolean().default(false),
    limit: z.number().int().min(1).max(5000).default(200),
  })
  .strict();
export type CrawlParams = z.infer<typeof crawlParamsSchema>;

/** Test hooks: fake DNS for the fixture websites, fake MX answers, no real waiting. */
export interface CrawlTestHooks {
  resolve?: Resolver;
  allowAddresses?: string[];
  mxResolve?: MxResolver;
  sleep?: (ms: number) => Promise<void>;
  feedUrlFor?: FeedUrlFor;
}
let hooks: CrawlTestHooks = {};
export function setCrawlTestHooks(h: CrawlTestHooks): void {
  hooks = h;
}

export function crawlSettings(s: Settings): CrawlSettings {
  return {
    maxPagesPerDomain: s.crawler.maxPagesPerDomain,
    minDelayMs: s.crawler.minDelayMs,
    timeoutMs: s.crawler.timeoutMs,
    maxBytes: s.crawler.maxBytes,
    maxRedirects: s.crawler.maxRedirects,
    maxCrawlDelaySeconds: s.crawler.maxCrawlDelaySeconds,
    siteTimeLimitMs: s.crawler.siteTimeLimitSeconds * 1000,
  };
}

/** Prisma filter for the leads a crawl job covers. */
export function crawlWhere(p: CrawlParams, recrawlDays: number): Prisma.PlaceWhereInput {
  const where: Prisma.PlaceWhereInput = {};
  if (p.segment) where.segment = p.segment;
  if (p.country) where.country = p.country;
  if (p.regionCode) where.regionCode = p.regionCode;
  if (p.city) where.city = { equals: p.city, mode: "insensitive" };
  if (p.categoryKeys?.length) where.categoryKey = { in: p.categoryKeys };
  if (p.finderJobId) where.OR = [{ firstJobId: BigInt(p.finderJobId) }, { lastJobId: BigInt(p.finderJobId) }];
  if (p.placeIds?.length) where.id = { in: p.placeIds.map((n) => BigInt(n)) };
  if (p.onlyReadable) where.crawlStatus = { in: ["ok", "partial"] };
  if (p.onlyHiring) where.signals = { some: { key: { in: ["hiring_dev", "job_opening"] } } };
  if (p.onlyNew) {
    const before = new Date(Date.now() - recrawlDays * 24 * 3600_000);
    where.AND = [{ OR: [{ crawlStatus: null }, { crawledAt: { lt: before } }] }];
  }
  return where;
}

export async function createCrawlJob(store: JobStore, input: unknown, label?: string): Promise<bigint> {
  const params = crawlParamsSchema.parse(input);
  return store.createJob({
    kind: CRAWL_JOB,
    params: { ...params, ...(label ? { label } : {}) } satisfies JsonObject,
    tasks: [{ kind: "crawl.plan", payload: {}, maxAttempts: 3 }],
    message: "Crawl created",
  });
}

/** A short description of the leads a crawl covers ("Segment A, GB, Manchester, not crawled yet"). */
export function crawlLabel(p: CrawlParams): string {
  const parts = [
    p.segment ? `Segment ${p.segment}` : "Both segments",
    p.country ?? "all countries",
    ...(p.regionCode ? [p.regionCode] : []),
    ...(p.city ? [p.city] : []),
    ...(p.finderJobId ? [`import #${p.finderJobId}`] : []),
    ...(p.categoryKeys?.length ? [`${p.categoryKeys.length} categories`] : []),
    ...(p.onlyHiring ? ["hiring developers"] : []),
    p.onlyNew ? "not crawled yet" : p.onlyReadable ? "readable before (crawl again)" : "all (crawl again)",
  ];
  return `${parts.join(", ")}; up to ${p.limit} leads`;
}

/** Step 1: pick the leads, one crawl step per website domain. */
export const crawlPlanTask: TaskHandler = async (ctx) => {
  const p = crawlParamsSchema.parse(ctx.job.params instanceof Object ? stripLabel(ctx.job.params) : {});
  const where = crawlWhere(p, ctx.settings.crawler.recrawlDays);
  const places = await ctx.db.place.findMany({
    where,
    select: { id: true, websiteDomain: true },
    orderBy: [{ leadScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: p.limit,
  });
  if (places.length === 0) {
    await ctx.event("warn", "No leads match (all crawled recently, or none saved for this area yet).");
    return { result: { leads: 0, sites: 0 } };
  }
  const byDomain = new Map<string, string[]>();
  for (const pl of places) {
    const list = byDomain.get(pl.websiteDomain) ?? [];
    list.push(String(pl.id));
    byDomain.set(pl.websiteDomain, list);
  }
  const domains = [...byDomain.keys()].sort();
  await ctx.event(
    "info",
    `${places.length} lead(s) on ${domains.length} website(s). At most ${ctx.settings.crawler.concurrency} sites at once, one request every ${(ctx.settings.crawler.minDelayMs / 1000).toFixed(1)} s or slower per site.`,
  );
  return {
    result: { leads: places.length, sites: domains.length },
    newTasks: domains.map((d) => ({ kind: "crawl.site", payload: { domain: d, placeIds: byDomain.get(d)! }, maxAttempts: 2 })),
  };
};

function stripLabel(params: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...params };
  delete rest.label;
  return rest;
}

export function clearCrawlCaches(): void {
  clearAddressRulesCache();
}

/** Step 2: crawl one website and update every lead that uses it. */
export const crawlSiteTask: TaskHandler = async (ctx) => {
  const payload = ctx.task.payload as { domain: string; placeIds: string[] };
  const places = await ctx.db.place.findMany({ where: { id: { in: payload.placeIds.map((id) => BigInt(id)) } }, orderBy: { id: "asc" } });
  if (places.length === 0) return { result: { domain: payload.domain, status: "gone", note: "Leads were deleted" } };
  const first = places[0]!;
  const seed = loadSeedData();
  const categories = new Map(seed.categories.map((c) => [c.key, c]));

  let outcome: CrawlOutcome;
  try {
    outcome = await crawlSite(
      { website: first.website, domain: first.websiteDomain, segment: first.segment as "A" | "B" },
      crawlSettings(ctx.settings),
      {
        net: { ...(hooks.resolve ? { resolve: hooks.resolve } : {}), ...(hooks.allowAddresses ? { allowAddresses: hooks.allowAddresses } : {}) },
        platforms: seed.platformDomains,
        ...(hooks.sleep ? { sleep: hooks.sleep } : {}),
        ...(hooks.feedUrlFor ? { feedUrlFor: hooks.feedUrlFor } : {}),
        onProgress: () => ctx.touch(),
        shouldStop: jobStopped(ctx),
      },
    );
  } catch (err) {
    if (err instanceof CrawlInterrupted) throw new RequeueTask(`${payload.domain}: stopped (job paused or cancelled)`);
    throw new Error(`Crawl of ${payload.domain} failed: ${(err as Error).message}`, { cause: err });
  }

  // Segment A and B leads on one domain read the same pages; e-mails and MX are shared.
  const classified = collectEmails(outcome, first.websiteDomain);
  const mx = new Map<string, boolean | null>();
  for (const d of [...new Set(classified.map((e) => e.domain))].sort()) {
    mx.set(d, (await checkMx(ctx.db, d, hooks.mxResolve)).hasMx);
  }
  const emails: EmailWithMx[] = classified.map((e) => ({ ...e, mxValid: mx.get(e.domain) ?? null }));

  const results: { place: (typeof places)[number]; a: Analysis }[] = [];
  for (const place of places) {
    const cat = categories.get(place.categoryKey);
    const lead: LeadInput = {
      id: place.id,
      segment: place.segment as "A" | "B",
      name: place.name,
      websiteDomain: place.websiteDomain,
      city: place.city,
      categoryLabel: cat?.label ?? place.categoryKey,
      categoryValue: cat?.value ?? 3,
      locationCount: place.locationCount,
      overtureEmails: place.overtureEmails,
      genericOnly: (await addressRules(ctx.db, place.country)).genericOnly,
    };
    const a = analyze(lead, outcome, emails, {
      weights: ctx.settings.scores.weights,
      agentThreshold: ctx.settings.scores.agentThreshold,
    });
    results.push({ place, a });
  }

  const owned = await withTxRetry(() =>
    ctx.db.$transaction(async (tx) => {
      await tx.domainCrawl.upsert({
        where: { domain: payload.domain },
        create: crawlRow(payload.domain, outcome, results[0]!.a.tech, ctx.job.id),
        update: crawlRow(payload.domain, outcome, results[0]!.a.tech, ctx.job.id),
      });
      const ownedBy = new Map<bigint, Set<string>>();
      for (const { place, a } of results) {
        const mine = new Set<string>();
        const keep = a.emails.map((e) => e.email);
        const listed = place.overtureEmails.map((x) => x.toLowerCase());
        // Gone from the website: an address Overture also lists stays as an Overture-only address.
        await tx.email.updateMany({ where: { placeId: place.id, onSite: true, origin: "overture", email: { notIn: keep, in: listed } }, data: { onSite: false, isPrimary: false } });
        await tx.email.deleteMany({ where: { placeId: place.id, onSite: true, origin: { not: "csv" }, email: { notIn: keep } } });
        for (const e of [...a.emails].sort((x, y) => x.email.localeCompare(y.email))) {
          const rows = await tx.$queryRaw<{ email: string }[]>`
            INSERT INTO emails (place_id, email, domain, kind, domain_match, is_primary, first_name, context, mx_valid, source_url, origin, on_site, updated_at)
            VALUES (${place.id}, ${e.email}, ${e.domain}, ${e.kind}, ${e.domainMatch}, false, ${e.firstName}, ${e.context}, ${e.mxValid}, ${e.sourceUrl},
                    ${listed.includes(e.email) ? "overture" : "crawl"}, true, now())
            ON CONFLICT (email) DO UPDATE SET
              kind = EXCLUDED.kind, domain_match = EXCLUDED.domain_match, first_name = EXCLUDED.first_name,
              context = EXCLUDED.context, mx_valid = EXCLUDED.mx_valid, source_url = EXCLUDED.source_url,
              origin = CASE WHEN emails.origin = 'overture' THEN 'overture' ELSE EXCLUDED.origin END, on_site = true, updated_at = now()
            WHERE emails.place_id = EXCLUDED.place_id
            RETURNING email`;
          if (rows.length > 0) mine.add(e.email);
        }
        // An address on the website first; otherwise an Overture-only address where the country allows it.
        const rules = await addressRules(ctx.db, place.country);
        const fallback = async () =>
          rules.publishedOnly
            ? null
            : choosePrimary((await tx.email.findMany({ where: { placeId: place.id, onSite: false, origin: "overture" } })).map(storedEmail), place.segment as "A" | "B", rules);
        const primary = a.primary && mine.has(a.primary.email) ? a.primary : await fallback();
        await tx.email.updateMany({ where: { placeId: place.id }, data: { isPrimary: false } });
        if (primary) await tx.email.update({ where: { email: primary.email }, data: { isPrimary: true } });
        await tx.signal.deleteMany({ where: { placeId: place.id } });
        if (a.signals.length > 0) {
          await tx.signal.createMany({
            data: a.signals.map((s) => ({
              placeId: place.id,
              key: s.key,
              score: s.score,
              weight: s.weight,
              value: s.value,
              evidenceUrl: s.evidenceUrl,
              snippet: s.snippet,
            })),
          });
        }
        await tx.place.update({
          where: { id: place.id },
          data: {
            crawlStatus: outcome.status,
            crawledAt: outcome.finishedAt,
            fitScore: a.scores.fit,
            needScore: a.scores.need,
            leadScore: a.scores.lead,
            bestOffer: a.scores.bestOffer,
            signalLine: a.signalLine,
            primaryEmail: primary?.email ?? null,
            firstName: primary?.firstName ?? null,
          },
        });
        ownedBy.set(place.id, mine);
      }
      return ownedBy;
    }),
  );

  // A new primary address may be on the suppression list.
  await refreshSuppressed(ctx.db, places.map((p) => p.id));

  const a0 = results[0]!.a;
  const result = {
    domain: payload.domain,
    status: outcome.status,
    note: outcome.error,
    pages: outcome.fetched.length,
    requests: outcome.pages.length,
    leads: places.length,
    emails: emails.length,
    savedEmails: [...owned.values()].reduce((n, s) => n + s.size, 0),
    withPrimary: results.filter((r) => r.a.primary && owned.get(r.place.id)?.has(r.a.primary.email)).length,
    noMx: emails.filter((e) => e.mxValid === false).length,
    primaryNote: primaryNote(emails),
    namedOnly: emails.length > 0 && emails.every((e) => e.kind !== "generic") && emails.some((e) => e.kind === "named"),
    overtureOnly: a0.overtureOnly.length,
    signals: [...new Set(results.flatMap((r) => r.a.signals.map((s) => s.key)))],
    jobBoard: outcome.jobBoard ? `${outcome.jobBoard.provider}: ${outcome.jobBoard.developerJobs}/${outcome.jobBoard.jobs}` : null,
    ms: outcome.finishedAt.getTime() - outcome.startedAt.getTime(),
  };
  if (outcome.status !== "ok") {
    await ctx.event(
      outcome.status === "partial" ? "info" : "warn",
      `${payload.domain}: ${outcome.error ?? statusText(outcome.status)}`,
    );
  }
  return { result };
};

/** True once the job is no longer running (Pause/Cancel); asks the database at most every 3 s. */
function jobStopped(ctx: Parameters<TaskHandler>[0]): () => Promise<boolean> {
  let checkedAt = 0;
  let stopped = false;
  return async () => {
    if (stopped || Date.now() - checkedAt < 3000) return stopped;
    checkedAt = Date.now();
    const job = await ctx.db.job.findUnique({ where: { id: ctx.job.id }, select: { status: true } });
    stopped = !job || job.status !== "running";
    return stopped;
  };
}

/** Why no address became primary (for the CLI line and the drawer). */
function primaryNote(emails: EmailWithMx[]): string | null {
  if (emails.length === 0) return null;
  if (emails.every((e) => e.mxValid === false)) return "the domain takes no mail (no MX)";
  if (emails.every((e) => e.kind === "role")) return "only department addresses (privacy@, careers@…)";
  if (!emails.some((e) => e.kind === "generic" && e.mxValid !== false)) return "only personal addresses; this country allows generic addresses only";
  return "the address belongs to another lead with the same website";
}

function crawlRow(domain: string, o: CrawlOutcome, tech: string[], jobId: bigint) {
  return {
    domain,
    status: o.status,
    finalUrl: o.finalUrl,
    httpStatus: o.httpStatus,
    pages: o.pages as unknown as Prisma.InputJsonValue,
    robots: o.robots as unknown as Prisma.InputJsonValue,
    tech,
    jobBoard: o.jobBoard ? (o.jobBoard as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    error: o.error,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
    jobId,
  };
}

export function statusText(status: string): string {
  return (
    {
      ok: "read",
      partial: "partly read",
      robots_blocked: "robots.txt does not allow crawling",
      bot_blocked: "the site blocks automated visits",
      unreachable: "could not be reached",
      not_html: "not a web page",
      platform: "forwards to a platform (not their own site)",
      error: "error",
    }[status] ?? status
  );
}

export const summarizeCrawl: Summarizer = (tasks) => {
  const plan = tasks.find((t) => t.kind === "crawl.plan")?.result ?? {};
  const sites = tasks.filter((t) => t.kind === "crawl.site");
  const done = sites.filter((t) => t.status === "done").map((t) => t.result ?? {});
  const byStatus: Record<string, number> = {};
  const bySignal: Record<string, number> = {};
  let emails = 0;
  let withEmail = 0;
  let withPrimary = 0;
  let leads = 0;
  let noMx = 0;
  let overtureOnly = 0;
  let pages = 0;
  let namedOnly = 0;
  let jobBoards = 0;
  for (const r of done) {
    const status = typeof r.status === "string" ? r.status : "error";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    emails += Number(r.emails ?? 0);
    if (Number(r.emails ?? 0) > 0) withEmail++;
    withPrimary += Number(r.withPrimary ?? 0);
    leads += Number(r.leads ?? 0);
    noMx += Number(r.noMx ?? 0);
    overtureOnly += Number(r.overtureOnly ?? 0);
    pages += Number(r.pages ?? 0);
    if (r.namedOnly === true) namedOnly++;
    if (typeof r.jobBoard === "string") jobBoards++;
    for (const k of (r.signals as string[] | undefined) ?? []) bySignal[k] = (bySignal[k] ?? 0) + 1;
  }
  const readable = (byStatus.ok ?? 0) + (byStatus.partial ?? 0);
  return {
    leadsPlanned: Number(plan.leads ?? 0),
    sites: sites.length,
    sitesDone: done.length,
    sitesFailed: sites.filter((t) => t.status === "failed").length,
    readable,
    byStatus,
    pages,
    sitesWithEmail: withEmail,
    emails,
    leads,
    leadsWithPrimary: withPrimary,
    noMx,
    overtureOnly,
    namedOnly,
    jobBoards,
    bySignal,
  };
};
