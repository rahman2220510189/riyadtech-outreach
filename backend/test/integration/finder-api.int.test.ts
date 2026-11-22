/**
 * Areas and finder API on a real database: login, area picker, estimate, job detail, pause/cancel.
 * Uses its own fake admin (zz.invalid), fake GeoNames ids and removes everything it creates.
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
import { syncSeeds } from "../../src/seed/sync.js";
import { testEnv } from "../helpers/env.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const EMAIL = "finder-api@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };

describe.skipIf(!url)("finder API (integration)", () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie: Record<string, string>;
  const jobIds: number[] = [];

  const switched = ["SM", "AT"];
  let originalEnabled: Record<string, boolean> = {};

  async function cleanup() {
    await db.auditLog.deleteMany({ where: { entity: "country", actor: EMAIL } });
    await db.job.deleteMany({ where: { id: { in: jobIds.map(BigInt) } } });
    await db.location.deleteMany({ where: { geonameId: { gte: 990_000_000 } } });
    const admins = await db.adminUser.findMany({ where: { email: EMAIL }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { entityId: { in: admins.map((a) => a.id) } } });
    await db.adminUser.deleteMany({ where: { email: EMAIL } });
  }

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 3, NODE_ENV: "test" });
    await cleanup();
    await syncSeeds(db, { info: () => undefined });
    originalEnabled = Object.fromEntries(
      (await db.country.findMany({ where: { code: { in: switched } } })).map((c) => [c.code, c.enabled]),
    );
    await db.country.updateMany({ where: { code: { in: switched } }, data: { enabled: false } });
    await db.location.createMany({
      data: [
        { geonameId: 990643123, country: "GB", kind: "city", name: "Manchester", asciiName: "Manchester", admin1Code: "ENG", regionCode: "GB-ENG", lat: 53.48, lng: -2.24, population: 395515, timezone: "Europe/London" },
        { geonameId: 990643124, country: "GB", kind: "city", name: "Mansfield", asciiName: "Mansfield", admin1Code: "ENG", regionCode: "GB-ENG", lat: 53.14, lng: -1.2, population: 110000, timezone: "Europe/London" },
        { geonameId: 991000001, country: "GB", kind: "region", name: "England", asciiName: "England", admin1Code: "ENG", regionCode: "GB-ENG", population: 0 },
      ],
    });
    await seedAdmin(db, EMAIL, "plum-orbit-lantern-47", 4);
    app = await buildApp(testEnv(), {
      authStore: prismaAuthStore(db),
      authOptions: { dummyHashCost: 4 },
      data: { db, jobs: new JobStore(db, JOB_SUMMARIZERS) },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { email: EMAIL, password: "plum-orbit-lantern-47" },
      remoteAddress: "10.88.0.1",
    });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const [code, enabled] of Object.entries(originalEnabled)) await db.country.update({ where: { code }, data: { enabled } });
    await cleanup();
    await db.$disconnect();
  });

  it("needs a login", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/areas/countries" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/finder/jobs" })).statusCode).toBe(401);
  });

  it("lists countries with rules and location counts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/areas/countries", cookies: cookie });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: { code: string; enabled: boolean; blocked: boolean; cities: number }[] }>().items;
    expect(items.find((c) => c.code === "GB")).toMatchObject({ enabled: true, blocked: false });
    expect(items.find((c) => c.code === "GB")!.cities).toBeGreaterThanOrEqual(2);
    expect(items.find((c) => c.code === "DE")).toMatchObject({ enabled: false, blocked: true });
    expect(items.slice(0, 4).map((c) => c.code)).toEqual(["GB", "IE", "US", "AU"]);
  });

  it("searches cities by prefix, biggest first, with a default radius", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/areas/countries/gb/cities?q=man", cookies: cookie });
    const items = res.json<{ items: { geonameId: number; name: string; population: number; regionName: string; defaultRadiusKm: number }[] }>().items;
    // The database may also hold the real GeoNames cities (after a real import): check order and our fake rows only.
    expect(items.every((c) => c.name.toLowerCase().startsWith("man"))).toBe(true);
    expect(items.map((c) => c.population)).toEqual([...items.map((c) => c.population)].sort((x, y) => y - x));
    const ours = items.filter((c) => c.geonameId >= 990_000_000);
    expect(ours.map((c) => c.name)).toEqual(["Manchester", "Mansfield"]);
    expect(ours[0]).toMatchObject({ regionName: "England", defaultRadiusKm: 16.6 });
  });

  it("lists categories with data-source attribution", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/finder/categories", cookies: cookie });
    const body = res.json<{ items: { segment: string }[]; dataSources: { name: string }[] }>();
    expect(body.items.length).toBeGreaterThan(15);
    expect(body.dataSources.map((d) => d.name)).toEqual(["Overture Maps Foundation", "GeoNames"]);
  });

  it("validates the area before creating a job", async () => {
    const tooBig = await app.inject({
      method: "POST",
      url: "/api/v1/finder/estimate",
      headers: CSRF,
      cookies: cookie,
      payload: { country: "GB", segments: ["A"] },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json<{ error: { message: string } }>().error.message).toMatch(/too large/);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/finder/jobs",
      headers: CSRF,
      cookies: cookie,
      payload: { country: "DE", segments: ["A"] },
    });
    expect(blocked.statusCode).toBe(400);

    const badCategory = await app.inject({
      method: "POST",
      url: "/api/v1/finder/estimate",
      headers: CSRF,
      cookies: cookie,
      payload: { country: "GB", cityGeonameId: 990643123, segments: ["A"], categoryKeys: ["dentist"] },
    });
    expect(badCategory.statusCode).toBe(400);
    expect(badCategory.json<{ error: { message: string } }>().error.message).toMatch(/not in the chosen segments/);
  });

  it("creates an estimate, shows it, pauses and cancels it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/finder/estimate",
      headers: CSRF,
      cookies: cookie,
      payload: { country: "GB", cityGeonameId: 990643123, segments: ["A", "B"] },
    });
    expect(created.statusCode).toBe(202);
    const { jobId } = created.json<{ jobId: number }>();
    jobIds.push(jobId);

    const detail = await app.inject({ method: "GET", url: `/api/v1/finder/jobs/${jobId}`, cookies: cookie });
    expect(detail.json()).toMatchObject({
      id: jobId,
      kind: "finder",
      status: "running",
      dryRun: true,
      tasks: { queued: 1 },
      params: { country: "GB", cityGeonameId: 990643123 },
    });

    const list = await app.inject({ method: "GET", url: "/api/v1/finder/jobs?kind=finder", cookies: cookie });
    expect(list.json<{ items: { id: number }[] }>().items.some((j) => j.id === jobId)).toBe(true);

    const pause = await app.inject({ method: "POST", url: `/api/v1/finder/jobs/${jobId}/pause`, headers: CSRF, cookies: cookie });
    expect(pause.json()).toEqual({ status: "paused" });
    const pauseAgain = await app.inject({ method: "POST", url: `/api/v1/finder/jobs/${jobId}/pause`, headers: CSRF, cookies: cookie });
    expect(pauseAgain.json()).toEqual({ status: "paused" }); // repeating changes nothing
    const cancel = await app.inject({ method: "POST", url: `/api/v1/finder/jobs/${jobId}/cancel`, headers: CSRF, cookies: cookie });
    expect(cancel.json()).toEqual({ status: "cancelled" });

    const events = (await app.inject({ method: "GET", url: `/api/v1/finder/jobs/${jobId}`, cookies: cookie })).json<{
      events: { message: string }[];
    }>().events;
    expect(events.filter((e) => /paused by finder-api@zz.invalid/.test(e.message))).toHaveLength(1);
    const resumeCancelled = await app.inject({ method: "POST", url: `/api/v1/finder/jobs/${jobId}/resume`, headers: CSRF, cookies: cookie });
    expect(resumeCancelled.statusCode).toBe(409);
  });

  it("switches countries on and off with the right confirmations, and audits it", async () => {
    const patch = (code: string, payload: object) =>
      app.inject({ method: "PATCH", url: `/api/v1/areas/countries/${code}`, headers: CSRF, cookies: cookie, payload });

    const noConfirm = await patch("SM", { enabled: true });
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json()).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED", details: { need: "confirmRules" } } });
    expect((await patch("SM", { enabled: true, confirmRules: true })).json()).toEqual({ code: "SM", enabled: true });
    expect((await patch("SM", { enabled: true, confirmRules: true })).json()).toEqual({ code: "SM", enabled: true }); // no-op

    const blocked = await patch("AT", { enabled: true, confirmRules: true });
    expect(blocked.json()).toMatchObject({ error: { details: { need: "confirmBlocked" } } });
    expect((await patch("AT", { enabled: true, confirmRules: true, confirmBlocked: true })).json()).toEqual({ code: "AT", enabled: true });

    const est = await app.inject({
      method: "POST",
      url: "/api/v1/finder/estimate",
      headers: CSRF,
      cookies: cookie,
      payload: { country: "SM", segments: ["B"] },
    });
    expect(est.statusCode).toBe(202); // San Marino: whole country allowed, now enabled
    jobIds.push(est.json<{ jobId: number }>().jobId);

    expect((await patch("SM", { enabled: false })).json()).toEqual({ code: "SM", enabled: false });
    expect((await patch("AT", { enabled: false })).json()).toEqual({ code: "AT", enabled: false });
    const audit = await db.auditLog.findMany({ where: { entity: "country", actor: EMAIL }, orderBy: { id: "asc" } });
    expect(audit.map((a) => `${a.action}:${a.entityId}`)).toEqual([
      "country.enable:SM",
      "country.enable:AT",
      "country.disable:SM",
      "country.disable:AT",
    ]);
    expect(audit[1]?.details).toMatchObject({ blocked: true, confirmedBlocked: true });
  });

  it("job search only: a country can be searched without enabling outreach, and it is audited", async () => {
    const estimate = () =>
      app.inject({ method: "POST", url: "/api/v1/finder/estimate", headers: CSRF, cookies: cookie, payload: { country: "SM", segments: ["A"] } });
    const js = (on: boolean) =>
      app.inject({ method: "PATCH", url: "/api/v1/areas/countries/SM/job-search", headers: CSRF, cookies: cookie, payload: { jobSearch: on } });
    expect((await estimate()).statusCode).toBe(400); // San Marino: outreach off, job search off
    expect((await js(true)).json()).toEqual({ code: "SM", jobSearch: true });
    const est = await estimate();
    expect(est.statusCode).toBe(202);
    jobIds.push(est.json<{ jobId: number }>().jobId);
    const list = (await app.inject({ method: "GET", url: "/api/v1/areas/countries", cookies: cookie })).json<{
      items: { code: string; enabled: boolean; jobSearch: boolean }[];
    }>().items;
    expect(list.find((c) => c.code === "SM")).toMatchObject({ enabled: false, jobSearch: true });
    expect(list.find((c) => c.code === "DE")?.jobSearch).toBe(true); // Riyad's goal: Germany starts in job-search mode
    expect((await js(false)).json()).toEqual({ code: "SM", jobSearch: false });
    const audit = await db.auditLog.findMany({
      where: { entity: "country", entityId: "SM", action: { startsWith: "country.job_search" } },
      orderBy: { id: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["country.job_search_on", "country.job_search_off"]);
  });

  it("starts a GeoNames import job", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/areas/geonames",
      headers: CSRF,
      cookies: cookie,
      payload: { countries: ["IE"] },
    });
    expect(res.statusCode).toBe(202);
    jobIds.push(res.json<{ jobId: number }>().jobId);
  });
});
