import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { JobStore, Summarizer } from "../jobs/store.js";
import { type JsonObject, RequeueTask, type TaskContext, type TaskHandler } from "../jobs/types.js";
import type { Settings } from "../settings/definitions.js";
import { countryName, DIRECTORY_SOURCES, type DirectorySource, saveDirectoryEntries } from "./directory.js";
import { type Extracted, factSignature, hasFacts, mergeFacts } from "./extract.js";
import { ERASMUS_CATALOGUE, HU_STUDY_FINDER, matchesSubjects, readErasmusCatalogue, readStudyFinder } from "./catalogues.js";
import { type AiCandidate, checkCandidates, searchScholarships } from "./discover.js";
import { type ReaderDeps, type ReaderSettings, readPages, type ReadPage, readUniversitySite } from "./reader.js";
import { DIRECTORY_DEFAULTS, type DirectoryDeps, directoryGetJson, fetchDirectory } from "./sources.js";

/** Job kinds: the directory refresh and the daily check. */
export const STUDY_DIR_JOB = "studydir";
export const STUDY_CHECK_JOB = "studycheck";
export const STUDY_AI_JOB = "studyai";

/** Test hooks: fake sources and websites, no real waiting. */
export interface StudyWatchHooks {
  directory?: Partial<DirectoryDeps>;
  reader?: ReaderDeps;
  today?: Date;
  /** Catalogue addresses in tests. */
  erasmusBase?: string;
  huBase?: string;
  huTo?: number;
  /** Replaces the Groq search in tests. */
  search?: (countryName: string) => Promise<{ candidates: AiCandidate[]; raw: string }>;
}
let hooks: StudyWatchHooks = {};
export function setStudyWatchHooks(h: StudyWatchHooks): void {
  hooks = h;
}

function readerSettings(s: Settings): ReaderSettings {
  return {
    minDelayMs: Math.max(2_000, s.crawler.minDelayMs),
    timeoutMs: s.crawler.timeoutMs,
    maxBytes: s.crawler.maxBytes,
    maxRedirects: s.crawler.maxRedirects,
    maxCrawlDelaySeconds: s.crawler.maxCrawlDelaySeconds,
    maxPages: s.study.maxPagesPerSite,
  };
}

async function stillRunning(ctx: TaskContext): Promise<void> {
  await ctx.touch();
  const j = await ctx.db.job.findUnique({ where: { id: ctx.job.id }, select: { status: true } });
  if (j?.status !== "running") throw new RequeueTask("The check was paused or cancelled");
}

function readerDeps(ctx: TaskContext): ReaderDeps {
  return { ...hooks.reader, checkpoint: () => stillRunning(ctx), ...(hooks.today ? { today: hooks.today } : {}) };
}

// ---- jobs -------------------------------------------------------------------------------------

export async function createDirectoryJob(store: JobStore, sources: readonly DirectorySource[] = DIRECTORY_SOURCES, opts: { catalogues?: boolean } = {}): Promise<bigint> {
  const catalogues = opts.catalogues ?? true;
  return store.createJob({
    kind: STUDY_DIR_JOB,
    params: { sources: [...sources], label: `University directory: ${sources.join(", ")}${catalogues ? " + Erasmus Mundus catalogue" : ""}` },
    tasks: [
      ...sources.map((source) => ({ kind: "study.import", payload: { source }, maxAttempts: 2 })),
      ...(catalogues
        ? [
            { kind: "study.catalogue", payload: { source: "erasmus" }, maxAttempts: 2 },
            { kind: "study.catalogue", payload: { source: "hungary" }, maxAttempts: 1 },
          ]
        : []),
    ],
    message: "University directory refresh created",
  });
}

/**
 * The daily check: every followed programme's own pages, plus N universities from the
 * directory that were never read (those listed by more sources first), plus a few old "nothing found" ones.
 */
