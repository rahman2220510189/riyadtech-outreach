/**
 * npm run finder -- --country GB --city Manchester [--radius 15] [--segments A,B] [--dry-run]
 * npm run finder -- --country US --region US-TX --dry-run
 * npm run finder -- --country IE --dry-run              (whole country, if allowed)
 *
 * Runs a finder job right here in the terminal (no worker needed) and prints each step as it happens.
 * Add --verbose to see every download (size, time, speed). The job also shows on the Finder page.
 * Do not run the worker (npm run dev:all) at the same time: it would pick up the same job.
 */
import pino from "pino";
import { join } from "node:path";
import { setFooterCacheDir } from "../finder/overture/parquet.js";
import { EnvError, loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { resolveArea } from "../finder/area.js";
import { createFinderJob } from "../finder/jobs.js";
import { finderParamsSchema } from "../finder/params.js";
import { JOB_SUMMARIZERS, TASK_HANDLERS } from "../jobs/handlers.js";
import { JobRunner } from "../jobs/runner.js";
import { FatalTaskError } from "../jobs/types.js";
import { setHttpLogger, shortUrl } from "../finder/overture/http.js";
import { resolveSettings } from "../settings/loader.js";
import { syncSeeds } from "../seed/sync.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env);
  setFooterCacheDir(join(env.DATA_CACHE_DIR, "overture"));
  const log = pino({ level: process.env.LOG_LEVEL === "debug" ? "debug" : "warn" });
  try {
    await syncSeeds(db, { info: () => undefined });
    const country = (arg("country") ?? "").toUpperCase();
    let cityGeonameId: number | undefined;
    const cityName = arg("city");
    if (cityName) {
      const city = await db.location.findFirst({
        where: { country, kind: "city", asciiName: { equals: cityName, mode: "insensitive" } },
        orderBy: { population: "desc" },
      });
      if (!city) throw new Error(`City "${cityName}" not found for ${country}. Run npm run geonames:import first.`);
      cityGeonameId = city.geonameId;
    }
    const params = finderParamsSchema.parse({
      country,
      ...(arg("region") ? { regionCode: arg("region")!.toUpperCase() } : {}),
      ...(cityGeonameId ? { cityGeonameId } : {}),
      ...(arg("radius") ? { radiusKm: Number(arg("radius")) } : {}),
      segments: (arg("segments") ?? "A,B").split(",").map((s) => s.trim().toUpperCase()),
    });
    const dryRun = process.argv.includes("--dry-run");
    const area = await resolveArea(db, params);

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
    const jobId = await createFinderJob(runner.store, params, dryRun, area.label);
    process.stdout.write(`${dryRun ? "Dry run" : "Import"} #${jobId}: ${area.label}\n`);
    const others = await db.job.count({ where: { id: { not: jobId }, status: { in: ["running", "paused"] } } });
    if (others > 0) {
      process.stdout.write(
        `  Note: ${others} other unfinished job(s) are waiting; the worker (npm run dev:all) will run them. Cancel them on the Finder page if you do not need them.\n`,
      );
    }

    const started = Date.now();
    const secs = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s`;
    if (process.argv.includes("--verbose")) {
      setHttpLogger((e) => {
        const mb = e.bytes / 1024 / 1024;
        const speed = e.ms > 0 ? (mb / (e.ms / 1000)).toFixed(2) : "?";
        process.stdout.write(
          `  ${secs()}  download ${shortUrl(e.url)}${e.range ? ` ${e.range}` : ""}: ${mb.toFixed(2)} MB in ${(e.ms / 1000).toFixed(1)} s (${speed} MB/s)${e.attempt > 0 ? `, try ${e.attempt + 1}` : ""}\n`,
        );
      });
    }
    let printed = 0n;
    let printing: Promise<void> = Promise.resolve();
    // One print at a time (the timer and the main loop both call this), so no event shows twice.
    const printEvents = () => {
      printing = printing.then(async () => {
        const events = await db.jobEvent.findMany({ where: { jobId, id: { gt: printed } }, orderBy: { id: "asc" } });
        for (const e of events) {
          process.stdout.write(`  ${secs()}  [${e.level}] ${e.message}\n`);
          printed = e.id;
        }
      });
      return printing;
    };
    // Print events while tasks run (a step can take minutes on a slow connection).
    const ticker = setInterval(() => void printEvents().catch(() => undefined), 1000);
    let lastDone = 0;
    try {
      for (;;) {
        const n = await runner.drain(1, jobId); // only this job, never leftovers of other jobs
        if (n > 0) {
          const done = await db.jobTask.count({ where: { jobId, status: { in: ["done", "failed"] } } });
          const all = await db.jobTask.count({ where: { jobId } });
          if (done > lastDone) {
            process.stdout.write(`  ${secs()}  step ${done} of ${all} finished\n`);
          } else {
            const failed = await db.jobTask.findFirst({
              where: { jobId, error: { not: null } },
              orderBy: { id: "desc" },
              select: { error: true },
            });
            process.stdout.write(`  ${secs()}  a step failed (${failed?.error ?? "unknown error"}); it will be retried\n`);
          }
          lastDone = done;
          continue;
        }
        // Nothing to run now: is a step waiting for its retry?
        const job = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
        const next = await db.jobTask.findFirst({
          where: { jobId, status: "queued" },
          orderBy: { runAfter: "asc" },
          select: { runAfter: true },
        });
        if (job?.status !== "running" || !next) break;
        const waitMs = Math.max(1000, next.runAfter.getTime() - Date.now());
        process.stdout.write(`  ${secs()}  waiting ${Math.ceil(waitMs / 1000)} s before retrying…\n`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    } finally {
      clearInterval(ticker);
      await printEvents();
    }
    const job = await db.job.findUnique({ where: { id: jobId } });
    const s = (job?.summary ?? {}) as Record<string, unknown>;
    process.stdout.write(`\nStatus: ${job?.status}${job?.error ? ` (${job.error})` : ""} in ${Math.round((Date.now() - started) / 1000)} s\n`);
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else if (err instanceof FatalTaskError) console.error(err.message);
  else console.error(`finder failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
