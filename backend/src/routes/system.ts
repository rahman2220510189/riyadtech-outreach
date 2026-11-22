import type { FastifyPluginCallback } from "fastify";
import { workerStatus } from "../worker/heartbeat.js";
import type { WorkerStore } from "../worker/store.js";
import { APP_VERSION } from "../version.js";

export interface SystemRoutesOptions {
  workerStore: Pick<WorkerStore, "readHeartbeat">;
}

/**
 * GET /api/v1/system/status (login required): worker heartbeat for the
 * "worker is not running" banner that every page shows when it is stale.
 */
export const systemRoutes: FastifyPluginCallback<SystemRoutesOptions> = (app, opts, done) => {
  app.get("/status", { preHandler: app.authenticate }, async () => {
    const row = await opts.workerStore.readHeartbeat();
    return {
      server: { version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) },
      worker: workerStatus(row),
    };
  });
  done();
};