export async function createCheckJob(db: Db, store: JobStore, s: Settings, opts: { newSites?: number; universityIds?: number[]; programIds?: number[]; auto?: boolean } = {}): Promise<bigint | null> {
  const tasks: { kind: string; payload: JsonObject; maxAttempts: number }[] = [];
  if (opts.universityIds) {
    for (const id of opts.universityIds) tasks.push({ kind: "study.site", payload: { universityId: id }, maxAttempts: 1 });
  } else if (opts.programIds) {
    for (const id of opts.programIds) tasks.push({ kind: "study.program", payload: { programId: id }, maxAttempts: 1 });
  } else {
    const programs = await db.studyProgram.findMany({
      where: { status: { notIn: ["rejected", "not_now", "accepted"] }, OR: [{ infoUrl: { not: null } }, { applyUrl: { not: null } }, { pages: { some: {} } }] },
      select: { id: true },
    });
    for (const p of programs) tasks.push({ kind: "study.program", payload: { programId: Number(p.id) }, maxAttempts: 1 });
    const n = opts.newSites ?? s.study.newSitesPerDay;
    if (n > 0) {
      const fresh = await db.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM study_universities WHERE status = 'new' AND country_code = ANY(${s.study.countries}::text[])
          ORDER BY cardinality(sources) DESC, id LIMIT ${n}`;
      const retry = await db.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM study_universities WHERE status IN ('nothing','unreadable') AND country_code = ANY(${s.study.countries}::text[])
          AND last_checked_at < now() - make_interval(days => ${s.study.retryNothingDays}) ORDER BY last_checked_at LIMIT ${Math.ceil(n / 4)}`;
      for (const u of [...fresh, ...retry]) tasks.push({ kind: "study.site", payload: { universityId: Number(u.id) }, maxAttempts: 1 });
    }
  }
  if (tasks.length === 0) return null;
  const sites = tasks.filter((t) => t.kind === "study.site").length;
  return store.createJob({
    kind: STUDY_CHECK_JOB,
    params: { label: `University check: ${tasks.length - sites} programme${tasks.length - sites === 1 ? "" : "s"}, ${sites} website${sites === 1 ? "" : "s"}`, programs: tasks.length - sites, sites, auto: opts.auto ?? false },
    tasks,
    message: "University check created",
  });
}

/** One AI search job: one task per country. */
export async function createAiSearchJob(store: JobStore, countries: string[], auto = false): Promise<bigint> {
  return store.createJob({
    kind: STUDY_AI_JOB,
    params: { label: `Scholarship search with AI: ${countries.map(countryName).join(", ")}`, countries, auto },
    tasks: countries.map((country) => ({ kind: "study.ai", payload: { country }, maxAttempts: 1 })),
    message: "Scholarship search created",
  });
}

/** Today's countries for the AI search: the chosen countries in turn, N a day. */
export function aiCountriesFor(s: Settings, now = new Date()): string[] {
  const list = [...s.study.countries].sort();
  const n = Math.min(s.study.aiCountriesPerDay, list.length);
  const day = Math.floor(now.getTime() / 86_400_000);
  const start = (day * n) % list.length;
  return Array.from({ length: n }, (_, i) => list[(start + i) % list.length]!);
}

