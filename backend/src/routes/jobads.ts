import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { createJobAdsFetch, JOBADS_JOB, jobAdsParamsSchema } from "../jobads/tasks.js";
import { SOURCE_LABELS, SOURCES } from "../jobads/sources.js";
import type { JobStore } from "../jobs/store.js";
import { errors } from "../lib/errors.js";
import { applyEmail } from "./leads.js";

export interface JobAdsRoutesOptions {
  db: Db;
  jobs: JobStore;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const listQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  source: z.enum(SOURCES).optional(),
  /** Default: developer jobs only. */
  dev: bool.default(true),
  stack: bool.optional(),
  flag: z.enum(["remote", "visa", "english", "no_local_lang"]).optional(),
  /** Town or region in the location text. */
  place: z.string().trim().min(1).max(80).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  /** open = new + saved (default), or one status, or all. */
  status: z.enum(["open", "new", "saved", "hidden", "applied", "all"]).default("open"),
  linked: bool.optional(),
  sort: z.enum(["newest", "company"]).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function where(q: z.infer<typeof listQuery>): Prisma.JobAdWhereInput {
  const and: Prisma.JobAdWhereInput[] = [];
  if (q.dev) and.push({ isDev: true });
  if (q.source) and.push({ source: q.source });
  if (q.stack !== undefined) and.push({ stackMatch: q.stack });
  if (q.flag === "english") and.push({ OR: [{ flags: { has: "ad_english" } }, { flags: { has: "english_team" } }] });
  else if (q.flag === "no_local_lang") and.push({ NOT: { flags: { has: "local_lang" } } });
  else if (q.flag) and.push({ flags: { has: q.flag } });
  if (q.place) and.push({ OR: [{ location: { contains: q.place, mode: "insensitive" } }, { postcode: { startsWith: q.place } }] });
  if (q.days) and.push({ postedAt: { gte: new Date(Date.now() - q.days * 24 * 3600_000) } });
  if (q.status === "open") and.push({ status: { in: ["new", "saved"] } });
  else if (q.status !== "all") and.push({ status: q.status });
  if (q.linked !== undefined) and.push(q.linked ? { placeId: { not: null } } : { placeId: null });
  if (q.q) {
    and.push({
      OR: [
        { title: { contains: q.q, mode: "insensitive" } },
        { company: { contains: q.q, mode: "insensitive" } },
        { description: { contains: q.q, mode: "insensitive" } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

/** Job adverts from the public job APIs: search runs, the list with filters, keep/hide/applied. */
export const jobAdsRoutes: FastifyPluginCallback<JobAdsRoutesOptions> = (app, { db, jobs }, done) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    const q = listQuery.parse(request.query);
    const w = where(q);
    const orderBy: Prisma.JobAdOrderByWithRelationInput[] =
      q.sort === "company" ? [{ company: "asc" }, { postedAt: { sort: "desc", nulls: "last" } }] : [{ postedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }];
    const [total, rows] = await Promise.all([
      db.jobAd.count({ where: w }),
      db.jobAd.findMany({
        where: w,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          place: {
            select: {
              id: true,
              name: true,
              websiteDomain: true,
              suppressed: true,
              emails: { select: { email: true, kind: true, sourceUrl: true, mxValid: true, isPrimary: true } },
            },
          },
        },
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((a) => ({
        id: Number(a.id),
        source: a.source,
        sourceLabel: SOURCE_LABELS[a.source as keyof typeof SOURCE_LABELS] ?? a.source,
        title: a.title,
        role: a.role,
        company: a.company,
        location: a.location,
        country: a.country,
        url: a.url,
        externalUrl: a.externalUrl,
        excerpt: a.description ? a.description.slice(0, 400) : null,
        tags: a.tags,
        jobTypes: a.jobTypes,
        isDev: a.isDev,
        stackMatch: a.stackMatch,
        flags: a.flags,
        postedAt: a.postedAt,
        firstSeenAt: a.firstSeenAt,
        lastSeenAt: a.lastSeenAt,
        status: a.status,
        note: a.note,
        lead: a.place
          ? {
              id: Number(a.place.id),
              name: a.place.name,
              domain: a.place.websiteDomain,
              applyEmail: a.place.suppressed ? null : applyEmail(a.place.emails, null),
            }
          : null,
      })),
    };
  });

  app.get("/stats", async () => {
    const [bySource, dev, statuses, last] = await Promise.all([
      db.jobAd.groupBy({ by: ["source"], _count: { _all: true }, _max: { lastSeenAt: true } }),
      db.jobAd.count({ where: { isDev: true, status: { in: ["new", "saved"] } } }),
      db.jobAd.groupBy({ by: ["status"], where: { isDev: true }, _count: { _all: true } }),
      db.job.findMany({ where: { kind: JOBADS_JOB }, orderBy: { id: "desc" }, take: 1 }),
    ]);
    const lastJob = last[0];
    return {
      sources: SOURCES.map((s) => {
        const r = bySource.find((x) => x.source === s);
        return { source: s, label: SOURCE_LABELS[s], ads: r?._count._all ?? 0, lastSeenAt: r?._max.lastSeenAt ?? null };
      }),
      openDev: dev,
      byStatus: Object.fromEntries(statuses.map((s) => [s.status, s._count._all])),
      lastFetch: lastJob
        ? {
            id: Number(lastJob.id),
            status: lastJob.status,
            label: (lastJob.params as { label?: string }).label ?? null,
            summary: lastJob.summary ?? (lastJob.status === "running" || lastJob.status === "paused" ? await jobs.summarize(lastJob.id, JOBADS_JOB) : null),
            error: lastJob.error,
            createdAt: lastJob.createdAt,
            finishedAt: lastJob.finishedAt,
            events: (
              await db.jobEvent.findMany({ where: { jobId: lastJob.id }, orderBy: { id: "desc" }, take: 6, select: { at: true, level: true, message: true } })
            ).reverse(),
          }
        : null,
    };
  });

  app.post("/fetch", async (request, reply) => {
    const running = await db.job.count({ where: { kind: JOBADS_JOB, status: { in: ["queued", "running"] } } });
    if (running > 0) throw errors.conflict("A job advert search is already running. Wait for it or cancel it.");
    const p = jobAdsParamsSchema.parse(request.body ?? {});
    const id = await createJobAdsFetch(jobs, p);
    void reply.status(202);
    return { jobId: Number(id) };
  });

  app.post("/fetch/:id/cancel", async (request) => {
    const { id } = idParam.parse(request.params);
    const job = await db.job.findUnique({ where: { id: BigInt(id) }, select: { kind: true } });
    if (job?.kind !== JOBADS_JOB) throw errors.notFound("Search not found");
    const out = await jobs.changeStatus(BigInt(id), "cancel");
    return { status: out?.status ?? null };
  });

  app.patch("/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ status: z.enum(["new", "saved", "hidden", "applied"]).optional(), note: z.string().trim().max(1000).nullable().optional() })
      .strict()
      .parse(request.body);
    const ad = await db.jobAd.findUnique({ where: { id: BigInt(id) }, select: { id: true } });
    if (!ad) throw errors.notFound("Job advert not found");
    const updated = await db.jobAd.update({
      where: { id: BigInt(id) },
      data: { ...(body.status ? { status: body.status } : {}), ...(body.note !== undefined ? { note: body.note || null } : {}) },
      select: { id: true, status: true, note: true },
    });
    return { id: Number(updated.id), status: updated.status, note: updated.note };
  });

  done();
};
