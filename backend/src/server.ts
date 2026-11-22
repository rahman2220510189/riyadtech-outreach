import { EnvError, loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { prismaAuthStore } from "./auth/store.js";
import { createDb, pingDb } from "./db/client.js";
import { JOB_SUMMARIZERS } from "./jobs/handlers.js";
import { JobStore } from "./jobs/store.js";
import { syncSeeds } from "./seed/sync.js";
import { prismaWorkerStore } from "./worker/store.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env);
  const app = await buildApp(env, {
    pingDb: () => pingDb(db),
    authStore: prismaAuthStore(db),
    workerStore: prismaWorkerStore(db),
    data: { db, jobs: new JobStore(db, JOB_SUMMARIZERS) },
  });
  app.addHook("onClose", async () => {
    await db.$disconnect();
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Shutting down");
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, "Error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Countries and the category map come from reviewed files in seed/.
  await syncSeeds(db, app.log);

  await app.listen({ host: env.listenHost, port: env.PORT });
  app.log.info({ host: env.listenHost, port: env.PORT, env: env.NODE_ENV }, "API ready");
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) {
    console.error(err.message);
  } else {
    console.error("Failed to start server:", err);
  }
  process.exit(1);
});
