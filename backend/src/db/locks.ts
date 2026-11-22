import type { Prisma } from "../generated/prisma/client.js";

/**
 * Transaction-scoped advisory lock. Released automatically at COMMIT/ROLLBACK.
 * Never use session-level locks (pg_advisory_lock): Neon's pooled connection can keep them.
 * Must be called inside prisma.$transaction(async (tx) => ...).
 */
export async function xactLock(tx: Prisma.TransactionClient, name: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}

/** Like xactLock, but returns false immediately if another transaction holds the lock. */
export async function tryXactLock(tx: Prisma.TransactionClient, name: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${name}, 0)) AS locked`;
  return rows[0]?.locked === true;
}
