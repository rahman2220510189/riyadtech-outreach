import { PrismaPg } from "@prisma/adapter-pg";
import type { Env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { normalizePgUrl } from "./url.js";

export type Db = PrismaClient;

/** How long a new connection may take (TLS + auth + Neon waking from sleep). */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Interactive transaction limits.
 * Prisma's default maxWait is 2 s: too short when a NEW connection to Neon is needed
 * (seen from Dhaka: 2-6 s; error P2028 "Unable to start a transaction in the given time").
 * maxWait must be longer than the connect timeout so the pool can open a connection.
 */
export const TX_MAX_WAIT_MS = CONNECT_TIMEOUT_MS + 5_000;
export const TX_TIMEOUT_MS = 20_000;

/**
 * Prisma 7 client over node-postgres, using the POOLED Neon URL.
 */
export function createDb(env: Pick<Env, "DATABASE_URL" | "DB_POOL_MAX" | "NODE_ENV">): Db {
  const adapter = new PrismaPg({
    connectionString: normalizePgUrl(env.DATABASE_URL),
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({
    adapter,
    transactionOptions: { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS },
    // Errors are thrown to the caller and logged there (with request id); tests stay quiet.
    log: env.NODE_ENV === "development" ? ["warn", "error"] : env.NODE_ENV === "test" ? [] : ["error"],
  });
}

/** Cheap round trip used by /health. Rejects if the database does not answer within timeoutMs. */
export async function pingDb(db: Db, timeoutMs = 10_000): Promise<number> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Database did not answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    await Promise.race([db.$queryRaw`SELECT 1`, timeout]);
    return Math.round(performance.now() - started);
  } finally {
    clearTimeout(timer);
  }
}
