import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { resolveArea } from "../finder/area.js";
import { createFinderJob } from "../finder/jobs.js";
import { finderParamsSchema } from "../finder/params.js";
import { checkStorage } from "../finder/storage.js";
import { FINDER_JOB } from "../finder/tasks.js";
import type { JobStore } from "../jobs/store.js";
import { FatalTaskError } from "../jobs/types.js";
import { AppError, errors } from "../lib/errors.js";
import { loadSeedData } from "../seed/files.js";
import { resolveSettings } from "../settings/loader.js";

export interface FinderRoutesOptions {
  db: Db;
  jobs: JobStore;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  kind: z.enum(["finder", "geonames", "crawl"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Overture Maps data (CDLA Permissive 2.0) and GeoNames (CC BY 4.0) need attribution. */
export const DATA_SOURCES = [
  {
    name: "Overture Maps Foundation",
    use: "Places and area outlines",
    licence: "CDLA Permissive 2.0 (places also include data under other open licences; see Overture's attribution page)",
    url: "https://docs.overturemaps.org/attribution/",
  },
  { name: "GeoNames", use: "Regions, cities and time zones", licence: "CC BY 4.0", url: "https://www.geonames.org/" },
];

export const finderRoutes: FastifyPluginCallback<FinderRoutesOptions> = (app, { db, jobs }, done) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/categories", () => {
    const seed = loadSeedData();
    return {
      taxonomyRelease: seed.taxonomyRelease,
      items: seed.categories.map((c) => ({ key: c.key, segment: c.segment, label: c.label, value: c.value, nodes: c.nodes })),
      dataSources: DATA_SOURCES,
    };
  });

  /** Validates the area now (clear error at once) and creates the job. */
  const create = async (body: unknown, dryRun: boolean) => {
    const params = finderParamsSchema.parse(body);
    try {
      const area = await resolveArea(db, params);
      return Number(await createFinderJob(jobs, params, dryRun, area.label));
    } catch (err) {
      if (err instanceof FatalTaskError) throw errors.badRequest(err.message);
      throw err;
    }
  };

  app.post("/estimate", async (request, reply) => {
    const jobId = await create(request.body, true);
    void reply.status(202);
    return { jobId };
  });

  app.post("/jobs", async (request, reply) => {
    const jobId = await create(request.body, false);
    void reply.status(202);
    return { jobId };
  });

  app.get("/jobs", async (request) => {
    const q = listQuery.parse(request.query);
    const where = q.kind ? { kind: q.kind } : { kind: { in: [FINDER_JOB, "geonames", "crawl"] } };
    const [total, rows] = await Promise.all([
      db.job.count({ where }),
      db.job.findMany({ where, orderBy: { id: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const items = await Promise.all(
      rows.map(async (j) => ({
        id: Number(j.id),
        kind: j.kind,
        status: j.status,
        dryRun: j.dryRun,
        params: j.params,
        summary: j.summary ?? (j.status === "running" || j.status === "paused" ? await jobs.summarize(j.id, j.kind) : null),
        error: j.error,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
      })),
    );
    return { items, page: q.page, pageSize: q.pageSize, total };
  });

  app.get("/jobs/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const job = await db.job.findUnique({ where: { id: BigInt(id) } });
    if (!job) throw errors.notFound("Job not found");
    const [byStatus, events] = await Promise.all([
      db.jobTask.groupBy({ by: ["status"], where: { jobId: job.id }, _count: { _all: true } }),
      db.jobEvent.findMany({ where: { jobId: job.id }, orderBy: { id: "desc" }, take: 200 }),
    ]);
    const tasks = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
    const summary = (job.summary ?? (await jobs.summarize(job.id, job.kind))) as Record<string, unknown> | null;
    // An estimate also says how big the database would get (Neon free plan: 1 GB).
    const kept = typeof summary?.kept === "number" ? summary.kept : 0;
    const storage =
      job.kind === FINDER_JOB && job.dryRun && job.status === "done" && kept > 0
        ? await checkStorage(db, kept, resolveSettings(await db.setting.findMany()).settings.storage.limitMb)
        : null;
    return {
      id: Number(job.id),
      kind: job.kind,
      status: job.status,
      dryRun: job.dryRun,
      params: job.params,
      summary,
      storage,
      error: job.error,
      tasks,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      events: events.map((e) => ({ id: Number(e.id), at: e.at, level: e.level, message: e.message, data: e.data })),
    };
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/jobs/:id/${action}`, async (request) => {
      const { id } = idParam.parse(request.params);
      const out = await jobs.changeStatus(BigInt(id), action);
      if (!out) throw errors.notFound("Job not found");
      const expected = { pause: "paused", resume: "running", cancel: "cancelled" }[action];
      const verb = { pause: "paused", resume: "resumed", cancel: "cancelled" }[action];
      if (out.status !== expected) throw new AppError(409, "CONFLICT", `The job is ${out.status}; it cannot be ${verb}.`);
      if (out.changed) await jobs.event(BigInt(id), "info", `Job ${verb} by ${request.admin?.email ?? "admin"}`);
      return { status: out.status };
    });
  }

  /** How many places are saved, by country and segment. */
  app.get("/places/stats", async () => {
    const rows = await db.place.groupBy({ by: ["country", "segment"], _count: { _all: true } });
    return { items: rows.map((r) => ({ country: r.country, segment: r.segment, places: r._count._all })) };
  });

  done();
};