/** Called by the worker every few minutes: starts the directory refresh and the daily check when due. */
export async function studySchedule(db: Db, store: JobStore, s: Settings, now = new Date(), env: { GROQ_API_KEY?: string | undefined } = {}): Promise<string | null> {
  if (!s.study.autoCheck) return null;
  // Each kind waits only for itself: a long directory refresh (hours, over several days when the
  // PC is off) must not hold up the daily check or the AI search.
  const busyKinds = new Set(
    (await db.job.findMany({ where: { kind: { in: [STUDY_DIR_JOB, STUDY_CHECK_JOB, STUDY_AI_JOB] }, status: { in: ["queued", "running", "paused"] } }, select: { kind: true } })).map((j) => j.kind),
  );
  const lastDir = await db.job.findFirst({ where: { kind: STUDY_DIR_JOB }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (!busyKinds.has(STUDY_DIR_JOB) && (!lastDir || now.getTime() - lastDir.createdAt.getTime() > s.study.directoryRefreshDays * 86_400_000)) {
    await createDirectoryJob(store);
    return "directory";
  }
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const today = await db.job.count({ where: { kind: STUDY_CHECK_JOB, createdAt: { gte: dayStart }, params: { path: ["auto"], equals: true } } });
  if (today === 0 && !busyKinds.has(STUDY_CHECK_JOB)) {
    const id = await createCheckJob(db, store, s, { auto: true });
    if (id) return "check";
  }
  if (s.study.aiSearch && env.GROQ_API_KEY) {
    const ai = await db.job.count({ where: { kind: STUDY_AI_JOB, createdAt: { gte: dayStart }, params: { path: ["auto"], equals: true } } });
    if (ai === 0 && !busyKinds.has(STUDY_AI_JOB)) {
      await createAiSearchJob(store, aiCountriesFor(s, now), true);
      return "ai";
    }
  }
  return null;
}

// ---- findings ---------------------------------------------------------------------------------

type ProgramFacts = { id: bigint; minIelts: Prisma.Decimal | null; contactEmail: string | null; englishRequirement: string };

/** New findings from one page's facts; values already known (or already decided) are skipped. */
export async function addFindings(db: Db, program: ProgramFacts, page: { id: bigint | null; url: string }, f: Extracted): Promise<number> {
  const dates = new Set(
    (await db.studyDeadline.findMany({ where: { programId: program.id }, select: { dueOn: true } })).map((d) => d.dueOn.toISOString().slice(0, 10)),
  );
  const rows: Prisma.StudyFindingCreateManyInput[] = [];
  const base = { programId: program.id, pageId: page.id, url: page.url };
  for (const d of f.deadlines) if (!dates.has(d.date)) rows.push({ ...base, type: "deadline", value: d.date, label: d.label, snippet: d.snippet });
  const min = program.minIelts === null ? null : Number(program.minIelts);
  for (const i of f.ielts) if (i.score !== min) rows.push({ ...base, type: "ielts", value: i.score.toFixed(1), snippet: i.snippet });
  if (program.englishRequirement !== "moi_ok") for (const m of f.moi) rows.push({ ...base, type: "moi", value: m.slice(0, 300), snippet: m });
  for (const e of f.emails) if (e !== program.contactEmail) rows.push({ ...base, type: "email", value: e, snippet: `Address on ${page.url}` });
  if (rows.length === 0) return 0;
  const r = await db.studyFinding.createMany({ data: rows, skipDuplicates: true });
  return r.count;
}

async function savePage(db: Db, p: ReadPage, link: { programId?: bigint; universityId?: bigint }): Promise<{ id: bigint; changed: boolean }> {
  const sig = p.status === "ok" ? factSignature(p.facts) : null;
  const old = await db.studyPage.findUnique({ where: { url: p.url }, select: { id: true, signature: true } });
  const data = {
    lastStatus: p.status,
    lastError: p.error ?? null,
    lastFetchedAt: new Date(),
    ...(p.status === "ok" ? { extracted: p.facts as unknown as Prisma.InputJsonValue, signature: sig } : {}),
    ...(link.programId ? { programId: link.programId } : {}),
    ...(link.universityId ? { universityId: link.universityId } : {}),
  };
  if (old) {
    await db.studyPage.update({ where: { id: old.id }, data });
    return { id: old.id, changed: p.status === "ok" && sig !== old.signature };
  }
  const created = await db.studyPage.create({ data: { url: p.url, ...data } });
  return { id: created.id, changed: p.status === "ok" };
}

// ---- task handlers ----------------------------------------------------------------------------

export const studyImportTask: TaskHandler = async (ctx) => {
  const payload = ctx.task.payload as { source: DirectorySource; done?: string[]; read?: number; added?: number; updated?: number };
  const { source } = payload;
  // Progress is kept in the task itself: after a restart (worker closed, PC off) the task goes on
  // with the countries it has not finished, instead of starting the whole list again.
  const done = new Set(payload.done ?? []);
  const totals = { read: payload.read ?? 0, added: payload.added ?? 0, updated: payload.updated ?? 0 };
  const chosen = hooks.directory?.countries ?? ctx.settings.study.countries;
  const deps: DirectoryDeps = {
    getJson: directoryGetJson(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...DIRECTORY_DEFAULTS,
    ...(ctx.settings.study.rorClientId ? { rorClientId: ctx.settings.study.rorClientId } : {}),
    allCountries: chosen,
    progress: async () => {
      await ctx.touch();
      const j = await ctx.db.job.findUnique({ where: { id: ctx.job.id }, select: { status: true } });
      if (j?.status === "cancelled") throw new Error("Cancelled");
      if (j?.status === "paused") throw new RequeueTask("The refresh was paused");
    },
    ...(source === "hipo"
      ? {}
      : {
          countryDone: async (country: string, entries: Parameters<typeof saveDirectoryEntries>[1]) => {
            const saved = await saveDirectoryEntries(ctx.db, entries);
            totals.read += entries.length;
            totals.added += saved.added;
            totals.updated += saved.updated;
            done.add(country);
            await ctx.db.jobTask.update({ where: { id: ctx.task.id }, data: { payload: { source, done: [...done], ...totals } } });
          },
        }),
    ...hooks.directory,
    countries: chosen.filter((c) => !done.has(c)),
  };
  const { entries, problems } = await fetchDirectory(source, deps);
  if (entries.length > 0) {
    const saved = await saveDirectoryEntries(ctx.db, entries);
    totals.read += entries.length;
    totals.added += saved.added;
    totals.updated += saved.updated;
  }
  for (const p of problems.slice(0, 10)) await ctx.event("warn", p);
  await ctx.event("info", `${source}: ${totals.read} universities read, ${totals.added} new`);
  return { result: { source, read: totals.read, ...(source === "hipo" ? {} : { countries: done.size }), added: totals.added, updated: totals.updated, problems: problems.length } };
};

/** One university from the directory: find its admission pages; when they say something useful, it becomes a programme. */
export const studySiteTask: TaskHandler = async (ctx) => {
  const { universityId } = ctx.task.payload as { universityId: number };
  const u = await ctx.db.studyUniversity.findUnique({ where: { id: BigInt(universityId) } });
  if (!u || u.status === "skipped") return { result: { skipped: true } };
  const site = await readUniversitySite(u.website, u.domain, readerSettings(ctx.settings), readerDeps(ctx));
  const okPages = site.pages.filter((p) => p.status === "ok");
  const facts = mergeFacts(okPages.map((p) => p.facts));
  const useful = hasFacts(facts) && (facts.englishTaught || facts.ielts.length > 0 || facts.moi.length > 0);
  if (site.status !== "ok" || okPages.length === 0) {
    const note = site.status === "ok" ? "No readable text (JavaScript-only pages?)" : site.note;
    await ctx.db.studyUniversity.update({ where: { id: u.id }, data: { status: "unreadable", note: note.slice(0, 300), lastCheckedAt: new Date() } });
    return { result: { site: 1, unreadable: 1 } };
  }
  if (!useful) {
    await ctx.db.studyUniversity.update({ where: { id: u.id }, data: { status: "nothing", note: `${okPages.length} pages read; nothing about English proof or deadlines`, lastCheckedAt: new Date() } });
    return { result: { site: 1, nothing: 1 } };
  }
  // The page with the most facts is the programme's information page.
  const best = [...okPages].sort((a, b) => weight(b.facts) - weight(a.facts))[0]!;
  const ielts = facts.ielts.map((i) => i.score);
  // The application link: from the best page first, then any page.
  const applyUrl = best.applyLinks?.[0] ?? okPages.find((p) => p.applyLinks?.length)?.applyLinks?.[0] ?? null;
  const program =
    (u.programId ? await ctx.db.studyProgram.findUnique({ where: { id: u.programId } }) : null) ??
    (await ctx.db.studyProgram.create({
      data: {
        name: u.name,
        kind: "programme",
        country: countryName(u.countryCode),
        university: u.name,
        level: "both",
        englishRequirement: "varies",
        minIelts: ielts.length ? Math.max(...ielts) : null,
        infoUrl: best.url,
        applyUrl,
        contactEmail: facts.emails[0] ?? null,
        notes: summary(facts, okPages.length),
        origin: "auto",
        verified: false,
      },
    }));
  await ctx.db.studyUniversity.update({ where: { id: u.id }, data: { status: "found", programId: program.id, note: summary(facts, okPages.length).slice(0, 300), lastCheckedAt: new Date() } });
  let added = 0;
  for (const p of okPages.filter((x) => hasFacts(x.facts) || x.facts.emails.length > 0)) {
    const saved = await savePage(ctx.db, p, { programId: program.id, universityId: u.id });
    added += await addFindings(ctx.db, program, { id: saved.id, url: p.url }, { ...p.facts, ielts: p.facts.ielts.filter((i) => i.score !== Number(program.minIelts)) });
  }
  return { result: { site: 1, found: 1, findings: added } };
};

/** A followed programme: read its own pages again; changed facts become findings. */
export const studyProgramTask: TaskHandler = async (ctx) => {
  const { programId } = ctx.task.payload as { programId: number };
  const program = await ctx.db.studyProgram.findUnique({ where: { id: BigInt(programId) }, include: { pages: { select: { url: true, lastFetchedAt: true } } } });
  if (!program) return { result: { skipped: true } };
  const urls = [...new Set([program.infoUrl, program.applyUrl, ...program.pages.map((p) => p.url)].filter((u): u is string => !!u && /^https?:\/\//.test(u)))].slice(0, 10);
  if (urls.length === 0) return { result: { pages: 0 } };
  const pages = await readPages(urls, readerSettings(ctx.settings), readerDeps(ctx));
  let findings = 0;
  let changed = 0;
  let failed = 0;
  // A programme found automatically gets its application link when one appears on its pages.
  const link = program.origin === "auto" && !program.applyUrl ? pages.find((p) => p.applyLinks?.length)?.applyLinks?.[0] : undefined;
  if (link) await ctx.db.studyProgram.update({ where: { id: program.id }, data: { applyUrl: link } });
  for (const p of pages) {
    const saved = await savePage(ctx.db, p, { programId: program.id });
    if (p.status !== "ok") failed++;
    if (saved.changed) {
      changed++;
      findings += await addFindings(ctx.db, program, { id: saved.id, url: p.url }, p.facts);
    }
  }
  return { result: { programs: 1, pages: pages.length, changed, findings, failed } };
};

/** The Erasmus Mundus catalogue: every joint master in my subjects becomes its own scholarship with its website; the daily check then reads it (application link, deadline, English rules). */
export const studyCatalogueTask: TaskHandler = async (ctx) => {
  if ((ctx.task.payload as { source?: string }).source === "hungary") return studyFinderHungary(ctx);
  const res = await readErasmusCatalogue(readerSettings(ctx.settings), readerDeps(ctx), hooks.erasmusBase ?? ERASMUS_CATALOGUE);
  if (res.problem) {
    await ctx.event("warn", `Erasmus Mundus catalogue: ${res.problem}`);
    return { result: { catalogue: 1, read: 0, added: 0 } };
  }
  const prof = await ctx.db.studyProfile.findUnique({ where: { id: 1 } });
  const fields = prof?.targetFields?.length ? prof.targetFields : [prof?.bscSubject ?? "Computer Science"];
  const mine = res.entries.filter((e) => matchesSubjects(e.name, fields));
  const existing = await ctx.db.studyProgram.findMany({ select: { infoUrl: true, applyUrl: true, name: true } });
  const urls = new Set(existing.flatMap((p) => [p.infoUrl, p.applyUrl]).filter((u): u is string => !!u).map(normUrl));
  const names = new Set(existing.map((p) => p.name.toLowerCase()));
  let added = 0;
  for (const e of mine) {
    if (urls.has(normUrl(e.website)) || names.has(e.name.toLowerCase())) continue;
    await ctx.db.studyProgram.create({
      data: {
        name: e.name.slice(0, 160),
        kind: "scholarship",
        country: "Europe (several countries)",
        level: "master",
        englishRequirement: "varies",
        funding: "Erasmus Mundus scholarship: about €1,400 a month for up to 24 months, tuition and insurance covered (for the best-ranked applicants).",
        infoUrl: e.website,
        howToApply: "Apply on the programme's own website (one application per programme). Each programme sets its own deadline (most October–January) and English rule; many accept an English-taught bachelor's.",
        notes: `From the official Erasmus Mundus catalogue (EACEA), ${new Date().toISOString().slice(0, 10)}. The daily check reads the programme's website for the application link, the deadline and the English rules.`,
        origin: "auto",
        verified: false,
      },
    });
    urls.add(normUrl(e.website));
    names.add(e.name.toLowerCase());
    added++;
  }
  await ctx.event("info", `Erasmus Mundus catalogue: ${res.entries.length} programmes on ${res.pages} pages, ${mine.length} in your subjects, ${added} new`);
  return { result: { catalogue: 1, read: res.entries.length, added } };
};

/** Hungary's official Study Finder: English-taught master's in my subjects, with requirements and the accepted English proof. */
async function studyFinderHungary(ctx: TaskContext) {
  const res = await readStudyFinder(readerSettings(ctx.settings), readerDeps(ctx), {
    base: hooks.huBase ?? HU_STUDY_FINDER,
    ...(hooks.huTo ? { to: hooks.huTo, maxMisses: 3 } : {}),
    onProgress: async (id) => {
      if (id % 25 === 0) await ctx.touch();
    },
  });
  if (res.problem && res.entries.length === 0) {
    await ctx.event("warn", `Hungarian Study Finder: ${res.problem}`);
    return { result: { catalogue: 1, read: 0, added: 0 } };
  }
  const prof = await ctx.db.studyProfile.findUnique({ where: { id: 1 } });
  const fields = prof?.targetFields?.length ? prof.targetFields : [prof?.bscSubject ?? "Computer Science"];
  const wantMaster = prof?.targetLevel !== "bachelor";
  const mine = res.entries.filter((e) => (wantMaster ? /master|msc|m\.sc|\bma\b|mba/i.test(`${e.level ?? ""} ${e.name}`) : /bachelor|bsc|\bba\b/i.test(`${e.level ?? ""} ${e.name}`)) && matchesSubjects(e.name, fields));
  const existing = await ctx.db.studyProgram.findMany({ select: { infoUrl: true, applyUrl: true, name: true, university: true } });
  const urls = new Set(existing.flatMap((p) => [p.infoUrl, p.applyUrl]).filter((u): u is string => !!u).map(normUrl));
  const keys = new Set(existing.map((p) => `${p.name}|${p.university ?? ""}`.toLowerCase()));
  let added = 0;
  for (const e of mine) {
    const link = e.website ?? e.url;
    const key = `${e.name}|${e.university ?? ""}`.toLowerCase();
    if (urls.has(normUrl(link)) || urls.has(normUrl(e.url)) || keys.has(key)) continue;
    await ctx.db.studyProgram.create({
      data: {
        name: e.name,
        kind: "programme",
        country: "Hungary",
        university: e.university,
        level: wantMaster ? "master" : "bachelor",
        englishRequirement: "varies",
        minIelts: e.minIelts,
        infoUrl: link,
        howToApply: e.requirements,
        notes: `From Hungary's official Study Finder (Tempus Public Foundation): ${e.url}.${e.englishTests ? ` Accepted English proof: ${e.englishTests}.` : ""} Ask whether your MOI letter is accepted; Stipendium Hungaricum applicants apply through apply.stipendiumhungaricum.hu.`,
        origin: "auto",
        verified: false,
      },
    });
    urls.add(normUrl(link));
    keys.add(key);
    added++;
  }
  await ctx.event("info", `Hungarian Study Finder: ${res.read} pages read, ${res.entries.length} English-taught programmes, ${mine.length} in your subjects and level, ${added} new`);
  return { result: { catalogue: 1, read: res.entries.length, added } };
}

const normUrl = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/+$/, "");

/** One country: Groq proposes scholarships with their official pages; the tool opens each page and keeps the ones that name it. */
export const studyAiTask: TaskHandler = async (ctx) => {
  const { country } = ctx.task.payload as { country: string };
  const name = countryName(country);
  const prof = await ctx.db.studyProfile.findUnique({ where: { id: 1 } });
  const subject = prof?.targetFields?.[0] ?? prof?.bscSubject ?? "Computer Science";
  const level = prof?.targetLevel === "bachelor" ? "bachelor's degree" : "master's degree";
  const { candidates } = hooks.search
    ? await hooks.search(name)
    : await searchScholarships({ GROQ_API_KEY: ctx.env.GROQ_API_KEY, GROQ_MODEL: ctx.env.GROQ_MODEL }, name, subject, level);
  await ctx.touch();
  const checked = await checkCandidates(candidates, readerSettings(ctx.settings), readerDeps(ctx));
  const existing = await ctx.db.studyProgram.findMany({ select: { name: true, infoUrl: true, applyUrl: true } });
  const urls = new Set(existing.flatMap((p) => [p.infoUrl, p.applyUrl]).filter((u): u is string => !!u).map(normUrl));
  const names = new Set(existing.map((p) => p.name.toLowerCase()));
  let added = 0;
  for (const c of checked) {
    if (!c.ok) {
      await ctx.event("info", `${name}: “${c.name}” left out — ${c.reason} (${c.url})`);
      continue;
    }
    if (urls.has(normUrl(c.url)) || names.has(c.name.toLowerCase())) continue;
    const program = await ctx.db.studyProgram.create({
      data: {
        name: c.name,
        kind: "scholarship",
        country: name,
        level: prof?.targetLevel === "bachelor" ? "bachelor" : "master",
        englishRequirement: c.english === "none" ? "not_required" : "varies",
        funding: c.funding || null,
        infoUrl: c.url,
        applyUrl: c.applyLink ?? null,
        notes: `Found by the AI web search on ${new Date().toISOString().slice(0, 10)}; the tool opened the page and it names this scholarship. The AI said: English proof “${c.english}”, deadline ${c.deadline ?? "unknown"}${c.deadline ? (c.deadlineOnPage ? " (the same date is on the page)" : " (NOT found on the page)") : ""}. Check everything on the official page.`,
        origin: "auto",
        verified: false,
      },
    });
    urls.add(normUrl(c.url));
    names.add(c.name.toLowerCase());
    const page = await savePage(ctx.db, { url: c.url, status: "ok", facts: c.facts!, textLength: 0 }, { programId: program.id });
    await addFindings(ctx.db, program, { id: page.id, url: c.url }, c.facts!);
    added++;
  }
  return { result: { ai: 1, proposed: candidates.length, verified: checked.filter((c) => c.ok).length, added } };
};

function weight(f: Extracted): number {
  return f.ielts.length * 3 + f.moi.length * 3 + f.deadlines.length * 2 + (f.englishTaught ? 1 : 0);
}

function summary(f: Extracted, pages: number): string {
  const parts = [`Found automatically on ${new Date().toISOString().slice(0, 10)} (${pages} pages read) — check on the official page.`];
  if (f.ielts.length) parts.push(`IELTS mentioned: ${[...new Set(f.ielts.map((i) => i.score))].sort().join(", ")}.`);
  if (f.moi.length) parts.push(`About English-medium degrees: “${f.moi[0]}”`);
  if (f.englishTaught) parts.push("Mentions programmes taught in English.");
  if (f.deadlines.length) parts.push(`Dates: ${f.deadlines.map((d) => `${d.label} ${d.date}`).join("; ")}.`);
  return parts.join(" ").slice(0, 2900);
}

export const summarizeStudy: Summarizer = (tasks) => {
  const sum = { read: 0, added: 0, sites: 0, found: 0, nothing: 0, unreadable: 0, programs: 0, pages: 0, changed: 0, findings: 0, failed: 0, proposed: 0, verified: 0, countries: 0 };
  for (const t of tasks) {
    if (t.status === "failed") sum.failed++;
    const r = (t.result ?? {});
    const n = (k: string) => (typeof r[k] === "number" ? (r[k]) : 0);
    sum.read += n("read");
    sum.added += n("added");
    sum.sites += n("site");
    sum.found += n("found");
    sum.nothing += n("nothing");
    sum.unreadable += n("unreadable");
    sum.programs += n("programs");
    sum.pages += n("pages");
    sum.changed += n("changed");
    sum.findings += n("findings");
    sum.proposed += n("proposed");
    sum.verified += n("verified");
    sum.countries += n("ai");
  }
  return sum;
};
