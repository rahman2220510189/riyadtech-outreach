import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { normalizeEmail } from "../crawler/emails.js";
import type { Db } from "../db/client.js";
import type { Application, Prisma } from "../generated/prisma/client.js";
import { suppressedSet } from "../leads/suppression.js";
import { AppError, errors } from "../lib/errors.js";
import { composeMail, countryName, type Recipient } from "../mail/compose.js";
import { waitingMessageIds } from "../mail/outbox.js";
import { ownAddresses, sendLogged } from "../mail/send.js";
import { resolveSettings } from "../settings/loader.js";
import { applyEmail } from "./leads.js";

export interface ApplicationsRoutesOptions {
  db: Db;
  env: Pick<Env, "ENCRYPTION_KEY" | "PUBLIC_BASE_URL" | "SENDING_ENABLED" | "MAIL_DELIVERY">;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
export const APPLICATION_STATUSES = ["draft", "sent", "failed", "applied_elsewhere", "interview", "rejected", "offer", "no_answer"] as const;
const MAX_CV_BYTES = 5 * 1024 * 1024;
const CV_TYPES: Record<string, string> = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const PLACEHOLDER = /\[\[[\s\S]*?\]\]/;

function view(a: Application & { jobAd?: { title: string; url: string; source: string } | null; mailbox?: { fromEmail: string } | null }, waiting = false) {
  return {
    id: Number(a.id),
    jobAdId: a.jobAdId ? Number(a.jobAdId) : null,
    job: a.jobAd ? { title: a.jobAd.title, url: a.jobAd.url, source: a.jobAd.source } : null,
    placeId: a.placeId ? Number(a.placeId) : null,
    company: a.company,
    role: a.role,
    toEmail: a.toEmail,
    mailboxId: a.mailboxId ? Number(a.mailboxId) : null,
    mailboxEmail: a.mailbox?.fromEmail ?? null,
    templateId: a.templateId ? Number(a.templateId) : null,
    subject: a.subject,
    body: a.body,
    cvFileIds: a.cvFileIds.map(Number),
    status: a.status,
    sentAt: a.sentAt,
    messageId: a.messageId,
    error: a.error,
    note: a.note,
    hasPlaceholders: PLACEHOLDER.test(`${a.subject}\n${a.body}`),
    /** Sent from the tool, but still waiting in the outbox for my PC. */
    waiting,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** CV files and job applications: write from a job advert (or from scratch), attach CVs, test to myself, send one by one. */
export const applicationsRoutes: FastifyPluginCallback<ApplicationsRoutesOptions> = (app, { db, env }, done) => {
  app.addHook("preHandler", app.authenticate);
  const settings = async () => resolveSettings(await db.setting.findMany()).settings;
  const include = { jobAd: { select: { title: true, url: true, source: true } }, mailbox: { select: { fromEmail: true } } } as const;
  const find = async (id: number) => {
    const a = await db.application.findUnique({ where: { id: BigInt(id) }, include });
    if (!a) throw errors.notFound("Application not found");
    return a;
  };
  const audit = (request: { admin?: { email: string } | null; ip: string }, action: string, id: bigint, details: Prisma.InputJsonObject) =>
    db.auditLog.create({ data: { actor: request.admin?.email ?? null, action, entity: "application", entityId: String(id), details, ip: request.ip } });

  /* --------------------------------- CV files --------------------------------- */

  app.get("/cv-files", async () => {
    const rows = await db.cvFile.findMany({ select: { id: true, label: true, fileName: true, mime: true, size: true, createdAt: true }, orderBy: { id: "desc" } });
    return { items: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  });

  app.post("/cv-files", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    const b = z
      .object({ label: z.string().trim().min(1).max(80), fileName: z.string().trim().min(1).max(200), dataBase64: z.string().min(10) })
      .strict()
      .parse(request.body);
    const ext = b.fileName.toLowerCase().split(".").pop() ?? "";
    const mime = CV_TYPES[ext];
    if (!mime) throw errors.badRequest("Only PDF or Word files (.pdf, .doc, .docx). PDF is best for applications.");
    const data = Buffer.from(b.dataBase64, "base64");
    if (data.length === 0 || data.length > MAX_CV_BYTES) throw errors.badRequest("The file must be between 1 byte and 5 MB");
    if (ext === "pdf" && data.subarray(0, 5).toString("latin1") !== "%PDF-") throw errors.badRequest("This is not a PDF file");
    const f = await db.cvFile.create({ data: { label: b.label, fileName: b.fileName.replace(/[\\/:*?"<>|]+/g, "_"), mime, size: data.length, data } });
    void reply.status(201);
    return { id: Number(f.id), label: f.label, fileName: f.fileName, mime: f.mime, size: f.size, createdAt: f.createdAt };
  });

  app.get("/cv-files/:id/download", async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const f = await db.cvFile.findUnique({ where: { id: BigInt(id) } });
    if (!f) throw errors.notFound("File not found");
    void reply.header("content-type", f.mime).header("content-disposition", `attachment; filename="${f.fileName.replace(/"/g, "")}"`);
    return Buffer.from(f.data);
  });

  app.delete("/cv-files/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    await db.cvFile.delete({ where: { id: BigInt(id) } }).catch(() => {
      throw errors.notFound("File not found");
    });
    return { deleted: id };
  });

  /* ------------------------------- applications ------------------------------- */

  app.get("/", async (request) => {
    const q = z
      .object({ status: z.enum([...APPLICATION_STATUSES, "all", "open"]).default("all"), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);
    const where: Prisma.ApplicationWhereInput =
      q.status === "all" ? {} : q.status === "open" ? { status: { in: ["draft", "failed"] } } : { status: q.status };
    const [total, rows, byStatus, sentToday] = await Promise.all([
      db.application.count({ where }),
      db.application.findMany({ where, include, orderBy: { updatedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      db.application.groupBy({ by: ["status"], _count: { _all: true } }),
      db.application.count({ where: { sentAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) } } }),
    ]);
    const s = await settings();
    const waiting = await waitingMessageIds(db, rows.map((r) => r.messageId));
    return {
      total,
      items: rows.map((r) => view(r, !!r.messageId && waiting.has(r.messageId))),
      mailDelivery: env.MAIL_DELIVERY,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      sendingEnabled: env.SENDING_ENABLED,
      sentToday,
      perDay: s.sending.applicationsPerDay,
    };
  });

  app.get("/:id", async (request) => {
    const a = await find(idParam.parse(request.params).id);
    return view(a, (await waitingMessageIds(db, [a.messageId])).size > 0);
  });

  /** A new draft: from a job advert (company, role, the company's address if it is also a lead) and a job template. */
  app.post("/", async (request, reply) => {
    const b = z
      .object({
        jobAdId: z.number().int().positive().optional(),
        templateId: z.number().int().positive().optional(),
        mailboxId: z.number().int().positive().optional(),
        company: z.string().trim().min(1).max(200).optional(),
        role: z.string().trim().min(1).max(200).optional(),
        toEmail: z.email().optional(),
      })
      .strict()
      .parse(request.body ?? {});
    const ad = b.jobAdId
      ? await db.jobAd.findUnique({
          where: { id: BigInt(b.jobAdId) },
          include: { place: { select: { id: true, suppressed: true, emails: { select: { email: true, kind: true, sourceUrl: true, mxValid: true, isPrimary: true } } } } },
        })
      : null;
    if (b.jobAdId && !ad) throw errors.notFound("Job advert not found");
    if (ad) {
      const open = await db.application.findFirst({ where: { jobAdId: ad.id }, select: { id: true } });
      if (open) throw errors.conflict(`There is already an application for this advert (#${open.id})`, { applicationId: Number(open.id) });
    }
    const template = b.templateId
      ? await db.template.findUnique({ where: { id: BigInt(b.templateId) } })
      : await db.template.findFirst({ where: { kind: "job" }, orderBy: { id: "asc" } });
    if (!template || template.kind !== "job") throw errors.badRequest("Choose a job application template (Templates → kind: job)");
    const mailbox = b.mailboxId ? await db.mailbox.findUnique({ where: { id: BigInt(b.mailboxId) } }) : await db.mailbox.findFirst({ where: { active: true }, orderBy: { id: "asc" } });
    const s = await settings();
    const company = b.company ?? ad?.company ?? "";
    const role = b.role ?? ad?.role ?? ad?.title ?? "";
    if (!company || !role) throw errors.badRequest("Give the company and the role");
    const recipient: Recipient = {
      key: ad ? `ad:${ad.id}` : `app:${Date.now()}`,
      label: company,
      email: null,
      suppressed: false,
      vars: { company, role, city: ad?.city ?? null, country: countryName(ad?.country), job_title: ad?.title ?? role, job_url: ad?.url ?? null },
    };
    const m = composeMail({
      kind: "job",
      subject: template.subject,
      body: template.body,
      templateKey: `t${template.id}`,
      recipient,
      to: "",
      mailbox: mailbox ?? { fromName: s.company.senderName || "Your name", fromEmail: "you@example.com", replyTo: null },
      company: s.company,
      env,
    });
    const newestCv = await db.cvFile.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    const toEmail = b.toEmail ? normalizeEmail(b.toEmail) : ad?.place && !ad.place.suppressed ? applyEmail(ad.place.emails, null) : null;
    const created = await db.application.create({
      data: {
        jobAdId: ad?.id ?? null,
        placeId: ad?.placeId ?? null,
        company,
        role,
        toEmail,
        mailboxId: mailbox?.id ?? null,
        templateId: template.id,
        subject: m.subject,
        body: m.text,
        cvFileIds: newestCv ? [newestCv.id] : [],
      },
      include,
    });
    void reply.status(201);
    return view(created);
  });

  app.patch("/:id", async (request) => {
    const a = await find(idParam.parse(request.params).id);
    const b = z
      .object({
        toEmail: z.email().nullable().optional(),
        mailboxId: z.number().int().positive().nullable().optional(),
        subject: z.string().trim().min(1).max(300).optional(),
        body: z.string().min(1).max(20_000).optional(),
        cvFileIds: z.array(z.number().int().positive()).max(5).optional(),
        status: z.enum(APPLICATION_STATUSES).optional(),
        note: z.string().trim().max(2000).nullable().optional(),
        company: z.string().trim().min(1).max(200).optional(),
        role: z.string().trim().min(1).max(200).optional(),
      })
      .strict()
      .parse(request.body);
    if (a.status === "sent" && (b.subject || b.body || b.toEmail !== undefined || b.cvFileIds || b.mailboxId !== undefined)) {
      throw new AppError(409, "ALREADY_SENT", "This application was sent; only its status and note can change");
    }
    if (b.status === "sent") throw errors.badRequest('Use "Send" to send it; the status "sent" is set by the sending');
    const data: Prisma.ApplicationUncheckedUpdateInput = {
      ...(b.toEmail !== undefined ? { toEmail: b.toEmail ? normalizeEmail(b.toEmail) : null } : {}),
      ...(b.mailboxId !== undefined ? { mailboxId: b.mailboxId ? BigInt(b.mailboxId) : null } : {}),
      ...(b.subject ? { subject: b.subject } : {}),
      ...(b.body ? { body: b.body } : {}),
      ...(b.cvFileIds ? { cvFileIds: b.cvFileIds.map((n) => BigInt(n)) } : {}),
      ...(b.status ? { status: b.status } : {}),
      ...(b.note !== undefined ? { note: b.note } : {}),
      ...(b.company ? { company: b.company } : {}),
      ...(b.role ? { role: b.role } : {}),
    };
    const u = await db.application.update({ where: { id: a.id }, data, include });
    if (b.status === "applied_elsewhere" && u.jobAdId) await db.jobAd.update({ where: { id: u.jobAdId }, data: { status: "applied" } });
    return view(u);
  });

  app.delete("/:id", async (request) => {
    const a = await find(idParam.parse(request.params).id);
    if (a.status === "sent") throw new AppError(409, "ALREADY_SENT", "A sent application is kept as a record");
    await db.application.delete({ where: { id: a.id } });
    return { deleted: Number(a.id) };
  });

  async function prepare(a: Awaited<ReturnType<typeof find>>, to: string) {
    if (!a.mailboxId) throw errors.badRequest("Choose the mailbox to send from");
    const mailbox = await db.mailbox.findUnique({ where: { id: a.mailboxId } });
    if (!mailbox) throw errors.badRequest("The chosen mailbox no longer exists");
    if (PLACEHOLDER.test(`${a.subject}\n${a.body}`)) throw new AppError(400, "PLACEHOLDERS", "Replace the text in [[double brackets]] first");
    const files = a.cvFileIds.length ? await db.cvFile.findMany({ where: { id: { in: a.cvFileIds } } }) : [];
    return {
      mailbox,
      attachments: files.map((f) => ({ filename: f.fileName, content: Buffer.from(f.data), contentType: f.mime })),
      to,
    };
  }

  /** The application exactly as it would go out, to MY OWN address (works while sending is off). */
  app.post("/:id/test-send", async (request) => {
    const a = await find(idParam.parse(request.params).id);
    const { to } = z.object({ to: z.email().transform((e) => e.toLowerCase()) }).parse(request.body);
    const s = await settings();
    const allowed = await ownAddresses(db, request.admin?.email, s.sending.testAddresses);
    if (!allowed.includes(to)) throw new AppError(400, "NOT_MY_ADDRESS", `Tests go only to your own addresses (${allowed.join(", ")})`);
    const p = await prepare(a, to);
    const r = await sendLogged(db, env, { kind: "test", mailbox: p.mailbox, to, subject: `[TEST] ${a.subject}`, text: a.body, attachments: p.attachments, actor: request.admin?.email ?? null });
    if (!r.ok) throw new AppError(502, "SEND_FAILED", r.error);
    return { sent: true, to, messageId: r.messageId, queued: !!r.queued };
  });

  /** Sends the application to the company. Needs SENDING_ENABLED=true; checks suppression and the daily limit. */
  app.post("/:id/send", async (request) => {
    const a = await find(idParam.parse(request.params).id);
    if (!env.SENDING_ENABLED) {
      throw new AppError(409, "SENDING_OFF", "Sending is off (SENDING_ENABLED=false in backend/.env). Send a test to yourself, or apply on the advert's page and mark it as applied.");
    }
    if (a.status === "sent") throw new AppError(409, "ALREADY_SENT", "This application was sent already");
    if (!a.toEmail) throw errors.badRequest("Enter the address to send the application to");
    const domain = a.toEmail.split("@")[1]!;
    const sup = await suppressedSet(db, [a.toEmail], [domain]);
    if (sup.emails.has(a.toEmail) || sup.domains.has(domain)) {
      throw new AppError(409, "SUPPRESSED", `${a.toEmail} is on the suppression list; it is never e-mailed`);
    }
    const s = await settings();
    const today = await db.application.count({ where: { sentAt: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) } } });
    if (today >= s.sending.applicationsPerDay) throw new AppError(429, "DAILY_LIMIT", `Daily limit reached (${s.sending.applicationsPerDay} applications; Settings → Sending)`);
    const p = await prepare(a, a.toEmail);
    // Claim it first, so a double click cannot send twice.
    const claimed = await db.application.updateMany({ where: { id: a.id, status: { in: ["draft", "failed"] } }, data: { status: "sent", sentAt: new Date(), error: null } });
    if (claimed.count === 0) throw new AppError(409, "ALREADY_SENT", "This application is being sent or was sent already");
    const r = await sendLogged(db, env, { kind: "application", mailbox: p.mailbox, to: a.toEmail, subject: a.subject, text: a.body, attachments: p.attachments, actor: request.admin?.email ?? null, ref: { kind: "application", id: a.id } });
    const u = await db.application.update({
      where: { id: a.id },
      data: r.ok ? { messageId: r.messageId, smtpResponse: r.response.slice(0, 500) } : { status: "failed", sentAt: null, error: r.error.slice(0, 1000) },
      include,
    });
    if (r.ok && u.jobAdId) await db.jobAd.update({ where: { id: u.jobAdId }, data: { status: "applied" } });
    await audit(request, r.ok ? "application.sent" : "application.failed", a.id, { to: a.toEmail, company: a.company, ...(r.ok ? {} : { error: r.error.slice(0, 200) }) });
    if (!r.ok) throw new AppError(502, "SEND_FAILED", r.error);
    return view(u, !!r.queued);
  });

  done();
};
