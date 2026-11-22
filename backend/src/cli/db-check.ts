/**
 * npm run db:check
 *
 * Verifies the database setup without printing any secret:
 *  1. DATABASE_URL (pooled) and DIRECT_URL (direct) look right for Neon.
 *  2. The app can connect through the pool and measures latency.
 *  3. Migrations are applied and the expected tables exist.
 *  4. A write/read/delete round trip on `settings` using a fake "ZZ" key,
 *     cleaned up afterwards (also on Ctrl+C).
 *  5. The deadlock retry helper and the transaction-scoped advisory lock work.
 */
import { randomUUID } from "node:crypto";
import { EnvError, loadEnv } from "../config/env.js";
import { createDb, pingDb, type Db } from "../db/client.js";
import { tryXactLock } from "../db/locks.js";
import { withTxRetry } from "../db/retry.js";
import { describePgUrl } from "../db/url.js";

const EXPECTED_TABLES = ["admin_users", "settings", "audit_log", "worker_heartbeat"];
const TEST_KEY_PREFIX = "verify.ZZ.";

let failures = 0;
const ok = (msg: string) => process.stdout.write(`  OK    ${msg}\n`);
const warn = (msg: string) => process.stdout.write(`  WARN  ${msg}\n`);
const fail = (msg: string) => {
  failures++;
  process.stdout.write(`  FAIL  ${msg}\n`);
};

async function cleanup(db: Db): Promise<void> {
  await db.setting.deleteMany({ where: { key: { startsWith: TEST_KEY_PREFIX } } });
}

async function main(): Promise<void> {
  const env = loadEnv();
  process.stdout.write("\nDatabase check\n\n");

  // 1. URLs
  const pooled = describePgUrl(env.DATABASE_URL);
  process.stdout.write(`  DATABASE_URL -> host ${pooled.host}, db ${pooled.database}, user ${pooled.user}\n`);
  if (pooled.host.endsWith(".neon.tech")) {
    if (pooled.pooled) ok("DATABASE_URL is the pooled Neon endpoint (-pooler)");
    else warn("DATABASE_URL is not the pooled endpoint; turn ON 'Connection pooling' when copying it");
  }
  if (!pooled.ssl && pooled.host !== "localhost" && pooled.host !== "127.0.0.1") warn("DATABASE_URL has no sslmode");

  if (env.DIRECT_URL) {
    const direct = describePgUrl(env.DIRECT_URL);
    process.stdout.write(`  DIRECT_URL   -> host ${direct.host}, db ${direct.database}, user ${direct.user}\n`);
    if (direct.pooled) fail("DIRECT_URL must NOT be the pooled endpoint (remove -pooler / turn pooling OFF)");
    else ok("DIRECT_URL is a direct (non-pooled) endpoint");
    if (direct.database !== pooled.database) fail("DATABASE_URL and DIRECT_URL point to different databases");
    if (direct.host.replace("-pooler", "") !== pooled.host.replace("-pooler", "")) {
      fail("DATABASE_URL and DIRECT_URL point to different Neon endpoints (different branches?)");
    }
  } else {
    fail("DIRECT_URL is not set (needed for migrations)");
  }

  const db = createDb(env);
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stdout.write("\nInterrupted, cleaning up...\n");
    cleanup(db)
      .catch(() => undefined)
      .finally(() => process.exit(130));
  });

  try {
    // 2. Connect (first call may wake Neon)
    const first = await pingDb(db, 20_000);
    const second = await pingDb(db);
    ok(`Connected. First query ${first} ms (includes wake-up), next ${second} ms`);

    const [info] = await db.$queryRaw<{ version: string; tz: string }[]>`
      SELECT split_part(version(), ' on ', 1) AS version, current_setting('TimeZone') AS tz`;
    ok(`Server: ${info?.version ?? "unknown"}, session time zone ${info?.tz ?? "?"}`);

    // 3. Migrations and tables
    const tables = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`;
    const names = new Set(tables.map((t) => t.table_name));
    if (!names.has("_prisma_migrations")) {
      fail("No migrations applied yet. Run: npx prisma migrate deploy");
    } else {
      const migrations = await db.$queryRaw<{ name: string; finished: boolean }[]>`
        SELECT migration_name AS name, finished_at IS NOT NULL AS finished
        FROM _prisma_migrations WHERE rolled_back_at IS NULL ORDER BY started_at`;
      const unfinished = migrations.filter((m) => !m.finished);
      if (unfinished.length > 0) fail(`Unfinished migrations: ${unfinished.map((m) => m.name).join(", ")}`);
      else ok(`${migrations.length} migration(s) applied: ${migrations.map((m) => m.name).join(", ")}`);
    }
    const missing = EXPECTED_TABLES.filter((t) => !names.has(t));
    if (missing.length > 0) fail(`Missing tables: ${missing.join(", ")}`);
    else ok(`Tables present: ${EXPECTED_TABLES.join(", ")}`);

    if (missing.length === 0) {
      // 4. Round trip with a fake ZZ key
      const key = `${TEST_KEY_PREFIX}${randomUUID()}`;
      await db.setting.create({ data: { key, value: { check: true, at: new Date().toISOString() } } });
      const row = await db.setting.findUnique({ where: { key } });
      await cleanup(db);
      const gone = await db.setting.findUnique({ where: { key } });
      if (row && !gone) ok("Write / read / delete on settings works (test row removed)");
      else fail("Settings round trip failed");

      // 5. Retry helper + advisory lock inside a transaction
      let attempts = 0;
      await withTxRetry(async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("simulated"), { code: "40P01" });
        await db.$transaction(async (tx) => {
          if (!(await tryXactLock(tx, "verify.ZZ.lock"))) throw new Error("advisory lock not acquired");
        });
      }, { minDelayMs: 10, maxDelayMs: 20 });
      ok(`Deadlock retry helper recovered after ${attempts - 1} simulated deadlock; xact advisory lock works`);
    }
  } finally {
    await cleanup(db).catch(() => undefined);
    await db.$disconnect();
  }

  process.stdout.write(failures === 0 ? "\nAll checks passed.\n\n" : `\n${failures} check(s) failed.\n\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else console.error("Database check failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
