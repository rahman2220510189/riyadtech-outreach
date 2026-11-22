/**
 * Worker against a real database: heartbeat row (database clock) and settings read.
 * The heartbeat row is shared with a real worker; a running real worker simply
 * overwrites it again within 30 s, so nothing needs restoring.
 */
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { workerStatus } from "../../src/worker/heartbeat.js";
import { Worker } from "../../src/worker/runner.js";
import { prismaWorkerStore } from "../../src/worker/store.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();

describe.skipIf(!url)("worker (integration)", () => {
  let db: Db;

  beforeAll(() => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 3, NODE_ENV: "test" });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("writes the heartbeat with the database clock and reads it back as ok", async () => {
    const store = prismaWorkerStore(db);
    const w = new Worker({ store, log: pino({ level: "silent" }), version: "0.0.0-test" });
    await w.start();
    await w.stop();

    const row = await store.readHeartbeat();
    expect(row?.version).toBe("0.0.0-test");
    const [dbNow] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    expect(workerStatus(row, dbNow?.now).state).toBe("ok");
  });

  it("reads settings rows and validates them", async () => {
    const store = prismaWorkerStore(db);
    const rows = await store.readSettingRows();
    expect(Array.isArray(rows)).toBe(true);
  });
});
