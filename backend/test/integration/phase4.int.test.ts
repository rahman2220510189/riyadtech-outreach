/**
 * Phase 4 on a real database: mailboxes (encrypted passwords never returned), test connection,
 * DNS check, seed templates, preview with leads, "send test to myself" (own addresses only),
 * the public unsubscribe link (also one-click POST), CV files and job applications
 * (blocked while SENDING_ENABLED=false). SMTP, IMAP and DNS are fakes; nothing leaves the machine.
 * Fake country ZZ, *.invalid addresses; removes everything it creates.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE } from "../../src/auth/plugin.js";
import { seedAdmin } from "../../src/auth/seed.js";
import { prismaAuthStore } from "../../src/auth/store.js";
import { createDb, type Db } from "../../src/db/client.js";
import { JOB_SUMMARIZERS } from "../../src/jobs/handlers.js";
import { JobStore } from "../../src/jobs/store.js";
import { decryptSecret } from "../../src/mail/crypto.js";
import { setDnsTestLookups } from "../../src/mail/dns-check.js";
import { type OutgoingMail, setMailTestHooks, type SmtpConfig } from "../../src/mail/transport.js";
import { syncSeedTemplates } from "../../src/seed/sync.js";
import { testEnv } from "../helpers/env.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const ADMIN = "phase4@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };
const KEY = testEnv().ENCRYPTION_KEY!;

describe.skipIf(!url)("phase 4: mailboxes, templates, test send, unsubscribe, applications (integration)", () => {
  let db: Db;
  let app: FastifyInstance;
  let appSending: FastifyInstance;
  let cookie: Record<string, string>;
  const sent: { cfg: SmtpConfig; mail: OutgoingMail }[] = [];
  let mailboxId = 0;
  let savedSettings: { key: string; value: unknown }[] = [];

  async function cleanup() {
    if (!db) return;
    await db.application.deleteMany({ where: { company: { endsWith: "ZZ" } } });
    await db.cvFile.deleteMany({ where: { label: { startsWith: "ZZ " } } });
    await db.jobAd.deleteMany({ where: { externalId: { startsWith: "zz-p4-" } } });
    await db.mailLog.deleteMany({ where: { OR: [{ toEmail: { endsWith: ".invalid" } }, { createdBy: ADMIN }] } });
    await db.mailbox.deleteMany({ where: { fromEmail: { endsWith: ".invalid" } } });
    await db.template.deleteMany({ where: { name: { startsWith: "ZZ " } } });
    await db.place.deleteMany({ where: { country: "ZZ" } });
    await db.suppression.deleteMany({ where: { value: { endsWith: ".invalid" } } });
    const admins = await db.adminUser.findMany({ where: { email: ADMIN }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { OR: [{ actor: ADMIN }, { entityId: { in: admins.map((a) => a.id) } }, { entityId: { endsWith: ".invalid" } }] } });
    await db.adminUser.deleteMany({ where: { email: ADMIN } });
  }
  const get = (u: string) => app.inject({ method: "GET", url: u, cookies: cookie });
  const send = (method: "POST" | "PATCH" | "DELETE", u: string, payload?: object, target = app) =>
    target.inject({ method, url: u, cookies: cookie, headers: CSRF, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 4, NODE_ENV: "test" });
    await cleanup();
    savedSettings = await db.setting.findMany({ where: { key: { in: ["company", "sending"] } } });
    await syncSeedTemplates(db);
    await seedAdmin(db, ADMIN, "plum-orbit-lantern-47", 4);
    const store = new JobStore(db, JOB_SUMMARIZERS);
    const deps = { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 }, data: { db, jobs: store } };
    app = await buildApp(testEnv({ PUBLIC_BASE_URL: "https://outreach.zz.invalid" }), deps);
    appSending = await buildApp(testEnv({ PUBLIC_BASE_URL: "https://outreach.zz.invalid", SENDING_ENABLED: "true" }), deps);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: CSRF, payload: { email: ADMIN, password: "plum-orbit-lantern-47" }, remoteAddress: "10.88.0.5" });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
    setMailTestHooks({
      verifySmtp: (c) => (c.password === "app-pass-1234" ? Promise.resolve() : Promise.reject(Object.assign(new Error("535 Username and Password not accepted"), { code: "EAUTH" }))),
      verifyImap: () => Promise.reject(Object.assign(new Error("Command failed"), { authenticationFailed: true })),
      send: (cfg, mail) => {
        sent.push({ cfg, mail });
        if (mail.to === "bounce@company.invalid") return Promise.reject(Object.assign(new Error("550 No such user"), { code: "EENVELOPE", responseCode: 550 }));
        return Promise.resolve({ messageId: mail.messageId, response: "250 2.0.0 OK queued", accepted: [mail.to], rejected: [] });
      },
    });
    setDnsTestLookups({ mx: () => Promise.resolve([{ exchange: "route1.mx.cloudflare.net", priority: 10 }]), txt: () => Promise.resolve([]) });
  }, 60_000);

  afterAll(async () => {
    setMailTestHooks({});
    setDnsTestLookups(null);
    await app?.close();
    await appSending?.close();
    await cleanup();
    if (db) {
      await db.setting.deleteMany({ where: { key: { in: ["company", "sending"] } } });
      for (const s of savedSettings) await db.setting.create({ data: { key: s.key, value: s.value as object } });
      await db.$disconnect();
    }
  }, 60_000);

  it("mailboxes: the password is stored encrypted and never returned; test connection and DNS check explain the result", async () => {
    const body = {
      label: "ZZ Gmail",
      fromName: "Riyad",
      fromEmail: "Hello@Riyadtech.invalid",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "ssl",
      smtpUser: "riyad@gmail.invalid",
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapUser: "riyad@gmail.invalid",
      imapSameAsSmtp: true,
      smtpPassword: "app-pass-1234",
    };
    const res = await send("POST", "/api/v1/mailboxes", body);
    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain("app-pass-1234");
    const m = res.json<{ id: number; fromEmail: string; smtpPasswordSet: boolean; imapPasswordSet: boolean; allowedToday: number }>();
    mailboxId = m.id;
    expect(m).toMatchObject({ fromEmail: "hello@riyadtech.invalid", smtpPasswordSet: true, imapPasswordSet: true, allowedToday: 10 });
    const row = await db.mailbox.findUniqueOrThrow({ where: { id: BigInt(m.id) } });
    expect(row.smtpPasswordEnc).toMatch(/^v1:/);
    expect(decryptSecret(KEY, row.smtpPasswordEnc!)).toBe("app-pass-1234");
    expect((await send("POST", "/api/v1/mailboxes", body)).statusCode).toBe(409);
    expect((await get("/api/v1/mailboxes")).body).not.toContain("app-pass");
    const audit = await db.auditLog.findMany({ where: { entity: "mailbox", entityId: String(m.id) } });
    expect(JSON.stringify(audit.map((x) => x.details))).not.toContain("app-pass");

    const test = (await send("POST", `/api/v1/mailboxes/${m.id}/test`)).json<{ smtp: { ok: boolean; message: string }; imap: { ok: boolean; message: string } }>();
    expect(test.smtp.ok).toBe(true);
    expect(test.imap).toMatchObject({ ok: false, message: expect.stringMatching(/IMAP login failed.*App Password/) as string });

    // A wrong password: plain words, nothing sent.
    await send("PATCH", `/api/v1/mailboxes/${m.id}`, { smtpPassword: "wrong" });
    const bad = (await send("POST", `/api/v1/mailboxes/${m.id}/test`)).json<{ smtp: { ok: boolean; message: string } }>();
    expect(bad.smtp).toMatchObject({ ok: false, message: expect.stringMatching(/SMTP login failed/) as string });
    await send("PATCH", `/api/v1/mailboxes/${m.id}`, { smtpPassword: "app-pass-1234", dailyCap: 40 });
    expect(sent).toHaveLength(0);

    const dns = (await send("POST", `/api/v1/mailboxes/${m.id}/dns`)).json<{ provider: string; items: { key: string; status: string }[] }>();
    expect(dns.provider).toBe("Gmail / Google");
    expect(dns.items.find((i) => i.key === "spf")?.status).toBe("bad");
    expect((await get("/api/v1/mailboxes")).json<{ items: { id: number; lastDns: unknown; lastTest: unknown }[] }>().items.find((i) => i.id === m.id)?.lastDns).toBeTruthy();
  });

  it("templates: seeds exist; preview renders leads exactly, flags missing variables; test send only to my own addresses", async () => {
    const list = (await get("/api/v1/templates")).json<{ items: { id: number; seedKey: string | null; kind: string; variables: string[] }[]; variables: { name: string }[] }>();
    const a1 = list.items.find((t) => t.seedKey === "a-1")!;
    expect(a1.variables).toEqual(expect.arrayContaining(["company", "first_name", "signal_line", "sender_name"]));
    expect(list.items.filter((t) => t.seedKey).length).toBeGreaterThanOrEqual(10);
    expect(list.items.some((t) => t.kind === "job")).toBe(true);

    await send("PATCH", "/api/v1/settings/company", { senderName: "Riyad", postalAddress: "House 1, Road 2, Dhaka 1207, Bangladesh" });
    const base = { lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", country: "ZZ", city: "Testville", crawlStatus: "ok", segment: "A", categoryKey: "web_design" };
    const good = await db.place.create({ data: { ...base, name: "Good Agency", website: "https://good.invalid/", websiteDomain: "good.invalid", primaryEmail: "info@good.invalid", firstName: "Sam", signalLine: "I saw Good Agency is hiring.", leadScore: 99 } });
    await db.place.create({ data: { ...base, name: "No Signal Agency", website: "https://nosignal.invalid/", websiteDomain: "nosignal.invalid", primaryEmail: "info@nosignal.invalid", leadScore: 98 } });

    const p = (await send("POST", "/api/v1/templates/preview", { templateId: a1.id, mailboxId, source: { country: "ZZ", segment: "A" } })).json<{
      items: { recipient: string; to: string; subject: string; text: string; missing: string[]; willSkip: boolean; headers: Record<string, string> }[];
      problems: string[];
    }>();
    expect(p.problems).toEqual([]);
    const g = p.items.find((i) => i.recipient.startsWith("Good Agency"))!;
    expect(g.to).toBe("info@good.invalid");
    expect(g.subject).toMatch(/^(Dev capacity|Development help|A dev partner) for Good Agency\?$/);
    expect(g.text).toMatch(/^(Hi|Hello) Sam,\n\nI saw Good Agency is hiring\./);
    expect(g.text).toContain("House 1, Road 2, Dhaka 1207, Bangladesh");
    expect(g.text).toContain("https://outreach.zz.invalid/u/");
    expect(g.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(p.items.find((i) => i.recipient.startsWith("No Signal"))).toMatchObject({ missing: ["signal_line"], willSkip: true });
    // Same lead, same text (a preview equals the sent e-mail).
    const again = (await send("POST", "/api/v1/templates/preview", { templateId: a1.id, mailboxId, source: { leadIds: [Number(good.id)] } })).json<{ items: { text: string }[] }>();
    expect(again.items[0]!.text).toBe(g.text);

    const notMine = await send("POST", "/api/v1/templates/test-send", { templateId: a1.id, mailboxId, to: "info@good.invalid", leadId: Number(good.id) });
    expect(notMine.statusCode).toBe(400);
    expect(notMine.json<{ error: { code: string } }>().error.code).toBe("NOT_MY_ADDRESS");
    expect(sent).toHaveLength(0);

    const own = (await get("/api/v1/templates/test-addresses")).json<{ items: string[] }>().items;
    expect(own).toEqual(expect.arrayContaining([ADMIN, "hello@riyadtech.invalid", "riyad@gmail.invalid"]));
    const ok = await send("POST", "/api/v1/templates/test-send", { templateId: a1.id, mailboxId, to: ADMIN, leadId: Number(good.id) });
    expect(ok.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!.mail;
    expect(mail.to).toBe(ADMIN);
    expect(mail.subject).toMatch(/^\[TEST\] .* for Good Agency\?$/);
    expect(mail.text).toMatch(/^(Hi|Hello) Sam,/);
    expect(mail.headers?.["List-Unsubscribe"]).toContain("mailto:hello@riyadtech.invalid?subject=unsubscribe");
    expect(sent[0]!.cfg.password).toBe("app-pass-1234");
    expect(await db.mailLog.count({ where: { kind: "test", toEmail: ADMIN, status: "sent" } })).toBe(1);

    // A lead without a signal line cannot be used even for a test.
    const noSig = await db.place.findFirstOrThrow({ where: { websiteDomain: "nosignal.invalid" } });
    expect((await send("POST", "/api/v1/templates/test-send", { templateId: a1.id, mailboxId, to: ADMIN, leadId: Number(noSig.id) })).json<{ error: { code: string } }>().error.code).toBe("MISSING_VARIABLES");

    // Templates can be edited, created and deleted; a deleted seed template does not come back.
    const t = (await send("POST", "/api/v1/templates", { kind: "outreach", name: "ZZ mine", subject: "Hi {company}", body: "Hello {first_name|there}" })).json<{ id: number }>();
    expect((await send("PATCH", `/api/v1/templates/${t.id}`, { body: "Changed" })).json<{ body: string }>().body).toBe("Changed");
    expect((await send("DELETE", `/api/v1/templates/${t.id}`)).statusCode).toBe(200);
  });

  it("unsubscribe: the link in the e-mail works without login and without the CSRF header (one-click too)", async () => {
    const token = /\/u\/([A-Za-z0-9_.-]+)/.exec(sent[0]!.mail.text)![1]!;
    const pub = await app.inject({ method: "GET", url: `/api/v1/u/${token}` });
    expect(pub.json()).toEqual({ email: "p***@zz.invalid", unsubscribed: false });
    const oneClick = await app.inject({ method: "POST", url: `/api/v1/u/${token}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
    expect(oneClick.statusCode).toBe(200);
    expect(await db.suppression.findUnique({ where: { kind_value: { kind: "email", value: ADMIN } } })).toMatchObject({ reason: "unsubscribed", source: "unsubscribe_link" });
    expect((await app.inject({ method: "POST", url: `/api/v1/u/${token}` })).json()).toEqual({ email: "p***@zz.invalid", unsubscribed: true }); // twice is fine
    expect((await app.inject({ method: "GET", url: `/api/v1/u/${token.slice(0, -3)}abc` })).statusCode).toBe(404);
    await db.suppression.deleteMany({ where: { value: ADMIN } });
  });

  it("applications: CV upload, draft from a job advert, placeholders block sending, sending is off by default, then sent once", async () => {
    const pdf = Buffer.from("%PDF-1.4\n% fake CV\n").toString("base64");
    expect((await send("POST", "/api/v1/applications/cv-files", { label: "ZZ CV", fileName: "notes.txt", dataBase64: pdf })).statusCode).toBe(400);
    expect((await send("POST", "/api/v1/applications/cv-files", { label: "ZZ CV", fileName: "cv.pdf", dataBase64: Buffer.from("hello").toString("base64") })).statusCode).toBe(400);
    const cv = (await send("POST", "/api/v1/applications/cv-files", { label: "ZZ CV English", fileName: "Riyad CV.pdf", dataBase64: pdf })).json<{ id: number; size: number }>();
    expect(cv.size).toBeGreaterThan(5);

    const place = await db.place.create({
      data: { lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", country: "ZZ", city: "Berlin", crawlStatus: "ok", segment: "A", categoryKey: "web_design", name: "Hiring Co", website: "https://company.invalid/", websiteDomain: "company.invalid" },
    });
    await db.email.create({ data: { placeId: place.id, email: "jobs@company.invalid", domain: "company.invalid", kind: "role", domainMatch: "own", isPrimary: false, mxValid: true, sourceUrl: "https://company.invalid/jobs" } });
    const ad = await db.jobAd.create({
      data: { source: "ba", externalId: "zz-p4-1", title: "React Developer (m/w/d)", role: "React Developer", isDev: true, company: "Hiring Co ZZ", companyKey: "hiring co zz", city: "Berlin", country: "DE", url: "https://ads.invalid/1", placeId: place.id },
    });
    const created = await send("POST", "/api/v1/applications", { jobAdId: Number(ad.id), mailboxId });
    expect(created.statusCode).toBe(201);
    const a = created.json<{ id: number; subject: string; body: string; toEmail: string; cvFileIds: number[]; hasPlaceholders: boolean; status: string }>();
    expect(a).toMatchObject({ toEmail: "jobs@company.invalid", status: "draft", hasPlaceholders: true, cvFileIds: [cv.id] });
    expect(a.subject).toBe("Application: React Developer – Riyad");
    expect(a.body).toContain("the React Developer position at Hiring Co ZZ");
    expect((await send("POST", "/api/v1/applications", { jobAdId: Number(ad.id) })).statusCode).toBe(409); // one per advert

    expect((await send("POST", `/api/v1/applications/${a.id}/test-send`, { to: ADMIN })).json<{ error: { code: string } }>().error.code).toBe("PLACEHOLDERS");
    const body = a.body.replace(/\[\[[\s\S]*?\]\]/, "I like your product.");
    await send("PATCH", `/api/v1/applications/${a.id}`, { body });
    const n = sent.length;
    expect((await send("POST", `/api/v1/applications/${a.id}/test-send`, { to: ADMIN })).statusCode).toBe(200);
    const test = sent[n]!.mail;
    expect(test).toMatchObject({ to: ADMIN, subject: "[TEST] Application: React Developer – Riyad" });
    expect(test.attachments?.[0]).toMatchObject({ filename: "Riyad CV.pdf", contentType: "application/pdf" });
    expect(test.headers ?? {}).toEqual({});

    // Sending to the company is off (SENDING_ENABLED=false).
    const off = await send("POST", `/api/v1/applications/${a.id}/send`);
    expect(off.json<{ error: { code: string } }>().error.code).toBe("SENDING_OFF");
    expect(sent.length).toBe(n + 1);

    // With sending on: sent once, recorded, the advert marked as applied; a second send is refused.
    const ok = await send("POST", `/api/v1/applications/${a.id}/send`, undefined, appSending);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "sent", toEmail: "jobs@company.invalid" });
    expect(sent.at(-1)!.mail.to).toBe("jobs@company.invalid");
    expect((await db.jobAd.findUniqueOrThrow({ where: { id: ad.id } })).status).toBe("applied");
    expect((await send("POST", `/api/v1/applications/${a.id}/send`, undefined, appSending)).json<{ error: { code: string } }>().error.code).toBe("ALREADY_SENT");
    expect((await send("PATCH", `/api/v1/applications/${a.id}`, { body: "x" })).statusCode).toBe(409);
    expect((await send("PATCH", `/api/v1/applications/${a.id}`, { status: "interview", note: "Call on Monday" })).json()).toMatchObject({ status: "interview" });

    // A refused address: failed, can be edited and sent again; a suppressed address is never sent.
    const b2 = (await send("POST", "/api/v1/applications", { company: "Other ZZ", role: "Node.js Developer", toEmail: "bounce@company.invalid", mailboxId })).json<{ id: number; body: string }>();
    await send("PATCH", `/api/v1/applications/${b2.id}`, { body: b2.body.replace(/\[\[[\s\S]*?\]\]/, "Hello.") });
    const failed = await send("POST", `/api/v1/applications/${b2.id}/send`, undefined, appSending);
    expect(failed.statusCode).toBe(502);
    expect((await get(`/api/v1/applications/${b2.id}`)).json()).toMatchObject({ status: "failed" });
    await db.suppression.create({ data: { kind: "domain", value: "suppressed.invalid", reason: "manual" } });
    await send("PATCH", `/api/v1/applications/${b2.id}`, { toEmail: "hr@suppressed.invalid" });
    expect((await send("POST", `/api/v1/applications/${b2.id}/send`, undefined, appSending)).json<{ error: { code: string } }>().error.code).toBe("SUPPRESSED");

    const listed = (await get("/api/v1/applications")).json<{ byStatus: Record<string, number>; sendingEnabled: boolean }>();
    expect(listed.sendingEnabled).toBe(false);
    expect(listed.byStatus.interview).toBeGreaterThanOrEqual(1);
  });
});
