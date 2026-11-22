/**
 * Phase 3 on a real database: lead filters and CSV export, CSV import with mapping
 * (suppression, duplicates, invalid rows), the suppression list and its effect on leads.
 * Fake country ZZ, *.invalid domains and its own admin only; removes everything it creates.
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
import { parseCsv } from "../../src/leads/csv.js";
import { syncSeeds } from "../../src/seed/sync.js";
import { testEnv } from "../helpers/env.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const ADMIN = "phase3@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };

describe.skipIf(!url)("phase 3: filters, export, CSV import, suppression (integration)", () => {
  let db: Db;
  let app: FastifyInstance;
  let cookie: Record<string, string>;
  const listIds: number[] = [];

  async function cleanup() {
    if (!db) return;
    await db.place.deleteMany({ where: { country: "ZZ" } });
    await db.suppression.deleteMany({ where: { value: { endsWith: ".invalid" } } });
    await db.leadList.deleteMany({ where: { createdBy: ADMIN } });
    await db.auditLog.deleteMany({ where: { actor: ADMIN } });
    const admins = await db.adminUser.findMany({ where: { email: ADMIN }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { entityId: { in: admins.map((a) => a.id) } } });
    await db.adminUser.deleteMany({ where: { email: ADMIN } });
  }

  const get = (u: string) => app.inject({ method: "GET", url: u, cookies: cookie });
  const post = (u: string, payload: object) => app.inject({ method: "POST", url: u, cookies: cookie, headers: CSRF, payload });

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 4, NODE_ENV: "test" });
    await cleanup();
    await syncSeeds(db, { info: () => undefined });
    const base = { lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", country: "ZZ", city: "Testville", crawlStatus: "ok" };
    const a = await db.place.create({
      data: { ...base, segment: "A", categoryKey: "web_design", name: "Hiring Agency", website: "https://hiring.invalid/", websiteDomain: "hiring.invalid", primaryEmail: "hello@hiring.invalid", fitScore: 80, needScore: 70, leadScore: 56, signalLine: "=cmd|' /C calc'!A0" },
    });
    await db.signal.create({ data: { placeId: a.id, key: "hiring_dev", score: "need", weight: 40, value: "React Developer", evidenceUrl: "https://hiring.invalid/careers" } });
    await db.email.create({ data: { placeId: a.id, email: "hello@hiring.invalid", domain: "hiring.invalid", kind: "generic", domainMatch: "own", isPrimary: true, mxValid: true, sourceUrl: "https://hiring.invalid/contact" } });
    await db.place.create({
      data: { ...base, segment: "A", categoryKey: "marketing_agency", name: "Quiet Agency", website: "https://quiet.invalid/", websiteDomain: "quiet.invalid", primaryEmail: "info@quiet.invalid", fitScore: 40, needScore: 20, leadScore: 8 },
    });
    await db.place.create({
      data: { ...base, segment: "B", categoryKey: "dentist", name: "Clinic", website: "https://clinic.invalid/", websiteDomain: "clinic.invalid", primaryEmail: "info@clinic.invalid", fitScore: 50, needScore: 30, leadScore: 15 },
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
      remoteAddress: "10.88.0.3",
    });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db?.$disconnect();
  }, 60_000);

  it("filters Segment A + hiring_dev and exports exactly those leads as safe CSV, audited", async () => {
    const list = (await get("/api/v1/leads?country=ZZ&segment=A&signal=hiring_dev")).json<{ total: number; items: { name: string }[] }>();
    expect(list.items.map((i) => i.name)).toEqual(["Hiring Agency"]);
    expect((await get("/api/v1/leads?country=ZZ&minFit=45")).json<{ total: number }>().total).toBe(2);
    expect((await get("/api/v1/leads?country=ZZ&category=dentist")).json<{ total: number }>().total).toBe(1);
    const recheck = (await post("/api/v1/leads/crawl/count", { country: "ZZ", onlyNew: false, onlyHiring: true })).json<{ leads: number; label: string }>();
    expect(recheck).toMatchObject({ leads: 1, label: expect.stringContaining("hiring developers") as string });

    const res = await get("/api/v1/leads/export.csv?country=ZZ&segment=A&signal=hiring_dev");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="leads-/);
    const csv = parseCsv(res.body);
    expect(csv.rows).toHaveLength(1);
    const row = Object.fromEntries(csv.headers.map((h, i) => [h, csv.rows[0]![i]]));
    expect(row).toMatchObject({ company: "Hiring Agency", primary_email: "hello@hiring.invalid", hiring_role: "React Developer", segment: "A" });
    expect(row.signal_line?.startsWith("'=")).toBe(true); // a formula never runs in Excel
    const audit = await db.auditLog.findFirst({ where: { actor: ADMIN, action: "leads.export" } });
    expect(audit?.details).toMatchObject({ rows: 1, filters: { country: "ZZ", segment: "A", signal: "hiring_dev" } });
  });

  it("hiring view: the apply address is never a finance or sales address", async () => {
    const base = { lat: 0, lng: 0, confidence: 0.9, release: "1999-12-31.0", country: "ZZ", city: "Testville", crawlStatus: "ok" };
    const p = await db.place.create({
      data: { ...base, segment: "A", categoryKey: "web_design", name: "Accounts First Ltd", website: "https://acc.invalid/", websiteDomain: "acc.invalid", primaryEmail: "info@acc.invalid", fitScore: 60, needScore: 40, leadScore: 24 },
    });
    await db.signal.create({ data: { placeId: p.id, key: "hiring_dev", score: "need", weight: 40, value: "Software Engineer", evidenceUrl: "https://acc.invalid/careers" } });
    const mk = (email: string, isPrimary: boolean) =>
      db.email.create({ data: { placeId: p.id, email, domain: "acc.invalid", kind: "generic", domainMatch: "own", isPrimary, mxValid: true, sourceUrl: "https://acc.invalid/contact" } });
    await mk("accounts@acc.invalid", false);
    await mk("info@acc.invalid", true);
    const res = (await get("/api/v1/leads?country=ZZ&hiring=true&q=accounts first")).json<{ items: { applyEmail: string | null }[] }>();
    expect(res.items[0]?.applyEmail).toBe("info@acc.invalid");
    await db.place.delete({ where: { id: p.id } });
  });

  it("suppression: an address or a whole domain disappears from lists and exports, and comes back when removed", async () => {
    const add = await post("/api/v1/suppression", { value: "info@quiet.invalid", reason: "unsubscribed" });
    expect(add.statusCode).toBe(201);
    expect((await post("/api/v1/suppression", { value: "INFO@quiet.invalid", reason: "manual" })).statusCode).toBe(409);
    expect((await post("/api/v1/suppression", { value: "not valid", reason: "manual" })).statusCode).toBe(400);
    expect((await post("/api/v1/suppression", { value: "https://www.clinic.invalid/x", reason: "client" })).json()).toMatchObject({
      item: { kind: "domain", value: "clinic.invalid", reason: "client" },
    });

    const leads = (await get("/api/v1/leads?country=ZZ&sort=name")).json<{ items: { name: string; primaryEmail: string | null; suppressed: boolean }[] }>();
    expect(leads.items.map((i) => [i.name, i.primaryEmail, i.suppressed])).toEqual([
      ["Clinic", null, true],
      ["Hiring Agency", "hello@hiring.invalid", false],
      ["Quiet Agency", null, true],
    ]);
    expect((await get("/api/v1/leads?country=ZZ&hasEmail=true")).json<{ total: number }>().total).toBe(1);
    expect((await get("/api/v1/leads?country=ZZ&suppressed=true")).json<{ total: number }>().total).toBe(2);
    expect(parseCsv((await get("/api/v1/leads/export.csv?country=ZZ")).body).rows).toHaveLength(1);

    const page = (await get("/api/v1/suppression?q=.invalid")).json<{ items: { id: number; value: string }[]; byReason: Record<string, number> }>();
    expect(page.items.map((i) => i.value).sort()).toEqual(["clinic.invalid", "info@quiet.invalid"]);
    const quiet = page.items.find((i) => i.value === "info@quiet.invalid")!;
    const del = await app.inject({ method: "DELETE", url: `/api/v1/suppression/${quiet.id}`, cookies: cookie, headers: CSRF });
    expect(del.json()).toMatchObject({ removed: "info@quiet.invalid" });
    const back = (await get("/api/v1/leads?country=ZZ&q=quiet")).json<{ items: { primaryEmail: string | null; suppressed: boolean }[] }>();
    expect(back.items[0]).toMatchObject({ primaryEmail: "info@quiet.invalid", suppressed: false });

    const actions = (await db.auditLog.findMany({ where: { actor: ADMIN, entity: "suppression" }, orderBy: { id: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["suppression.add", "suppression.add", "suppression.remove"]);
  });

  it("imports a pasted suppression list (addresses and domains), skipping repeats", async () => {
    const res = await post("/api/v1/suppression/import", { text: "email\nbounced1@x.invalid\nBOUNCED1@x.invalid; @spam.invalid\nnope", reason: "bounced" });
    expect(res.json()).toMatchObject({ found: 2, added: 2, alreadyListed: 0, invalid: ["nope"] });
    const again = await post("/api/v1/suppression/import", { text: "bounced1@x.invalid", reason: "bounced" });
    expect(again.json()).toMatchObject({ found: 1, added: 0, alreadyListed: 1 });
  });

  it("CSV import: preview suggests the mapping; rows are ok, suppressed, duplicate or invalid", async () => {
    const text = [
      "E-Mail;Vorname;Firma;Webseite;Land;Stadt;Branche",
      "anna@new-co.invalid;Anna;New Co;https://new-co.invalid;Deutschland;Berlin;Software",
      "ANNA@new-co.invalid;Anna;New Co;;DE;Berlin;Software",
      "hello@hiring.invalid;;Hiring Agency;;;;",
      "info@clinic.invalid;;Clinic;;;;",
      "x@spam.invalid;;Spammy;;;;",
      "not-an-email;;Broken;;;;",
      "logo@2x.png;;Junk;;;;",
      "zoe@other.invalid;Zoe;Other;;Netherlands;Amsterdam;Retail",
    ].join("\n");
    const preview = (await post("/api/v1/lists/preview", { text })).json<{ headers: string[]; rows: number; delimiter: string; suggested: Record<string, string> }>();
    expect(preview).toMatchObject({ delimiter: ";", rows: 8 });
    expect(preview.suggested).toEqual({ email: "E-Mail", first_name: "Vorname", company: "Firma", website: "Webseite", country: "Land", city: "Stadt" });

    const bad = await post("/api/v1/lists", { name: "x", text, mapping: { email: "Mail", custom: [] } });
    expect(bad.statusCode).toBe(400);

    const imp = await post("/api/v1/lists", {
      name: "Berlin test list",
      fileName: "berlin.csv",
      text,
      mapping: { ...preview.suggested, custom: ["Branche"] },
    });
    expect(imp.statusCode).toBe(201);
    const out = imp.json<{ id: number; rows: number; counts: Record<string, number> }>();
    listIds.push(out.id);
    // anna (ok), anna again (duplicate in file), hello@hiring (already a found lead), clinic (domain suppressed),
    // spam (domain suppressed), two invalid, zoe (ok)
    expect(out.counts).toEqual({ ok: 2, suppressed: 2, duplicate: 2, invalid: 2 });

    const detail = (await get(`/api/v1/lists/${out.id}`)).json<{
      items: { email: string; status: string; note: string | null; country: string | null; custom: Record<string, string>; firstName: string | null }[];
    }>();
    const by = Object.fromEntries(detail.items.map((i) => [i.email, i]));
    expect(by["anna@new-co.invalid"]).toMatchObject({ status: "ok", country: "DE", firstName: "Anna", custom: { branche: "Software" } });
    expect(by["zoe@other.invalid"]).toMatchObject({ status: "ok", country: "NL" });
    expect(by["hello@hiring.invalid"]).toMatchObject({ status: "duplicate", note: "Already a found lead (Hiring Agency)" });
    expect(by["info@clinic.invalid"]?.status).toBe("suppressed");
    expect(by["x@spam.invalid"]?.status).toBe("suppressed");

    // A second list with the same address: duplicate of the first list.
    const second = await post("/api/v1/lists", { name: "Second", text: "email\nzoe@other.invalid\n", mapping: { email: "email", custom: [] } });
    listIds.push(second.json<{ id: number }>().id);
    expect(second.json()).toMatchObject({ counts: { ok: 0, duplicate: 1 } });

    // Suppressing later marks the list row too; only usable rows are exported.
    await post("/api/v1/suppression", { value: "zoe@other.invalid", reason: "replied_no" });
    const now = (await get(`/api/v1/lists/${out.id}?status=suppressed`)).json<{ total: number }>();
    expect(now.total).toBe(3);
    const exp = await get(`/api/v1/lists/${out.id}/export.csv`);
    const rows = parseCsv(exp.body);
    expect(rows.headers).toEqual(["email", "first_name", "company", "website", "country", "city", "branche"]);
    expect(rows.rows.map((r) => r[0])).toEqual(["anna@new-co.invalid"]);

    // Removing a suppression gives the row back its real status: ok, or duplicate of a found lead / an older list.
    await post("/api/v1/suppression", { value: "hello@hiring.invalid", reason: "manual" });
    expect((await get(`/api/v1/lists/${out.id}?status=suppressed`)).json<{ total: number }>().total).toBe(4);
    const sup = (await get("/api/v1/suppression?q=invalid")).json<{ items: { id: number; value: string }[] }>();
    for (const v of ["hello@hiring.invalid", "zoe@other.invalid"]) {
      const id = sup.items.find((i) => i.value === v)?.id;
      await app.inject({ method: "DELETE", url: `/api/v1/suppression/${id}`, cookies: cookie, headers: CSRF });
    }
    const after = Object.fromEntries(
      (await get(`/api/v1/lists/${out.id}`)).json<{ items: { email: string; status: string; note: string | null }[] }>().items.map((i) => [i.email, i]),
    );
    expect(after["hello@hiring.invalid"]).toMatchObject({ status: "duplicate", note: "Already a found lead (Hiring Agency)" });
    expect(after["zoe@other.invalid"]).toMatchObject({ status: "ok", note: null });
    const secondRows = (await get(`/api/v1/lists/${second.json<{ id: number }>().id}`)).json<{ items: { status: string; note: string }[] }>();
    expect(secondRows.items[0]).toMatchObject({ status: "duplicate", note: 'Already in the list "Berlin test list"' });

    const lists = (await get("/api/v1/lists")).json<{ items: { id: number; name: string }[] }>();
    expect(lists.items.some((l) => l.name === "Berlin test list")).toBe(true);
    const del = await app.inject({ method: "DELETE", url: `/api/v1/lists/${out.id}`, cookies: cookie, headers: CSRF });
    expect(del.statusCode).toBe(200);
    expect(await db.listLead.count({ where: { listId: BigInt(out.id) } })).toBe(0);
    const actions = (await db.auditLog.findMany({ where: { actor: ADMIN, entity: "lead_list" } })).map((a) => a.action).sort();
    expect(actions).toEqual(["list.delete", "list.export", "list.import", "list.import"]);
  });

  it("needs a login and the CSRF header", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/suppression" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/leads/export.csv" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/suppression", cookies: cookie, payload: { value: "a@b.invalid", reason: "manual" } })).statusCode).toBe(403);
  });
});
