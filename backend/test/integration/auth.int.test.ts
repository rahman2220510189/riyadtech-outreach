/**
 * Auth against a real database: seed -> login -> me -> logout -> me (401).
 * Uses a fake "zz.invalid" admin and removes it (and its audit rows) afterwards.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../helpers/test-db.js";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE } from "../../src/auth/plugin.js";
import { seedAdmin } from "../../src/auth/seed.js";
import { prismaAuthStore } from "../../src/auth/store.js";
import { createDb, type Db } from "../../src/db/client.js";
import { testEnv } from "../helpers/env.js";

const url = testDatabaseUrl();
const EMAIL = "verify-admin@zz.invalid";
const CSRF = { "x-requested-with": "XMLHttpRequest" };

describe.skipIf(!url)("auth (integration)", () => {
  let db: Db;
  let app: FastifyInstance;

  async function cleanup() {
    const admins = await db.adminUser.findMany({ where: { email: EMAIL }, select: { id: true } });
    const ids = admins.map((a) => a.id);
    await db.auditLog.deleteMany({ where: { entity: "admin_user", entityId: { in: ids } } });
    await db.adminUser.deleteMany({ where: { email: EMAIL } });
  }

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 5, NODE_ENV: "test" });
    await cleanup();
    app = await buildApp(testEnv(), { authStore: prismaAuthStore(db), authOptions: { dummyHashCost: 4 } });
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.$disconnect();
  });

  it("seeds, logs in, reads /me, logs out and revokes the token", async () => {
    const created = await seedAdmin(db, "  Verify-Admin@ZZ.invalid ", "plum-orbit-lantern-47", 4);
    expect(created).toMatchObject({ action: "created", email: EMAIL });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { email: EMAIL, password: "plum-orbit-lantern-47" },
      remoteAddress: "10.77.0.1",
    });
    expect(login.statusCode).toBe(200);
    const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "";

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { [SESSION_COOKIE]: token } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { lastLoginAt: string } }>().user.lastLoginAt).toBeTruthy();

    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: CSRF,
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { [SESSION_COOKIE]: token } });
    expect(after.statusCode).toBe(401);

    const actions = await db.auditLog.findMany({
      where: { entity: "admin_user", entityId: created.id },
      orderBy: { id: "asc" },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(["admin.create", "auth.login", "auth.logout"]);
  });

  it("re-seeding sets a new password and logs out existing sessions", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { email: EMAIL, password: "plum-orbit-lantern-47" },
      remoteAddress: "10.77.0.2",
    });
    const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? "";

    const updated = await seedAdmin(db, EMAIL, "new-quiet-harbor-58", 4);
    expect(updated.action).toBe("updated");

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", cookies: { [SESSION_COOKIE]: token } });
    expect(me.statusCode).toBe(401);

    const oldPw = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: CSRF,
      payload: { email: EMAIL, password: "plum-orbit-lantern-47" },
      remoteAddress: "10.77.0.3",
    });
    expect(oldPw.statusCode).toBe(401);
  });
});
