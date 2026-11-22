/**
 * Retry a transaction on deadlock (40P01) or serialization failure (40001).
 * Lesson from the previous project: concurrent bulk upserts deadlock now and then.
 * Always also write rows in a fixed order (sort by key) to make deadlocks rare.
 */

/** PostgreSQL SQLSTATE codes that are safe to retry, plus Prisma's own code for them. */
const RETRYABLE_CODES = new Set(["40P01", "40001", "P2034"]);

function codesOf(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== "object" || depth > 5) return [];
  const e = err as Record<string, unknown>;
  const found: string[] = [];
  for (const key of ["code", "originalCode"]) {
    const v = e[key];
    if (typeof v === "string") found.push(v);
  }
  // Prisma driver-adapter errors keep the database error under meta.driverAdapterError.cause.
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") found.push(...codesOf(meta.driverAdapterError, depth + 1));
  found.push(...codesOf(e.cause, depth + 1));
  return found;
}

export function isRetryableTxError(err: unknown): boolean {
  if (codesOf(err).some((c) => RETRYABLE_CODES.has(c))) return true;
  // Fallback: some wrappers only keep the message.
  const msg = err instanceof Error ? err.message : "";
  return /deadlock detected|could not serialize access|write conflict or a deadlock/i.test(msg);
}

export interface RetryOptions {
  /** Retries after the first attempt. Default 4 (so up to 5 attempts). */
  retries?: number;
  /** Random pause between minDelayMs and maxDelayMs before each retry. */
  minDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withTxRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  const min = opts.minDelayMs ?? 50;
  const max = opts.maxDelayMs ?? 250;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !isRetryableTxError(err)) throw err;
      opts.onRetry?.(attempt + 1, err);
      await sleep(min + Math.floor(Math.random() * (max - min + 1)));
    }
  }
}
