/**
 * University directory and daily check on a real database with fake sources and fake websites:
 * three sources merged by domain, admission pages found and read (robots.txt respected),
 * a useful site becomes a programme with findings, accepting/dismissing findings, a followed
 * programme's page change, pasted page text, and the schedule switch.
 * Only *.test domains and names starting with "ZZ"; everything created is removed.
 */
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE } from "../../src/auth/plugin.js";
import { seedAdmin } from "../../src/auth/seed.js";
import { prismaAuthStore } from "../../src/auth/store.js";
import { createDb, type Db } from "../../src/db/client.js";
import { JOB_SUMMARIZERS, TASK_HANDLERS } from "../../src/jobs/handlers.js";
import { JobRunner } from "../../src/jobs/runner.js";
import { JobStore } from "../../src/jobs/store.js";
import { defaultSettings } from "../../src/settings/definitions.js";
import { createCheckJob, createDirectoryJob, setStudyWatchHooks, studySchedule } from "../../src/study/watch.js";
import { testEnv } from "../helpers/env.js";
import { fakeResolve, type SiteServer, startSiteServer } from "../helpers/site-server.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const ADMIN = "study-watch@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };

describe.skipIf(!url)("study: university directory and daily check (integration)", () => {
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
      concurrency: () => 2,
    });
  async function run(make: (store: JobStore) => Promise<bigint | null>) {
    const r = runner();
    const id = await make(r.store);
    if (!id) throw new Error("no job");
    jobIds.push(id);
    await r.drain(20_000, id);
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    return (job.summary ?? {}) as Record<string, number>;
  }

  async function cleanup() {
    if (!db) return;
    await db.studyProgram.deleteMany({ where: { name: { startsWith: "ZZ" } } });
    await db.studyUniversity.deleteMany({ where: { domain: { endsWith: ".test" } } });
    await db.studyPage.deleteMany({ where: { url: { contains: ".test" } } });
    if (jobIds.length) await db.job.deleteMany({ where: { id: { in: jobIds } } });
    const admins = await db.adminUser.findMany({ where: { email: ADMIN }, select: { id: true } });
    await db.auditLog.deleteMany({ where: { OR: [{ actor: ADMIN }, { entityId: { in: admins.map((a) => a.id) } }] } });
    await db.adminUser.deleteMany({ where: { email: ADMIN } });
  }
  const get = (u: string) => app.inject({ method: "GET", url: u, cookies: cookie });
  const post = (u: string, payload?: object) => app.inject({ method: "POST", url: u, cookies: cookie, headers: CSRF, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 4, NODE_ENV: "test" });
    await cleanup();
    srv = await startSiteServer({
      "zz-uni-a.test": {
        "/robots.txt": { body: "User-agent: *\nDisallow: /private/\nSitemap: /sitemap.xml\n", type: "text/plain" },
        "/": `<html><head><link rel="alternate" hreflang="en" href="/en/"></head><body><p>Üdvözöljük az egyetemen. ${"Hírek és események. ".repeat(20)}</p></body></html>`,
        "/en/": `<html><body><a href="/en/international/admission">International admission</a><a href="/private/secret-apply">Apply (private)</a><a href="/en/news/2026">News</a>
          <p>Welcome to ZZ University A. ${"We teach many subjects to students from all over the world. ".repeat(6)}</p></body></html>`,
        "/en/international/admission": `<html><body><h1>Admission for international students</h1>
          <p>All our master's programmes are taught in English.</p>
          <p>English language requirements: IELTS Academic overall 6.0 or TOEFL iBT 80.</p>
          <p>Applicants whose previous degree was taught entirely in English may submit a Medium of Instruction letter instead.</p>
          <p>Application deadline for non-EU students: 15 March 2027.</p>
          <p>Questions: admissions@zz-uni-a.test</p>
          <a href="https://zz-uni-a.dreamapply.com/">Apply online</a>
          <a href="/en/international/fees">Tuition fees</a></body></html>`,
        "/en/international/fees": `<html><body><p>${"Tuition fees for the academic year are listed per programme. ".repeat(6)}</p></body></html>`,
        "/sitemap.xml": { body: "<urlset><url><loc>/en/international/admission</loc></url></urlset>", type: "application/xml" },
        "/private/secret-apply": "<html><body>must never be read</body></html>",
      },
      "zz-uni-b.test": {
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
        "/": `<html><body><a href="/about">About</a><p>${"A small college of arts with a long history in the old town. ".repeat(6)}</p></body></html>`,
      },
      "zz-uni-c.test": {
        "/robots.txt": { body: "User-agent: RiyadTechBot\nDisallow: /\n", type: "text/plain" },
        "/": "<html><body>closed</body></html>",
      },
      "zz-scholar.test": {
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
        "/zz-national-award": `<html><body><h1>ZZ National Talent Scholarship</h1><p>${"The ZZ National Talent Scholarship supports international master's students with tuition and a monthly stipend. ".repeat(3)}</p><p>Application deadline: 31 March 2027.</p></body></html>`,
        "/sports": `<html><body><p>${"Our football team won the regional cup again this season. ".repeat(6)}</p></body></html>`,
      },
      "zz-catalogue.test": {
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
        "/em": `<html><body><header><a href="https://ec.europa.eu/">European Commission home page</a></header><main>
          <h2>Projects (3)</h2>
          <a href="https://zz-ai.test/">ZZ Joint Master in Artificial Intelligence and Data</a>
          <a href="https://zz-marine.test/">ZZ Joint Master in Marine Biology and Ecology</a>
          <a href="https://erasmus-plus.ec.europa.eu/projects/x">Project overview on the results platform</a>
          <a href="/em?page=1">Next page of results</a></main></body></html>`,
      },
      "zz-hu.test": {
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
        "/show/1": `<html><body><table><tr><th>Course / programme name</th><td>ZZ Computer Science Engineering</td></tr><tr><th>Name of institution</th><td>ZZ Budapest University of Technology</td></tr><tr><th>Level</th><td>Master</td></tr><tr><th>Language of instruction</th><td>English</td></tr><tr><th>Entry requirements</th><td>Completed BACHELORS studies with an overall result of min. 70%.</td></tr><tr><th>Accepted language certificates</th><td>IELTS 5.5 or higher, TOEFL iBT 72</td></tr><tr><th>Contact website</th><td><a href="https://zz-bme.test/msc-cs">https://zz-bme.test/msc-cs</a></td></tr></table><p>${"Programme details for international applicants. ".repeat(5)}</p></body></html>`,
        "/show/2": `<html><body><table><tr><th>Course / programme name</th><td>ZZ Kodaly Music Pedagogy</td></tr><tr><th>Name of institution</th><td>ZZ Music Academy</td></tr><tr><th>Level</th><td>Master</td></tr><tr><th>Language of instruction</th><td>English</td></tr><tr><th>Entry requirements</th><td>Completed BACHELORS studies with an overall result of min. 70%.</td></tr><tr><th>Accepted language certificates</th><td>IELTS 5.5 or higher, TOEFL iBT 72</td></tr><tr><th>Contact website</th><td><a href="https://zz-bme.test/msc-cs">https://zz-bme.test/msc-cs</a></td></tr></table><p>${"Programme details for international applicants. ".repeat(5)}</p></body></html>`,
        "/show/3": `<html><body><table><tr><th>Course / programme name</th><td>ZZ Software Engineering</td></tr><tr><th>Name of institution</th><td>ZZ Regional University</td></tr><tr><th>Level</th><td>Master</td></tr><tr><th>Language of instruction</th><td>Hungarian</td></tr><tr><th>Entry requirements</th><td>Completed BACHELORS studies with an overall result of min. 70%.</td></tr><tr><th>Accepted language certificates</th><td>IELTS 5.5 or higher, TOEFL iBT 72</td></tr><tr><th>Contact website</th><td><a href="https://zz-bme.test/msc-cs">https://zz-bme.test/msc-cs</a></td></tr></table><p>${"Programme details for international applicants. ".repeat(5)}</p></body></html>`,
      },
      "zz-followed.test": {
        "/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
        "/apply": `<html><body><p>${"How to apply to our scholarship programme as an international student. ".repeat(4)}</p><p>The application deadline is 1 February 2027.</p></body></html>`,
      },
    });
    const origin = (h: string) => srv.origin(h);
    // Fake sources: the same university in two of them, one only in ROR, one only in Wikidata.
    setStudyWatchHooks({
      reader: { net: { resolve: fakeResolve, allowAddresses: ["127.0.0.1"] }, sleep: () => Promise.resolve() },
      today: new Date("2026-11-13T00:00:00Z"),
      directory: {
        sleep: () => Promise.resolve(),
        countries: ["HU"],
        hipoUrl: "http://fake/hipo",
        rorBase: "http://fake/ror",
        wikidataBase: "http://fake/wd",
        getJson: (u: string) => {
          if (u.includes("/hipo"))
            return Promise.resolve([
              { name: "ZZ University A", alpha_two_code: "HU", web_pages: [`${origin("zz-uni-a.test")}/`], domains: ["zz-uni-a.test"] },
              { name: "ZZ Somewhere Else", alpha_two_code: "BD", web_pages: ["https://zz-bd.test/"], domains: ["zz-bd.test"] },
            ]);
          if (u.includes("/ror"))
            return Promise.resolve({
              number_of_results: 2,
              items: [
                { id: "https://ror.org/0zz", status: "active", names: [{ value: "ZZ University A (ROR name)", types: ["ror_display"] }], links: [{ type: "website", value: `${origin("zz-uni-a.test")}/` }], locations: [{ geonames_details: { country_code: "HU" } }] },
                { id: "https://ror.org/0zy", status: "active", names: [{ value: "ZZ College B", types: ["ror_display", "label"] }], links: [{ type: "website", value: `${origin("zz-uni-b.test")}/` }], locations: [{ geonames_details: { country_code: "HU" } }] },
              ],
            });
          return Promise.resolve({
            results: {
              bindings: [
                { item: { value: "http://www.wikidata.org/entity/Q999" }, itemLabel: { value: "ZZ Closed Institute" }, website: { value: `${origin("zz-uni-c.test")}/` } },
                { item: { value: "http://www.wikidata.org/entity/Q998" }, itemLabel: { value: "Q998" }, website: { value: "https://zz-nolabel.test/" } },
              ],
            },
          });
        },
      },
    });
    await seedAdmin(db, ADMIN, "plum-orbit-lantern-48", 4);
    app = await buildApp(testEnv({}), { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 }, data: { db, jobs: new JobStore(db, JOB_SUMMARIZERS) } });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: CSRF, payload: { email: ADMIN, password: "plum-orbit-lantern-48" }, remoteAddress: "10.88.0.7" });
    cookie = { [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "" };
  }, 60_000);

  afterAll(async () => {
    setStudyWatchHooks({});
    await app?.close();
    await srv?.close();
    await cleanup();
    await db?.$disconnect();
  }, 60_000);

  it("merges the three sources by domain, Europe only", async () => {
    const sum = await run((s) => createDirectoryJob(s, undefined, { catalogues: false }));
    expect(sum.read).toBe(4); // A (hipo) + A, B (ror) + C (wikidata); Bangladesh and the unlabelled item are left out
    const rows = await db.studyUniversity.findMany({ where: { domain: { endsWith: ".test" } }, orderBy: { domain: "asc" } });
    expect(rows.map((r) => [r.domain, r.sources.sort(), r.countryCode])).toEqual([
      ["zz-uni-a.test", ["hipo", "ror"], "HU"],
      ["zz-uni-b.test", ["ror"], "HU"],
      ["zz-uni-c.test", ["wikidata"], "HU"],
    ]);
    expect(rows[0]!.name).toBe("ZZ University A"); // the first name is kept
    expect(rows[0]!.rorId).toBe("https://ror.org/0zz");
    // Running again adds nothing.
    await run((s) => createDirectoryJob(s, ["hipo"], { catalogues: false }));
    expect(await db.studyUniversity.count({ where: { domain: { endsWith: ".test" } } })).toBe(3);
  });

  it("a stopped directory import goes on where it stopped: finished countries are kept in the task", async () => {
    // ROR finished Hungary before the PC was switched off: the restarted task skips it.
    const sum = await run((s) => s.createJob({ kind: "studydir", params: { label: "ZZ resume" }, tasks: [{ kind: "study.import", payload: { source: "ror", done: ["HU"], read: 7, added: 2, updated: 5 }, maxAttempts: 2 }] }));
    expect(sum.read).toBe(7);
    expect(sum.added).toBe(2);
    // A fresh one reads Hungary and records it as done.
    const fresh = await run((s) => s.createJob({ kind: "studydir", params: { label: "ZZ fresh" }, tasks: [{ kind: "study.import", payload: { source: "ror" }, maxAttempts: 2 }] }));
    expect(fresh.read).toBe(2);
    const task = await db.jobTask.findFirstOrThrow({ where: { jobId: jobIds.at(-1)!, kind: "study.import" } });
    expect((task.payload as { done?: string[] }).done).toEqual(["HU"]);
  });

  it("reads the websites: a useful one becomes a programme with findings; robots.txt is respected", async () => {
    const ids = (await db.studyUniversity.findMany({ where: { domain: { endsWith: ".test" } }, orderBy: { domain: "asc" } })).map((u) => Number(u.id));
    const sum = await run((s) => createCheckJob(db, s, defaultSettings(), { universityIds: ids }));
    expect(sum).toMatchObject({ sites: 3, found: 1, nothing: 1, unreadable: 1 });
    const [a, b, c] = await db.studyUniversity.findMany({ where: { domain: { endsWith: ".test" } }, orderBy: { domain: "asc" } });
    expect(a).toMatchObject({ status: "found" });
    expect(b).toMatchObject({ status: "nothing" });
    expect(c).toMatchObject({ status: "unreadable" });
    expect(c!.note).toMatch(/robots/i);
    // Nothing behind Disallow and nothing on the closed site except robots.txt.
    expect(srv.requests.some((r) => r.path.startsWith("/private"))).toBe(false);
    expect(srv.requests.filter((r) => r.host === "zz-uni-c.test").map((r) => r.path)).toEqual(["/robots.txt"]);
    expect(srv.requests.every((r) => r.ua.startsWith("RiyadTechBot"))).toBe(true);

    const p = await db.studyProgram.findUniqueOrThrow({ where: { id: a!.programId! } });
    expect(p).toMatchObject({ name: "ZZ University A", country: "Hungary", origin: "auto", englishRequirement: "varies", contactEmail: "admissions@zz-uni-a.test", verified: false });
    expect(Number(p.minIelts)).toBe(6);
    expect(p.infoUrl).toMatch(/\/en\/international\/admission$/);
    expect(p.applyUrl).toBe("https://zz-uni-a.dreamapply.com/");
    const f = await db.studyFinding.findMany({ where: { programId: p.id }, orderBy: { type: "asc" } });
    expect(f.map((x) => [x.type, x.type === "moi" ? "…" : x.value])).toEqual([
      ["deadline", "2027-03-15"],
      ["moi", "…"],
    ]);
    expect(f[0]!.snippet).toContain("15 March 2027");
  });

  it("findings: list, accept a date (it becomes a confirmed deadline), dismiss, the overview step", async () => {
    const list = (await get("/api/v1/study/findings")).json<{ items: { id: number; type: string; program: string }[]; newTotal: number }>();
    const mine = list.items.filter((i) => i.program === "ZZ University A");
    expect(mine).toHaveLength(2);
    const overview = (await get("/api/v1/study/overview")).json<{ findings: number; steps: { id: string }[] }>();
    expect(overview.findings).toBeGreaterThanOrEqual(2);
    expect(overview.steps.some((s) => s.id === "findings")).toBe(true);

    const date = mine.find((i) => i.type === "deadline")!;
    expect((await post(`/api/v1/study/findings/${date.id}/accept`)).json()).toMatchObject({ status: "accepted" });
    const program = await db.studyProgram.findFirstOrThrow({ where: { name: "ZZ University A" }, include: { deadlines: true } });
    expect(program.deadlines.map((d) => [d.dueOn.toISOString().slice(0, 10), d.confirmed, d.kind])).toEqual([["2027-03-15", true, "deadline"]]);
    const moi = mine.find((i) => i.type === "moi")!;
    expect((await post(`/api/v1/study/findings/${moi.id}/dismiss`)).json()).toMatchObject({ status: "dismissed" });
    expect((await db.studyProgram.findUniqueOrThrow({ where: { id: program.id } })).englishRequirement).toBe("varies");

    // The programme list shows where it came from and how many findings wait.
    const progs = (await get("/api/v1/study/programs?origin=auto&status=all")).json<{ items: { name: string; origin: string; newFindings: number }[] }>();
    expect(progs.items.find((p) => p.name === "ZZ University A")).toMatchObject({ origin: "auto", newFindings: 0 });
  });

  it("a followed programme: its page is read again; a new date becomes a finding once", async () => {
    const p = await db.studyProgram.create({ data: { name: "ZZ Followed Scholarship", country: "Hungary", infoUrl: `${srv.origin("zz-followed.test")}/apply`, origin: "manual" } });
    const first = await run((s) => createCheckJob(db, s, defaultSettings(), { programIds: [Number(p.id)] }));
    expect(first).toMatchObject({ programs: 1, pages: 1, changed: 1, findings: 1 });
    const again = await run((s) => createCheckJob(db, s, defaultSettings(), { programIds: [Number(p.id)] }));
    expect(again).toMatchObject({ pages: 1, changed: 0, findings: 0 });
    // The page changes: a second round appears.
    srv.sites["zz-followed.test"]!["/apply"] = `<html><body><p>${"How to apply to our scholarship programme as an international student. ".repeat(4)}</p><p>The application deadline is 1 February 2027. Second application round deadline: 10 April 2027.</p></body></html>`;
    const changed = await run((s) => createCheckJob(db, s, defaultSettings(), { programIds: [Number(p.id)] }));
    expect(changed).toMatchObject({ changed: 1, findings: 1 });
    const values = (await db.studyFinding.findMany({ where: { programId: p.id } })).map((f) => f.value).sort();
    expect(values).toEqual(["2027-02-01", "2027-04-10"]);
  });

  it("pasted page text gives findings when the tool cannot read a page", async () => {
    const p = await db.studyProgram.create({ data: { name: "ZZ Pasted University", country: "Poland", origin: "manual" } });
    const res = await post(`/api/v1/study/programs/${p.id}/paste`, {
      url: "https://zz-pasted.test/admission",
      text: "English requirements: IELTS 5.5 overall. We accept a medium of instruction letter from your university. Applications close on 30 June 2027. Contact admission@zz-pasted.test",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: 4 });
    const types = (await db.studyFinding.findMany({ where: { programId: p.id } })).map((f) => f.type).sort();
    expect(types).toEqual(["deadline", "email", "ielts", "moi"]);
    const ielts = (await db.studyFinding.findFirstOrThrow({ where: { programId: p.id, type: "ielts" } })).id;
    await post(`/api/v1/study/findings/${ielts}/accept`);
    expect(Number((await db.studyProgram.findUniqueOrThrow({ where: { id: p.id } })).minIelts)).toBe(5.5);
  });

  it("the universities page lists the directory; deleting an auto programme skips its university", async () => {
    const res = (await get("/api/v1/study/universities?country=HU&q=zz")).json<{ items: { name: string; status: string; sources: string[] }[]; total: number; sources: { key: string; n: number }[] }>();
    expect(res.total).toBe(3);
    expect(res.items.map((i) => i.status).sort()).toEqual(["found", "nothing", "unreadable"]);
    const auto = await db.studyProgram.findFirstOrThrow({ where: { name: "ZZ University A" } });
    expect((await app.inject({ method: "DELETE", url: `/api/v1/study/programs/${auto.id}`, cookies: cookie, headers: CSRF })).statusCode).toBe(200);
    expect((await db.studyUniversity.findUniqueOrThrow({ where: { domain: "zz-uni-a.test" } })).status).toBe("skipped");
  });

  it("AI search: proposals are kept only when their official page names them; duplicates are skipped", async () => {
    const origin = srv.origin("zz-scholar.test");
    setStudyWatchHooks({
      reader: { net: { resolve: fakeResolve, allowAddresses: ["127.0.0.1"] }, sleep: () => Promise.resolve() },
      today: new Date("2026-11-13T00:00:00Z"),
      search: () =>
        Promise.resolve({
          raw: "",
          candidates: [
            { name: "ZZ National Talent Scholarship", url: `${origin}/zz-national-award`, deadline: "2027-03-31", english: "moi", funding: "Tuition and stipend" },
            { name: "ZZ Invented Fellowship", url: `${origin}/sports`, deadline: null, english: "unknown", funding: "" },
            { name: "ZZ Missing Grant", url: `${origin}/gone`, deadline: null, english: "unknown", funding: "" },
          ],
        }),
    });
    const sum = await run((s) => import("../../src/study/watch.js").then((m) => m.createAiSearchJob(s, ["HU"])));
    expect(sum).toMatchObject({ countries: 1, proposed: 3, verified: 1, added: 1 });
    const p = await db.studyProgram.findFirstOrThrow({ where: { name: "ZZ National Talent Scholarship" } });
    expect(p).toMatchObject({ origin: "auto", kind: "scholarship", country: "Hungary", verified: false, englishRequirement: "varies" });
    expect(p.notes).toMatch(/same date is on the page/);
    expect((await db.studyFinding.findMany({ where: { programId: p.id, type: "deadline" } })).map((f) => f.value)).toEqual(["2027-03-31"]);
    expect(await db.studyProgram.count({ where: { name: { in: ["ZZ Invented Fellowship", "ZZ Missing Grant"] } } })).toBe(0);
    // The same proposal again is not added twice.
    const again = await run((s) => import("../../src/study/watch.js").then((m) => m.createAiSearchJob(s, ["HU"])));
    expect(again).toMatchObject({ added: 0 });
  });

  it("Erasmus Mundus catalogue: programmes in my subjects become scholarships with their own websites, once", async () => {
    setStudyWatchHooks({
      reader: { net: { resolve: fakeResolve, allowAddresses: ["127.0.0.1"] }, sleep: () => Promise.resolve() },
      today: new Date("2026-11-13T00:00:00Z"),
      erasmusBase: `${srv.origin("zz-catalogue.test")}/em`,
    });
    const store = new JobStore(db, JOB_SUMMARIZERS);
    const job = await store.createJob({ kind: "studydir", params: { label: "ZZ catalogue" }, tasks: [{ kind: "study.catalogue", payload: { source: "erasmus" }, maxAttempts: 1 }] });
    jobIds.push(job);
    const r = runner();
    await r.drain(20_000, job);
    const ai = await db.studyProgram.findFirstOrThrow({ where: { name: "ZZ Joint Master in Artificial Intelligence and Data" } });
    expect(ai).toMatchObject({ kind: "scholarship", origin: "auto", infoUrl: "https://zz-ai.test/", level: "master" });
    expect(await db.studyProgram.count({ where: { name: { startsWith: "ZZ Joint Master in Marine" } } })).toBe(0); // not my subject
    expect(await db.studyProgram.count({ where: { name: { contains: "results platform" } } })).toBe(0);
    const again = await store.createJob({ kind: "studydir", params: { label: "ZZ catalogue" }, tasks: [{ kind: "study.catalogue", payload: { source: "erasmus" }, maxAttempts: 1 }] });
    jobIds.push(again);
    await runner().drain(20_000, again);
    expect(await db.studyProgram.count({ where: { name: "ZZ Joint Master in Artificial Intelligence and Data" } })).toBe(1);
  });

  it("Hungarian Study Finder: English-taught master's in my subjects, with requirements and accepted English proof", async () => {
    setStudyWatchHooks({
      reader: { net: { resolve: fakeResolve, allowAddresses: ["127.0.0.1"] }, sleep: () => Promise.resolve() },
      today: new Date("2026-11-13T00:00:00Z"),
      huBase: `${srv.origin("zz-hu.test")}/show/`,
      huTo: 8,
    });
    const store = new JobStore(db, JOB_SUMMARIZERS);
    const job = await store.createJob({ kind: "studydir", params: { label: "ZZ hu" }, tasks: [{ kind: "study.catalogue", payload: { source: "hungary" }, maxAttempts: 1 }] });
    jobIds.push(job);
    await runner().drain(20_000, job);
    const cs = await db.studyProgram.findFirstOrThrow({ where: { name: "ZZ Computer Science Engineering" } });
    expect(cs).toMatchObject({ country: "Hungary", university: "ZZ Budapest University of Technology", level: "master", infoUrl: "https://zz-bme.test/msc-cs", origin: "auto" });
    expect(Number(cs.minIelts)).toBe(5.5);
    expect(cs.howToApply).toMatch(/min\. 70%/);
    expect(cs.notes).toMatch(/IELTS 5\.5 or higher/);
    expect(await db.studyProgram.count({ where: { name: { in: ["ZZ Kodaly Music Pedagogy", "ZZ Software Engineering"] } } })).toBe(0); // not my subject / not in English
    await db.studyProgram.deleteMany({ where: { name: "ZZ Computer Science Engineering" } });
  });

  it("settings: the countries list can be changed", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/settings/study", cookies: cookie, headers: CSRF, payload: { countries: ["HU", "KR"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ value: { countries: string[] } }>().value.countries).toEqual(["HU", "KR"]);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/settings/study", cookies: cookie, headers: CSRF, payload: { countries: ["hungary"] } })).statusCode).toBe(400);
    await db.setting.deleteMany({ where: { key: "study" } });
  });

  it("the schedule does nothing when switched off or while a check runs", async () => {
    const s = defaultSettings();
    const store = new JobStore(db, JOB_SUMMARIZERS);
    expect(await studySchedule(db, store, { ...s, study: { ...s.study, autoCheck: false } })).toBeNull();
    const busy = await store.createJob({ kind: "studycheck", params: { label: "ZZ busy" }, tasks: [] });
    jobIds.push(busy);
    await db.job.update({ where: { id: busy }, data: { status: "running" } });
    expect(await studySchedule(db, store, s)).toBeNull();
  });

  it("a long directory refresh does not hold up the daily check", async () => {
    const s = defaultSettings();
    const store = new JobStore(db, JOB_SUMMARIZERS);
    await db.job.updateMany({ where: { kind: { in: ["studycheck", "studyai", "studydir"] }, status: { in: ["queued", "running", "paused"] } }, data: { status: "done" } });
    await db.job.deleteMany({ where: { kind: "studycheck", params: { path: ["auto"], equals: true } } });
    const dir = await store.createJob({ kind: "studydir", params: { label: "ZZ long refresh" }, tasks: [] });
    jobIds.push(dir);
    await db.job.update({ where: { id: dir }, data: { status: "running", createdAt: new Date(Date.now() - 8 * 86_400_000) } });
    await db.studyUniversity.update({ where: { domain: "zz-uni-b.test" }, data: { status: "new" } });
    expect(await studySchedule(db, store, s)).toBe("check");
    const check = await db.job.findFirstOrThrow({ where: { kind: "studycheck" }, orderBy: { id: "desc" } });
    jobIds.push(check.id);
    // Today's check exists and the refresh still runs: nothing more to start.
    expect(await studySchedule(db, store, s)).toBeNull();
  });
});
