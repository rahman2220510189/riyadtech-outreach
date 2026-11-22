/**
 * Background worker: heartbeat every 30 s, settings reload every minute, and the job
 * queue (finder imports, GeoNames, website crawls). Later phases add sending and IMAP tasks.
 */
import pino from "pino";
import { join } from "node:path";
import { setFooterCacheDir } from "./finder/overture/parquet.js";
import { EnvError, loadEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { JOB_SUMMARIZERS, TASK_HANDLERS } from "./jobs/handlers.js";
import { JobRunner } from "./jobs/runner.js";
import { JobStore } from "./jobs/store.js";
import { studySchedule } from "./study/watch.js";
import { setHttpLogger, shortUrl } from "./finder/overture/http.js";
import { buildLoggerOptions } from "./lib/logger.js";
import { APP_VERSION } from "./version.js";
import { Worker } from "./worker/runner.js";
import { prismaWorkerStore } from "./worker/store.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = pino({ ...buildLoggerOptions(env), base: { service: "riyadtech-outreach-worker" } });
  const db = createDb(env);
  setFooterCacheDir(join(env.DATA_CACHE_DIR, "overture"));
  // LOG_LEVEL=debug shows every data download.
  setHttpLogger((e) => log.debug({ url: shortUrl(e.url), range: e.range, bytes: e.bytes, ms: e.ms, attempt: e.attempt }, "Download"));
  // The runner reads the worker's settings, which reload every minute.
  const ref: { worker?: Worker } = {};
  const jobs = new JobRunner({
    db,
    log,
    env,
    handlers: TASK_HANDLERS,
    summarizers: JOB_SUMMARIZERS,
    settings: () => ref.worker!.settings,
    // Finder imports and crawls can run side by side, each within its own limit.
    concurrency: () => ref.worker!.settings.finder.concurrency + ref.worker!.settings.crawler.concurrency + 4, // +2: GeoNames and job-advert searches; +2: university checks
    groupLimits: () => ({ finder: ref.worker!.settings.finder.concurrency, crawl: ref.worker!.settings.crawler.concurrency, study: 2 }),
  });
  const jobStore = new JobStore(db, JOB_SUMMARIZERS);
  const w = new Worker({
    store: prismaWorkerStore(db),
    log,
    version: APP_VERSION,
    jobs,
    // Study abroad: refresh the university directory and start the daily check when due.
    periodic: [
      {
        name: "study schedule",
        ms: 10 * 60_000,
        run: async (settings) => {
          const started = await studySchedule(db, jobStore, settings, new Date(), env);
          if (started) log.info({ started }, "Study check started");
        },
      },
    ],
  });
  ref.worker = w;

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "Worker shutting down");
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    w
      .stop()
      .then(() => db.$disconnect())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error({ err }, "Error during worker shutdown");
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await w.start();
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else console.error("Failed to start worker:", err);
  process.exit(1);
});
