import type { FastifyPluginCallback } from "fastify";
import { APP_VERSION } from "../version.js";

export type DatabaseStatus = "ok" | "error" | "not_configured";

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  time: string;
  checks: {
    database: DatabaseStatus;
    databaseLatencyMs?: number;
  };
}

export interface HealthOptions {
  /** Returns the round-trip time in ms, or throws. Undefined = no database configured. */
  pingDb?: () => Promise<number>;
}

/**
 * GET /health: Render's health check and the cron-job.org keep-awake ping.
 * Always HTTP 200 while the process is alive (so Render does not restart the
 * service just because Neon is waking up); the body says whether the database answered.
 */
export const healthRoutes: FastifyPluginCallback<HealthOptions> = (app, opts, done) => {
  app.get("/health", async (request, reply): Promise<HealthResponse> => {
    void reply.header("cache-control", "no-store");
    const body: HealthResponse = {
      status: "ok",
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      time: new Date().toISOString(),
      checks: { database: "not_configured" },
    };
    if (opts.pingDb) {
      try {
        body.checks.databaseLatencyMs = await opts.pingDb();
        body.checks.database = "ok";
      } catch (err) {
        request.log.warn({ err }, "Health check: database did not answer");
        body.checks.database = "error";
        body.status = "degraded";
      }
    }
    return body;
  });
  done();
};
