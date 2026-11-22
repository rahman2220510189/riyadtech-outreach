import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { JobStore } from "../jobs/store.js";
import { errors } from "../lib/errors.js";
import { resolveSettings } from "../settings/loader.js";
import { countryName, DIRECTORY_SOURCES, SOURCE_NAMES, STUDY_COUNTRIES } from "../study/directory.js";
import { extractFacts, hasFacts } from "../study/extract.js";
import { htmlText } from "../study/reader.js";
import { addFindings, createAiSearchJob, createCheckJob, createDirectoryJob, STUDY_AI_JOB, STUDY_CHECK_JOB, STUDY_DIR_JOB } from "../study/watch.js";

export interface StudyWatchRoutesOptions {
  db: Db;
  jobs: JobStore;
  env: { GROQ_API_KEY?: string | undefined };
}

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** University directory, the daily check, findings to review, and pasted page text. Mounted under /study. */
export const studyWatchRoutes: FastifyPluginCallback<StudyWatchRoutesOptions> = (app, opts, done) => {
  const { db, jobs, env } = opts;
  const settings = async () => resolveSettings(await db.setting.findMany()).settings;

  const jobView = (j: { id: bigint; status: string; params: unknown; summary: unknown; createdAt: Date; finishedAt: Date | null } | null) =>
    j ? { id: Number(j.id), status: j.status, label: (j.params as { label?: string })?.label ?? "", summary: j.summary ?? null, createdAt: j.createdAt, finishedAt: j.finishedAt } : null;

  /* ------------------------------ directory ------------------------------ */

  app.get("/universities", async (request) => {
    const q = z
      .object({
        country: z.string().regex(/^[A-Z]{2}$/).optional(),
        status: z.enum(["new", "found", "nothing", "unreadable", "skipped"]).optional(),
        q: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).max(500).default(1),
      })
      .parse(request.query);
    const where = {
      ...(q.country ? { countryCode: q.country } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" as const } }, { domain: { contains: q.q.toLowerCase() } }] } : {}),
    };
    const [items, total, byStatus, byCountry, bySource, lastDir, lastCheck] = await Promise.all([
      db.studyUniversity.findMany({ where, orderBy: [{ status: "asc" }, { name: "asc" }], skip: (q.page - 1) * 50, take: 50 }),
      db.studyUniversity.count({ where }),
      db.studyUniversity.groupBy({ by: ["status"], _count: { _all: true } }),
      db.studyUniversity.groupBy({ by: ["countryCode"], _count: { _all: true } }),
      db.$queryRaw<{ source: string; n: bigint }[]>`SELECT unnest(sources) AS source, count(*) AS n FROM study_universities GROUP BY 1`,
      db.job.findFirst({ where: { kind: STUDY_DIR_JOB }, orderBy: { createdAt: "desc" } }),
      db.job.findFirst({ where: { kind: STUDY_CHECK_JOB }, orderBy: { createdAt: "desc" } }),
    ]);
    const lastAi = await db.job.findFirst({ where: { kind: STUDY_AI_JOB }, orderBy: { createdAt: "desc" } });
    const s = await settings();
    return {
      items: items.map((u) => ({
        id: Number(u.id),
        name: u.name,
        country: countryName(u.countryCode),
        countryCode: u.countryCode,
        website: u.website,
        domain: u.domain,
        sources: u.sources,
        status: u.status,
        note: u.note,
        lastCheckedAt: u.lastCheckedAt,
        programId: u.programId ? Number(u.programId) : null,
      })),
      total,
      page: q.page,
      counts: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      countries: byCountry.map((r) => ({ code: r.countryCode, name: countryName(r.countryCode), n: r._count._all })).sort((a, b) => a.name.localeCompare(b.name)),
      sources: DIRECTORY_SOURCES.map((k) => ({ key: k, name: SOURCE_NAMES[k], n: Number(bySource.find((r) => r.source === k)?.n ?? 0) })),
      europe: STUDY_COUNTRIES.length,
      lastDirectoryJob: jobView(lastDir),
      lastCheckJob: jobView(lastCheck),
      lastAiJob: jobView(lastAi),
      aiConfigured: !!env.GROQ_API_KEY,
      settings: s.study,
    };
  });

  const ensureIdle = async (kind: string, what: string) => {
    const busy = await db.job.count({ where: { kind, status: { in: ["queued", "running", "paused"] } } });
    if (busy > 0) throw errors.conflict(`${what} is already running. Wait for it or cancel it on its job page.`);
  };

  app.post("/universities/refresh", async (request, reply) => {
    await ensureIdle(STUDY_DIR_JOB, "A directory refresh");
    const b = z.object({ sources: z.array(z.enum(DIRECTORY_SOURCES)).min(1).optional() }).strict().parse(request.body ?? {});
    const id = await createDirectoryJob(jobs, b.sources);
    void reply.status(202);
    return { jobId: Number(id) };
  });

  app.post("/check", async (request, reply) => {
    await ensureIdle(STUDY_CHECK_JOB, "A university check");
    const b = z.object({ newSites: z.number().int().min(0).max(300).optional() }).strict().parse(request.body ?? {});
    const id = await createCheckJob(db, jobs, await settings(), b.newSites !== undefined ? { newSites: b.newSites } : {});
    if (!id) throw errors.badRequest("Nothing to check yet: refresh the university directory first.");
    void reply.status(202);
    return { jobId: Number(id) };
  });

  app.post("/universities/:id/check", async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const u = await db.studyUniversity.findUnique({ where: { id: BigInt(id) } });
    if (!u) throw errors.notFound("University not found");
    if (u.status === "skipped") await db.studyUniversity.update({ where: { id: u.id }, data: { status: "new" } });
    const jobId = await createCheckJob(db, jobs, await settings(), { universityIds: [id] });
    void reply.status(202);
    return { jobId: Number(jobId) };
  });

  app.patch("/universities/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z.object({ status: z.enum(["new", "skipped"]) }).strict().parse(request.body);
    const u = await db.studyUniversity.update({ where: { id: BigInt(id) }, data: { status: b.status } }).catch(() => {
      throw errors.notFound("University not found");
    });
    return { id: Number(u.id), status: u.status };
  });

  app.post("/programs/:id/check", async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const p = await db.studyProgram.findUnique({ where: { id: BigInt(id) }, select: { infoUrl: true, applyUrl: true, _count: { select: { pages: true } } } });
    if (!p) throw errors.notFound("Programme not found");
    if (!p.infoUrl && !p.applyUrl && p._count.pages === 0) throw errors.badRequest("Add the official page (Edit → information or application page) first.");
    const jobId = await createCheckJob(db, jobs, await settings(), { programIds: [id] });
    void reply.status(202);
    return { jobId: Number(jobId) };
  });

  /** Scholarship search with AI for chosen countries now (each proposal is checked on its official page). */
  app.post("/ai-search", async (request, reply) => {
    if (!env.GROQ_API_KEY) throw errors.badRequest("GROQ_API_KEY is not set in backend/.env.");
    await ensureIdle(STUDY_AI_JOB, "A scholarship search");
    const b = z.object({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(5) }).strict().parse(request.body);
    const id = await createAiSearchJob(jobs, b.countries);
    void reply.status(202);
    return { jobId: Number(id) };
  });

  /* ------------------------------ findings ------------------------------ */

  app.get("/findings", async (request) => {
    const q = z
      .object({ status: z.enum(["new", "accepted", "dismissed"]).default("new"), programId: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    const rows = await db.studyFinding.findMany({
      where: { status: q.status, ...(q.programId ? { programId: BigInt(q.programId) } : {}) },
      include: { program: { select: { id: true, name: true, country: true, origin: true } } },
      orderBy: [{ createdAt: "desc" }],
      take: 300,
    });
    const total = await db.studyFinding.count({ where: { status: "new" } });
    return {
      items: rows.map((f) => ({
        id: Number(f.id),
        programId: Number(f.programId),
        program: f.program.name,
        country: f.program.country,
        origin: f.program.origin,
        type: f.type,
        value: f.value,
        label: f.label,
        snippet: f.snippet,
        url: f.url,
        status: f.status,
        createdAt: f.createdAt,
      })),
      newTotal: total,
    };
  });

  /** Accept: the fact goes into the programme (a confirmed date, the minimum IELTS, "MOI accepted", the address). */
  app.post("/findings/:id/accept", async (request) => {
    const { id } = idParam.parse(request.params);
    const f = await db.studyFinding.findUnique({ where: { id: BigInt(id) } });
    if (!f) throw errors.notFound("Finding not found");
    if (f.status !== "new") return { id, status: f.status };
    const b = z.object({ label: z.string().trim().min(2).max(200).optional() }).strict().parse(request.body ?? {});
    await db.$transaction(async (tx) => {
      if (f.type === "deadline") {
        await tx.studyDeadline.create({
          data: { programId: f.programId, label: b.label ?? f.label ?? "Application deadline", kind: "deadline", dueOn: new Date(`${f.value}T00:00:00Z`), confirmed: true, note: `From ${f.url}` },
        });
      } else if (f.type === "ielts") {
        await tx.studyProgram.update({ where: { id: f.programId }, data: { minIelts: Number(f.value) } });
      } else if (f.type === "moi") {
        await tx.studyProgram.update({ where: { id: f.programId }, data: { englishRequirement: "moi_ok" } });
      } else if (f.type === "email") {
        await tx.studyProgram.update({ where: { id: f.programId }, data: { contactEmail: f.value } });
      }
      await tx.studyFinding.update({ where: { id: f.id }, data: { status: "accepted", decidedAt: new Date() } });
    });
    return { id, status: "accepted" };
  });

  app.post("/findings/:id/dismiss", async (request) => {
    const { id } = idParam.parse(request.params);
    const f = await db.studyFinding.update({ where: { id: BigInt(id) }, data: { status: "dismissed", decidedAt: new Date() } }).catch(() => {
      throw errors.notFound("Finding not found");
    });
    return { id: Number(f.id), status: f.status };
  });

  /* ------------------------------ pasted text ------------------------------ */

  /** When a page cannot be read by the tool: I open it, copy its text (or HTML) and paste it here. */
  app.post("/programs/:id/paste", { bodyLimit: 3 * 1024 * 1024 }, async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z.object({ text: z.string().min(20).max(2_000_000), url: z.url().max(500).optional() }).strict().parse(request.body);
    const program = await db.studyProgram.findUnique({ where: { id: BigInt(id) } });
    if (!program) throw errors.notFound("Programme not found");
    const text = /<html|<body|<div|<p[\s>]/i.test(b.text.slice(0, 5000)) ? htmlText(b.text) : b.text;
    const facts = extractFacts(text);
    const url = b.url ?? program.infoUrl ?? program.applyUrl ?? "pasted text";
    let pageId: bigint | null = null;
    if (b.url) {
      const page = await db.studyPage.upsert({
        where: { url: b.url },
        create: { url: b.url, programId: program.id, lastStatus: "pasted", extracted: facts as unknown as Prisma.InputJsonValue, lastFetchedAt: new Date() },
        update: { programId: program.id, lastStatus: "pasted", extracted: facts as unknown as Prisma.InputJsonValue, lastFetchedAt: new Date() },
      });
      pageId = page.id;
    }
    const added = hasFacts(facts) || facts.emails.length ? await addFindings(db, program, { id: pageId, url }, facts) : 0;
    return { added, facts };
  });

  done();
};
