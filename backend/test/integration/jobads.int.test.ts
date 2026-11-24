/**
 * Job advert search on a real database: a search job reads both APIs (fixtures, no network),
 * saves the adverts, links them to found leads (website domain or company name), and the
 * list API filters them; keep/hide/applied; a second search keeps texts read before.
 * Uses fake country ZZ for its leads and *.invalid; removes everything it creates.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE } from "../../src/auth/plugin.js";
import { seedAdmin } from "../../src/auth/seed.js";
import { prismaAuthStore } from "../../src/auth/store.js";
import { createDb, type Db } from "../../src/db/client.js";
import { setJobAdsTestHooks } from "../../src/jobads/tasks.js";
import { JOB_SUMMARIZERS, TASK_HANDLERS } from "../../src/jobs/handlers.js";
import { JobRunner } from "../../src/jobs/runner.js";
import { JobStore } from "../../src/jobs/store.js";
import { defaultSettings } from "../../src/settings/definitions.js";
import { testEnv } from "../helpers/env.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const ADMIN = "jobads@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };

const BA = {
  maxErgebnisse: 3,
  stellenangebote: [
    {
      refnr: "ZZ-1",
      titel: "React Developer (m/w/d)",
      arbeitgeber: "Domain Match GmbH",
      arbeitsort: { plz: "10115", ort: "Berlin", land: "Deutschland" },
      aktuelleVeroeffentlichungsdatum: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10),
      externeUrl: "https://www.domainmatch.invalid/jobs/1",
    },
    {
      refnr: "ZZ-2",
      titel: "Softwareentwickler Java (w/m/d)",
      arbeitgeber: "Name Match AG",
      arbeitsort: { ort: "Hamburg", land: "Deutschland" },
      aktuelleVeroeffentlichungsdatum: new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10),
    },
    { refnr: "ZZ-3", titel: "Lagerist (m/w/d)", arbeitgeber: "Lager GmbH", arbeitsort: { ort: "Köln", land: "Deutschland" } },
  ],
};
const DETAIL = {
  stellenangebotsBeschreibung:
    "<p>We are an English speaking team. You will build our product with React and TypeScript, and you can work remotely from anywhere in the country for most of the week.</p>",
};
const AN = {
  data: [
    {
      slug: "zz-node-dev",
      company_name: "Arbeitnow Co",
      title: "Node.js Backend Engineer",
      description: "<p>Wir suchen dich. Sehr gute Deutschkenntnisse sind Pflicht.</p>",
      remote: true,
      url: "https://www.arbeitnow.com/jobs/companies/arbeitnow-co/zz-node-dev",
      tags: ["Backend"],
      job_types: ["Full Time"],
      location: "Munich",
      created_at: Math.floor(Date.now() / 1000) - 3600,
    },
  ],
  links: { next: null },
};

describe.skipIf(!url)("job adverts (integration)", () => {
  let db: Db;
  let app: FastifyInstance;
  let runner: JobRunner;
  let cookie: Record<string, string>;
  let answerDetail = true;
  const jobIds: bigint[] = [];

  async function cleanup() {
    if (!db) return;
    await db.jobAd.deleteMany({ where: { externalId: { in: ["ZZ-1", "ZZ-2", "ZZ-3", "zz-node-dev"] } } });
    await db.place.deleteMany({ where: { websiteDomain: { in: ["domainmatch.invalid", "namematch.invalid"] } } });
    if (jobIds.length) await db.job.deleteMany({ where: { id: { in: jobIds } } });
    const admins = await db.adminUser.findMany({ where: { email: ADMIN }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { OR: [{ actor: ADMIN }, { entityId: { in: admins.map((a) => a.id) } }] } });
    await db.adminUser.deleteMany({ where: { email: ADMIN } });
  }
  const get = (u: string) => app.inject({ method: "GET", url: u, cookies: cookie });
  const send = (method: "POST" | "PATCH", u: string, payload: object) => app.inject({ method, url: u, cookies: cookie, headers: CSRF, payload });

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 4, NODE_ENV: "test" });
    await cleanup();
    // Job adverts are in Germany: the leads to link are German too (name matching is per country).
    const base = { lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", country: "DE", city: "Berlin", crawlStatus: "ok", segment: "A", categoryKey: "web_design" };
    const dm = await db.place.create({ data: { ...base, name: "Domain Match", website: "https://domainmatch.invalid/", websiteDomain: "domainmatch.invalid", primaryEmail: "info@domainmatch.invalid" } });
    await db.email.create({ data: { placeId: dm.id, email: "jobs@domainmatch.invalid", domain: "domainmatch.invalid", kind: "role", domainMatch: "own", isPrimary: false, mxValid: true, sourceUrl: "https://domainmatch.invalid/careers" } });
    await db.place.create({ data: { ...base, name: "Name Match AG", website: "https://namematch.invalid/", websiteDomain: "namematch.invalid" } });
    setJobAdsTestHooks({
      baBase: "https://ba.test",
      arbeitnowBase: "https://an.test/api",
      sleep: () => Promise.resolve(),
      getJson: (u) => {
        if (u.includes("/jobdetails/")) {
          if (!answerDetail) return Promise.reject(new Error("HTTP 500"));
          return Promise.resolve(u.endsWith(Buffer.from("ZZ-1").toString("base64")) ? DETAIL : { stellenangebotsBeschreibung: "<p>Wir suchen Verstärkung für unser Team in Hamburg.</p>" });
        }
        if (u.startsWith("https://ba.test")) return Promise.resolve(u.includes("page=1") ? BA : { stellenangebote: [] });
        if (u.startsWith("https://an.test")) return Promise.resolve(u.includes("page=1") && !u.includes("visa") ? AN : { data: [], links: { next: null } });
        return Promise.reject(new Error(`unexpected ${u}`));
      },
    });
    await seedAdmin(db, ADMIN, "plum-orbit-lantern-47", 4);
    const store = new JobStore(db, JOB_SUMMARIZERS);
    app = await buildApp(testEnv(), { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 }, data: { db, jobs: store } });
    runner = new JobRunner({
      db,
      log: pino({ level: "silent" }),
      env: { OVERTURE_STAC_URL: "", GEONAMES_BASE_URL: "" },
      handlers: TASK_HANDLERS,
      summarizers: JOB_SUMMARIZERS,
      settings: () => defaultSettings(),
      concurrency: () => 1,
    });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: CSRF, payload: { email: ADMIN, password: "plum-orbit-lantern-47" }, remoteAddress: "10.88.0.4" });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
  }, 60_000);

  afterAll(async () => {
    setJobAdsTestHooks({});
    await app?.close();
    await cleanup();
    await db?.$disconnect();
  }, 60_000);

  it("searches both APIs, saves and links the adverts, and lists developer jobs with filters", async () => {
    const res = await send("POST", "/api/v1/jobads/fetch", { keywords: ["React"], where: "Berlin", radiusKm: 30, maxPages: 2 });
    expect(res.statusCode).toBe(202);
    const jobId = BigInt(res.json<{ jobId: number }>().jobId);
    jobIds.push(jobId);
    expect((await send("POST", "/api/v1/jobads/fetch", {})).statusCode).toBe(409); // one search at a time
    await runner.drain(10, jobId);
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("done");
    expect(job.summary).toMatchObject({ ads: 4, dev: 3, linked: 2, failed: 0 });

    const list = (await get("/api/v1/jobads?pageSize=50")).json<{
      total: number;
      items: { title: string; role: string; source: string; flags: string[]; stackMatch: boolean; lead: { name: string; applyEmail: string | null } | null }[];
    }>();
    const mine = list.items.filter((i) => ["React Developer (m/w/d)", "Softwareentwickler Java (w/m/d)", "Node.js Backend Engineer"].includes(i.title));
    expect(mine).toHaveLength(3); // the warehouse job is not a developer job
    const react = mine.find((i) => i.title.startsWith("React"))!;
    expect(react).toMatchObject({ role: "React Developer", stackMatch: true, lead: { name: "Domain Match", applyEmail: "jobs@domainmatch.invalid" } });
    expect(react.flags).toEqual(expect.arrayContaining(["english_team", "remote", "ad_english"]));
    expect(mine.find((i) => i.title.startsWith("Software"))?.lead?.name).toBe("Name Match AG");
    expect(mine.find((i) => i.source === "arbeitnow")?.flags).toEqual(expect.arrayContaining(["remote", "local_lang"]));

    const titles = async (qs: string) =>
      (await get(`/api/v1/jobads?${qs}&pageSize=100`)).json<{ items: { title: string }[] }>().items.map((i) => i.title).filter((t) => mine.some((m) => m.title === t));
    expect(await titles("flag=english")).toEqual(["React Developer (m/w/d)"]);
    expect(await titles("flag=no_local_lang&source=arbeitnow")).toEqual([]);
    expect(await titles("stack=true&sort=company")).toEqual(["Node.js Backend Engineer", "React Developer (m/w/d)"]);
    expect(await titles("days=7&source=ba")).toEqual(["React Developer (m/w/d)"]);
    expect(await titles("place=hamburg")).toEqual(["Softwareentwickler Java (w/m/d)"]);
    expect((await titles("dev=false&q=lagerist")).length).toBe(0); // only "mine" are compared
    expect((await get("/api/v1/jobads?dev=false&q=Lagerist")).json<{ total: number }>().total).toBe(1);

    const stats = (await get("/api/v1/jobads/stats")).json<{ lastFetch: { status: string; summary: { dev: number } } }>();
    expect(stats.lastFetch).toMatchObject({ status: "done", summary: { dev: 3 } });
  });

  it("match with my profile: entry level filter, best match first, reasons; my German level counts", async () => {
    type Item = { title: string; fit: { level: string; seniority: string; warnings: string[]; matched: string[] } };
    const list = (await get("/api/v1/jobads?sort=fit&level=entry&pageSize=100")).json<{ total: number; items: Item[]; profile: { germanLevel: string } }>();
    expect(list.profile.germanLevel).toBe("a1");
    const titles = list.items.map((i) => i.title);
    const react = list.items.find((i) => i.title.startsWith("React Developer"))!;
    const node = list.items.find((i) => i.title.startsWith("Node.js Backend Engineer"))!;
    expect(react.fit.matched).toEqual(expect.arrayContaining(["React", "TypeScript"]));
    expect(node.fit.warnings.join(" ")).toMatch(/German/);
    expect(titles.indexOf(react.title)).toBeLessThan(titles.indexOf(node.title));
    expect(list.items.every((i) => i.fit.seniority === "junior" || i.fit.seniority === "open")).toBe(true);
    const good = (await get("/api/v1/jobads?fit=possible&pageSize=100")).json<{ items: Item[] }>().items;
    expect(good.every((i) => i.fit.level !== "unlikely")).toBe(true);

    expect((await send("PATCH", "/api/v1/settings/jobProfile", { germanLevel: "c1" })).statusCode).toBe(200);
    const after = (await get("/api/v1/jobads?sort=fit&pageSize=100")).json<{ items: Item[] }>().items.find((i) => i.title.startsWith("Node.js Backend Engineer"))!;
    expect(after.fit.warnings.join(" ")).not.toMatch(/German/);
    expect((await send("PATCH", "/api/v1/settings/jobProfile", { germanLevel: "zz" })).statusCode).toBe(400);
    await db.setting.deleteMany({ where: { key: "jobProfile" } });
  });

  it("keep, hide and applied; a second search keeps the text read before", async () => {
    const ad = await db.jobAd.findFirstOrThrow({ where: { externalId: "ZZ-1" } });
    expect((await send("PATCH", `/api/v1/jobads/${ad.id}`, { status: "hidden" })).json()).toMatchObject({ status: "hidden" });
    expect((await get("/api/v1/jobads?q=React Developer")).json<{ items: { title: string }[] }>().items.some((i) => i.title.startsWith("React Developer"))).toBe(false);
    expect((await get("/api/v1/jobads?status=hidden&q=Domain Match")).json<{ total: number }>().total).toBe(1);
    expect((await send("PATCH", `/api/v1/jobads/${ad.id}`, { status: "applied", note: "Sent CV on 15 Oct" })).json()).toMatchObject({ status: "applied", note: "Sent CV on 15 Oct" });
    expect((await send("PATCH", `/api/v1/jobads/${ad.id}`, { status: "deleted" })).statusCode).toBe(400);

    answerDetail = false; // the text is not read again (already known), so a failure would not matter
    const res = await send("POST", "/api/v1/jobads/fetch", { sources: ["ba"], keywords: ["React"] });
    const jobId = BigInt(res.json<{ jobId: number }>().jobId);
    jobIds.push(jobId);
    await runner.drain(10, jobId);
    const again = await db.jobAd.findFirstOrThrow({ where: { externalId: "ZZ-1" } });
    expect(again.status).toBe("applied");
    expect(again.description).toContain("English speaking team");
    expect(again.flags).toContain("english_team");
    expect(again.lastSeenAt.getTime()).toBeGreaterThan(ad.lastSeenAt.getTime());
  });

  it("saves a large search quickly (one statement per 500 adverts)", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({
      slug: `zz-bulk-${i}`,
      company_name: `Bulk ${i % 50} GmbH`,
      title: i % 3 === 0 ? "React Developer" : "Sales Manager",
      description: "<p>Wir suchen dich.</p>",
      remote: i % 2 === 0,
      url: `https://www.arbeitnow.com/jobs/zz-bulk-${i}`,
      tags: ["IT"],
      job_types: [],
      location: "Berlin",
      created_at: Math.floor(Date.now() / 1000),
    }));
    setJobAdsTestHooks({
      arbeitnowBase: "https://an.test/api",
      sleep: () => Promise.resolve(),
      getJson: (u) => {
        const page = Number(new URL(u).searchParams.get("page"));
        if (u.includes("visa")) return Promise.resolve({ data: [], links: { next: null } });
        return Promise.resolve({ data: many.slice((page - 1) * 100, page * 100), links: { next: page < 12 ? "x" : null } });
      },
    });
    try {
      const res = await send("POST", "/api/v1/jobads/fetch", { sources: ["arbeitnow"], maxPages: 20 });
      const jobId = BigInt(res.json<{ jobId: number }>().jobId);
      jobIds.push(jobId);
      const t0 = Date.now();
      await runner.drain(5, jobId);
      expect(Date.now() - t0).toBeLessThan(15_000);
      const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.summary).toMatchObject({ ads: 1200, dev: 400, added: 1200, failed: 0 });
      expect(await db.jobAd.count({ where: { externalId: { startsWith: "zz-bulk-" }, isDev: true, flags: { has: "remote" } } })).toBe(200);
      // Again: all updated, none added.
      const res2 = await send("POST", "/api/v1/jobads/fetch", { sources: ["arbeitnow"], maxPages: 20 });
      const jobId2 = BigInt(res2.json<{ jobId: number }>().jobId);
      jobIds.push(jobId2);
      await runner.drain(5, jobId2);
      expect((await db.job.findUniqueOrThrow({ where: { id: jobId2 } })).summary).toMatchObject({ ads: 1200, added: 0 });
    } finally {
      await db.jobAd.deleteMany({ where: { externalId: { startsWith: "zz-bulk-" } } });
    }
  }, 60_000);
});
