import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { type CampaignEnv, createCampaign, launchCampaign, renderStep } from "../campaigns/engine.js";
import type { Db } from "../db/client.js";
import type { JobStore } from "../jobs/store.js";
import { readyWhere } from "../leads/ready.js";
import { AppError, errors } from "../lib/errors.js";
import { usesGmail } from "../mail/send.js";
import { loadSeedData } from "../seed/files.js";
import { resolveSettings } from "../settings/loader.js";

export interface CampaignsRoutesOptions {
  db: Db;
  jobs: JobStore;
  env: CampaignEnv;
}

const idParam = z.object({ id: z.coerce.number().int().positive() });
const leadParam = z.object({ id: z.coerce.number().int().positive(), leadId: z.coerce.number().int().positive() });
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    segment: z.enum(["A", "B"]),
    country: z.string().regex(/^[A-Z]{2}$/),
    categoryKeys: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(50).default([]),
    mailboxId: z.number().int().positive(),
    size: z.number().int().min(1).max(200).default(20),
  })
  .strict();

const STATUSES = ["waiting_crawl", "queued", "done", "stopped", "replied", "skipped", "failed", "bounced"] as const;

/** Campaigns: create from "Ready now" leads, preview, launch, pause, stop, mark a reply. */
export const campaignsRoutes: FastifyPluginCallback<CampaignsRoutesOptions> = (app, { db, jobs, env }, done) => {
  app.addHook("preHandler", app.authenticate);
  const settings = async () => resolveSettings(await db.setting.findMany()).settings;
  const audit = (request: { admin?: { email: string } | null; ip: string }, action: string, id: bigint, details: object = {}) =>
    db.auditLog.create({ data: { actor: request.admin?.email ?? null, action, entity: "campaign", entityId: String(id), details, ip: request.ip } });

  async function counts(campaignId: bigint) {
    const [byStatus, sends] = await Promise.all([
      db.campaignLead.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } }),
      db.campaignSend.groupBy({ by: ["status"], where: { lead: { campaignId } }, _count: { _all: true } }),
    ]);
    return {
      leads: Object.fromEntries(STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?._count._all ?? 0])),
      sent: sends.find((s) => s.status === "sent")?._count._all ?? 0,
      previews: sends.find((s) => s.status === "preview")?._count._all ?? 0,
      failed: sends.find((s) => s.status === "failed")?._count._all ?? 0,
    };
  }

  /** What the form needs: mailboxes, countries with outreach on, kinds of business, switches. */
  app.get("/options", async () => {
    const s = await settings();
    const [mailboxes, countries] = await Promise.all([
      db.mailbox.findMany({ where: { active: true }, orderBy: { id: "asc" } }),
      db.country.findMany({ where: { enabled: true }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    const ready = await db.place.groupBy({
      by: ["country", "segment"],
      where: readyWhere({ outreachCountries: countries.map((c) => c.code), minLeadScore: s.scores.readyMinLeadScore }),
      _count: { _all: true },
    });
    const readyOf = (code: string, segment: string) => ready.find((r) => r.country === code && r.segment === segment)?._count._all ?? 0;
    return {
      mailboxes: mailboxes.map((m) => ({ id: Number(m.id), label: m.label, fromEmail: m.fromEmail, gmail: usesGmail(m, env) })),
      countries: countries.map((c) => ({ ...c, ready: { A: readyOf(c.code, "A"), B: readyOf(c.code, "B") } })),
      categories: loadSeedData().categories.map((c) => ({ key: c.key, label: c.label, segment: c.segment })),
      sendingEnabled: env.SENDING_ENABLED,
      postalAddressSet: s.company.postalAddress.trim().length > 0,
      firstCampaign: (await db.campaignSend.count({ where: { status: "sent" } })) === 0,
    };
  });

  app.get("/", async () => {
    const rows = await db.campaign.findMany({ orderBy: { id: "desc" }, include: { mailbox: { select: { fromEmail: true } } } });
    return { items: await Promise.all(rows.map(async (c) => ({ ...view(c), ...(await counts(c.id)) }))) };
  });

  app.post("/", async (request, reply) => {
    const b = createSchema.parse(request.body);
    const c = await createCampaign(db, { ...b, mailboxId: BigInt(b.mailboxId) }, await settings());
    await audit(request, "campaign.create", c.id, { leads: c.leads.length });
    reply.code(201);
    return { id: Number(c.id), leads: c.leads.length };
  });

  app.get("/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const c = await db.campaign.findUnique({ where: { id: BigInt(id) }, include: { mailbox: { select: { fromEmail: true } } } });
    if (!c) throw errors.notFound("Campaign not found");
    const leads = await db.campaignLead.findMany({
      where: { campaignId: c.id },
      include: { place: { select: { name: true, websiteDomain: true, city: true } }, sends: { orderBy: { step: "asc" }, select: { step: true, status: true, createdAt: true } } },
      orderBy: [{ id: "asc" }],
    });
    return {
      ...view(c),
      ...(await counts(c.id)),
      leads: leads.map((l) => ({
        id: Number(l.id),
        company: l.place.name,
        website: l.place.websiteDomain,
        city: l.place.city,
        email: l.email,
        offer: l.offer,
        step: l.step,
        status: l.status,
        nextAt: l.nextAt,
        reason: l.reason,
        sends: l.sends,
      })),
    };
  });

  /** The e-mails as they will leave, for the first leads (step 1 by default). */
  app.get("/:id/preview", async (request) => {
    const { id } = idParam.parse(request.params);
    const q = z.object({ step: z.coerce.number().int().min(1).max(3).default(1), limit: z.coerce.number().int().min(1).max(10).default(3) }).parse(request.query);
    const c = await db.campaign.findUnique({ where: { id: BigInt(id) }, include: { mailbox: true } });
    if (!c) throw errors.notFound("Campaign not found");
    const s = await settings();
    const leads = await db.campaignLead.findMany({
      where: { campaignId: c.id, status: { in: ["queued", "waiting_crawl"] } },
      include: { place: { include: { signals: true } } },
      orderBy: { id: "asc" },
      take: q.limit,
    });
    const items = [];
    for (const l of leads) {
      const r = await renderStep(db, env, s, c, l, q.step);
      items.push({
        leadId: Number(l.id),
        company: l.place.name,
        to: l.email,
        waitingForCrawl: l.status === "waiting_crawl",
        subject: r?.subject ?? null,
        text: r?.text ?? null,
        missing: r?.missing ?? [],
        template: r?.templateName ?? null,
      });
    }
    return { items };
  });

  app.post("/:id/launch", async (request) => {
    const { id } = idParam.parse(request.params);
    const c = await launchCampaign(db, jobs, env, await settings(), BigInt(id));
    await audit(request, "campaign.launch", c.id, { sendLimit: c.sendLimit, sendingEnabled: env.SENDING_ENABLED });
    return view(c);
  });

  app.post("/:id/pause", async (request) => {
    const { id } = idParam.parse(request.params);
    const c = await db.campaign.findUnique({ where: { id: BigInt(id) } });
    if (!c) throw errors.notFound("Campaign not found");
    if (c.status !== "running") throw new AppError(409, "CONFLICT", `The campaign is ${c.status}.`);
    const u = await db.campaign.update({ where: { id: c.id }, data: { status: "paused", note: "Paused by you." } });
    await audit(request, "campaign.pause", c.id);
    return view(u);
  });

  app.post("/:id/stop", async (request) => {
    const { id } = idParam.parse(request.params);
    const c = await db.campaign.findUnique({ where: { id: BigInt(id) } });
    if (!c) throw errors.notFound("Campaign not found");
    await db.campaignLead.updateMany({ where: { campaignId: c.id, status: { in: ["queued", "waiting_crawl"] } }, data: { status: "stopped", reason: "Campaign stopped", nextAt: null } });
    const u = await db.campaign.update({ where: { id: c.id }, data: { status: "stopped", note: "Stopped by you." } });
    await audit(request, "campaign.stop", c.id);
    return view(u);
  });

  app.delete("/:id", async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const c = await db.campaign.findUnique({ where: { id: BigInt(id) } });
    if (!c) throw errors.notFound("Campaign not found");
    if (c.status !== "draft") throw new AppError(409, "CONFLICT", "Only a draft can be deleted; stop the campaign instead.");
    await db.campaign.delete({ where: { id: c.id } });
    await audit(request, "campaign.delete", c.id);
    reply.code(204);
  });

  /** They answered (or asked to stop): no more follow-ups to this lead. */
  app.post("/:id/leads/:leadId/stop", async (request) => {
    const { id, leadId } = leadParam.parse(request.params);
    const b = z.object({ reason: z.enum(["replied", "manual"]) }).strict().parse(request.body);
    const l = await db.campaignLead.findFirst({ where: { id: BigInt(leadId), campaignId: BigInt(id) } });
    if (!l) throw errors.notFound("Lead not found in this campaign");
    const u = await db.campaignLead.update({
      where: { id: l.id },
      data: { status: b.reason === "replied" ? "replied" : "stopped", reason: b.reason === "replied" ? "They replied" : "Stopped by you", nextAt: null },
    });
    await audit(request, `campaign.lead_${b.reason}`, BigInt(id), { lead: leadId, email: l.email });
    return { id: Number(u.id), status: u.status };
  });

  done();
};

function view(c: { id: bigint; name: string; segment: string; country: string; categoryKeys: string[]; mailboxId: bigint; status: string; sendLimit: number | null; note: string | null; crawlJobId: bigint | null; createdAt: Date; startedAt: Date | null; mailbox?: { fromEmail: string } }) {
  return {
    id: Number(c.id),
    name: c.name,
    segment: c.segment,
    country: c.country,
    categoryKeys: c.categoryKeys,
    mailboxId: Number(c.mailboxId),
    mailbox: c.mailbox?.fromEmail ?? null,
    status: c.status,
    sendLimit: c.sendLimit,
    note: c.note,
    crawlJobId: c.crawlJobId === null ? null : Number(c.crawlJobId),
    createdAt: c.createdAt,
    startedAt: c.startedAt,
  };
}
