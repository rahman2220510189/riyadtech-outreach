/**
 * Crawl jobs on a real database with fake websites (local server, fake DNS and MX):
 * e-mails with proof, primary choice per country rules, signals with evidence, scores,
 * repeatable re-crawls, and the leads / settings API.
 * Uses fake countries ZZ and ZY and *.invalid domains only, and removes everything it creates.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE } from "../../src/auth/plugin.js";
import { seedAdmin } from "../../src/auth/seed.js";
import { prismaAuthStore } from "../../src/auth/store.js";
import { clearCrawlCaches, createCrawlJob, setCrawlTestHooks } from "../../src/crawler/tasks.js";
import { createDb, type Db } from "../../src/db/client.js";
import { JOB_SUMMARIZERS, TASK_HANDLERS } from "../../src/jobs/handlers.js";
import { JobRunner } from "../../src/jobs/runner.js";
import { JobStore } from "../../src/jobs/store.js";
import { defaultSettings } from "../../src/settings/definitions.js";
import { syncSeeds } from "../../src/seed/sync.js";
import { testEnv } from "../helpers/env.js";
import { fakeResolve, type SiteServer, startSiteServer } from "../helpers/site-server.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const ADMIN = "crawl-api@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };

describe.skipIf(!url)("crawl jobs (integration)", () => {
  let db: Db;
  let srv: SiteServer;
  let app: FastifyInstance;
  let cookie: Record<string, string>;
  const jobIds: bigint[] = [];

  const runner = () =>
    new JobRunner({
      db,
      log: pino({ level: "silent" }),
      env: { OVERTURE_STAC_URL: "http://unused.invalid", GEONAMES_BASE_URL: "http://unused.invalid" },
      handlers: TASK_HANDLERS,
      summarizers: JOB_SUMMARIZERS,
      settings: () => defaultSettings(),
      concurrency: () => 3,
    });

  async function crawl(params: object) {
    const r = runner();
    const id = await createCrawlJob(r.store, params);
    jobIds.push(id);
    await r.drain(10_000, id);
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    return { id, job, summary: (job.summary ?? {}) as Record<string, unknown> };
  }

  async function cleanup() {
    if (!db) return;
    await db.place.deleteMany({ where: { country: { in: ["ZZ", "ZY"] } } });
    await db.domainCrawl.deleteMany({ where: { domain: { endsWith: ".invalid" } } });
    await db.mxCheck.deleteMany({ where: { domain: { endsWith: ".invalid" } } });
    await db.country.deleteMany({ where: { code: { in: ["ZZ", "ZY"] } } });
    if (jobIds.length) await db.job.deleteMany({ where: { id: { in: jobIds } } });
    await db.auditLog.deleteMany({ where: { actor: ADMIN } });
    const admins = await db.adminUser.findMany({ where: { email: ADMIN }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { entityId: { in: admins.map((a) => a.id) } } });
    await db.adminUser.deleteMany({ where: { email: ADMIN } });
  }

  let savedSettings: { key: string; value: unknown }[] = [];

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 5, NODE_ENV: "test" });
    await cleanup();
    await syncSeeds(db, { info: () => undefined });
    savedSettings = await db.setting.findMany({ where: { key: { in: ["crawler", "scores"] } } });
    const agency = (domain: string) => ({
      "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
      "/": `<html><body><a href="/contact">Contact</a><a href="/careers">Careers</a><a href="/services">Services</a><a href="/team">Team</a>
            <p>Web design, branding, SEO, social media and content for brands.</p></body></html>`,
      "/careers": "<html><body>We're hiring! Senior React Developer (remote). Apply now.</body></html>",
      "/services": "<html><body>Web design. Branding. SEO. Social media. Content marketing.</body></html>",
      "/team": "<html><body>Anna Lee, Founder. Tom Baker, Designer. Liam Walsh, Developer.</body></html>",
      "/contact": `<html><body><p>Anna Lee, Founder - <a href="mailto:anna@${domain}">anna@${domain}</a></p>
            <p>New projects: hello@${domain}</p><p>Data protection: privacy@${domain}</p></body></html>`,
    });
    srv = await startSiteServer({
      "pixel-studio.invalid": agency("pixel-studio.invalid"),
      "north-studio.invalid": agency("north-studio.invalid"),
      "smile-dental.invalid": {
        "/": `<html><body><a href="/contact-us">Contact us</a><a href="/faq">FAQ</a>
              <p>Book an appointment online. Opening hours: Monday - Friday 8am - 6pm. Download our new patient forms.</p>
              <script>fbq('init', '123');</script></body></html>`,
        "/contact-us": `<html><body>Email reception@smile-dental.invalid or call us.</body></html>`,
        "/faq": "<html><body>Frequently asked questions</body></html>",
      },
      "nomx-clinic.invalid": {
        "/": "<html><body>Contact: info@nomx-clinic.invalid</body></html>",
        "/careers": "<html><body>Join our team: we are hiring a Python Developer for our booking system. Fully remote, English-speaking team. Send your CV to jobs@nomx-clinic.invalid</body></html>",
      },
      "walled.invalid": { "/": { status: 403, body: "Forbidden" } },
    });
    const site = (host: string) => `${srv.origin(host)}/`;
    setCrawlTestHooks({
      resolve: fakeResolve,
      allowAddresses: ["127.0.0.1"],
      sleep: () => Promise.resolve(),
      mxResolve: (domain) =>
        domain.startsWith("nomx")
          ? Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }))
          : Promise.resolve([{ exchange: `mx.${domain}`, priority: 10 }]),
    });
    clearCrawlCaches();
    const rules = { law: "test", genericOnly: false, verified: true, notes: "test country" };
    await db.country.createMany({
      data: [
        { code: "ZZ", name: "Testland", timezones: ["UTC"], bbox: [0, 0, 1, 1], outreachRules: rules },
        { code: "ZY", name: "Generic-only land", timezones: ["UTC"], bbox: [0, 0, 1, 1], outreachRules: { ...rules, genericOnly: true } },
      ],
    });
    const base = { lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", city: "Testville" };
    await db.place.createMany({
      data: [
        { ...base, segment: "A", categoryKey: "web_design", name: "Pixel Studio Ltd", website: site("pixel-studio.invalid"), websiteDomain: "pixel-studio.invalid", country: "ZZ" },
        { ...base, segment: "B", categoryKey: "dentist", name: "Smile Dental", website: site("smile-dental.invalid"), websiteDomain: "smile-dental.invalid", country: "ZZ", locationCount: 2, overtureEmails: ["old@smile-dental.invalid"] },
        { ...base, segment: "B", categoryKey: "medical_clinic", name: "No MX Clinic", website: site("nomx-clinic.invalid"), websiteDomain: "nomx-clinic.invalid", country: "ZZ" },
        { ...base, segment: "B", categoryKey: "law_firm", name: "Walled Law", website: site("walled.invalid"), websiteDomain: "walled.invalid", country: "ZZ" },
        // Same website as the agency, listed as a Segment B business too: shares the crawl, not the e-mail rows.
        { ...base, segment: "B", categoryKey: "insurance_broker", name: "Pixel Studio (B)", website: site("pixel-studio.invalid"), websiteDomain: "pixel-studio.invalid", country: "ZZ" },
        // An agency in a generic-only country: the named founder may not be primary.
        { ...base, segment: "A", categoryKey: "web_design", name: "North Studio", website: site("north-studio.invalid"), websiteDomain: "north-studio.invalid", country: "ZY" },
      ],
    });

    await seedAdmin(db, ADMIN, "plum-orbit-lantern-47", 4);
    app = await buildApp(testEnv(), {
      authStore: prismaAuthStore(db),
      authOptions: { dummyHashCost: 4 },
      data: { db, jobs: new JobStore(db, JOB_SUMMARIZERS) },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { email: ADMIN, password: "plum-orbit-lantern-47" },
      remoteAddress: "10.88.0.2",
    });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
  }, 60_000);

  afterAll(async () => {
    setCrawlTestHooks({});
    await app?.close();
    await srv?.close();
    // Settings changed by the API test go back to what they were.
    await db.setting.deleteMany({ where: { key: { in: ["crawler", "scores"] } } });
    for (const s of savedSettings) await db.setting.create({ data: { key: s.key, value: s.value as object } });
    await cleanup();
    await db?.$disconnect();
  }, 60_000);

  it("crawls every lead website once and saves e-mails, signals and scores with evidence", async () => {
    const { job, summary } = await crawl({ country: "ZZ", limit: 50 });
    expect(job.error).toBeNull();
    expect(job.status).toBe("done");
    expect(summary).toMatchObject({ sites: 4, sitesDone: 4, leads: 5, readable: 3, sitesWithEmail: 3, byStatus: { ok: 3, bot_blocked: 1 } });

    const agency = await db.place.findFirstOrThrow({ where: { segment: "A", websiteDomain: "pixel-studio.invalid" }, include: { emails: true, signals: true } });
    expect(agency.crawlStatus).toBe("ok");
    expect(agency.primaryEmail).toBe("anna@pixel-studio.invalid"); // Segment A: the named founder
    expect(agency.firstName).toBe("Anna");
    expect(agency.emails.map((e) => `${e.email}:${e.kind}:${e.isPrimary}:${e.mxValid}`).sort()).toEqual([
      "anna@pixel-studio.invalid:named:true:true",
      "hello@pixel-studio.invalid:generic:false:true",
      "privacy@pixel-studio.invalid:role:false:true",
    ]);
    expect(agency.emails.every((e) => e.sourceUrl.endsWith("/contact") && e.lawfulBasis === "legitimate_interest_b2b")).toBe(true);
    const sig = Object.fromEntries(agency.signals.map((s) => [s.key, s]));
    expect(sig.hiring_dev?.value).toBe("Senior React Developer");
    expect(sig.hiring_dev?.evidenceUrl).toMatch(/\/careers$/);
    expect(sig.stack_match).toBeDefined();
    expect(sig.design_led).toBeDefined();
    expect(sig.small_team?.value).toBe("3");
    expect(agency.needScore).toBeGreaterThanOrEqual(85);
    expect(agency.signalLine).toMatch(/Pixel Studio is (hiring|looking for) a Senior React Developer/);

    const dental = await db.place.findFirstOrThrow({ where: { websiteDomain: "smile-dental.invalid" }, include: { signals: true, emails: true } });
    expect(dental.primaryEmail).toBe("reception@smile-dental.invalid");
    expect(dental.signals.map((s) => s.key).sort()).toEqual(["ads_spend", "after_hours", "booking", "faq", "manual_ops", "multi_location", "no_chat"]);
    expect(dental.bestOffer).toBe("agent"); // new patient forms (manual_ops 20) reach the agent threshold
    expect(dental.emails.map((e) => e.email)).not.toContain("old@smile-dental.invalid"); // Overture-only: no proof on the site
    expect(summary.overtureOnly).toBe(1);

    const nomx = await db.place.findFirstOrThrow({ where: { websiteDomain: "nomx-clinic.invalid" }, include: { emails: true } });
    expect(nomx.emails[0]?.mxValid).toBe(false);
    expect(nomx.primaryEmail).toBeNull(); // held back

    const walled = await db.place.findFirstOrThrow({ where: { websiteDomain: "walled.invalid" } });
    expect(walled.crawlStatus).toBe("bot_blocked");
    expect(walled.needScore).toBeNull();
    expect(walled.fitScore).toBe(50);
    const crawlRow = await db.domainCrawl.findUniqueOrThrow({ where: { domain: "walled.invalid" } });
    expect(crawlRow.error).toMatch(/403/);
  });

  it("one website, two leads: the e-mail row belongs to one lead; generic-only countries never get a named primary", async () => {
    const twin = await db.place.findFirstOrThrow({ where: { segment: "B", websiteDomain: "pixel-studio.invalid" }, include: { signals: true } });
    expect(twin.crawlStatus).toBe("ok"); // crawled in the same step as the agency
    expect(twin.primaryEmail).toBeNull(); // the addresses already belong to the agency lead (one row per address)
    expect(twin.signals.map((s) => s.key)).toContain("no_chat"); // its own segment's signals
    expect(await db.email.count({ where: { email: "hello@pixel-studio.invalid" } })).toBe(1);

    const zy = await (async () => {
      await crawl({ country: "ZY" });
      return db.place.findFirstOrThrow({ where: { country: "ZY" }, include: { emails: true } });
    })();
    expect(zy.primaryEmail).toBe("hello@north-studio.invalid");
    expect(zy.firstName).toBeNull();
    expect(zy.emails.find((e) => e.email === "anna@north-studio.invalid")?.isPrimary).toBe(false);
  });

  it("re-running: only new leads by default; a full re-crawl replaces rows without duplicates", async () => {
    const again = await crawl({ country: "ZZ" });
    expect(again.summary).toMatchObject({ sites: 0 });
    const before = await db.email.count({ where: { place: { country: "ZZ" } } });
    const signalsBefore = await db.signal.count({ where: { place: { country: "ZZ" } } });
    const full = await crawl({ country: "ZZ", onlyNew: false });
    expect(full.summary).toMatchObject({ sites: 4, sitesDone: 4, leads: 5 });
    expect(await db.email.count({ where: { place: { country: "ZZ" } } })).toBe(before);
    expect(await db.signal.count({ where: { place: { country: "ZZ" } } })).toBe(signalsBefore);
  });

  it("leads API: list with filters, detail with evidence, crawl count and start", async () => {
    const get = (u: string) => app.inject({ method: "GET", url: u, cookies: cookie });
    expect((await app.inject({ method: "GET", url: "/api/v1/leads" })).statusCode).toBe(401);
    const list = (await get("/api/v1/leads?country=ZZ&hasEmail=true&sort=score")).json<{ items: { name: string; leadScore: number; signals: string[] }[]; total: number }>();
    expect(list.total).toBe(2); // agency + dental (the B twin and the no-MX clinic have no primary)
    expect(list.items[0]!.leadScore).toBeGreaterThanOrEqual(list.items[1]!.leadScore);
    const hiring = (await get("/api/v1/leads?country=ZZ&signal=hiring_dev")).json<{ items: { id: number }[]; total: number }>();
    expect(hiring.total).toBe(1);
    expect((await get("/api/v1/leads?country=ZZ&crawl=problem")).json<{ total: number }>().total).toBe(1);
    const detail = (await get(`/api/v1/leads/${hiring.items[0]!.id}`)).json<{
      emails: { email: string; sourceUrl: string; isPrimary: boolean }[];
      signals: { key: string; label: string; evidenceUrl: string; snippet: string }[];
      crawl: { pages: { kind: string }[]; robots: { status: string } };
      signalLine: string;
    }>();
    expect(detail.emails.find((e) => e.isPrimary)?.email).toBe("anna@pixel-studio.invalid");
    const hd = detail.signals.find((s) => s.key === "hiring_dev")!;
    expect(hd.label).toBe("Hiring a developer");
    expect(hd.snippet).toMatch(/Senior React Developer/);
    expect(detail.crawl.pages.map((p) => p.kind)).toContain("careers");
    expect(detail.crawl.robots.status).toBe("ok");
    expect((await get("/api/v1/leads/999999999")).statusCode).toBe(404);

    const stats = (await get("/api/v1/leads/stats")).json<{ items: { segment: string }[] }>();
    expect(stats.items.map((i) => i.segment)).toEqual(["A", "B"]);
    const signals = (await get("/api/v1/leads/signals")).json<{ items: { key: string }[] }>();
    expect(signals.items.map((s) => s.key)).toContain("no_chat");

    // Job applications: companies advertising a developer job, both segments.
    const jobs0 = (await get("/api/v1/leads?country=ZZ&hiring=true")).json<{
      items: { name: string; segment: string; hiringRole: string; jobUrl: string; stackMatch: boolean }[];
      total: number;
    }>();
    expect(jobs0.items.map((i) => `${i.segment}:${i.hiringRole}:${i.stackMatch}`).sort()).toEqual([
      "A:Senior React Developer:true",
      "B:Python Developer:true",
      "B:Senior React Developer:true", // the Segment B twin on the agency's website
    ]);
    expect(jobs0.items.every((i) => i.jobUrl.endsWith("/careers"))).toBe(true);
    const remote = (await get("/api/v1/leads?country=ZZ&hiring=true&jobFlag=remote")).json<{
      items: { name: string; jobFlags: string[]; applyEmail: string | null; outreachAllowed: boolean }[];
    }>().items;
    expect(remote.map((i) => i.name).sort()).toEqual(["No MX Clinic", "Pixel Studio (B)", "Pixel Studio Ltd"]); // the agency's job is "(remote)" too
    const clinicJob = remote.find((i) => i.name === "No MX Clinic")!;
    expect(clinicJob.jobFlags.sort()).toEqual(["english", "remote"]);
    expect(clinicJob.applyEmail).toBeNull(); // jobs@ is on the page, but the domain takes no mail (no MX)
    expect(remote.find((i) => i.name === "Pixel Studio Ltd")?.applyEmail).toBe("hello@pixel-studio.invalid");
    expect(clinicJob.outreachAllowed).toBe(false); // ZZ is a test country with outreach off
    expect((await get("/api/v1/leads?country=ZZ&hiring=true&jobFlag=no_local_lang")).json<{ total: number }>().total).toBe(3);
    const clinic = await db.place.findFirstOrThrow({ where: { websiteDomain: "nomx-clinic.invalid" } });
    expect(clinic.needScore).toBe(30); // no_chat only: the job advert adds nothing to a Segment B score
    expect(clinic.signalLine).not.toMatch(/hiring|Python/);
    const statsHiring = (await get("/api/v1/leads/stats")).json<{ items: { hiring: number }[] }>();
    expect(statsHiring.items.reduce((n, i) => n + i.hiring, 0)).toBeGreaterThanOrEqual(2);

    const count = await app.inject({ method: "POST", url: "/api/v1/leads/crawl/count", cookies: cookie, headers: CSRF, payload: { country: "ZZ", onlyNew: false, limit: 3 } });
    expect(count.json()).toMatchObject({ matching: 5, leads: 3 });
    const readableOnly = await app.inject({ method: "POST", url: "/api/v1/leads/crawl/count", cookies: cookie, headers: CSRF, payload: { country: "ZZ", onlyNew: false, onlyReadable: true, limit: 50 } });
    const ro = readableOnly.json<{ matching: number; label: string }>();
    expect(ro.matching).toBe(4); // not the bot-blocked site
    expect(ro.label).toMatch(/readable before/);
    const bad = await app.inject({ method: "POST", url: "/api/v1/leads/crawl", cookies: cookie, headers: CSRF, payload: { country: "ZZ", limit: 0 } });
    expect(bad.statusCode).toBe(400);
    const noCsrf = await app.inject({ method: "POST", url: "/api/v1/leads/crawl", cookies: cookie, payload: { country: "ZZ" } });
    expect(noCsrf.statusCode).toBe(403);
    const start = await app.inject({ method: "POST", url: "/api/v1/leads/crawl", cookies: cookie, headers: CSRF, payload: { country: "ZZ", limit: 5 } });
    expect(start.statusCode).toBe(202);
    const jobId = start.json<{ jobId: number }>().jobId;
    jobIds.push(BigInt(jobId));
    const jobs = (await get("/api/v1/finder/jobs?kind=crawl")).json<{ items: { id: number; kind: string }[] }>();
    expect(jobs.items.some((j) => j.id === jobId && j.kind === "crawl")).toBe(true);
    await app.inject({ method: "POST", url: `/api/v1/finder/jobs/${jobId}/cancel`, cookies: cookie, headers: CSRF });
  });

  it("settings API: validated changes, audit log, unknown keys", async () => {
    const patch = (key: string, payload: object) =>
      app.inject({ method: "PATCH", url: `/api/v1/settings/${key}`, cookies: cookie, headers: CSRF, payload });
    const ok = await patch("crawler", { maxPagesPerDomain: 6 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ value: { maxPagesPerDomain: 6, minDelayMs: 1500 }, changed: ["maxPagesPerDomain"] });
    expect((await patch("crawler", { minDelayMs: 500 })).statusCode).toBe(400); // never faster than 1.5 s
    expect((await patch("scores", { weights: { no_chat: 45 } })).json()).toMatchObject({ value: { weights: { no_chat: 45 } } });
    expect((await patch("nonsense", { a: 1 })).statusCode).toBe(400);
    const all = (await app.inject({ method: "GET", url: "/api/v1/settings", cookies: cookie })).json<{ values: { crawler: { maxPagesPerDomain: number } } }>();
    expect(all.values.crawler.maxPagesPerDomain).toBe(6);
    const audit = await db.auditLog.findMany({ where: { actor: ADMIN, action: "settings.update" } });
    expect(audit.map((a) => a.entityId).sort()).toEqual(["crawler", "scores"]);
  });
});
