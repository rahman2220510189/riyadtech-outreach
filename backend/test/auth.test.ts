import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { LoginLimiter } from "../src/auth/login-limiter.js";
import { hashPassword } from "../src/auth/password.js";
import { SESSION_COOKIE } from "../src/auth/plugin.js";
import { parseEnv } from "../src/config/env.js";
import { testEnv } from "./helpers/env.js";
import { MemoryAuthStore } from "./helpers/memory-store.js";

const EMAIL = "riyad@riyadtech.xyz";
const PASSWORD = "correct horse battery staple";
const CSRF = { "x-requested-with": "XMLHttpRequest" };

let passwordHash: string;
let store: MemoryAuthStore;
let app: FastifyInstance;
let ipCounter = 0;
/** A fresh client IP per test so the per-IP limit (5 / 15 min) only matters where tested. */
let ip: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

beforeEach(async () => {
  store = new MemoryAuthStore();
  store.addAdmin(EMAIL, passwordHash);
  app = await buildApp(testEnv(), { authStore: store, authOptions: { dummyHashCost: 4 } });
  ip = `10.0.0.${++ipCounter}`;
  return () => app.close();
});

function login(body: unknown, opts: { headers?: Record<string, string>; ip?: string } = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { ...CSRF, ...opts.headers },
    payload: body as Record<string, unknown>,
    remoteAddress: opts.ip ?? ip,
  });
}

function sessionCookie(res: LightMyRequestResponse) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE);
}

function me(token?: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/auth/me",
    cookies: token ? { [SESSION_COOKIE]: token } : {},
  });
}

