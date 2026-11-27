import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCsrfGuard } from "./auth/csrf.js";
import { authPlugin } from "./auth/plugin.js";
import type { AuthStore } from "./auth/store.js";
import type { Env } from "./config/env.js";
import type { Db } from "./db/client.js";
import type { JobStore } from "./jobs/store.js";
import { areasRoutes } from "./routes/areas.js";
import { finderRoutes } from "./routes/finder.js";
import { leadsRoutes } from "./routes/leads.js";
import { applicationsRoutes } from "./routes/applications.js";
import { jobAdsRoutes } from "./routes/jobads.js";
import { listsRoutes } from "./routes/lists.js";
import { mailboxesRoutes } from "./routes/mailboxes.js";
import { templatesRoutes } from "./routes/templates.js";
import { campaignsRoutes } from "./routes/campaigns.js";
import { unsubscribeRoutes } from "./routes/unsubscribe.js";
import { suppressionRoutes } from "./routes/suppression.js";
import { settingsRoutes } from "./routes/settings.js";
import { studyRoutes } from "./routes/study.js";
import { studyWatchRoutes } from "./routes/study-watch.js";
import { registerErrorHandlers } from "./lib/errors.js";
import { buildLoggerOptions } from "./lib/logger.js";
import { type AuthRoutesOptions, authRoutes } from "./routes/auth.js";
import { type HealthOptions, healthRoutes } from "./routes/health.js";
import { systemRoutes } from "./routes/system.js";
import type { WorkerStore } from "./worker/store.js";

export const API_PREFIX = "/api/v1";

export interface AppDeps {
  /** Database round trip for /health. Tests pass a fake; omitted = "not_configured". */
  pingDb?: HealthOptions["pingDb"];
  /** Admin storage for login. Required for the auth routes (the server always passes it). */
  authStore?: AuthStore;
  /** Test hooks for the auth routes (limiter, low bcrypt cost). */
  authOptions?: Pick<AuthRoutesOptions, "limiter" | "dummyHashCost">;
  /** Reads the worker heartbeat for /api/v1/system/status. */
  workerStore?: Pick<WorkerStore, "readHeartbeat">;
  /** Database + job queue for the areas and finder routes. */
  data?: { db: Db; jobs: JobStore };
}

/** Public, state-changing API paths that must work without the CSRF header (e.g. one-click unsubscribe, Phase 4). */
const CSRF_EXEMPT = [`${API_PREFIX}/u/`];

/** Builds the Fastify app without listening, so tests can use app.inject(). */
export async function buildApp(env: Env, deps: AppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(env),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024, // 1 MB; CSV uploads get their own limit later
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  // An empty body with Content-Type: application/json (e.g. POST /logout) means "no body", not an error.
  // Non-empty bodies still go through Fastify's own parser (with prototype-poisoning protection).
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") {
      done(null, undefined);
      return;
    }
    void defaultJsonParser(request, text, done);
  });

  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
    // API answers are personal: never cache them in a browser or proxy.
    if (request.url.startsWith(API_PREFIX) && !reply.hasHeader("cache-control")) {
      void reply.header("cache-control", "no-store");
    }
  });

  // API only: no HTML is served, so a strict CSP is safe.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
  });

  const allowed = new Set(env.CORS_ORIGIN);
  await app.register(cors, {
    // No Origin header (server-to-server, curl, Vercel rewrite) is allowed; browsers must match the list.
    origin: (origin, cb) => {
      if (!origin || allowed.has(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Requested-With"],
    maxAge: 600,
  });

  registerErrorHandlers(app, { exposeInternalErrors: env.NODE_ENV !== "production" });
  registerCsrfGuard(app, { prefix: API_PREFIX, exempt: CSRF_EXEMPT });

  if (deps.authStore) {
    await app.register(authPlugin, { env, store: deps.authStore });
    await app.register(authRoutes, {
      prefix: `${API_PREFIX}/auth`,
      env,
      store: deps.authStore,
      ...deps.authOptions,
    });
    if (deps.workerStore) {
      await app.register(systemRoutes, { prefix: `${API_PREFIX}/system`, workerStore: deps.workerStore });
    }
    if (deps.data) {
      await app.register(areasRoutes, { prefix: `${API_PREFIX}/areas`, ...deps.data });
      await app.register(finderRoutes, { prefix: `${API_PREFIX}/finder`, ...deps.data });
      await app.register(leadsRoutes, { prefix: `${API_PREFIX}/leads`, ...deps.data });
      await app.register(settingsRoutes, { prefix: `${API_PREFIX}/settings`, db: deps.data.db });
      await app.register(listsRoutes, { prefix: `${API_PREFIX}/lists`, db: deps.data.db });
      await app.register(suppressionRoutes, { prefix: `${API_PREFIX}/suppression`, db: deps.data.db });
      await app.register(jobAdsRoutes, { prefix: `${API_PREFIX}/jobads`, ...deps.data });
      await app.register(mailboxesRoutes, { prefix: `${API_PREFIX}/mailboxes`, db: deps.data.db, env });
      await app.register(templatesRoutes, { prefix: `${API_PREFIX}/templates`, db: deps.data.db, env });
      await app.register(applicationsRoutes, { prefix: `${API_PREFIX}/applications`, db: deps.data.db, env });
      await app.register(studyRoutes, { prefix: `${API_PREFIX}/study`, db: deps.data.db, env });
      await app.register(studyWatchRoutes, { prefix: `${API_PREFIX}/study`, ...deps.data, env });
      await app.register(campaignsRoutes, { prefix: `${API_PREFIX}/campaigns`, ...deps.data, env });
      await app.register(unsubscribeRoutes, { prefix: `${API_PREFIX}/u`, db: deps.data.db, env });
    }
  }

  // /health at the root (Render health check, cron ping) and under /api/v1 (via the Vercel rewrite).
  const healthOpts: HealthOptions = deps.pingDb ? { pingDb: deps.pingDb } : {};
  await app.register(healthRoutes, healthOpts);
  await app.register(healthRoutes, { ...healthOpts, prefix: API_PREFIX });

  return app;
}
