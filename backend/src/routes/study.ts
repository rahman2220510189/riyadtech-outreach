import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { normalizeEmail } from "../crawler/emails.js";
import type { Db } from "../db/client.js";
import type { Prisma, StudyEmail, StudyProfile, StudyProgram } from "../generated/prisma/client.js";
import { suppressedSet } from "../leads/suppression.js";
import { AppError, errors } from "../lib/errors.js";
import { waitingMessageIds } from "../mail/outbox.js";
import { ownAddresses, sendLogged } from "../mail/send.js";
import { resolveSettings } from "../settings/loader.js";
import { type FitProfile, subjectFit, suggestedSubjects } from "../study/fit.js";
import { aiConfigured, chat, draftEmail, draftLetter, letterChecks, letterGaps } from "../study/ai.js";
import {
  DOC_KINDS,
  DOC_LABELS,
  docLabel,
  heldDocs,
  type DocKind,
  ENGLISH_REQUIREMENTS,
  englishFit,
  LEVELS,
  PROGRAM_STATUSES,
  requiredDocsFor,
} from "../study/definitions.js";

export interface StudyRoutesOptions {
  db: Db;
  env: Pick<Env, "ENCRYPTION_KEY" | "SENDING_ENABLED" | "GROQ_API_KEY" | "GROQ_MODEL" | "MAIL_DELIVERY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "PUBLIC_BASE_URL">;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const MAX_DOC = 8 * 1024 * 1024;
const MAX_ATTACH_TOTAL = 20 * 1024 * 1024;
const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const PLACEHOLDER = /\[\[[\s\S]*?\]\]/;
const DAY = 24 * 3600_000;
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const url = z.url().max(500).nullable().optional();

function today(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const daysLeft = (d: Date) => Math.round((d.getTime() - today().getTime()) / DAY);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const num = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));

function profileView(p: StudyProfile) {
  return {
    fullName: p.fullName,
    nationality: p.nationality,
    dateOfBirth: iso(p.dateOfBirth),
    phone: p.phone,
    targetLevel: p.targetLevel,
    targetFields: p.targetFields,
    bscSubject: p.bscSubject,
    bscUniversity: p.bscUniversity,
    bscCgpa: num(p.bscCgpa),
    bscCgpaScale: Number(p.bscCgpaScale),
    bscYear: p.bscYear,
    hscGpa: num(p.hscGpa),
    hscYear: p.hscYear,
    sscGpa: num(p.sscGpa),
    sscYear: p.sscYear,
    englishMedium: p.englishMedium,
    ieltsScore: num(p.ieltsScore),
    duolingoScore: p.duolingoScore,
    passportStatus: p.passportStatus,
    passportExpiry: iso(p.passportExpiry),
    workExperience: p.workExperience,
    aboutMe: p.aboutMe,
  };
}

