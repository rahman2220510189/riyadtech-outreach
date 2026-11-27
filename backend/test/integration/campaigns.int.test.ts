/**
 * Phase 5 campaign engine on a real PostgreSQL: choosing leads, the preview mode, office hours,
 * gaps, the first-campaign limit of 5, follow-ups in the same thread, suppression right before
 * sending, no step sent twice, and the API. SMTP is a fake; nothing leaves the machine.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE } from "../../src/auth/plugin.js";
import { seedAdmin } from "../../src/auth/seed.js";
import { prismaAuthStore } from "../../src/auth/store.js";
import { crawlAhead } from "../../src/campaigns/crawl-ahead.js";
import { campaignTick, createCampaign, FIRST_CAMPAIGN_LIMIT, launchCampaign } from "../../src/campaigns/engine.js";
import { createDb, type Db } from "../../src/db/client.js";
import { JOB_SUMMARIZERS } from "../../src/jobs/handlers.js";
import { JobStore } from "../../src/jobs/store.js";
import { refreshSuppressed } from "../../src/leads/suppression.js";
import { encryptSecret } from "../../src/mail/crypto.js";
import { type OutgoingMail, setMailTestHooks } from "../../src/mail/transport.js";
import { syncSeedTemplates } from "../../src/seed/sync.js";
import { defaultSettings, type Settings } from "../../src/settings/definitions.js";
import { testEnv } from "../helpers/env.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const ADMIN = "zz-campaigns@riyadtech.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };
const env = testEnv({ PUBLIC_BASE_URL: "https://outreach.zz.invalid" });
const KEY = env.ENCRYPTION_KEY!;
const MONDAY_10 = new Date("2026-11-30T10:00:00Z");
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

describe.skipIf(!url)("campaigns (integration)", () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie: Record<string, string>;
  let jobs: JobStore;
  let mailboxId: bigint;
  const sent: OutgoingMail[] = [];
  const settings: Settings = defaultSettings();
  settings.company.postalAddress = "1 Test Street, Testville";

  async function cleanup() {
    if (!db) return;
    await db.campaign.deleteMany({ where: { name: { startsWith: "ZZ " } } });
    await db.place.deleteMany({ where: { country: "ZC" } });
    await db.mailLog.deleteMany({ where: { toEmail: { endsWith: ".invalid" }, kind: "outreach" } });
    await db.mailbox.deleteMany({ where: { fromEmail: "zz-campaign@riyadtech.invalid" } });
    await db.suppression.deleteMany({ where: { value: { endsWith: ".zc.invalid" } } });
    await db.country.deleteMany({ where: { code: "ZC" } });
    const admins = await db.adminUser.findMany({ where: { email: ADMIN }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { OR: [{ actor: ADMIN }, { entityId: { in: admins.map((a) => a.id) } }] } });
    await db.adminUser.deleteMany({ where: { email: ADMIN } });
  }

  /** Crawled, readable agencies with an address (plus a chain and one not crawled yet). */
  async function makeLeads(prefix: string, n: number) {
    const base = { lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", segment: "A", categoryKey: "web_design", country: "ZC", city: "Testville", timezone: "UTC" };
    await db.place.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        ...base,
        name: `${prefix} Studio ${i}`,
        website: `https://${prefix}${i}.zc.invalid/`,
        websiteDomain: `${prefix}${i}.zc.invalid`,
        crawlStatus: "ok",
        crawledAt: new Date(),
        signalLine: `I saw ${prefix} Studio ${i} is hiring a React developer.`,
        primaryEmail: `hello@${prefix}${i}.zc.invalid`,
        leadScore: 90 - i,
        fitScore: 70,
        needScore: 70,
      })),
    });
  }

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 4, NODE_ENV: "test" });
    await cleanup();
    await syncSeedTemplates(db);
    await db.country.create({ data: { code: "ZC", name: "Campaignland", timezones: ["UTC"], bbox: [0, 0, 1, 1], enabled: true, outreachRules: { law: "test", genericOnly: false, verified: true, notes: "test" } } });
    const mb = await db.mailbox.create({
      data: {
        label: "ZZ campaign box",
        fromName: "Riyad",
        fromEmail: "zz-campaign@riyadtech.invalid",
        smtpHost: "smtp.zc.invalid",
        smtpPort: 465,
        smtpSecurity: "ssl",
        smtpUser: "zz-campaign@riyadtech.invalid",
        smtpPasswordEnc: encryptSecret(KEY, "app-pass-1234"),
        imapHost: "imap.zc.invalid",
        imapPort: 993,
        imapUser: "zz-campaign@riyadtech.invalid",
        dailyCap: 50,
        warmupStartedOn: new Date("2026-01-01"),
      },
    });
    mailboxId = mb.id;
    setMailTestHooks({
      send: (_cfg, mail) => {
        sent.push(mail);
        return Promise.resolve({ messageId: mail.messageId, response: "250 2.0.0 OK queued", accepted: [mail.to], rejected: [] });
      },
    });
    await seedAdmin(db, ADMIN, "plum-orbit-lantern-47", 4);
    jobs = new JobStore(db, JOB_SUMMARIZERS);
    app = await buildApp(env, { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 }, data: { db, jobs } });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: CSRF, payload: { email: ADMIN, password: "plum-orbit-lantern-47" }, remoteAddress: "10.88.0.9" });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
  }, 60_000);

  afterAll(async () => {
    setMailTestHooks({});
    await app?.close();
    await cleanup();
    await db?.$disconnect();
  }, 60_000);

  it("chooses ready leads (best first, no chains, crawls the new ones), previews in office hours with gaps", async () => {
    await makeLeads("pa", 5);
    await db.place.update({ where: { segment_websiteDomain: { segment: "A", websiteDomain: "pa4.zc.invalid" } }, data: { locationCount: 40 } }); // a chain
    await db.place.update({ where: { segment_websiteDomain: { segment: "A", websiteDomain: "pa3.zc.invalid" } }, data: { crawlStatus: null, crawledAt: null, signalLine: null } }); // not crawled yet

    const c = await createCampaign(db, { name: "ZZ preview", segment: "A", country: "ZC", categoryKeys: [], mailboxId, size: 10 }, settings);
    expect(c.leads.map((l) => `${l.domain}:${l.status}`).sort()).toEqual(["pa0.zc.invalid:queued", "pa1.zc.invalid:queued", "pa2.zc.invalid:queued", "pa3.zc.invalid:waiting_crawl"]);

    // Leads in a campaign are not "Ready now" any more.
    const readyRes = await app.inject({ method: "GET", url: "/api/v1/leads?country=ZC&ready=true", cookies: cookie });
    const ready = readyRes.json<{ total: number }>();
    expect(ready.total).toBe(0);

    const launched = await launchCampaign(db, jobs, { ...env, SENDING_ENABLED: false }, settings, c.id);
    expect(launched).toMatchObject({ status: "running", sendLimit: null });
    expect(launched.crawlJobId).not.toBeNull(); // the not-crawled lead gets its website read first

    const pre = { ...env, SENDING_ENABLED: false };
    expect(await campaignTick(db, pre, settings, new Date("2026-11-28T10:00:00Z"))).toMatchObject({ previews: 0 }); // Saturday
    expect(await campaignTick(db, pre, settings, at(MONDAY_10, -120))).toMatchObject({ previews: 0 }); // 08:00, before office hours
    expect(await campaignTick(db, pre, settings, MONDAY_10)).toMatchObject({ previews: 1 });
    expect(await campaignTick(db, pre, settings, at(MONDAY_10, 1))).toMatchObject({ previews: 0 }); // the 2-6 minute gap
    expect(await campaignTick(db, pre, settings, at(MONDAY_10, 7))).toMatchObject({ previews: 1 });
    expect(sent).toHaveLength(0); // nothing leaves with SENDING_ENABLED=false

    const previews = await db.campaignSend.findMany({ where: { lead: { campaignId: c.id } }, orderBy: { id: "asc" } });
    expect(previews.map((p) => [p.toEmail, p.step, p.status])).toEqual([
      ["hello@pa0.zc.invalid", 1, "preview"],
      ["hello@pa1.zc.invalid", 1, "preview"],
    ]);
    expect(previews[0]!.body).toContain("I saw pa Studio 0 is hiring a React developer.");
    expect(previews[0]!.body).toMatch(/unsubscribe here: https:\/\/outreach\.zz\.invalid\/u\//);
    expect(previews[0]!.body).toContain("1 Test Street, Testville");

    // The crawl finished for pa3: it joins the queue.
    await db.place.update({ where: { segment_websiteDomain: { segment: "A", websiteDomain: "pa3.zc.invalid" } }, data: { crawlStatus: "ok", signalLine: "I saw pa Studio 3 is growing." } });
    expect(await campaignTick(db, pre, settings, at(MONDAY_10, 14))).toMatchObject({ promoted: 1 });

    // Follow-up 1 after 4 days: "Re:" in the same thread.
    const first = await db.campaignLead.findFirstOrThrow({ where: { campaignId: c.id, domain: "pa0.zc.invalid" } });
    expect(first).toMatchObject({ step: 1, status: "queued" });
    expect(first.nextAt!.getTime()).toBe(MONDAY_10.getTime() + 4 * 24 * 3600_000);
    await db.campaignLead.updateMany({ where: { campaignId: c.id, domain: { not: "pa0.zc.invalid" } }, data: { nextAt: new Date("2027-06-01") } });
    await campaignTick(db, pre, settings, at(MONDAY_10, 4 * 24 * 60 + 30));
    const fu = await db.campaignSend.findFirstOrThrow({ where: { campaignLeadId: first.id, step: 2 } });
    expect(fu.subject).toBe(`Re: ${first.firstSubject}`);

    await app.inject({ method: "POST", url: `/api/v1/campaigns/${c.id}/stop`, cookies: cookie, headers: CSRF });
  });

  it("real sending: the first campaign stops after 5, follow-ups thread, suppression stops a lead, no step twice", async () => {
    await makeLeads("rb", 8);
    const real = { ...env, SENDING_ENABLED: true };
    const c = await createCampaign(db, { name: "ZZ real", segment: "A", country: "ZC", categoryKeys: [], mailboxId, size: 8 }, settings);
    expect(c.leads).toHaveLength(8);
    const launched = await launchCampaign(db, jobs, real, settings, c.id);
    expect(launched.sendLimit).toBe(FIRST_CAMPAIGN_LIMIT);

    // Suppressed after queuing: checked again right before sending.
    await db.suppression.create({ data: { kind: "email", value: "hello@rb0.zc.invalid", reason: "unsubscribed", source: "test" } });
    await refreshSuppressed(db);

    let t = at(MONDAY_10, 7 * 24 * 60); // the next Monday, 10:00
    for (let i = 0; i < 12; i++) {
      await campaignTick(db, real, settings, t);
      t = at(t, 7);
    }
    expect(sent).toHaveLength(FIRST_CAMPAIGN_LIMIT);
    expect(new Set(sent.map((m) => m.to.split("@")[1])).size).toBe(FIRST_CAMPAIGN_LIMIT); // one per company
    expect(sent.some((m) => m.to === "hello@rb0.zc.invalid")).toBe(false);
    expect((await db.campaignLead.findFirstOrThrow({ where: { campaignId: c.id, domain: "rb0.zc.invalid" } })).status).toBe("stopped");
    const paused = await db.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(paused.status).toBe("paused");
    expect(paused.note).toMatch(/Paused after 5/);
    // The HTML part shows "unsubscribe" as a link word; the plain text keeps the full address.
    expect(sent[0]!.html).toMatch(/or <a href="https:\/\/outreach\.zz\.invalid\/u\/[^"]+">unsubscribe<\/a>\./);
    expect(sent[0]!.html).toContain("I saw rb Studio");
    expect(sent[0]!.text).toMatch(/unsubscribe here: https:\/\/outreach\.zz\.invalid\/u\//);
    expect(sent[0]!.headers?.["List-Unsubscribe"]).toMatch(/^<mailto:.*>, <https:\/\/outreach\.zz\.invalid\/api\/v1\/u\//);
    expect(await db.mailLog.count({ where: { kind: "outreach", toEmail: { endsWith: ".zc.invalid" }, status: "sent" } })).toBe(5);

    // Resume: no limit any more. A follow-up goes in the same thread.
    expect((await launchCampaign(db, jobs, real, settings, c.id)).sendLimit).toBeNull();
    const lead = await db.campaignLead.findFirstOrThrow({ where: { campaignId: c.id, step: 1 }, orderBy: { id: "asc" } });
    await db.campaignLead.updateMany({ where: { campaignId: c.id, id: { not: lead.id } }, data: { nextAt: new Date("2027-06-01") } });
    await db.campaignLead.update({ where: { id: lead.id }, data: { nextAt: at(t, -1) } });
    const before = sent.length;
    await campaignTick(db, real, settings, at(t, 10));
    const followUp = sent[before]!;
    expect(followUp.to).toBe(lead.email);
    expect(followUp.subject).toBe(`Re: ${lead.firstSubject}`);
    expect(followUp.headers?.["In-Reply-To"]).toBe(lead.firstMessageId);
    expect(followUp.headers?.References).toContain(lead.firstMessageId!);

    // A step already claimed is never sent again (a second worker, a restart).
    const other = await db.campaignLead.findFirstOrThrow({ where: { campaignId: c.id, step: 0, status: "queued" } });
    await db.campaignSend.create({ data: { campaignLeadId: other.id, step: 1, mailboxId, toEmail: other.email, subject: "x", body: "x", messageId: "<x@zc.invalid>", status: "sent", createdAt: at(t, -60) } });
    await db.campaignLead.updateMany({ where: { campaignId: c.id, id: { not: other.id } }, data: { nextAt: new Date("2027-06-01") } });
    await db.campaignLead.update({ where: { id: other.id }, data: { nextAt: at(t, -1) } });
    const n = sent.length;
    await campaignTick(db, real, settings, at(t, 30));
    expect(sent.length).toBe(n);
  });

  it("API: options, create, preview, launch refuses without a postal address, mark a reply", async () => {
    await makeLeads("api", 3);
    const opts = (await app.inject({ method: "GET", url: "/api/v1/campaigns/options", cookies: cookie })).json<{ countries: { code: string }[]; mailboxes: { id: number }[]; sendingEnabled: boolean }>();
    expect(opts.countries.map((x) => x.code)).toContain("ZC");
    expect(opts.sendingEnabled).toBe(false);
    const created = await app.inject({ method: "POST", url: "/api/v1/campaigns", cookies: cookie, headers: CSRF, payload: { name: "ZZ api", segment: "A", country: "ZC", mailboxId: Number(mailboxId), size: 3 } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: number }>();
    const preview = (await app.inject({ method: "GET", url: `/api/v1/campaigns/${id}/preview`, cookies: cookie })).json<{ items: { to: string; subject: string; text: string; missing: string[] }[] }>();
    expect(preview.items).toHaveLength(3);
    expect(preview.items[0]!.missing).toEqual([]);
    expect(preview.items[0]!.text).toContain("I saw api Studio 0");

    // The settings in the database have no postal address: launching is refused (CAN-SPAM).
    const saved = await db.setting.findUnique({ where: { key: "company" } });
    await db.setting.deleteMany({ where: { key: "company" } });
    const refused = await app.inject({ method: "POST", url: `/api/v1/campaigns/${id}/launch`, cookies: cookie, headers: CSRF });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(/postal address/);
    if (saved) await db.setting.create({ data: { key: saved.key, value: saved.value as object } });

    const detail = (await app.inject({ method: "GET", url: `/api/v1/campaigns/${id}`, cookies: cookie })).json<{ leads: { id: number }[]; leads_count?: number; status: string }>();
    expect(detail.status).toBe("draft");
    const stop = await app.inject({ method: "POST", url: `/api/v1/campaigns/${id}/leads/${detail.leads[0]!.id}/stop`, cookies: cookie, headers: CSRF, payload: { reason: "replied" } });
    expect(stop.json()).toMatchObject({ status: "replied" });
    const list = (await app.inject({ method: "GET", url: "/api/v1/campaigns", cookies: cookie })).json<{ items: { name: string; leads: Record<string, number> }[] }>();
    expect(list.items.find((x) => x.name === "ZZ api")?.leads).toMatchObject({ queued: 2, replied: 1 });
    const del = await app.inject({ method: "DELETE", url: `/api/v1/campaigns/${id}`, cookies: cookie, headers: CSRF });
    expect(del.statusCode).toBe(204);
  });

  it("crawl ahead: one background crawl of ready websites not read yet, never two at once", async () => {
    await db.job.deleteMany({ where: { kind: "crawl", status: { in: ["queued", "running", "paused"] } } });
    await makeLeads("ah", 2);
    await db.place.updateMany({ where: { websiteDomain: { startsWith: "ah" } }, data: { crawlStatus: null, crawledAt: null, signalLine: null } });
    const id = await crawlAhead(db, jobs, settings);
    expect(id).not.toBeNull();
    const job = await db.job.findUniqueOrThrow({ where: { id: id! } });
    const ids = (job.params as { placeIds: number[] }).placeIds;
    const ah = await db.place.findMany({ where: { websiteDomain: { startsWith: "ah" } }, select: { id: true } });
    expect(ids).toEqual(expect.arrayContaining(ah.map((p) => Number(p.id))));
    expect(await crawlAhead(db, jobs, settings)).toBeNull(); // a crawl is already waiting
    await db.job.delete({ where: { id: id! } });
  });
});
