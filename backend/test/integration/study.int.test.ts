/**
 * Study abroad on a real database: seeds, profile, documents, programmes with dates and checklists,
 * the deadline bar, AI drafts (fake Groq), test to myself, sending only with SENDING_ENABLED.
 * Restores the profile; removes what it creates (names starting with "ZZ", *.invalid addresses).
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
import { encryptSecret } from "../../src/mail/crypto.js";
import { setGmailTestHooks } from "../../src/mail/gmail.js";
import { deliverOutbox } from "../../src/mail/outbox.js";
import { type OutgoingMail, setMailTestHooks } from "../../src/mail/transport.js";
import { syncStudySeeds } from "../../src/seed/sync.js";
import { type ChatMessage, setAiTestHook } from "../../src/study/ai.js";
import { testEnv } from "../helpers/env.js";

const urlOf = (x: unknown): string => (typeof x === "string" ? x : x instanceof URL ? x.href : x instanceof Request ? x.url : "");
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const ADMIN = "study@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };
const isoIn = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

describe.skipIf(!url)("study abroad (integration)", () => {
  let db: Db;
  let app: FastifyInstance;
  let appSending: FastifyInstance;
  let appOutbox: FastifyInstance;
  let cookie: Record<string, string>;
  let savedProfile: unknown = null;
  const sent: OutgoingMail[] = [];
  const prompts: ChatMessage[][] = [];
  let mailboxId = 0;

  async function cleanup() {
    if (!db) return;
    await db.studyEmail.deleteMany({ where: { OR: [{ toEmail: { endsWith: ".invalid" } }, { subject: { startsWith: "ZZ" } }, { program: { name: { startsWith: "ZZ" } } }] } });
    await db.studyProgram.deleteMany({ where: { name: { startsWith: "ZZ" } } });
    await db.studyDocument.deleteMany({ where: { label: { startsWith: "ZZ" } } });
    await db.mailLog.deleteMany({ where: { createdBy: ADMIN } });
    await db.mailbox.deleteMany({ where: { fromEmail: "student@uni.invalid" } });
    const admins = await db.adminUser.findMany({ where: { email: ADMIN }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { OR: [{ actor: ADMIN }, { entityId: { in: admins.map((a) => a.id) } }] } });
    await db.adminUser.deleteMany({ where: { email: ADMIN } });
  }
  const get = (u: string) => app.inject({ method: "GET", url: u, cookies: cookie });
  const send = (method: "POST" | "PATCH" | "PUT" | "DELETE", u: string, payload?: object, target = app) =>
    target.inject({ method, url: u, cookies: cookie, headers: CSRF, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 4, NODE_ENV: "test" });
    await cleanup();
    await syncStudySeeds(db);
    savedProfile = await db.studyProfile.findUnique({ where: { id: 1 } });
    await seedAdmin(db, ADMIN, "plum-orbit-lantern-47", 4);
    const env = { PUBLIC_BASE_URL: "https://outreach.zz.invalid", GROQ_API_KEY: "gsk_test_0123456789" };
    const deps = { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 }, data: { db, jobs: new JobStore(db, JOB_SUMMARIZERS) } };
    app = await buildApp(testEnv(env), deps);
    appSending = await buildApp(testEnv({ ...env, SENDING_ENABLED: "true" }), deps);
    appOutbox = await buildApp(testEnv({ ...env, SENDING_ENABLED: "true", MAIL_DELIVERY: "outbox" }), deps);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: CSRF, payload: { email: ADMIN, password: "plum-orbit-lantern-47" }, remoteAddress: "10.88.0.6" });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
    const box = await db.mailbox.create({
      data: { label: "ZZ student", fromName: "Riyad", fromEmail: "student@uni.invalid", smtpHost: "smtp.uni.invalid", smtpPort: 465, smtpSecurity: "ssl", smtpUser: "student@uni.invalid", smtpPasswordEnc: encryptSecret(testEnv().ENCRYPTION_KEY, "pw-123456"), imapHost: "imap.uni.invalid", imapPort: 993, imapUser: "student@uni.invalid" },
    });
    mailboxId = Number(box.id);
    setMailTestHooks({ send: (_c, m) => (sent.push(m), Promise.resolve({ messageId: m.messageId, response: "250 OK", accepted: [m.to], rejected: [] })) });
    setAiTestHook((_k, _model, messages) => {
      prompts.push(messages);
      if (messages[0]!.content.includes("motivation letter")) {
        const para = "I want to deepen my knowledge of natural language processing and build reliable systems for languages with few resources. ";
        return Promise.resolve(`TITLE: Statement of Purpose – ZZ letter programme\nLETTER:\n**${para.repeat(6)}**\n\n\n\n${para.repeat(6)} After the degree I plan to [[your career goal]].\n\nRiyad Hasan`);
      }
      return Promise.resolve(
        "SUBJECT: Question about MOI and scholarships for MSc\nBODY:\nDear Admissions Team,\n\nI completed a BSc in Computer Science, taught in English, with a CGPA of 3.15 out of 4. Could you tell me whether you accept a Medium of Instruction letter instead of IELTS, and whether scholarships are available for the next intake?\n\nKind regards,\nRiyad Hasan",
      );
    });
  }, 60_000);

  afterAll(async () => {
    setMailTestHooks({});
    setAiTestHook(null);
    await app?.close();
    await appSending?.close();
    await appOutbox?.close();
    await cleanup();
    if (db && savedProfile) await db.studyProfile.update({ where: { id: 1 }, data: savedProfile });
    await db?.$disconnect();
  }, 60_000);

  it("profile, documents and programmes: checklists, English fit, the deadline bar and next steps", async () => {
    const prof = await send("PUT", "/api/v1/study/profile", { fullName: "Riyad Hasan", targetLevel: "master", bscSubject: "Computer Science", bscCgpa: 3.15, englishMedium: true, ieltsScore: null, passportStatus: "applied" });
    expect(prof.json()).toMatchObject({ fullName: "Riyad Hasan", bscCgpa: 3.15, englishMedium: true });
    expect((await send("PUT", "/api/v1/study/profile", { ieltsScore: 6.3 })).statusCode).toBe(400); // IELTS goes in half bands

    const seeds = (await get("/api/v1/study/programs?status=all")).json<{ items: { seedKey: string | null; name: string }[] }>().items;
    expect(seeds.map((s) => s.seedKey)).toEqual(expect.arrayContaining(["hu-stipendium-hungaricum", "tr-turkiye-burslari", "eu-erasmus-mundus", "it-invest-your-talent", "uk-chevening", "guide-poland", "kr-gks-embassy", "my-mis", "guide-scotland"]));
    const gks = (await get("/api/v1/study/programs?status=all&country=Korea")).json<{ items: { seedKey: string | null; workWhileStudying: string | null; englishRequirement: string }[] }>().items;
    const embassy = gks.find((p) => p.seedKey === "kr-gks-embassy");
    expect(embassy?.englishRequirement).toBe("not_required");
    expect(embassy?.workWhileStudying).toMatch(/15 hours/);
    // A fact added to the seed later fills an empty field of a saved row, but never overwrites my edit.
    await db.studyProgram.update({ where: { seedKey: "guide-lithuania" }, data: { workWhileStudying: null } });
    await db.studyProgram.update({ where: { seedKey: "guide-hungary" }, data: { workWhileStudying: "my own note" } });
    await syncStudySeeds(db);
    expect((await db.studyProgram.findUniqueOrThrow({ where: { seedKey: "guide-lithuania" } })).workWhileStudying).toMatch(/20 hours/);
    expect((await db.studyProgram.findUniqueOrThrow({ where: { seedKey: "guide-hungary" } })).workWhileStudying).toBe("my own note");
    await db.studyProgram.update({ where: { seedKey: "guide-hungary" }, data: { workWhileStudying: null } });
    await syncStudySeeds(db);

    const pdf = Buffer.from("%PDF-1.4\n% test\n").toString("base64");
    expect((await send("POST", "/api/v1/study/documents", { kind: "bsc_transcript", label: "ZZ transcript", fileName: "notes.exe", dataBase64: pdf })).statusCode).toBe(400);
    const doc = await send("POST", "/api/v1/study/documents", { kind: "bsc_transcript", label: "ZZ transcript", fileName: "BSc transcript.pdf", dataBase64: pdf });
    expect(doc.statusCode).toBe(201);
    await send("POST", "/api/v1/study/documents", { kind: "moi_letter", label: "ZZ MOI", fileName: "moi.png", dataBase64: Buffer.from("\x89PNG fake").toString("base64") });

    const created = await send("POST", "/api/v1/study/programs", {
      name: "ZZ Test University MSc Computer Science",
      kind: "programme",
      country: "Hungary",
      level: "master",
      englishRequirement: "moi_ok",
      contactEmail: "Admissions@TestUni.invalid",
      requiredDocs: ["passport", "cv"],
    });
    expect(created.statusCode).toBe(201);
    const p = created.json<{ id: number; english: { fit: string }; docsNeeded: { kind: string; have: boolean }[]; docsMissing: number; contactEmail: string }>();
    expect(p.english.fit).toBe("yes");
    expect(p.contactEmail).toBe("admissions@testuni.invalid");
    expect(p.docsNeeded.map((d) => [d.kind, d.have])).toEqual([
      ["passport", false],
      ["bsc_certificate", false],
      ["bsc_transcript", true],
      ["moi_letter", true],
      ["cv", false],
    ]);
    await send("POST", `/api/v1/study/programs/${p.id}/deadlines`, { label: "ZZ application deadline", kind: "deadline", dueOn: isoIn(10), confirmed: true });
    await send("POST", `/api/v1/study/programs/${p.id}/deadlines`, { label: "ZZ old date", kind: "deadline", dueOn: isoIn(-20) });

    const bar = (await get("/api/v1/study/upcoming?days=30")).json<{ items: { program: string; label: string; daysLeft: number }[] }>().items;
    const mine = bar.filter((b) => b.program.startsWith("ZZ"));
    expect(mine).toEqual([expect.objectContaining({ label: "ZZ application deadline", daysLeft: 10 })]);

    const overview = (await get("/api/v1/study/overview")).json<{ steps: { id: string; text: string; urgent: boolean }[]; ai: { configured: boolean } }>();
    expect(overview.ai.configured).toBe(true);
    expect(overview.steps.find((s) => s.id === "passport")).toBeTruthy();
    expect(overview.steps.find((s) => s.id === `date-${p.id}`)).toMatchObject({ urgent: true });
    expect(overview.steps.some((s) => s.id === "doc-cv")).toBe(true);

    const fitYes = (await get("/api/v1/study/programs?fit=yes&level=master")).json<{ items: { id: number }[] }>().items;
    expect(fitYes.some((i) => i.id === p.id)).toBe(true);
    // Done dates leave the bar.
    const dl = await db.studyDeadline.findFirstOrThrow({ where: { label: "ZZ application deadline" } });
    await send("PATCH", `/api/v1/study/deadlines/${dl.id}`, { done: true });
    expect((await get("/api/v1/study/upcoming?days=30")).json<{ items: { program: string }[] }>().items.some((b) => b.program.startsWith("ZZ"))).toBe(false);
  });

  it("e-mails: AI draft from my facts only, my documents attached, test to myself, sending only when switched on", async () => {
    const p = (await get("/api/v1/study/programs?status=all")).json<{ items: { id: number; name: string }[] }>().items.find((i) => i.name.startsWith("ZZ"))!;
    const res = await send("POST", "/api/v1/study/emails", { programId: p.id, purpose: "inquiry", mailboxId, extra: "Ask about the September intake" });
    expect(res.statusCode).toBe(201);
    const e = res.json<{ id: number; subject: string; body: string; toEmail: string; documentIds: number[]; aiModel: string; hasPlaceholders: boolean }>();
    expect(e).toMatchObject({ subject: "Question about MOI and scholarships for MSc", toEmail: "admissions@testuni.invalid", aiModel: "openai/gpt-oss-120b", hasPlaceholders: false });
    expect(e.documentIds).toHaveLength(2); // transcript and MOI letter
    const prompt = prompts.at(-1)!;
    expect(prompt[0]!.content).toMatch(/Never invent/);
    expect(prompt[1]!.content).toContain('"bscCgpa":"3.15 out of 4"');
    expect(prompt[1]!.content).toContain("Ask about the September intake");
    expect(prompt[1]!.content).toContain("ZZ transcript");

    // A hand-written draft has placeholders and cannot be sent until they are replaced.
    const hand = (await send("POST", "/api/v1/study/emails", { programId: p.id, useAi: false, mailboxId })).json<{ id: number; hasPlaceholders: boolean }>();
    expect(hand.hasPlaceholders).toBe(true);
    expect((await send("POST", `/api/v1/study/emails/${hand.id}/test-send`, { to: ADMIN })).json<{ error: { code: string } }>().error.code).toBe("PLACEHOLDERS");

    expect((await send("POST", `/api/v1/study/emails/${e.id}/test-send`, { to: "admissions@testuni.invalid" })).json<{ error: { code: string } }>().error.code).toBe("NOT_MY_ADDRESS");
    expect((await send("POST", `/api/v1/study/emails/${e.id}/test-send`, { to: ADMIN })).statusCode).toBe(200);
    expect(sent.at(-1)).toMatchObject({ to: ADMIN, subject: "[TEST] Question about MOI and scholarships for MSc" });
    expect(sent.at(-1)!.attachments?.map((a) => a.filename).sort()).toEqual(["BSc transcript.pdf", "moi.png"]);

    expect((await send("POST", `/api/v1/study/emails/${e.id}/send`)).json<{ error: { code: string } }>().error.code).toBe("SENDING_OFF");
    const ok = await send("POST", `/api/v1/study/emails/${e.id}/send`, undefined, appSending);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "sent" });
    expect(sent.at(-1)!.to).toBe("admissions@testuni.invalid");
    expect((await get(`/api/v1/study/programs/${p.id}`)).json()).toMatchObject({ status: "preparing" });
    expect((await send("PATCH", `/api/v1/study/emails/${e.id}`, { body: "changed" })).statusCode).toBe(409);
    expect((await send("POST", `/api/v1/study/emails/${e.id}/send`, undefined, appSending)).json<{ error: { code: string } }>().error.code).toBe("ALREADY_SENT");

    // Without a key: a clear message, nothing breaks.
    const noKey = await buildApp(testEnv({ PUBLIC_BASE_URL: "https://outreach.zz.invalid" }), { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 }, data: { db, jobs: new JobStore(db, JOB_SUMMARIZERS) } });
    const r = await noKey.inject({ method: "POST", url: "/api/v1/study/emails", cookies: cookie, headers: CSRF, payload: { programId: p.id } });
    expect(r.json<{ error: { code: string } }>().error.code).toBe("AI_NOT_SET");
    await noKey.close();
  });
  it("motivation letter: AI draft from my facts and notes, gaps listed, edits saved, completion letter counts as the certificate", async () => {
    const p = (await send("POST", "/api/v1/study/programs", { name: "ZZ letter programme", kind: "programme", country: "Austria", level: "master", englishRequirement: "moi_ok", requiredDocs: [] })).json<{ id: number }>();
    expect((await get(`/api/v1/study/programs/${p.id}/letter`)).json()).toMatchObject({ letter: null, ai: { configured: true } });

    const d = await send("POST", `/api/v1/study/programs/${p.id}/letter/draft`, { notes: "I like the NLP group here.", target: "MSc Computer Science, ZZ University", length: "short" });
    expect(d.statusCode).toBe(200);
    const l = d.json<{ letter: { title: string; body: string; words: number; gaps: string[]; notes: string } }>().letter;
    expect(l.title).toBe("Statement of Purpose – ZZ letter programme");
    expect(l.body).not.toContain("**");
    expect(l.body).not.toMatch(/\n{3}/);
    expect(l.gaps).toEqual(["your career goal"]);
    expect(l.words).toBeGreaterThan(120);
    expect(l.notes).toBe("I like the NLP group here.");
    const prompt = prompts.at(-1)!;
    expect(prompt[0]!.content).toMatch(/Never invent/);
    expect(prompt[1]!.content).toContain("300 to 400 words");
    expect(prompt[1]!.content).toContain("I like the NLP group here.");
    expect(prompt[1]!.content).toContain('"name":"ZZ letter programme"');
    expect(prompt[1]!.content).toContain("Target programme (the student applies to this): MSc Computer Science, ZZ University");
    expect(prompt[0]!.content).toMatch(/A scholarship is not a study programme/);
    expect(d.json<{ letter: { target: string; checks: string[] } }>().letter).toMatchObject({ target: "MSc Computer Science, ZZ University", checks: [] });

    const saved = await send("PUT", `/api/v1/study/programs/${p.id}/letter`, { title: "My SOP", body: "Short text written by me." });
    expect(saved.json()).toMatchObject({ letter: { title: "My SOP", words: 5, gaps: [], notes: "I like the NLP group here." } });
    expect((await send("PUT", `/api/v1/study/programs/${p.id}/letter`, { title: "", body: "x" })).statusCode).toBe(400);
    expect((await send("DELETE", `/api/v1/study/programs/${p.id}/letter`)).statusCode).toBe(204);
    expect((await get(`/api/v1/study/programs/${p.id}/letter`)).json()).toMatchObject({ letter: null });
    expect((await get("/api/v1/study/programs/999999999/letter")).statusCode).toBe(404);

    // Before the certificate arrives, the completion letter covers it.
    const before = (await get(`/api/v1/study/programs/${p.id}`)).json<{ docsNeeded: { kind: string; have: boolean }[] }>();
    const hadCertificate = before.docsNeeded.find((x) => x.kind === "bsc_certificate")!.have;
    const up = await send("POST", "/api/v1/study/documents", { kind: "bsc_completion_letter", label: "ZZ completion letter", fileName: "completion.pdf", dataBase64: Buffer.from("%PDF-1.4 completion letter").toString("base64") });
    expect(up.statusCode).toBe(201);
    const after = (await get(`/api/v1/study/programs/${p.id}`)).json<{ docsNeeded: { kind: string; have: boolean; label: string }[] }>();
    const cert = after.docsNeeded.find((x) => x.kind === "bsc_certificate")!;
    expect(cert.have).toBe(true);
    if (!hadCertificate) expect(cert.label).toMatch(/completion letter/);
  });

  it("outbox (hosted on a plan that blocks SMTP): sending queues it, the PC delivers it, failures come back", async () => {
    const p = (await get("/api/v1/study/programs?status=all")).json<{ items: { id: number; name: string }[] }>().items.find((i) => i.name.startsWith("ZZ"))!;
    const draft = async (subject: string) => {
      const d = (await send("POST", "/api/v1/study/emails", { programId: p.id, useAi: false, mailboxId })).json<{ id: number }>();
      await send("PATCH", `/api/v1/study/emails/${d.id}`, { subject, body: "Dear Admissions Team,\n\nA question about the MSc.\n\nKind regards,\nRiyad", toEmail: "outbox@testuni.invalid" });
      return d.id;
    };
    const before = sent.length;
    const id = await draft("ZZ outbox one");
    const r = await send("POST", `/api/v1/study/emails/${id}/send`, undefined, appOutbox);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "sent", waiting: true });
    expect(sent.length).toBe(before); // nothing left the server
    expect((await get(`/api/v1/study/emails/${id}`)).json()).toMatchObject({ waiting: true });
    // A test to myself is queued too.
    const t = await send("POST", `/api/v1/study/emails/${id}/test-send`, { to: ADMIN }, appOutbox);
    expect(t.json()).toMatchObject({ sent: true, queued: true });

    const d1 = await deliverOutbox(db, testEnv());
    expect(d1).toMatchObject({ sent: 2, failed: 0 });
    expect(sent.slice(before).map((m) => m.subject).sort()).toEqual(["ZZ outbox one", "[TEST] ZZ outbox one"].sort());
    expect(sent.at(-1)!.from.address).toBe("student@uni.invalid");
    expect((await get(`/api/v1/study/emails/${id}`)).json()).toMatchObject({ status: "sent", waiting: false });
    expect(await db.mailLog.count({ where: { toEmail: "outbox@testuni.invalid", status: "sent" } })).toBe(1);
    expect((await deliverOutbox(db, testEnv())).sent).toBe(0); // never twice

    // The SMTP server refuses: the e-mail is marked failed and can be sent again.
    const id2 = await draft("ZZ outbox two");
    await send("POST", `/api/v1/study/emails/${id2}/send`, undefined, appOutbox);
    setMailTestHooks({ send: () => Promise.reject(Object.assign(new Error("Invalid credentials"), { code: "EAUTH" })) });
    const d2 = await deliverOutbox(db, testEnv());
    expect(d2.failed).toBe(1);
    expect((await get(`/api/v1/study/emails/${id2}`)).json()).toMatchObject({ status: "failed", waiting: false });
    expect((await get(`/api/v1/study/emails/${id2}`)).json<{ error: string }>().error).toMatch(/login failed/);
    setMailTestHooks({ send: (_c, m) => (sent.push(m), Promise.resolve({ messageId: m.messageId, response: "250 OK", accepted: [m.to], rejected: [] })) });

    // A PC that stopped mid-send: the row is marked failed, not sent again.
    const id3 = await draft("ZZ outbox three");
    await send("POST", `/api/v1/study/emails/${id3}/send`, undefined, appOutbox);
    const row = await db.mailOutbox.findFirstOrThrow({ where: { status: "queued" }, orderBy: { id: "desc" } });
    await db.mailOutbox.update({ where: { id: row.id }, data: { status: "sending", claimedAt: new Date(Date.now() - 60 * 60_000) } });
    const d3 = await deliverOutbox(db, testEnv());
    expect(d3).toMatchObject({ interrupted: 1, sent: 0 });
    expect((await get(`/api/v1/study/emails/${id3}`)).json<{ status: string; error: string }>()).toMatchObject({ status: "failed" });
    await db.mailLog.deleteMany({ where: { toEmail: "outbox@testuni.invalid" } });
  });

  it("Gmail API: connect the mailbox with Google, then it sends over HTTPS even where SMTP is blocked", async () => {
    const gEnv = { PUBLIC_BASE_URL: "https://outreach.zz.invalid", GROQ_API_KEY: "gsk_test_0123456789", SENDING_ENABLED: "true", MAIL_DELIVERY: "outbox", GOOGLE_CLIENT_ID: "zz-client.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "zz-secret-123456" };
    const appGmail = await buildApp(testEnv(gEnv), { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 }, data: { db, jobs: new JobStore(db, JOB_SUMMARIZERS) } });
    const calls: { url: string; body: string }[] = [];
    let account = "someone.else@gmail.com";
    setGmailTestHooks({
      fetch: (url, init) => {
        calls.push({ url: urlOf(url), body: typeof init?.body === "string" ? init.body : "" });
        const u = urlOf(url);
        const idToken = `x.${Buffer.from(JSON.stringify({ email: account, email_verified: true })).toString("base64url")}.y`;
        const body = u.includes("/token") ? { access_token: "at-zz", refresh_token: "rt-zz", id_token: idToken, expires_in: 3600 } : u.includes("/revoke") ? {} : { id: "gmail-msg-1" };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
      },
    });
    try {
      const list = (await appGmail.inject({ method: "GET", url: "/api/v1/mailboxes", cookies: cookie })).json<{ gmail: { available: boolean; redirectUri: string } }>();
      expect(list.gmail).toEqual({ available: true, redirectUri: "https://outreach.zz.invalid/api/v1/mailboxes/gmail/callback" });
      const start = async () => new URL((await send("POST", `/api/v1/mailboxes/${mailboxId}/gmail/start`, {}, appGmail)).json<{ url: string }>().url).searchParams.get("state")!;
      const callback = async (state: string) => appGmail.inject({ method: "GET", url: `/api/v1/mailboxes/gmail/callback?code=zz-code&state=${encodeURIComponent(state)}`, cookies: cookie });

      // Signed in with the wrong Google account: refused, token given back.
      let r = await callback(await start());
      expect(r.statusCode).toBe(302);
      expect(decodeURIComponent(r.headers.location!)).toMatch(/gmail=error.*someone\.else@gmail\.com/);
      expect(calls.some((c) => c.url.includes("/revoke"))).toBe(true);
      // A forged state is refused.
      expect(decodeURIComponent((await callback("1.9999999999999.x.bad")).headers.location!)).toMatch(/gmail=error/);

      account = "student@uni.invalid";
      r = await callback(await start());
      expect(r.headers.location).toBe("https://outreach.zz.invalid/mailboxes?gmail=connected&mailbox=student%40uni.invalid");
      const box = await db.mailbox.findUniqueOrThrow({ where: { id: BigInt(mailboxId) } });
      expect(box.gmailRefreshTokenEnc).toBeTruthy();
      expect(box.gmailRefreshTokenEnc).not.toContain("rt-zz");

      // Sending goes straight out through the Gmail API: no outbox, no SMTP.
      const p = (await get("/api/v1/study/programs?status=all")).json<{ items: { id: number; name: string }[] }>().items.find((i) => i.name.startsWith("ZZ"))!;
      const d = (await send("POST", "/api/v1/study/emails", { programId: p.id, useAi: false, mailboxId })).json<{ id: number }>();
      await send("PATCH", `/api/v1/study/emails/${d.id}`, { subject: "ZZ gmail", body: "Dear Admissions Team,\n\nA question.\n\nKind regards,\nRiyad", toEmail: "gmail@testuni.invalid" });
      const smtpBefore = sent.length;
      const res = await send("POST", `/api/v1/study/emails/${d.id}/send`, undefined, appGmail);
      expect(res.json()).toMatchObject({ status: "sent", waiting: false });
      expect(sent.length).toBe(smtpBefore);
      const raw = Buffer.from((JSON.parse(calls.at(-1)!.body) as { raw: string }).raw, "base64url").toString("utf8");
      expect(raw).toMatch(/^Subject: ZZ gmail/m);
      expect(await db.mailLog.findFirst({ where: { toEmail: "gmail@testuni.invalid" } })).toMatchObject({ status: "sent", smtpResponse: "Gmail API: accepted (id gmail-msg-1)" });

      const off = await send("POST", `/api/v1/mailboxes/${mailboxId}/gmail/disconnect`, {}, appGmail);
      expect(off.json()).toMatchObject({ gmailConnected: false });

      // An alias (sends as hello@…, logs in as a Gmail account): the login account is accepted.
      await db.mailbox.update({ where: { id: BigInt(mailboxId) }, data: { smtpUser: "zz.alias.owner@gmail.invalid" } });
      const hint = new URL((await send("POST", `/api/v1/mailboxes/${mailboxId}/gmail/start`, {}, appGmail)).json<{ url: string }>().url);
      expect(hint.searchParams.get("login_hint")).toBe("zz.alias.owner@gmail.invalid");
      account = "zz.alias.owner@gmail.invalid";
      expect((await callback(hint.searchParams.get("state")!)).headers.location).toMatch(/gmail=connected/);
    } finally {
      setGmailTestHooks({});
      await db.mailLog.deleteMany({ where: { toEmail: "gmail@testuni.invalid" } });
      await db.mailbox.update({ where: { id: BigInt(mailboxId) }, data: { gmailRefreshTokenEnc: null, gmailConnectedAt: null, smtpUser: "student@uni.invalid" } });
      await appGmail.close();
    }
  });

  it("application window: open, probably open, opens soon; the open filter and the overview list", async () => {
    const day = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + n));
    const mk = (name: string, deadlines: { kind: string; dueOn: Date }[]) =>
      db.studyProgram.create({ data: { name, country: "Hungary", applyUrl: "https://apply.example/zz", deadlines: { create: deadlines.map((d) => ({ label: d.kind, ...d })) } } });
    const open = await mk("ZZ Window Open", [{ kind: "opens", dueOn: day(-5) }, { kind: "deadline", dueOn: day(40) }]);
    const likely = await mk("ZZ Window Likely", [{ kind: "deadline", dueOn: day(20) }]);
    const soon = await mk("ZZ Window Soon", [{ kind: "opens", dueOn: day(10) }, { kind: "deadline", dueOn: day(80) }]);
    const closed = await mk("ZZ Window Closed", [{ kind: "opens", dueOn: day(-60) }, { kind: "deadline", dueOn: day(-2) }]);
    const all = (await get("/api/v1/study/programs?status=all")).json<{ items: { id: number; window: { state: string; daysLeft: number } | null }[] }>().items;
    const w = (id: bigint) => all.find((p) => p.id === Number(id))?.window ?? null;
    expect(w(open.id)).toMatchObject({ state: "open", daysLeft: 40 });
    expect(w(likely.id)).toMatchObject({ state: "likely_open", daysLeft: 20 });
    expect(w(soon.id)).toMatchObject({ state: "opens_soon", daysLeft: 10 });
    expect(w(closed.id)).toBeNull();
    const openOnly = (await get("/api/v1/study/programs?status=all&open=1")).json<{ items: { id: number }[] }>().items.map((p) => p.id);
    expect(openOnly).toEqual(expect.arrayContaining([Number(open.id), Number(likely.id)]));
    expect(openOnly).not.toContain(Number(soon.id));
    expect(openOnly).not.toContain(Number(closed.id));
    const ov = (await get("/api/v1/study/overview")).json<{ openNow: { id: number; applyUrl: string | null }[] }>().openNow.map((o) => o.id);
    expect(ov).toEqual(expect.arrayContaining([Number(open.id), Number(likely.id), Number(soon.id)]));
  });
});