/** Everything I study-apply with, in one place: profile, documents, programmes with dates, e-mails. */
export const studyRoutes: FastifyPluginCallback<StudyRoutesOptions> = (app, { db, env }, done) => {
  app.addHook("preHandler", app.authenticate);

  const profile = async () => db.studyProfile.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  const docKinds = async () => heldDocs((await db.studyDocument.findMany({ select: { kind: true } })).map((d) => d.kind));

  /**
   * Is the application open now?
   * - open: an "opens" date has passed and a deadline is still ahead
   * - likely_open: a deadline is ahead within 90 days and no opening date is known (or one found on the website, not yet confirmed)
   * - opens_soon: the opening date is within 60 days
   */
  function applicationWindow(deadlines: { kind: string; dueOn: Date; done: boolean }[], foundDeadline?: string) {
    const live = deadlines.filter((d) => !d.done);
    const nextDeadline = live.filter((d) => d.kind === "deadline" && daysLeft(d.dueOn) >= 0).sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime())[0];
    const opens = live.filter((d) => d.kind === "opens").sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime());
    const opened = opens.filter((d) => daysLeft(d.dueOn) <= 0).at(-1);
    const upcoming = opens.find((d) => daysLeft(d.dueOn) > 0);
    if (nextDeadline && opened && (!upcoming || upcoming.dueOn > nextDeadline.dueOn)) return { state: "open" as const, deadline: iso(nextDeadline.dueOn), daysLeft: daysLeft(nextDeadline.dueOn) };
    if (upcoming && daysLeft(upcoming.dueOn) <= 60) return { state: "opens_soon" as const, opensOn: iso(upcoming.dueOn), daysLeft: daysLeft(upcoming.dueOn) };
    if (nextDeadline && !upcoming && daysLeft(nextDeadline.dueOn) <= 90) return { state: "likely_open" as const, deadline: iso(nextDeadline.dueOn), daysLeft: daysLeft(nextDeadline.dueOn) };
    if (!nextDeadline && foundDeadline) {
      const left = daysLeft(new Date(`${foundDeadline}T00:00:00Z`));
      if (left >= 0 && left <= 120) return { state: "likely_open" as const, deadline: foundDeadline, daysLeft: left, fromWebsite: true };
    }
    return null;
  }

  const fitProfile = (prof: StudyProfile): FitProfile => ({
    bscSubject: prof.bscSubject,
    targetFields: prof.targetFields,
    workExperience: prof.workExperience,
    aboutMe: prof.aboutMe,
    bscCgpa: prof.bscCgpa === null ? null : Number(prof.bscCgpa),
    bscCgpaScale: Number(prof.bscCgpaScale),
  });

  function programView(p: StudyProgram & { deadlines?: { id: bigint; label: string; kind: string; dueOn: Date; confirmed: boolean; done: boolean; note: string | null }[] }, prof: StudyProfile, have: Set<DocKind>, foundDeadline?: string) {
    const needed = requiredDocsFor(p, prof);
    const open = (p.deadlines ?? []).filter((d) => !d.done && daysLeft(d.dueOn) >= -3).sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime());
    const next = open.find((d) => d.kind === "deadline") ?? open[0] ?? null;
    return {
      id: Number(p.id),
      name: p.name,
      kind: p.kind,
      country: p.country,
      university: p.university,
      level: p.level,
      field: p.field,
      englishRequirement: p.englishRequirement,
      minIelts: num(p.minIelts),
      funding: p.funding,
      costs: p.costs,
      workWhileStudying: p.workWhileStudying,
      applyUrl: p.applyUrl,
      infoUrl: p.infoUrl,
      contactEmail: p.contactEmail,
      requiredDocs: p.requiredDocs,
      howToApply: p.howToApply,
      notes: p.notes,
      status: p.status,
      verified: p.verified,
      seedKey: p.seedKey,
      origin: p.origin,
      english: englishFit(p, prof),
      docsNeeded: needed.map((k) => ({ kind: k, label: docLabel(k, have), have: have.has(k) })),
      docsMissing: needed.filter((k) => !have.has(k)).length,
      window: applicationWindow(p.deadlines ?? [], foundDeadline),
      subjectFit: subjectFit(p, fitProfile(prof)),
      nextDate: next ? { id: Number(next.id), label: next.label, kind: next.kind, dueOn: iso(next.dueOn), daysLeft: daysLeft(next.dueOn), confirmed: next.confirmed } : null,
      deadlines: (p.deadlines ?? [])
        .sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime())
        .map((d) => ({ id: Number(d.id), label: d.label, kind: d.kind, dueOn: iso(d.dueOn), daysLeft: daysLeft(d.dueOn), confirmed: d.confirmed, done: d.done, note: d.note })),
      updatedAt: p.updatedAt,
    };
  }

  /* ---------------------------------- profile ---------------------------------- */

  const profileSchema = z
    .object({
      fullName: z.string().trim().max(120),
      nationality: z.string().trim().min(2).max(60),
      dateOfBirth: z.iso.date().nullable(),
      phone: nullableText(40),
      targetLevel: z.enum(LEVELS),
      targetFields: z.array(z.string().trim().min(1).max(80)).max(10),
      bscSubject: nullableText(120),
      bscUniversity: nullableText(160),
      bscCgpa: z.number().min(0).max(10).nullable(),
      bscCgpaScale: z.number().min(1).max(10),
      bscYear: z.number().int().min(1990).max(2035).nullable(),
      hscGpa: z.number().min(0).max(5).nullable(),
      hscYear: z.number().int().min(1990).max(2035).nullable(),
      sscGpa: z.number().min(0).max(5).nullable(),
      sscYear: z.number().int().min(1990).max(2035).nullable(),
      englishMedium: z.boolean(),
      ieltsScore: z.number().min(0).max(9).multipleOf(0.5).nullable(),
      duolingoScore: z.number().int().min(10).max(160).nullable(),
      passportStatus: z.enum(["none", "applied", "ready"]),
      passportExpiry: z.iso.date().nullable(),
      workExperience: nullableText(2000),
      aboutMe: nullableText(3000),
    })
    .partial()
    .strict();

  app.get("/profile", async () => profileView(await profile()));

  app.put("/profile", async (request) => {
    const b = profileSchema.parse(request.body);
    const data: Prisma.StudyProfileUpdateInput = {
      ...b,
      ...(b.dateOfBirth !== undefined ? { dateOfBirth: b.dateOfBirth ? new Date(`${b.dateOfBirth}T00:00:00Z`) : null } : {}),
      ...(b.passportExpiry !== undefined ? { passportExpiry: b.passportExpiry ? new Date(`${b.passportExpiry}T00:00:00Z`) : null } : {}),
    };
    await profile();
    return profileView(await db.studyProfile.update({ where: { id: 1 }, data }));
  });

  /* --------------------------------- documents --------------------------------- */

  app.get("/documents", async () => {
    const rows = await db.studyDocument.findMany({ select: { id: true, kind: true, label: true, fileName: true, mime: true, size: true, createdAt: true }, orderBy: [{ kind: "asc" }, { id: "desc" }] });
    return {
      items: rows.map((r) => ({ ...r, id: Number(r.id), kindLabel: DOC_LABELS[r.kind as DocKind] ?? r.kind })),
      kinds: DOC_KINDS.map((k) => ({ kind: k, label: DOC_LABELS[k] })),
    };
  });

  app.post("/documents", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const b = z
      .object({ kind: z.enum(DOC_KINDS), label: z.string().trim().max(120).optional(), fileName: z.string().trim().min(1).max(200), dataBase64: z.string().min(10) })
      .strict()
      .parse(request.body);
    const ext = b.fileName.toLowerCase().split(".").pop() ?? "";
    const mime = MIME[ext];
    if (!mime) throw errors.badRequest("Upload a PDF, a photo (JPG, PNG) or a Word file. PDF is best for certificates and marksheets.");
    const data = Buffer.from(b.dataBase64, "base64");
    if (data.length === 0 || data.length > MAX_DOC) throw errors.badRequest("The file must be at most 8 MB. Scan at 150–200 dpi, or compress the PDF.");
    if (ext === "pdf" && data.subarray(0, 5).toString("latin1") !== "%PDF-") throw errors.badRequest("This is not a PDF file");
    const d = await db.studyDocument.create({
      data: { kind: b.kind, label: b.label || DOC_LABELS[b.kind], fileName: b.fileName.replace(/[\\/:*?"<>|]+/g, "_"), mime, size: data.length, data },
    });
    void reply.status(201);
    return { id: Number(d.id), kind: d.kind, label: d.label, fileName: d.fileName, mime: d.mime, size: d.size, createdAt: d.createdAt };
  });

  app.get("/documents/:id/download", async (request, reply) => {
    const d = await db.studyDocument.findUnique({ where: { id: BigInt(idParam.parse(request.params).id) } });
    if (!d) throw errors.notFound("Document not found");
    void reply.header("content-type", d.mime).header("content-disposition", `inline; filename="${d.fileName.replace(/"/g, "")}"`);
    return Buffer.from(d.data);
  });

  app.patch("/documents/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const b = z.object({ label: z.string().trim().min(1).max(120).optional(), kind: z.enum(DOC_KINDS).optional() }).strict().parse(request.body);
    const d = await db.studyDocument.update({ where: { id: BigInt(id) }, data: b, select: { id: true, kind: true, label: true } }).catch(() => {
      throw errors.notFound("Document not found");
    });
    return { ...d, id: Number(d.id) };
  });

  app.delete("/documents/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    await db.studyDocument.delete({ where: { id: BigInt(id) } }).catch(() => {
      throw errors.notFound("Document not found");
    });
    return { deleted: id };
  });

  /* --------------------------------- programmes -------------------------------- */

  const programSchema = z
    .object({
      name: z.string().trim().min(2).max(160),
      kind: z.enum(["scholarship", "programme"]),
      country: z.string().trim().min(2).max(80),
      university: nullableText(160),
      level: z.enum(LEVELS),
      field: nullableText(120),
      englishRequirement: z.enum(ENGLISH_REQUIREMENTS),
      minIelts: z.number().min(0).max(9).multipleOf(0.5).nullable(),
      funding: nullableText(1000),
      costs: nullableText(1000),
      workWhileStudying: nullableText(1000),
      applyUrl: url,
      infoUrl: url,
      contactEmail: z.email().max(200).nullable().optional(),
      requiredDocs: z.array(z.enum(DOC_KINDS)).max(20),
      howToApply: nullableText(3000),
      notes: nullableText(3000),
      status: z.enum(PROGRAM_STATUSES),
      verified: z.boolean(),
    })
    .partial()
    .strict();

  app.get("/programs", async (request) => {
    const q = z
      .object({
        status: z.enum([...PROGRAM_STATUSES, "active", "all"]).default("active"),
        level: z.enum(["bachelor", "master"]).optional(),
        fit: z.enum(["yes", "maybe", "no"]).optional(),
        country: z.string().trim().max(80).optional(),
        origin: z.enum(["seed", "manual", "auto"]).optional(),
        open: z.enum(["1"]).optional(),
        sort: z.enum(["date", "fit"]).default("date"),
      })
      .parse(request.query);
    const [prof, have] = await Promise.all([profile(), docKinds()]);
    const where: Prisma.StudyProgramWhereInput = {
      ...(q.status === "active" ? { status: { notIn: ["rejected", "not_now"] } } : q.status === "all" ? {} : { status: q.status }),
      ...(q.level ? { level: { in: [q.level, "both"] } } : {}),
      ...(q.country ? { country: { contains: q.country, mode: "insensitive" } } : {}),
      ...(q.origin ? { origin: q.origin } : {}),
    };
    const rows = await db.studyProgram.findMany({ where, include: { deadlines: true }, orderBy: { id: "asc" } });
    const open = new Map(
      (await db.studyFinding.groupBy({ by: ["programId"], where: { status: "new" }, _count: { _all: true } })).map((r) => [Number(r.programId), r._count._all]),
    );
    // Dates found on university websites but not yet accepted count as a hint for "probably open".
    const found = new Map(
      (
        await db.$queryRaw<{ program_id: bigint; d: string }[]>`
          SELECT program_id, min(value) AS d FROM study_findings
          WHERE type = 'deadline' AND status = 'new' AND value >= to_char(now(), 'YYYY-MM-DD') GROUP BY program_id`
      ).map((r) => [Number(r.program_id), r.d]),
    );
    let items = rows.map((p) => ({ ...programView(p, prof, have, found.get(Number(p.id))), newFindings: open.get(Number(p.id)) ?? 0 }));
    if (q.open) items = items.filter((p) => p.window && p.window.state !== "opens_soon");
    if (q.sort === "fit") {
      const rank = { strong: 0, any: 1, related: 2, weak: 3 } as const;
      // Best subject match first; within a level, fewer problems (CGPA, work experience) first, then the nearest date.
      items.sort(
        (a, b) =>
          rank[a.subjectFit.level] - rank[b.subjectFit.level] ||
          a.subjectFit.warnings.length - b.subjectFit.warnings.length ||
          (a.nextDate?.daysLeft ?? 99_999) - (b.nextDate?.daysLeft ?? 99_999),
      );
      return { items };
    }
    if (q.fit) items = items.filter((i) => i.english.fit === q.fit);
    // Soonest date first, then those without a date.
    items.sort((a, b) => (a.nextDate?.daysLeft ?? 99_999) - (b.nextDate?.daysLeft ?? 99_999));
    return { items };
  });

  app.get("/programs/:id", async (request) => {
    const p = await db.studyProgram.findUnique({ where: { id: BigInt(idParam.parse(request.params).id) }, include: { deadlines: true } });
    if (!p) throw errors.notFound("Programme not found");
    const emails = await db.studyEmail.findMany({ where: { programId: p.id }, orderBy: { updatedAt: "desc" }, select: { id: true, purpose: true, subject: true, status: true, toEmail: true, sentAt: true, updatedAt: true } });
    return { ...programView(p, await profile(), await docKinds()), emails: emails.map((e) => ({ ...e, id: Number(e.id) })) };
  });

  app.post("/programs", async (request, reply) => {
    const b = programSchema.required({ name: true, country: true }).parse(request.body);
    const p = await db.studyProgram.create({ data: { ...b, contactEmail: b.contactEmail ? normalizeEmail(b.contactEmail) : null } });
    void reply.status(201);
    return programView({ ...p, deadlines: [] }, await profile(), await docKinds());
  });

  app.patch("/programs/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const b = programSchema.parse(request.body);
    const p = await db.studyProgram
      .update({ where: { id: BigInt(id) }, data: { ...b, ...(b.contactEmail !== undefined ? { contactEmail: b.contactEmail ? normalizeEmail(b.contactEmail) : null } : {}) }, include: { deadlines: true } })
      .catch(() => {
        throw errors.notFound("Programme not found");
      });
    return programView(p, await profile(), await docKinds());
  });

  app.delete("/programs/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const p = await db.studyProgram.findUnique({ where: { id: BigInt(id) } });
    if (!p) throw errors.notFound("Programme not found");
    // A university found automatically is not turned into a programme again.
    await db.studyUniversity.updateMany({ where: { programId: p.id }, data: { status: "skipped", note: "Programme deleted by me" } });
    await db.studyProgram.delete({ where: { id: p.id } });
    if (p.seedKey) {
      const row = await db.setting.findUnique({ where: { key: "study.deletedSeeds" } });
      const list = new Set(Array.isArray(row?.value) ? (row.value as string[]) : []);
      list.add(p.seedKey);
      await db.setting.upsert({ where: { key: "study.deletedSeeds" }, create: { key: "study.deletedSeeds", value: [...list] }, update: { value: [...list] } });
    }
    return { deleted: id };
  });

  /* ---------------------------------- dates ---------------------------------- */

  const deadlineSchema = z
    .object({
      label: z.string().trim().min(2).max(200),
      kind: z.enum(["deadline", "opens", "reminder"]),
      dueOn: z.iso.date(),
      confirmed: z.boolean(),
      done: z.boolean(),
      note: nullableText(1000),
    })
    .partial()
    .strict();

  app.post("/programs/:id/deadlines", async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const b = deadlineSchema.required({ label: true, dueOn: true }).parse(request.body);
    if (!(await db.studyProgram.findUnique({ where: { id: BigInt(id) }, select: { id: true } }))) throw errors.notFound("Programme not found");
    const d = await db.studyDeadline.create({ data: { ...b, programId: BigInt(id), dueOn: new Date(`${b.dueOn}T00:00:00Z`) } });
    void reply.status(201);
    return { id: Number(d.id) };
  });

  app.patch("/deadlines/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const b = deadlineSchema.parse(request.body);
    const d = await db.studyDeadline
      .update({ where: { id: BigInt(id) }, data: { ...b, ...(b.dueOn ? { dueOn: new Date(`${b.dueOn}T00:00:00Z`) } : {}) } })
      .catch(() => {
        throw errors.notFound("Date not found");
      });
    return { id: Number(d.id), done: d.done };
  });

  app.delete("/deadlines/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    await db.studyDeadline.delete({ where: { id: BigInt(id) } }).catch(() => {
      throw errors.notFound("Date not found");
    });
    return { deleted: id };
  });

  /** Open dates in the next N days (and up to 3 days overdue), soonest first: the notification bar. */
  app.get("/upcoming", async (request) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(120) }).parse(request.query);
    const rows = await db.studyDeadline.findMany({
      where: {
        done: false,
        dueOn: { gte: new Date(today().getTime() - 3 * DAY), lte: new Date(today().getTime() + q.days * DAY) },
        program: { status: { notIn: ["rejected", "not_now", "accepted"] } },
      },
      include: { program: { select: { id: true, name: true } } },
      orderBy: { dueOn: "asc" },
      take: 20,
    });
    return {
      items: rows.map((d) => ({
        id: Number(d.id),
        programId: Number(d.program.id),
        program: d.program.name,
        label: d.label,
        kind: d.kind,
        dueOn: iso(d.dueOn),
        daysLeft: daysLeft(d.dueOn),
        confirmed: d.confirmed,
      })),
    };
  });

  /** The study start page: what to do next, in plain words. */
  app.get("/overview", async () => {
    const [prof, docs, programs] = await Promise.all([
      profile(),
      db.studyDocument.findMany({ select: { kind: true } }),
      db.studyProgram.findMany({ where: { status: { notIn: ["rejected", "not_now"] } }, include: { deadlines: true } }),
    ]);
    const have = heldDocs(docs.map((d) => d.kind));
    const views = programs.map((p) => programView(p, prof, have));
    const steps: { id: string; text: string; link: string; urgent: boolean }[] = [];
    const missingProfile = [
      !prof.fullName && "your full name",
      !prof.bscSubject && prof.targetLevel !== "bachelor" && "your BSc subject",
      !prof.bscCgpa && prof.targetLevel !== "bachelor" && "your CGPA",
    ].filter(Boolean);
    if (missingProfile.length) steps.push({ id: "profile", text: `Fill in your profile: ${missingProfile.join(", ")}.`, link: "/study/profile", urgent: false });
    const soonest = views.filter((v) => v.nextDate && v.nextDate.kind === "deadline").sort((a, b) => a.nextDate!.daysLeft - b.nextDate!.daysLeft)[0];
    if (prof.passportStatus !== "ready") {
      steps.push({
        id: "passport",
        text: `Get your passport${soonest ? ` — you need it for ${soonest.name} (${soonest.nextDate!.daysLeft} days left)` : ""}.`,
        link: "/study/profile",
        urgent: !!soonest && soonest.nextDate!.daysLeft <= 60,
      });
    }
    // Documents needed by the most programmes first.
    const need = new Map<DocKind, string[]>();
    for (const v of views) for (const d of v.docsNeeded) if (!d.have && d.kind !== "passport") need.set(d.kind, [...(need.get(d.kind) ?? []), v.name]);
    for (const [kind, names] of [...need.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const hint =
        kind === "moi_letter"
          ? " Ask your university's registrar office for a “Medium of Instruction” certificate."
          : kind === "motivation_letter"
            ? " One page about why this subject, this country and your plans."
            : kind === "recommendation"
              ? " Ask a teacher or your supervisor early."
              : "";
      steps.push({ id: `doc-${kind}`, text: `Upload: ${DOC_LABELS[kind]} (needed for ${names.length} option${names.length > 1 ? "s" : ""}).${hint}`, link: "/study/documents", urgent: false });
    }
    for (const v of views) {
      if (v.nextDate && v.nextDate.daysLeft <= 30 && v.nextDate.daysLeft >= -3 && !["applied", "interview", "accepted"].includes(v.status)) {
        steps.push({ id: `date-${v.id}`, text: `${v.name}: ${v.nextDate.label} on ${v.nextDate.dueOn} (${v.nextDate.daysLeft} days).`, link: `/study/programs/${v.id}`, urgent: v.nextDate.daysLeft <= 14 });
      }
      if (!v.verified && ["preparing"].includes(v.status)) steps.push({ id: `verify-${v.id}`, text: `${v.name}: check the dates on the official page and mark it as checked.`, link: `/study/programs/${v.id}`, urgent: false });
    }
    const findings = await db.studyFinding.count({ where: { status: "new" } });
    if (findings > 0) steps.push({ id: "findings", text: `${findings} new fact${findings === 1 ? "" : "s"} found on university websites: check and accept or dismiss them.`, link: "/study/updates", urgent: false });
    steps.sort((a, b) => Number(b.urgent) - Number(a.urgent));
    const counts = Object.fromEntries(PROGRAM_STATUSES.map((s) => [s, 0])) as Record<string, number>;
    for (const p of await db.studyProgram.groupBy({ by: ["status"], _count: { _all: true } })) counts[p.status] = p._count._all;
    const sentEmails = await db.studyEmail.count({ where: { status: "sent" } });
    const openNow = views
      .filter((v) => v.window && !["applied", "interview", "accepted"].includes(v.status))
      .map((v) => ({ id: v.id, name: v.name, country: v.country, applyUrl: v.applyUrl, window: v.window! }))
      .sort((a, b) => (a.window.state === "opens_soon" ? 1 : 0) - (b.window.state === "opens_soon" ? 1 : 0) || a.window.daysLeft - b.window.daysLeft);
    const subjects = suggestedSubjects(fitProfile(prof));
    const bestMatches = views
      .filter((v) => v.subjectFit.level === "strong" && v.subjectFit.warnings.length === 0 && !["applied", "interview", "accepted"].includes(v.status))
      .sort((a, b) => (a.nextDate?.daysLeft ?? 99_999) - (b.nextDate?.daysLeft ?? 99_999))
      .slice(0, 8)
      .map((v) => ({ id: v.id, name: v.name, country: v.country, reason: v.subjectFit.reasons[0] ?? "", window: v.window }));
    return { steps, counts, documents: docs.length, sentEmails, findings, openNow, subjects, bestMatches, ai: { configured: aiConfigured(env), model: env.GROQ_MODEL } };
  });

  /* ----------------------------------- AI ----------------------------------- */

  app.post("/ai/test", async () => {
    const started = Date.now();
    const answer = await chat(env, [
      { role: "system", content: "Answer with one short sentence." },
      { role: "user", content: "Say that the connection works." },
    ]);
    return { ok: true, model: env.GROQ_MODEL, answer: answer.slice(0, 200), ms: Date.now() - started };
  });

  /* ---------------------------------- e-mails ---------------------------------- */

  const emailView = (e: StudyEmail & { program?: { id: bigint; name: string } | null }, waiting = false) => ({
    id: Number(e.id),
    programId: e.programId ? Number(e.programId) : null,
    program: e.program?.name ?? null,
    purpose: e.purpose,
    toEmail: e.toEmail,
    mailboxId: e.mailboxId ? Number(e.mailboxId) : null,
    subject: e.subject,
    body: e.body,
    documentIds: e.documentIds.map(Number),
    aiModel: e.aiModel,
    status: e.status,
    sentAt: e.sentAt,
    error: e.error,
    hasPlaceholders: PLACEHOLDER.test(`${e.subject}\n${e.body}`),
    /** Sent from the tool, but still waiting in the outbox for my PC. */
    waiting,
    updatedAt: e.updatedAt,
  });
  const findEmail = async (id: number) => {
    const e = await db.studyEmail.findUnique({ where: { id: BigInt(id) }, include: { program: { select: { id: true, name: true } } } });
    if (!e) throw errors.notFound("E-mail not found");
    return e;
  };

  function aiFacts(prof: StudyProfile, p: StudyProgram | null, purpose: "inquiry" | "application" | "follow_up", attachments: string[], extra?: string) {
    return {
      purpose,
      profile: {
        fullName: prof.fullName || null,
        nationality: prof.nationality,
        applyingFor: prof.targetLevel === "both" ? "bachelor or master" : prof.targetLevel,
        bscSubject: prof.bscSubject,
        bscUniversity: prof.bscUniversity,
        bscCgpa: prof.bscCgpa ? `${Number(prof.bscCgpa)} out of ${Number(prof.bscCgpaScale)}` : null,
        bscYear: prof.bscYear,
        hscGpa: prof.hscGpa ? `${Number(prof.hscGpa)} out of 5` : null,
        degreeTaughtInEnglish: prof.englishMedium,
        ielts: prof.ieltsScore ? Number(prof.ieltsScore) : null,
        duolingo: prof.duolingoScore,
        workExperience: prof.workExperience,
        aboutMe: prof.aboutMe,
        fieldsOfInterest: prof.targetFields.join(", ") || null,
      },
      program: {
        name: p?.name ?? null,
        university: p?.university ?? null,
        country: p?.country ?? null,
        level: p?.level ?? null,
        field: p?.field ?? null,
      },
      attachments,
      extra,
    };
  }

  /* ---------------------------- Motivation letter (one per programme) ---------------------------- */

  const letterView = (
    l: { id: bigint; programId: bigint; title: string; body: string; notes: string | null; target: string | null; length: string; aiModel: string | null; updatedAt: Date },
    factsText: string,
  ) => ({
    id: Number(l.id),
    programId: Number(l.programId),
    title: l.title,
    body: l.body,
    notes: l.notes,
    target: l.target,
    length: l.length,
    aiModel: l.aiModel,
    updatedAt: l.updatedAt.toISOString(),
    words: l.body.trim() ? l.body.trim().split(/\s+/).length : 0,
    gaps: letterGaps(l.body),
    /** Lines to check by hand: numbers not in my facts, boastful words, length, order words. */
    checks: letterChecks(l.body, factsText, l.length === "short" ? "short" : "standard"),
  });

  /** Everything the letter may rightly mention, as one text (to spot invented numbers). */
  const letterFactsText = (prof: StudyProfile, p: StudyProgram, notes: string | null, target: string | null) =>
    [JSON.stringify(aiFacts(prof, p, "application", []).profile), p.name, p.university ?? "", p.field ?? "", p.notes ?? "", p.funding ?? "", notes ?? "", target ?? ""].join("\n");

  async function findProgram(id: number) {
    const p = await db.studyProgram.findUnique({ where: { id: BigInt(id) } });
    if (!p) throw errors.notFound("Programme not found");
    return p;
  }

  app.get("/programs/:id/letter", async (request) => {
    const p = await findProgram(idParam.parse(request.params).id);
    const l = await db.studyLetter.findUnique({ where: { programId: p.id } });
    return { letter: l ? letterView(l, letterFactsText(await profile(), p, l.notes, l.target)) : null, isScholarship: p.kind === "scholarship", program: { id: Number(p.id), name: p.name, university: p.university, country: p.country }, ai: { configured: aiConfigured(env), model: env.GROQ_MODEL } };
  });

  /** A new AI draft from my profile, the programme and my notes. Replaces the text (the page asks first). */
  app.post("/programs/:id/letter/draft", async (request) => {
    const p = await findProgram(idParam.parse(request.params).id);
    const b = z
      .object({ notes: z.string().trim().max(3000).optional(), target: z.string().trim().max(300).optional(), length: z.enum(["standard", "short"]).default("standard") })
      .strict()
      .parse(request.body ?? {});
    const prof = await profile();
    const facts = aiFacts(prof, p, "application", []);
    const d = await draftLetter(env, {
      profile: facts.profile,
      program: { ...facts.program, kind: p.kind, funding: p.funding, about: p.notes ? p.notes.slice(0, 800) : null },
      notes: b.notes,
      target: b.target,
      length: b.length,
    });
    const data = { title: d.title, body: d.body, notes: b.notes ?? null, target: b.target ?? null, length: b.length, aiModel: d.model };
    const l = await db.studyLetter.upsert({ where: { programId: p.id }, update: data, create: { programId: p.id, ...data } });
    return { letter: letterView(l, letterFactsText(prof, p, l.notes, l.target)) };
  });

  /** Saves my edits (or a letter written by hand). */
  app.put("/programs/:id/letter", async (request) => {
    const p = await findProgram(idParam.parse(request.params).id);
    const b = z
      .object({
        title: z.string().trim().min(1).max(200),
        body: z.string().max(20000),
        notes: z.string().trim().max(3000).nullable().optional(),
        target: z.string().trim().max(300).nullable().optional(),
      })
      .strict()
      .parse(request.body);
    const data = { title: b.title, body: b.body, ...(b.notes !== undefined ? { notes: b.notes } : {}), ...(b.target !== undefined ? { target: b.target } : {}) };
    const l = await db.studyLetter.upsert({ where: { programId: p.id }, update: data, create: { programId: p.id, ...data } });
    return { letter: letterView(l, letterFactsText(await profile(), p, l.notes, l.target)) };
  });

  app.delete("/programs/:id/letter", async (request, reply) => {
    const p = await findProgram(idParam.parse(request.params).id);
    await db.studyLetter.deleteMany({ where: { programId: p.id } });
    void reply.status(204);
  });

  app.get("/emails", async (request) => {
    const q = z.object({ programId: z.coerce.number().int().positive().optional(), status: z.enum(["draft", "sent", "failed"]).optional() }).parse(request.query);
    const rows = await db.studyEmail.findMany({
      where: { ...(q.programId ? { programId: BigInt(q.programId) } : {}), ...(q.status ? { status: q.status } : {}) },
      include: { program: { select: { id: true, name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const waiting = await waitingMessageIds(db, rows.map((r) => r.messageId));
    return { items: rows.map((r) => emailView(r, !!r.messageId && waiting.has(r.messageId))), mailDelivery: env.MAIL_DELIVERY, sendingEnabled: env.SENDING_ENABLED, ai: { configured: aiConfigured(env), model: env.GROQ_MODEL } };
  });

  app.get("/emails/:id", async (request) => {
    const e = await findEmail(idParam.parse(request.params).id);
    return emailView(e, (await waitingMessageIds(db, [e.messageId])).size > 0);
  });

  /** A new draft for a programme: documents chosen, text by the AI (or empty to write by hand). */
  app.post("/emails", async (request, reply) => {
    const b = z
      .object({
        programId: z.number().int().positive().optional(),
        purpose: z.enum(["inquiry", "application", "follow_up"]).default("inquiry"),
        toEmail: z.email().optional(),
        mailboxId: z.number().int().positive().optional(),
        useAi: z.boolean().default(true),
        extra: z.string().trim().max(1000).optional(),
      })
      .strict()
      .parse(request.body ?? {});
    const p = b.programId ? await db.studyProgram.findUnique({ where: { id: BigInt(b.programId) } }) : null;
    if (b.programId && !p) throw errors.notFound("Programme not found");
    const prof = await profile();
    // Attach what the purpose needs and I have (newest of each kind).
    const docs = await db.studyDocument.findMany({ select: { id: true, kind: true, label: true }, orderBy: { id: "desc" } });
    const wanted: DocKind[] =
      b.purpose === "application" && p
        ? requiredDocsFor(p, prof).filter((k) => k !== "passport" && k !== "photo")
        : prof.targetLevel === "bachelor"
          ? ["hsc_marksheet", "ssc_marksheet", "moi_letter"]
          : ["bsc_transcript", "moi_letter"];
    // Until the certificate arrives, the completion letter goes in its place.
    const chosen = wanted
      .map((k) => docs.find((d) => d.kind === k) ?? (k === "bsc_certificate" ? docs.find((d) => d.kind === "bsc_completion_letter") : undefined))
      .filter((d): d is (typeof docs)[number] => !!d);
    const mailbox = b.mailboxId ? await db.mailbox.findUnique({ where: { id: BigInt(b.mailboxId) } }) : await db.mailbox.findFirst({ where: { active: true }, orderBy: { id: "desc" } });
    let subject = p ? `Question about ${p.name}` : "Question about admission";
    let body = `Dear Admissions Team,\n\n[[Write your e-mail here.]]\n\nKind regards,\n${prof.fullName || "[[Your name]]"}`;
    let aiModel: string | null = null;
    if (b.useAi) {
      const d = await draftEmail(env, aiFacts(prof, p, b.purpose, chosen.map((c) => c.label), b.extra));
      subject = d.subject;
      body = d.body;
      aiModel = d.model;
    }
    const e = await db.studyEmail.create({
      data: {
        programId: p?.id ?? null,
        purpose: b.purpose,
        toEmail: b.toEmail ? normalizeEmail(b.toEmail) : (p?.contactEmail ?? null),
        mailboxId: mailbox?.id ?? null,
        subject,
        body,
        documentIds: chosen.map((c) => c.id),
        aiModel,
      },
      include: { program: { select: { id: true, name: true } } },
    });
    void reply.status(201);
    return emailView(e);
  });

  /** A new AI version of a draft (my extra instruction is followed). */
  app.post("/emails/:id/redraft", async (request) => {
    const e = await findEmail(idParam.parse(request.params).id);
    if (e.status === "sent") throw new AppError(409, "ALREADY_SENT", "This e-mail was sent already");
    const b = z.object({ extra: z.string().trim().max(1000).optional() }).strict().parse(request.body ?? {});
    const p = e.programId ? await db.studyProgram.findUnique({ where: { id: e.programId } }) : null;
    const docs = e.documentIds.length ? await db.studyDocument.findMany({ where: { id: { in: e.documentIds } }, select: { label: true } }) : [];
    const d = await draftEmail(env, aiFacts(await profile(), p, e.purpose as "inquiry", docs.map((x) => x.label), b.extra));
    const u = await db.studyEmail.update({ where: { id: e.id }, data: { subject: d.subject, body: d.body, aiModel: d.model }, include: { program: { select: { id: true, name: true } } } });
    return emailView(u);
  });

  app.patch("/emails/:id", async (request) => {
    const e = await findEmail(idParam.parse(request.params).id);
    if (e.status === "sent") throw new AppError(409, "ALREADY_SENT", "This e-mail was sent; it cannot change any more");
    const b = z
      .object({
        toEmail: z.email().nullable().optional(),
        mailboxId: z.number().int().positive().nullable().optional(),
        subject: z.string().trim().min(1).max(200).optional(),
        body: z.string().min(1).max(20_000).optional(),
        documentIds: z.array(z.number().int().positive()).max(12).optional(),
        purpose: z.enum(["inquiry", "application", "follow_up"]).optional(),
      })
      .strict()
      .parse(request.body);
    const u = await db.studyEmail.update({
      where: { id: e.id },
      data: {
        ...(b.toEmail !== undefined ? { toEmail: b.toEmail ? normalizeEmail(b.toEmail) : null } : {}),
        ...(b.mailboxId !== undefined ? { mailboxId: b.mailboxId ? BigInt(b.mailboxId) : null } : {}),
        ...(b.subject ? { subject: b.subject } : {}),
        ...(b.body ? { body: b.body } : {}),
        ...(b.documentIds ? { documentIds: b.documentIds.map((n) => BigInt(n)) } : {}),
        ...(b.purpose ? { purpose: b.purpose } : {}),
      },
      include: { program: { select: { id: true, name: true } } },
    });
    return emailView(u);
  });

  app.delete("/emails/:id", async (request) => {
    const e = await findEmail(idParam.parse(request.params).id);
    if (e.status === "sent") throw new AppError(409, "ALREADY_SENT", "A sent e-mail is kept as a record");
    await db.studyEmail.delete({ where: { id: e.id } });
    return { deleted: Number(e.id) };
  });

  async function prepare(e: StudyEmail) {
    if (!e.mailboxId) throw errors.badRequest("Choose the mailbox to send from (add your student e-mail on the Mailboxes page)");
    const mailbox = await db.mailbox.findUnique({ where: { id: e.mailboxId } });
    if (!mailbox) throw errors.badRequest("The chosen mailbox no longer exists");
    if (PLACEHOLDER.test(`${e.subject}\n${e.body}`)) throw new AppError(400, "PLACEHOLDERS", "Replace the text in [[double brackets]] first");
    const files = e.documentIds.length ? await db.studyDocument.findMany({ where: { id: { in: e.documentIds } } }) : [];
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > MAX_ATTACH_TOTAL) throw errors.badRequest(`The attachments add up to ${Math.round(total / 1024 / 1024)} MB; most mail servers take at most 20 MB. Remove some.`);
    return { mailbox, attachments: files.map((f) => ({ filename: f.fileName, content: Buffer.from(f.data), contentType: f.mime })) };
  }

  /** Exactly as it would go out, to MY OWN address (works while sending is off). */
  app.post("/emails/:id/test-send", async (request) => {
    const e = await findEmail(idParam.parse(request.params).id);
    const { to } = z.object({ to: z.email().transform((x) => x.toLowerCase()) }).parse(request.body);
    const s = resolveSettings(await db.setting.findMany()).settings;
    const allowed = await ownAddresses(db, request.admin?.email, s.sending.testAddresses);
    if (!allowed.includes(to)) throw new AppError(400, "NOT_MY_ADDRESS", `Tests go only to your own addresses (${allowed.join(", ")})`);
    const p = await prepare(e);
    const r = await sendLogged(db, env, { kind: "test", mailbox: p.mailbox, to, subject: `[TEST] ${e.subject}`, text: e.body, attachments: p.attachments, actor: request.admin?.email ?? null });
    if (!r.ok) throw new AppError(502, "SEND_FAILED", r.error);
    return { sent: true, to, queued: !!r.queued };
  });

  /** Sends it to the university. Needs SENDING_ENABLED=true; one by one, with a daily limit. */
  app.post("/emails/:id/send", async (request) => {
    const e = await findEmail(idParam.parse(request.params).id);
    if (!env.SENDING_ENABLED) throw new AppError(409, "SENDING_OFF", "Sending is off (SENDING_ENABLED=false in backend/.env). Send a test to yourself first.");
    if (e.status === "sent") throw new AppError(409, "ALREADY_SENT", "This e-mail was sent already");
    if (!e.toEmail) throw errors.badRequest("Enter the university's e-mail address");
    const domain = e.toEmail.split("@")[1]!;
    const sup = await suppressedSet(db, [e.toEmail], [domain]);
    if (sup.emails.has(e.toEmail) || sup.domains.has(domain)) throw new AppError(409, "SUPPRESSED", `${e.toEmail} is on the suppression list`);
    const s = resolveSettings(await db.setting.findMany()).settings;
    const sentToday = await db.studyEmail.count({ where: { sentAt: { gte: today() } } });
    if (sentToday >= s.sending.applicationsPerDay) throw new AppError(429, "DAILY_LIMIT", `Daily limit reached (${s.sending.applicationsPerDay}; Settings → Sending → job applications per day)`);
    const p = await prepare(e);
    const claimed = await db.studyEmail.updateMany({ where: { id: e.id, status: { in: ["draft", "failed"] } }, data: { status: "sent", sentAt: new Date(), error: null } });
    if (claimed.count === 0) throw new AppError(409, "ALREADY_SENT", "This e-mail is being sent or was sent already");
    const r = await sendLogged(db, env, { kind: "study", mailbox: p.mailbox, to: e.toEmail, subject: e.subject, text: e.body, attachments: p.attachments, actor: request.admin?.email ?? null, ref: { kind: "study_email", id: e.id } });
    const u = await db.studyEmail.update({
      where: { id: e.id },
      data: r.ok ? { messageId: r.messageId } : { status: "failed", sentAt: null, error: r.error.slice(0, 1000) },
      include: { program: { select: { id: true, name: true } } },
    });
    if (r.ok && e.programId && e.purpose === "application") {
      await db.studyProgram.updateMany({ where: { id: e.programId, status: { in: ["interested", "preparing"] } }, data: { status: "applied" } });
    } else if (r.ok && e.programId) {
      await db.studyProgram.updateMany({ where: { id: e.programId, status: "interested" }, data: { status: "preparing" } });
    }
    await db.auditLog.create({
      data: { actor: request.admin?.email ?? null, action: r.ok ? "study.email_sent" : "study.email_failed", entity: "study_email", entityId: String(e.id), details: { to: e.toEmail, program: e.program?.name ?? null }, ip: request.ip },
    });
    if (!r.ok) throw new AppError(502, "SEND_FAILED", r.error);
    return emailView(u, !!r.queued);
  });

  done();
};
