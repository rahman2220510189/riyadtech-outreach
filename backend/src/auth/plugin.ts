import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Env } from "../config/env.js";
import { AppError, errors } from "../lib/errors.js";
import type { AuthStore } from "./store.js";
import "./types.js";

export const SESSION_COOKIE = "rt_session";

export interface AuthPluginOptions {
  env: Pick<Env, "JWT_SECRET" | "SESSION_DAYS" | "NODE_ENV">;
  store: AuthStore;
}

export function sessionCookieOptions(env: Pick<Env, "SESSION_DAYS" | "NODE_ENV">) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: env.SESSION_DAYS * 24 * 60 * 60,
  };
}

/**
 * Cookie + JWT + rate limiting, and the `app.authenticate` preHandler.
 * Wrapped with fastify-plugin so the decorators are visible to all routes.
 */
export const authPlugin = fp<AuthPluginOptions>(
  async (app: FastifyInstance, { env, store }) => {
    await app.register(cookie);
    await app.register(jwt, {
      secret: env.JWT_SECRET,
      cookie: { cookieName: SESSION_COOKIE, signed: false },
      sign: { algorithm: "HS256", expiresIn: `${env.SESSION_DAYS}d` },
      verify: { algorithms: ["HS256"] },
    });
    // Off by default; routes opt in with `config.rateLimit`.
    await app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (_request, ctx) =>
        new AppError(429, "RATE_LIMITED", `Too many attempts. Try again in ${ctx.after}.`),
    });

    app.decorateRequest("admin", null);

    app.decorate("authenticate", async (request: FastifyRequest) => {
      try {
        await request.jwtVerify();
      } catch {
        throw errors.unauthorized("Please log in.");
      }
      const { sub, sv } = request.user;
      const admin = await store.findAdminById(sub);
      if (!admin || admin.sessionVersion !== sv) {
        throw errors.unauthorized("Your session has ended. Please log in again.");
      }
      request.admin = { id: admin.id, email: admin.email };
    });
  },
  { name: "auth" },
);
