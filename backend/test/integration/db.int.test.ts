/**
 * Integration tests against a real PostgreSQL with migrations applied.
 * Skipped unless TEST_DATABASE_URL is set (environment or backend/.env); point it at the Neon dev branch. Uses only "verify.ZZ." keys and removes them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "../helpers/test-db.js";
import { createDb, pingDb, type Db } from "../../src/db/client.js";
import { tryXactLock } from "../../src/db/locks.js";
import { withTxRetry } from "../../src/db/retry.js";

const url = testDatabaseUrl();
const PREFIX = "verify.ZZ.int.";

/** Rejects instead of hanging forever if the other side never arrives. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe.skipIf(!url)("database (integration)", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 5, NODE_ENV: "test" });
    await db.setting.deleteMany({ where: { key: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await db.setting.deleteMany({ where: { key: { startsWith: PREFIX } } });
    await db.$disconnect();
  });

  it("answers a ping", async () => {
    expect(await pingDb(db)).toBeGreaterThanOrEqual(0);
  });

  it("rejects an upper-case admin e-mail (database CHECK)", async () => {
    await expect(
      db.adminUser.create({ data: { email: "Upper@Example.com", passwordHash: "x" } }),
    ).rejects.toThrow();
  });

  it("starts transactions even when every new connection is slow (Neon from far away)", async () => {
    // Several transactions at once force the pool to open new connections.
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        db.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ n: number }[]>`SELECT ${i}::int AS n, pg_sleep(0.2)::text AS slept`;
          return rows[0]?.n;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3]);
  }, 60_000);

  it("recovers from a real deadlock with withTxRetry", async () => {
    const a = `${PREFIX}a`;
    const b = `${PREFIX}b`;
    await db.setting.createMany({ data: [{ key: a, value: 0 }, { key: b, value: 0 }] });

    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const meet = async () => {
      if (++arrived === 2) release();
      await within(barrier, 25_000, "second transaction reaching the barrier");
    };
    let retries = 0;

    const run = (first: string, second: string) =>
      withTxRetry(
        (attempt) =>
          db.$transaction(
            async (tx) => {
              await tx.$executeRaw`UPDATE settings SET value = to_jsonb(1), updated_at = now() WHERE key = ${first}`;
              if (attempt === 0) await meet(); // both now hold one row lock
              await tx.$executeRaw`UPDATE settings SET value = to_jsonb(2), updated_at = now() WHERE key = ${second}`;
            },
          ),
        { onRetry: () => retries++, minDelayMs: 20, maxDelayMs: 50 },
      );

    await expect(Promise.all([run(a, b), run(b, a)])).resolves.toHaveLength(2);
    expect(retries).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("transaction-scoped advisory lock blocks a second holder until commit", async () => {
    const name = `${PREFIX}lock`;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let lockedSignal!: () => void;
    const locked = new Promise<void>((r) => (lockedSignal = r));

    const holder = db.$transaction(async (tx) => {
      expect(await tryXactLock(tx, name)).toBe(true);
      lockedSignal();
      await hold;
    });
    // If the holder fails before taking the lock, fail fast instead of hanging.
    await within(Promise.race([locked, holder.then(() => undefined)]), 25_000, "holder taking the lock");
    const whileHeld = await db.$transaction((tx) => tryXactLock(tx, name));
    release();
    await holder;
    const afterCommit = await db.$transaction((tx) => tryXactLock(tx, name));

    expect(whileHeld).toBe(false);
    expect(afterCommit).toBe(true);
  }, 60_000);
});
