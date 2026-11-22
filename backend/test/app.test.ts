import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../src/app.js";
import { parseEnv } from "../src/config/env.js";
import { AppError } from "../src/lib/errors.js";
import { testEnv } from "./helpers/env.js";

const FRONTEND = "http://localhost:3000";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(testEnv({ CORS_ORIGIN: FRONTEND }));
  // Test-only routes to exercise the error handler.
  app.get("/__test/app-error", () => {
    throw new AppError(409, "CONFLICT", "Already exists", { field: "email" });
  });
  app.get("/__test/zod-error", () => {
    z.object({ email: z.email() }).parse({ email: "nope" });
  });
  app.get("/__test/crash", () => {
    throw new Error("boom");
  });
  app.post("/__test/echo", (req) => req.body);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns ok with version and database status", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; version: string; checks: { database: string } }>();
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.checks.database).toBe("not_configured");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("reports database ok with latency when the ping succeeds", async () => {
    const withDb = await buildApp(testEnv(), { pingDb: () => Promise.resolve(12) });
    const res = await withDb.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", checks: { database: "ok", databaseLatencyMs: 12 } });
    await withDb.close();
  });

  it("stays 200 but reports degraded when the database does not answer", async () => {
    const withDb = await buildApp(testEnv(), { pingDb: () => Promise.reject(new Error("connect ECONNREFUSED")) });
    const res = await withDb.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "degraded", checks: { database: "error" } });
    expect(res.body).not.toContain("ECONNREFUSED");
    await withDb.close();
  });

  it("is also available under /api/v1/health", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("sets security headers and a request id", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});

describe("CORS", () => {
  it("allows the configured frontend origin with credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: FRONTEND } });
    expect(res.headers["access-control-allow-origin"]).toBe(FRONTEND);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not allow an unknown origin", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("error shape", () => {
  it("404 uses the standard error shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: expect.any(String) as string } });
  });

  it("AppError keeps status, code and details", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/app-error" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: "CONFLICT", message: "Already exists", details: { field: "email" } } });
  });

  it("ZodError becomes 400 VALIDATION_ERROR with details", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/zod-error" });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string; details: { path: string }[] } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details[0]?.path).toBe("email");
  });

  it("unexpected errors become 500 INTERNAL_ERROR", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/crash" });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("INTERNAL_ERROR");
  });

  it("hides internal error messages in production", async () => {
    const prod = await buildApp(
      parseEnv({
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
        CORS_ORIGIN: "https://x.example.com",
        DATABASE_URL: "postgresql://u:p@localhost/db?sslmode=require",
        JWT_SECRET: "k".repeat(40),
        ENCRYPTION_KEY: "ab".repeat(32),
      }),
    );
    prod.get("/__test/crash", () => {
      throw new Error("secret detail");
    });
    const res = await prod.inject({ method: "GET", url: "/__test/crash" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret detail");
    await prod.close();
  });

  it("invalid JSON body becomes 400 with the standard shape", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/__test/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("BAD_REQUEST");
  });
});
