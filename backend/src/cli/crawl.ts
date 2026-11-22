/**
 * npm run crawl -- --segment A --country GB [--city Manchester] [--limit 30] [--again]
 * npm run crawl -- --import 34 --limit 50          (the leads of finder import #34)
 *
 * Crawls lead websites right here in the terminal (no worker needed), several sites at
 * once (Settings: crawler concurrency), and prints one line per site and an honest report
 * at the end: how many sites were readable, how many had an e-mail, how many blocked us.
 * --again also crawls leads that were crawled before; --readable crawls again only the sites that
 * could be read last time (e.g. to find job platforms after an update); --hiring crawls again only the leads
 * that currently show a developer job (to re-check them after new job rules). --verbose lists every request per site.
 * The job also shows on the Finder page.
 * Do not run the worker (npm run dev:all) at the same time: it would share the job.
 */
import pino from "pino";
import { EnvError, loadEnv } from "../config/env.js";
import { crawlLabel, crawlParamsSchema, createCrawlJob, statusText } from "../crawler/tasks.js";
import { createDb } from "../db/client.js";
import { JOB_SUMMARIZERS, TASK_HANDLERS } from "../jobs/handlers.js";
import { JobRunner } from "../jobs/runner.js";
import { resolveSettings } from "../settings/loader.js";
import { syncSeeds } from "../seed/sync.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "-");

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env);
  const log = pino({ level: process.env.LOG_LEVEL === "debug" ? "debug" : "warn" });
  try {
    await syncSeeds(db, { info: () => undefined });
    const params = crawlParamsSchema.parse({
      ...(arg("segment") ? { segment: arg("segment")!.toUpperCase() } : {}),
      ...(arg("country") ? { country: arg("country")!.toUpperCase() } : {}),
      ...(arg("region") ? { regionCode: arg("region")!.toUpperCase() } : {}),
      ...(arg("city") ? { city: arg("city") } : {}),
      ...(arg("category") ? { categoryKeys: arg("category")!.split(",") } : {}),
      ...(arg("import") ? { finderJobId: Number(arg("import")) } : {}),
      onlyNew: !process.argv.includes("--again") && !process.argv.includes("--readable") && !process.argv.includes("--hiring"),
      onlyReadable: process.argv.includes("--readable"),
      onlyHiring: process.argv.includes("--hiring"),
      limit: Number(arg("limit") ?? 30),
    });
    const settings = resolveSettings(await db.setting.findMany({ select: { key: true, value: true } })).settings;
    const runner = new JobRunner({
      db,
      log,
      env,
      handlers: TASK_HANDLERS,
      summarizers: JOB_SUMMARIZERS,
      settings: () => settings,
      concurrency: () => 1,
    });
    const label = crawlLabel(params);
    const jobId = await createCrawlJob(runner.store, params, label);
    process.stdout.write(`Crawl #${jobId}: ${label}\n`);

    const started = Date.now();
    const secs = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s`;
    await runner.drain(1, jobId); // the plan step: picks the leads
    const plan = await db.jobEvent.findMany({ where: { jobId }, orderBy: { id: "asc" } });
    for (const e of plan.slice(1)) process.stdout.write(`  ${secs()}  [${e.level}] ${e.message}\n`);

    const total = await db.jobTask.count({ where: { jobId, kind: "crawl.site" } });
    let finished = 0;
    const printed = new Set<bigint>();
    const verbose = process.argv.includes("--verbose");
    const printOnce = async () => {
      const tasks = await db.jobTask.findMany({
        where: { jobId, kind: "crawl.site", status: { in: ["done", "failed"] }, id: { notIn: [...printed] } },
        orderBy: { finishedAt: "asc" },
      });
      for (const t of tasks) {
        printed.add(t.id);
        finished++;
        const r = (t.result ?? {}) as Record<string, unknown>;
        const domain = (t.payload as { domain?: string }).domain ?? "?";
        if (t.status === "failed") {
          process.stdout.write(`  ${secs()}  ${String(finished).padStart(3)}/${total}  ${domain}: step failed (${t.error ?? "?"})\n`);
          continue;
        }
        const status = typeof r.status === "string" ? r.status : "?";
        const emails = Number(r.emails ?? 0);
        const signals = (r.signals as string[] | undefined) ?? [];
        const primary =
          Number(r.withPrimary ?? 0) > 0
            ? " (primary chosen)"
            : emails > 0 && typeof r.primaryNote === "string"
              ? ` (no primary: ${r.primaryNote})`
              : "";
        process.stdout.write(
          `  ${secs()}  ${String(finished).padStart(3)}/${total}  ${domain}: ${statusText(status)}, ${Number(r.pages ?? 0)} page(s), ${emails} e-mail(s)${primary}${typeof r.jobBoard === "string" ? `, jobs on ${r.jobBoard} (developer/all)` : ""}${signals.length ? `, signals: ${signals.join(" ")}` : ""}${status !== "ok" && typeof r.note === "string" ? ` - ${r.note}` : ""}\n`,
        );
        if (verbose) {
          const crawl = await db.domainCrawl.findUnique({ where: { domain }, select: { pages: true } });
          for (const pg of (crawl?.pages ?? []) as { url: string; kind: string; status: number | null; note?: string }[]) {
            process.stdout.write(`                 ${String(pg.status ?? "-").padStart(3)} ${pg.kind.padEnd(9)} ${pg.url}${pg.note ? `  (${pg.note})` : ""}\n`);
          }
        }
      }
    };
    // One print at a time (the timer and the end of the run both call this), so no site shows twice.
    let printing: Promise<void> = Promise.resolve();
    const printSites = () => {
      printing = printing.then(printOnce, printOnce);
      return printing;
    };
    const ticker = setInterval(() => void printSites().catch(() => undefined), 1000);
    try {
      for (;;) {
        // Several sites at once, each one politely (one request at a time, with pauses).
        const workers = Math.max(1, settings.crawler.concurrency);
        const counts = await Promise.all(Array.from({ length: workers }, () => runner.drain(10_000, jobId)));
        if (counts.some((n) => n > 0)) continue;
        const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
        const next = await db.jobTask.findFirst({ where: { jobId, status: "queued" }, orderBy: { runAfter: "asc" } });
        if (job?.status !== "running" || !next) break;
        const waitMs = Math.max(1000, next.runAfter.getTime() - Date.now());
        process.stdout.write(`  ${secs()}  waiting ${Math.ceil(waitMs / 1000)} s before retrying a failed site…\n`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    } finally {
      clearInterval(ticker);
      await printSites();
    }

    const job = await db.job.findUnique({ where: { id: jobId } });
    const s = (job?.summary ?? {}) as Record<string, unknown>;
    const byStatus = (s.byStatus ?? {}) as Record<string, number>;
    const sites = Number(s.sitesDone ?? 0);
    const readable = Number(s.readable ?? 0);
    const lines = [
      "",
      `Status: ${job?.status}${job?.error ? ` (${job.error})` : ""} in ${Math.round((Date.now() - started) / 1000)} s`,
      `Sites crawled:            ${sites}${Number(s.sitesFailed ?? 0) ? ` (+${String(s.sitesFailed)} failed steps)` : ""}`,
      `Readable (ok/partial):    ${readable} (${pct(readable, sites)})`,
      ...Object.entries(byStatus)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `   ${statusText(k).padEnd(42)} ${v}`),
      `Sites with an e-mail:     ${Number(s.sitesWithEmail ?? 0)} (${pct(Number(s.sitesWithEmail ?? 0), readable)} of readable sites)`,
      `Leads with a primary:     ${Number(s.leadsWithPrimary ?? 0)} of ${Number(s.leads ?? 0)}`,
      `Only personal addresses:  ${Number(s.namedOnly ?? 0)} site(s) (not used where the rules say "generic addresses only", e.g. UK, Ireland)`,
      `E-mails found:            ${Number(s.emails ?? 0)} (no MX: ${Number(s.noMx ?? 0)}; listed by Overture but not on the site: ${Number(s.overtureOnly ?? 0)})`,
      `Pages read:               ${Number(s.pages ?? 0)}`,
      `Job platforms found:      ${Number(s.jobBoards ?? 0)} site(s) (Personio, Greenhouse, Lever, Recruitee, Workable, SmartRecruiters)`,
      `Signals (sites):          ${Object.entries((s.bySignal ?? {}) as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"}`,
      "",
      "Open the Leads page to see each lead's e-mails and signals with their evidence.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else console.error(`crawl failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
