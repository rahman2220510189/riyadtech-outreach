/**
 * The worker's per-group limits: finder imports and crawls run side by side, each group
 * never above its own limit. Uses its own short jobs and deletes them afterwards.
 * pump() takes tasks from any running job, so this test only runs when no other job is waiting.
 */
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { JobRunner } from "../../src/jobs/runner.js";
import { RequeueTask, type TaskHandler } from "../../src/jobs/types.js";
import { defaultSettings } from "../../src/settings/definitions.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();

describe.skipIf(!url)("job groups (integration)", () => {
  let db: Db;
  const jobIds: bigint[] = [];

  beforeAll(() => {
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 5, NODE_ENV: "test" });
  });
  afterAll(async () => {
    if (jobIds.length) await db.job.deleteMany({ where: { id: { in: jobIds } } });
    await db.$disconnect();
  });

  it("never runs more tasks of a group than its limit", async () => {
    const waiting = await db.jobTask.count({ where: { status: "queued", job: { status: "running" } } });
    if (waiting > 0) {
      process.stdout.write(`job groups test skipped: ${waiting} task(s) of other jobs are waiting in this database\n`);
      return;
    }
    const running = { slow: 0, other: 0 };
    const peak = { slow: 0, other: 0 };
    const make =
      (group: "slow" | "other"): TaskHandler =>
      async () => {
        running[group]++;
        peak[group] = Math.max(peak[group], running[group]);
        await new Promise((r) => setTimeout(r, 150));
        running[group]--;
        return { result: {} };
      };
    const runner = new JobRunner({
      db,
      log: pino({ level: "silent" }),
      env: { OVERTURE_STAC_URL: "", GEONAMES_BASE_URL: "" },
      handlers: { "slow.task": make("slow"), "other.task": make("other") },
      settings: () => defaultSettings(),
      concurrency: () => 6,
      groupLimits: () => ({ slow: 2 }),
    });
    for (const kind of ["slow.task", "other.task"]) {
      jobIds.push(
        await runner.store.createJob({
          kind: "test-groups",
          params: {},
          tasks: Array.from({ length: 6 }, () => ({ kind, payload: {} })),
        }),
      );
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await runner.pump();
      const left = await db.jobTask.count({ where: { jobId: { in: jobIds }, status: { in: ["queued", "running"] } } });
      if (left === 0) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await runner.stop();
    expect(await db.jobTask.count({ where: { jobId: { in: jobIds }, status: "done" } })).toBe(12);
    expect(peak.slow).toBeLessThanOrEqual(2);
    expect(peak.other).toBeGreaterThan(2); // the other group used the remaining slots
  }, 30_000);

  it("a task interrupted by Pause goes back to the queue without using an attempt, and runs after Resume", async () => {
    let calls = 0;
    const runner = new JobRunner({
      db,
      log: pino({ level: "silent" }),
      env: { OVERTURE_STAC_URL: "", GEONAMES_BASE_URL: "" },
      handlers: {
        "pausy.task": async (ctx) => {
          calls++;
          if (calls === 1) {
            await runner.store.setStatus(ctx.job.id, "pause");
            throw new RequeueTask("paused mid-way");
          }
          return { result: { ok: true } };
        },
      },
      settings: () => defaultSettings(),
      concurrency: () => 1,
    });
    const id = await runner.store.createJob({ kind: "test-pause", params: {}, tasks: [{ kind: "pausy.task", payload: {}, maxAttempts: 1 }] });
    jobIds.push(id);
    await runner.drain(5, id);
    const t = await db.jobTask.findFirstOrThrow({ where: { jobId: id } });
    expect(t).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });
    expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe("paused");
    expect(await runner.drain(5, id)).toBe(0); // paused: nothing runs
    await runner.store.setStatus(id, "resume");
    await runner.drain(5, id);
    expect((await db.jobTask.findFirstOrThrow({ where: { jobId: id } })).status).toBe("done");
    expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe("done");

    // Cancelled while running: the task is cancelled, not queued again.
    calls = 0;
    const id2 = await runner.store.createJob({ kind: "test-pause", params: {}, tasks: [{ kind: "pausy.task", payload: {}, maxAttempts: 1 }] });
    jobIds.push(id2);
    const claimed = await runner.store.claim("test", id2);
    await runner.store.setStatus(id2, "cancel");
    await runner.store.requeue(claimed!);
    expect((await db.jobTask.findFirstOrThrow({ where: { jobId: id2 } })).status).toBe("cancelled");
  });
});
