import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { CRAWL_STATUSES } from "../crawler/site.js";
import { loadSignalRules } from "../crawler/signals.js";
import { stackWords } from "../crawler/analyze.js";
import { crawlLabel, crawlParamsSchema, crawlWhere, createCrawlJob, statusText } from "../crawler/tasks.js";
import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { JobStore } from "../jobs/store.js";
import { errors } from "../lib/errors.js";
import { loadSeedData } from "../seed/files.js";
import { resolveSettings } from "../settings/loader.js";
import { csvLine } from "../leads/csv.js";
import { suppressedSet } from "../leads/suppression.js";

export interface LeadsRoutesOptions {
  db: Db;
  jobs: JobStore;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const listQuery = z.object({
  segment: z.enum(["A", "B"]).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  regionCode: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,4}$/).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  category: z.string().regex(/^[a-z0-9_]+$/).optional(),
  /** new = not crawled; readable = crawled and read; problem = crawled but not readable */
  crawl: z.enum(["new", "crawled", "readable", "problem", ...CRAWL_STATUSES]).optional(),
  hasEmail: bool.optional(),
  /** true: only leads on the suppression list (address or domain). */
  suppressed: bool.optional(),
  signal: z.string().regex(/^[a-z_]+$/).optional(),
  /** Companies whose website advertises a developer job (any segment, any country). */
  hiring: bool.optional(),
  /** Job search: remote, visa (or relocation), english (English-speaking team), no_local_lang (no "fluent German/Dutch/French/Polish" demand). */
  jobFlag: z.enum(["remote", "visa", "english", "no_local_lang"]).optional(),
  bestOffer: z.enum(["chatbot", "agent"]).optional(),
  minFit: z.coerce.number().int().min(0).max(100).optional(),
  minNeed: z.coerce.number().int().min(0).max(100).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["score", "fit", "need", "name", "newest"]).default("score"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function listWhere(q: z.infer<typeof listQuery>): Prisma.PlaceWhereInput {
  const and: Prisma.PlaceWhereInput[] = [];
  if (q.segment) and.push({ segment: q.segment });
  if (q.country) and.push({ country: q.country });
  if (q.regionCode) and.push({ regionCode: q.regionCode });
  if (q.city) and.push({ city: { equals: q.city, mode: "insensitive" } });
  if (q.category) and.push({ categoryKey: q.category });
  if (q.crawl === "new") and.push({ crawlStatus: null });
  else if (q.crawl === "crawled") and.push({ crawlStatus: { not: null } });
  else if (q.crawl === "readable") and.push({ crawlStatus: { in: ["ok", "partial"] } });
  else if (q.crawl === "problem") and.push({ crawlStatus: { notIn: ["ok", "partial"] } }, { crawlStatus: { not: null } });
  else if (q.crawl) and.push({ crawlStatus: q.crawl });
  if (q.hasEmail === true) and.push({ primaryEmail: { not: null } }, { suppressed: false });
  if (q.hasEmail === false) and.push({ OR: [{ primaryEmail: null }, { suppressed: true }] });
  if (q.suppressed !== undefined) and.push({ suppressed: q.suppressed });
  if (q.signal) and.push({ signals: { some: { key: q.signal } } });
  if (q.hiring === true) and.push({ signals: { some: { key: { in: HIRING_KEYS } } } });
  if (q.jobFlag === "no_local_lang") and.push({ signals: { none: { key: "job_local_lang" } } });
  else if (q.jobFlag) and.push({ signals: { some: { key: `job_${q.jobFlag}` } } });
  if (q.bestOffer) and.push({ bestOffer: q.bestOffer });
  if (q.minFit !== undefined) and.push({ fitScore: { gte: q.minFit } });
  if (q.minNeed !== undefined) and.push({ needScore: { gte: q.minNeed } });
  if (q.q) {
    and.push({
      OR: [
        { name: { contains: q.q, mode: "insensitive" } },
        { websiteDomain: { contains: q.q.toLowerCase() } },
        { primaryEmail: { contains: q.q.toLowerCase() } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

/** Signals that mean "this company advertises a developer job" (Segment A and B). */
const HIRING_KEYS = ["hiring_dev", "job_opening"];
const JOB_FLAG_KEYS = ["job_remote", "job_visa", "job_english", "job_local_lang"];

/** Department addresses that are never right for a job application (finance, sales, bookings, support). */
const NOT_FOR_APPLYING = /^(accounts?|billing|invoices?|finance|payments?|sales|bookings?|reservations?|appointments?|support|help|helpdesk|orders?|shop|quotes?)([._+-]|@)/;

/**
 * Where to send a job application: a jobs/careers/HR address, else one shown on the job page,
 * else a general one (the primary first; never accounts@, sales@, support@ …), else a named one.
 */
export function applyEmail(
  emails: { email: string; kind: string; sourceUrl: string; mxValid: boolean | null; isPrimary: boolean }[],
  jobUrl: string | null,
): string | null {
  const ok = emails.filter((e) => e.mxValid !== false);
  const hr = ok.find((e) =>
    /^(jobs?|careers?|bewerbung(en)?|karriere|recruit(ment|ing)?|hr|talent|people|personal|vacatures?|werkenbij|sollicitaties?|recrutement|rh|emplois?|candidatures?|rekrutacja|kariera|praca)([._+-]|@)/.test(e.email),
  );
  if (hr) return hr.email;
  const usable = ok.filter((e) => e.kind !== "role" && !NOT_FOR_APPLYING.test(e.email));
  const onJobPage = jobUrl ? usable.find((e) => e.sourceUrl === jobUrl) : undefined;
  if (onJobPage) return onJobPage.email;
  return (
    usable.find((e) => e.kind === "generic" && e.isPrimary)?.email ??
    usable.find((e) => e.kind === "generic")?.email ??
    usable.find((e) => e.isPrimary)?.email ??
    usable.find((e) => e.kind === "named")?.email ??
    null
  );
}

const LIST_INCLUDE = {
  signals: { select: { key: true, weight: true, value: true, evidenceUrl: true }, orderBy: { weight: "desc" as const } },
  emails: { select: { email: true, kind: true, sourceUrl: true, mxValid: true, isPrimary: true } },
} satisfies Prisma.PlaceInclude;

const ORDER: Record<z.infer<typeof listQuery>["sort"], Prisma.PlaceOrderByWithRelationInput[]> = {
  score: [{ leadScore: { sort: "desc", nulls: "last" } }, { fitScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  fit: [{ fitScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  need: [{ needScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  name: [{ name: "asc" }, { id: "asc" }],
  newest: [{ id: "desc" }],
};

export const leadsRoutes: FastifyPluginCallback<LeadsRoutesOptions> = (app, { db, jobs }, done) => {
  app.addHook("preHandler", app.authenticate);

  const categoryLabels = () => new Map(loadSeedData().categories.map((c) => [c.key, c.label]));

  /** One lead as the list (and the export) shows it. Suppressed leads never show an address. */
  async function itemMapper() {
    const labels = categoryLabels();
    const stack = stackWords();
    const outreach = new Set((await db.country.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code));
    return (p: Prisma.PlaceGetPayload<{ include: typeof LIST_INCLUDE }>) => {
      const job = p.signals.find((s) => HIRING_KEYS.includes(s.key));
      const role = job?.value ?? null;
      return {
        id: Number(p.id),
        segment: p.segment,
        name: p.name,
        category: p.categoryKey,
        categoryLabel: labels.get(p.categoryKey) ?? p.categoryKey,
        country: p.country,
        regionCode: p.regionCode,
        city: p.city,
        address: p.address,
        postcode: p.postcode,
        phone: p.phone,
        website: p.website,
        domain: p.websiteDomain,
        crawlStatus: p.crawlStatus,
        crawledAt: p.crawledAt,
        fitScore: p.fitScore,
        needScore: p.needScore,
        leadScore: p.leadScore,
        bestOffer: p.bestOffer,
        signalLine: p.signalLine,
        firstName: p.suppressed ? null : p.firstName,
        primaryEmail: p.suppressed ? null : p.primaryEmail,
        suppressed: p.suppressed,
        signals: p.signals.map((s) => s.key),
        hiringRole: role,
        jobUrl: job?.evidenceUrl ?? null,
        /** The role is work we do (JS/TS, Node, React, Python, AI), not WordPress/PHP. */
        stackMatch: role ? stack.some((w) => role.toLowerCase().includes(w)) && !/wordpress|php|laravel/i.test(role) : null,
        jobFlags: p.signals.filter((s) => JOB_FLAG_KEYS.includes(s.key)).map((s) => s.key.replace(/^job_/, "")),
        applyEmail: job && !p.suppressed ? applyEmail(p.emails, job.evidenceUrl) : null,
        /** False for job-search-only countries: never e-mailed for sales. */
        outreachAllowed: outreach.has(p.country),
      };
    };
  }

  /** Signal keys and labels (for filters and badges). */
  app.get("/signals", () => {
    const rules = loadSignalRules();
    return {
      items: rules.rules.map((r) => ({ key: r.key, label: r.label, segment: r.segment, score: r.score, weight: r.weight })),
    };
  });

  app.get("/", async (request) => {
    const q = listQuery.parse(request.query);
    const where = listWhere(q);
    const [total, rows] = await Promise.all([
      db.place.count({ where }),
      db.place.findMany({
        where,
        orderBy: ORDER[q.sort],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: LIST_INCLUDE,
      }),
    ]);
    const toItem = await itemMapper();
    return {
      items: rows.map(toItem),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  });

  /**
   * The filtered leads as CSV (Excel opens it: UTF-8 with BOM). Suppressed leads are never
   * exported. At most 50,000 rows. Every export goes to the audit log.
   */
  app.get("/export.csv", async (request, reply) => {
    const q = listQuery.parse(request.query);
    const base = listWhere(q);
    const where: Prisma.PlaceWhereInput = { AND: [base, { suppressed: false }] };
    const toItem = await itemMapper();
    const header = [
      "id", "segment", "company", "category", "website", "domain", "country", "region", "city", "address", "postcode", "phone",
      "primary_email", "first_name", "fit", "need", "lead_score", "best_offer", "signal_line", "signals", "crawl_status",
      "hiring_role", "job_url", "apply_email", "outreach_allowed",
    ];
    const lines = [csvLine(header)];
    let cursor: bigint | undefined;
    let count = 0;
    while (count < 50_000) {
      const rows = await db.place.findMany({
        where,
        orderBy: { id: "asc" },
        take: 1000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: LIST_INCLUDE,
      });
      if (rows.length === 0) break;
      for (const p of rows) {
        const i = toItem(p);
        lines.push(
          csvLine([
            i.id, i.segment, i.name, i.categoryLabel, i.website, i.domain, i.country, i.regionCode, i.city, i.address, i.postcode, i.phone,
            i.primaryEmail, i.firstName, i.fitScore, i.needScore, i.leadScore, i.bestOffer, i.signalLine, i.signals.join(" "), i.crawlStatus,
            i.hiringRole, i.jobUrl, i.applyEmail, i.outreachAllowed ? "yes" : "no",
          ]),
        );
      }
      count += rows.length;
      cursor = rows[rows.length - 1]!.id;
    }
    const filters = Object.fromEntries(Object.entries(q).filter(([k]) => !["page", "pageSize", "sort"].includes(k)));
    await db.auditLog.create({
      data: { actor: request.admin?.email ?? null, action: "leads.export", entity: "places", details: { rows: count, filters }, ip: request.ip },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header("content-disposition", `attachment; filename="leads-${stamp}.csv"`);
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  });

  /** Counts for the dashboard and the leads page header. */
  app.get("/stats", async () => {
    const [bySegment, crawled, readable, withEmail, hiring] = await Promise.all([
      db.place.groupBy({ by: ["segment"], _count: { _all: true } }),
      db.place.groupBy({ by: ["segment"], where: { crawlStatus: { not: null } }, _count: { _all: true } }),
      db.place.groupBy({ by: ["segment"], where: { crawlStatus: { in: ["ok", "partial"] } }, _count: { _all: true } }),
      db.place.groupBy({ by: ["segment"], where: { primaryEmail: { not: null }, suppressed: false }, _count: { _all: true } }),
      db.place.groupBy({ by: ["segment"], where: { signals: { some: { key: { in: HIRING_KEYS } } } }, _count: { _all: true } }),
    ]);
    const pick = (rows: { segment: string; _count: { _all: number } }[], seg: string) =>
      rows.find((r) => r.segment === seg)?._count._all ?? 0;
    return {
      items: ["A", "B"].map((s) => ({
        segment: s,
        leads: pick(bySegment, s),
        crawled: pick(crawled, s),
        readable: pick(readable, s),
        withEmail: pick(withEmail, s),
        waiting: pick(bySegment, s) - pick(crawled, s),
        hiring: pick(hiring, s),
      })),
    };
  });

  app.get("/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const p = await db.place.findUnique({
      where: { id: BigInt(id) },
      include: {
        emails: { orderBy: [{ isPrimary: "desc" }, { email: "asc" }] },
        signals: { orderBy: [{ weight: "desc" }, { key: "asc" }] },
      },
    });
    if (!p) throw errors.notFound("Lead not found");
    const crawl = await db.domainCrawl.findUnique({ where: { domain: p.websiteDomain } });
    const country = await db.country.findUnique({ where: { code: p.country }, select: { enabled: true, jobSearch: true } });
    const sup = await suppressedSet(db, p.emails.map((e) => e.email), [p.websiteDomain]);
    const isSup = (email: string) => sup.emails.has(email) || sup.domains.has(email.split("@")[1] ?? "") || sup.domains.has(p.websiteDomain);
    const rules = new Map(loadSignalRules().rules.map((r) => [r.key, r.label]));
    return {
      id: Number(p.id),
      segment: p.segment,
      name: p.name,
      category: p.categoryKey,
      categoryLabel: categoryLabels().get(p.categoryKey) ?? p.categoryKey,
      website: p.website,
      domain: p.websiteDomain,
      country: p.country,
      regionCode: p.regionCode,
      city: p.city,
      postcode: p.postcode,
      address: p.address,
      phone: p.phone,
      timezone: p.timezone,
      locationCount: p.locationCount,
      outreachAllowed: country?.enabled ?? false,
      jobSearchOnly: !country?.enabled && (country?.jobSearch ?? false),
      confidence: p.confidence,
      release: p.release,
      createdAt: p.createdAt,
      crawlStatus: p.crawlStatus,
      crawlStatusText: p.crawlStatus ? statusText(p.crawlStatus) : null,
      crawledAt: p.crawledAt,
      fitScore: p.fitScore,
      needScore: p.needScore,
      leadScore: p.leadScore,
      bestOffer: p.bestOffer,
      signalLine: p.signalLine,
      primaryEmail: p.primaryEmail,
      firstName: p.firstName,
      suppressed: p.suppressed,
      overtureEmails: p.overtureEmails,
      emails: p.emails.map((e) => ({
        email: e.email,
        kind: e.kind,
        domainMatch: e.domainMatch,
        isPrimary: e.isPrimary,
        suppressed: isSup(e.email),
        firstName: e.firstName,
        mxValid: e.mxValid,
        sourceUrl: e.sourceUrl,
        context: e.context,
        origin: e.origin,
        lawfulBasis: e.lawfulBasis,
        foundAt: e.foundAt,
      })),
      signals: p.signals.map((s) => ({
        key: s.key,
        label: rules.get(s.key) ?? s.key,
        score: s.score,
        weight: s.weight,
        value: s.value,
        evidenceUrl: s.evidenceUrl,
        snippet: s.snippet,
      })),
      crawl: crawl
        ? {
            status: crawl.status,
            finalUrl: crawl.finalUrl,
            httpStatus: crawl.httpStatus,
            pages: crawl.pages,
            robots: crawl.robots,
            tech: crawl.tech,
            jobBoard: crawl.jobBoard,
            error: crawl.error,
            startedAt: crawl.startedAt,
            finishedAt: crawl.finishedAt,
            jobId: crawl.jobId ? Number(crawl.jobId) : null,
          }
        : null,
    };
  });

  /** How many leads and websites a crawl with these filters would cover. */
  app.post("/crawl/count", async (request) => {
    const p = crawlParamsSchema.parse(request.body ?? {});
    const settings = resolveSettings(await db.setting.findMany()).settings;
    const where = crawlWhere(p, settings.crawler.recrawlDays);
    const rows = await db.place.findMany({ where, select: { websiteDomain: true }, take: p.limit, orderBy: { id: "asc" } });
    const matching = await db.place.count({ where });
    return { matching, leads: rows.length, sites: new Set(rows.map((r) => r.websiteDomain)).size, label: crawlLabel(p) };
  });

  app.post("/crawl", async (request, reply) => {
    const p = crawlParamsSchema.parse(request.body ?? {});
    const jobId = await createCrawlJob(jobs, p, crawlLabel(p));
    void reply.status(202);
    return { jobId: Number(jobId) };
  });

  done();
};