describe("POST /api/v1/auth/login", () => {
  it("logs in and sets an httpOnly, SameSite=Lax session cookie", async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { email: EMAIL, previousLoginAt: null } });

    const c = sessionCookie(res);
    expect(c?.value).toBeTruthy();
    expect(c?.httpOnly).toBe(true);
    expect(c?.sameSite).toBe("Lax");
    expect(c?.path).toBe("/");
    expect(c?.secure).toBeFalsy(); // not production
    expect(c?.maxAge).toBe(7 * 24 * 60 * 60);
    expect(res.headers["cache-control"]).toBe("no-store");

    expect(store.auditLog).toEqual([expect.objectContaining({ action: "auth.login", actor: EMAIL, ip })]);
    expect([...store.admins.values()][0]?.lastLoginAt).toBeInstanceOf(Date);
  });

  it("accepts the e-mail in any case and with spaces", async () => {
    const res = await login({ email: "  Riyad@RiyadTech.XYZ ", password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it("gives the same 401 for a wrong password and an unknown e-mail, and writes no audit row", async () => {
    const wrong = await login({ email: EMAIL, password: "nope" });
    const unknown = await login({ email: "someone@else.com", password: PASSWORD });
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: "INVALID_CREDENTIALS", message: "Wrong e-mail or password." } });
      expect(sessionCookie(res)).toBeUndefined();
    }
    expect(store.auditLog).toHaveLength(0);
  });

  it("rejects a request without the CSRF header (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("CSRF_HEADER_MISSING");
  });

  it("validates the body (400)", async () => {
    const res = await login({ email: EMAIL });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("allows 5 attempts per IP per 15 minutes, then 429 with Retry-After", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await login({ email: EMAIL, password: "wrong" })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    const blocked = await login({ email: EMAIL, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBeDefined();
    // Another IP is not affected by this IP's limit.
    expect((await login({ email: EMAIL, password: PASSWORD }, { ip: "10.9.9.9" })).statusCode).toBe(200);
  });

  it("locks the account after repeated failures from many IPs (spoofed IPs do not help)", async () => {
    let t = 0;
    const limiter = new LoginLimiter({ maxFailures: 3, windowMs: 15 * 60_000, now: () => t });
    await app.close();
    app = await buildApp(testEnv(), { authStore: store, authOptions: { dummyHashCost: 4, limiter } });

    for (let i = 0; i < 3; i++) {
      expect((await login({ email: EMAIL, password: "wrong" }, { ip: `10.1.1.${i}` })).statusCode).toBe(401);
    }
    const locked = await login({ email: EMAIL, password: PASSWORD }, { ip: "10.1.1.99" });
    expect(locked.statusCode).toBe(429);
    expect(locked.json<{ error: { message: string } }>().error.message).toMatch(/this account/);

    t += 15 * 60_000; // window passed
    expect((await login({ email: EMAIL, password: PASSWORD }, { ip: "10.1.1.100" })).statusCode).toBe(200);
  });
});

describe("GET /api/v1/auth/me", () => {
  it("401 without a session cookie", async () => {
    const res = await me();
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("returns the admin with a valid session", async () => {
    const token = sessionCookie(await login({ email: EMAIL, password: PASSWORD }))?.value;
    const res = await me(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { email: EMAIL } });
  });

  it("401 for a tampered token or one signed with another key", async () => {
    const token = sessionCookie(await login({ email: EMAIL, password: PASSWORD }))?.value ?? "";
    const tampered = token.slice(0, -3) + (token.endsWith("aaa") ? "bbb" : "aaa");
    expect((await me(tampered)).statusCode).toBe(401);

    const other = await buildApp(testEnv({ JWT_SECRET: "another-unit-test-jwt-key-0123456789abcdef" }), {
      authStore: store,
      authOptions: { dummyHashCost: 4 },
    });
    await other.ready();
    const foreign = other.jwt.sign({ sub: [...store.admins.keys()][0] ?? "", sv: 0 });
    await other.close();
    expect((await me(foreign)).statusCode).toBe(401);
  });

  it("401 when the admin no longer exists", async () => {
    const token = sessionCookie(await login({ email: EMAIL, password: PASSWORD }))?.value;
    store.admins.clear();
    expect((await me(token)).statusCode).toBe(401);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("clears the cookie and revokes the token everywhere", async () => {
    const token = sessionCookie(await login({ email: EMAIL, password: PASSWORD }))?.value;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: CSRF,
      cookies: { [SESSION_COOKIE]: token ?? "" },
    });
    expect(res.statusCode).toBe(200);
    const cleared = sessionCookie(res);
    expect(cleared?.value).toBe("");
    expect(cleared?.expires?.getTime()).toBeLessThan(Date.now());

    // The old token is useless now, even if someone kept a copy.
    expect((await me(token)).statusCode).toBe(401);
    expect(store.auditLog.map((a) => a.action)).toEqual(["auth.login", "auth.logout"]);
  });

  it("accepts Content-Type: application/json with an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { ...CSRF, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("still rejects a prototype-poisoning JSON body", async () => {
    const res = await login(undefined, {
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    const poisoned = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { ...CSRF, "content-type": "application/json" },
      payload: '{"email":"a@b.cd","password":"x","__proto__":{"admin":true}}',
      remoteAddress: ip,
    });
    expect(poisoned.statusCode).toBe(400);
  });

  it("works without a session (just clears the cookie)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: CSRF });
    expect(res.statusCode).toBe(200);
  });

  it("requires the CSRF header", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(403);
  });
});

describe("production cookie", () => {
  it("is Secure in production", async () => {
    const prod = await buildApp(
      parseEnv({
        NODE_ENV: "production",
        LOG_LEVEL: "silent",
        CORS_ORIGIN: "https://outreach.example.com",
        DATABASE_URL: "postgresql://u:p@localhost/db?sslmode=require",
        JWT_SECRET: "k".repeat(40),
        ENCRYPTION_KEY: "ab".repeat(32),
      }),
      { authStore: store, authOptions: { dummyHashCost: 4 } },
    );
    const res = await prod.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)?.secure).toBe(true);
    await prod.close();
  });
});

describe("GET /api/v1/system/status", () => {
  it("needs login, then reports the worker state", async () => {
    await app.close();
    const lastBeatAt = new Date(Date.now() - 10_000);
    app = await buildApp(testEnv(), {
      authStore: store,
      authOptions: { dummyHashCost: 4 },
      workerStore: {
        readHeartbeat: () =>
          Promise.resolve({ id: "worker", pid: 1, version: "0.4.0", startedAt: lastBeatAt, lastBeatAt, info: null }),
      },
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/system/status" })).statusCode).toBe(401);

    const token = sessionCookie(await login({ email: EMAIL, password: PASSWORD }))?.value ?? "";
    const res = await app.inject({ method: "GET", url: "/api/v1/system/status", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ worker: { state: "ok", version: "0.4.0" }, server: { version: expect.any(String) as string } });
  });
});
