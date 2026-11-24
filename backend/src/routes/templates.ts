import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { Db } from "../db/client.js";
import type { Template } from "../generated/prisma/client.js";
import { AppError, errors } from "../lib/errors.js";
import { composeMail, previewRecipients, SAMPLE_RECIPIENT } from "../mail/compose.js";
import { STANDARD_VARIABLES, usedVariables } from "../mail/render.js";
import { ownAddresses, sendLogged } from "../mail/send.js";
import { resolveSettings } from "../settings/loader.js";

export interface TemplatesRoutesOptions {
  db: Db;
  env: Pick<Env, "ENCRYPTION_KEY" | "PUBLIC_BASE_URL" | "MAIL_DELIVERY">;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const templateFields = {
  kind: z.enum(["outreach", "job"]),
  name: z.string().trim().min(1).max(100),
  segment: z.enum(["A", "B"]).nullable(),
  offer: z.enum(["chatbot", "agent"]).nullable(),
  step: z.number().int().min(1).max(3),
  subject: z.string().max(300),
  body: z.string().min(1).max(20_000),
};
const createSchema = z.object(templateFields).partial({ segment: true, offer: true, step: true }).strict();
const updateSchema = z.object(templateFields).partial().strict();
/** A template to render: a saved one, or the editor's unsaved text. */
const draftSchema = z
  .object({ templateId: z.number().int().positive().optional(), kind: z.enum(["outreach", "job"]).optional(), subject: z.string().max(300).optional(), body: z.string().max(20_000).optional() })
  .refine((d) => d.templateId || (d.kind && d.body !== undefined), "Give templateId, or kind + subject + body");

export const VARIABLE_HELP: Record<string, string> = {
  first_name: "First name of the contact, if known. Use {first_name|there}.",
  company: "Company name",
  website: "Website domain (acme.com)",
  city: "City",
  country: "Country name",
  role: "The developer role the company advertises",
  stack_match: "Our stack words in that role (React, Node.js), empty if none",
  signal_line: "The opening line from the website signals (one per lead)",
  sender_name: "Your name (Settings → Company, else the mailbox name)",
  unsubscribe_link: "The personal unsubscribe link (also in the footer)",
  company_address: "Your postal address (Settings → Company)",
  job_title: "Full title of the job advert (applications)",
  job_url: "Link to the job advert (applications)",
};

function view(t: Template) {
  return {
    id: Number(t.id),
    kind: t.kind,
    name: t.name,
    segment: t.segment,
    offer: t.offer,
    step: t.step,
    subject: t.subject,
    body: t.body,
    seedKey: t.seedKey,
    variables: usedVariables(`${t.subject}\n${t.body}`),
    updatedAt: t.updatedAt,
  };
}

/** Templates: edit, preview with real leads, and send a test to myself. */
export const templatesRoutes: FastifyPluginCallback<TemplatesRoutesOptions> = (app, { db, env }, done) => {
  app.addHook("preHandler", app.authenticate);
  const settings = async () => resolveSettings(await db.setting.findMany()).settings;
  const find = async (id: number) => {
    const t = await db.template.findUnique({ where: { id: BigInt(id) } });
    if (!t) throw errors.notFound("Template not found");
    return t;
  };
  const draftOf = async (d: z.infer<typeof draftSchema>) => {
    if (d.templateId) {
      const t = await find(d.templateId);
      return { kind: t.kind as "outreach" | "job", subject: d.subject ?? t.subject, body: d.body ?? t.body, key: `t${t.id}` };
    }
    return { kind: d.kind!, subject: d.subject ?? "", body: d.body!, key: "draft" };
  };

  app.get("/", async (request) => {
    const q = z.object({ kind: z.enum(["outreach", "job"]).optional() }).parse(request.query);
    const rows = await db.template.findMany({ where: q.kind ? { kind: q.kind } : {}, orderBy: [{ kind: "desc" }, { segment: "asc" }, { offer: "asc" }, { step: "asc" }, { id: "asc" }] });
    return { items: rows.map(view), variables: STANDARD_VARIABLES.map((v) => ({ name: v, help: VARIABLE_HELP[v] ?? "" })) };
  });

  app.get("/:id", async (request) => view(await find(idParam.parse(request.params).id)));

  app.post("/", async (request, reply) => {
    const b = createSchema.parse(request.body);
    const t = await db.template.create({ data: { ...b, segment: b.segment ?? null, offer: b.offer ?? null, step: b.step ?? 1 } });
    void reply.status(201);
    return view(t);
  });

  app.patch("/:id", async (request) => {
    const t = await find(idParam.parse(request.params).id);
    return view(await db.template.update({ where: { id: t.id }, data: updateSchema.parse(request.body) }));
  });

  app.delete("/:id", async (request) => {
    const t = await find(idParam.parse(request.params).id);
    await db.template.delete({ where: { id: t.id } });
    if (t.seedKey) {
      // Remember it, so the seed does not bring it back at the next start.
      const row = await db.setting.findUnique({ where: { key: "templates.deletedSeeds" } });
      const list = new Set(Array.isArray(row?.value) ? (row.value as string[]) : []);
      list.add(t.seedKey);
      await db.setting.upsert({ where: { key: "templates.deletedSeeds" }, create: { key: "templates.deletedSeeds", value: [...list] }, update: { value: [...list] } });
    }
    return { deleted: Number(t.id) };
  });

  /** Renders the template for up to 10 recipients (found leads or an imported list), exactly as it would be sent. */
  app.post("/preview", async (request) => {
    const b = draftSchema
      .and(
        z.object({
          mailboxId: z.number().int().positive().optional(),
          source: z
            .object({
              listId: z.number().int().positive().optional(),
              segment: z.enum(["A", "B"]).optional(),
              country: z.string().regex(/^[A-Z]{2}$/).optional(),
              hiring: z.boolean().optional(),
              leadIds: z.array(z.number().int().positive()).max(10).optional(),
            })
            .default({}),
          count: z.number().int().min(1).max(10).default(10),
        }),
      )
      .parse(request.body);
    const d = await draftOf(b);
    const s = await settings();
    const mailbox = b.mailboxId ? await db.mailbox.findUnique({ where: { id: BigInt(b.mailboxId) } }) : await db.mailbox.findFirst({ where: { active: true }, orderBy: { id: "asc" } });
    const box = mailbox ?? { fromName: s.company.senderName || "Your name", fromEmail: "you@example.com", replyTo: null };
    let recipients = await previewRecipients(db, b.source, b.count);
    const sample = recipients.length === 0;
    if (sample) recipients = [SAMPLE_RECIPIENT];
    const items = recipients.map((r) => {
      const m = composeMail({ kind: d.kind, subject: d.subject, body: d.body, templateKey: d.key, recipient: r, to: r.email ?? "lead@example.com", mailbox: box, company: s.company, env });
      return { key: r.key, recipient: r.label, to: r.email, subject: m.subject, text: m.text, missing: m.missing, unknown: m.unknown, warnings: m.warnings, headers: m.headers, willSkip: m.missing.length > 0 || m.unknown.length > 0 || !r.email || r.suppressed };
    });
    return {
      items,
      sample,
      mailbox: mailbox ? { id: Number(mailbox.id), fromEmail: mailbox.fromEmail } : null,
      problems: [
        ...(mailbox ? [] : ["No mailbox yet: the preview uses a placeholder sender."]),
        ...(d.kind === "outreach" && !s.company.postalAddress.trim() ? ["Postal address is empty (Settings → Company)."] : []),
        ...(/\[\[[\s\S]*?\]\]/.test(`${d.subject}${d.body}`) ? ["The text still has [[double bracket]] parts to replace."] : []),
      ],
    };
  });

  app.get("/test-addresses", async (request) => {
    const s = await settings();
    return { items: await ownAddresses(db, request.admin?.email, s.sending.testAddresses) };
  });

  /** Sends one rendered e-mail to MY OWN address only (allowed even while SENDING_ENABLED is false). */
  app.post("/test-send", async (request) => {
    const b = draftSchema
      .and(
        z.object({
          mailboxId: z.number().int().positive(),
          to: z.email().transform((e) => e.toLowerCase()),
          leadId: z.number().int().positive().optional(),
          listLeadId: z.number().int().positive().optional(),
        }),
      )
      .parse(request.body);
    const s = await settings();
    const allowed = await ownAddresses(db, request.admin?.email, s.sending.testAddresses);
    if (!allowed.includes(b.to)) {
      throw new AppError(400, "NOT_MY_ADDRESS", `Tests go only to your own addresses (${allowed.join(", ")}). Add more in Settings → Sending → test addresses.`);
    }
    const mailbox = await db.mailbox.findUnique({ where: { id: BigInt(b.mailboxId) } });
    if (!mailbox) throw errors.notFound("Mailbox not found");
    const d = await draftOf(b);
    let recipient = SAMPLE_RECIPIENT;
    if (b.leadId) recipient = (await previewRecipients(db, { leadIds: [b.leadId] }, 1))[0] ?? SAMPLE_RECIPIENT;
    else if (b.listLeadId) {
      const row = await db.listLead.findUnique({ where: { id: BigInt(b.listLeadId) } });
      if (row) recipient = (await previewRecipients(db, { listId: Number(row.listId) }, 10_000)).find((r) => r.key === `list:${row.id}`) ?? SAMPLE_RECIPIENT;
    }
    // The unsubscribe link belongs to the test address (clicking it suppresses MY address; remove it on the Suppression page).
    const m = composeMail({ kind: d.kind, subject: d.subject, body: d.body, templateKey: d.key, recipient: { ...recipient, suppressed: false }, to: b.to, mailbox, company: s.company, env });
    if (m.missing.length || m.unknown.length) {
      throw new AppError(400, "MISSING_VARIABLES", `Empty or unknown variables for ${recipient.label}: ${[...m.missing, ...m.unknown].join(", ")}`);
    }
    const result = await sendLogged(db, env, { kind: "test", mailbox, to: b.to, subject: `[TEST] ${m.subject}`, text: m.text, headers: m.headers, actor: request.admin?.email ?? null });
    await db.auditLog.create({
      data: { actor: request.admin?.email ?? null, action: "mail.test_send", entity: "mailbox", entityId: String(mailbox.id), details: { to: b.to, ok: result.ok, recipient: recipient.label }, ip: request.ip },
    });
    if (!result.ok) throw new AppError(502, "SEND_FAILED", result.error);
    return { sent: true, to: b.to, subject: `[TEST] ${m.subject}`, messageId: result.messageId, response: result.response, queued: !!(result.ok && result.queued), recipient: recipient.label, warnings: m.warnings };
  });

  done();
};
