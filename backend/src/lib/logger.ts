import type { LoggerOptions } from "pino";
import type { Env } from "../config/env.js";

/**
 * Paths that must never appear in logs. Covers cookies, auth headers and any
 * field that looks like a secret, at the top level and one level deep.
 */
export const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
  "password",
  "*.password",
  "passwordHash",
  "*.passwordHash",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
];

export function buildLoggerOptions(env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">): LoggerOptions {
  const options: LoggerOptions = {
    level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: "riyadtech-outreach-api" },
  };
  // Pretty logs only for local development; JSON everywhere else.
  if (env.NODE_ENV === "development") {
    options.transport = {
      target: "pino-pretty",
      options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,service" },
    };
  }
  return options;
}
