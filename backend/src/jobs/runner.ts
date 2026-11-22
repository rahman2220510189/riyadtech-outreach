import { hostname } from "node:os";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import type { Settings } from "../settings/definitions.js";
import { JobStore, type Summarizer } from "./store.js";
import { type ClaimedTask, FatalTaskError, RequeueTask, type TaskContext, type TaskHandler } from "./types.js";

export interface RunnerOptions {
  db: Db;
  log: Logger;
  env: TaskContext["env"];
  handlers: Record<string, TaskHandler>;
  /** Job summaries by job kind, written when a job finishes. */
  summarizers?: Record<string, Summarizer>;
  /** Current settings (the worker reloads them every minute). */
  settings: () => Settings;
  /** How many tasks run at the same time (all kinds together). */
  concurrency: () => number;
  /** Per task group ("finder", "crawl"): at most this many at once. Groups not listed share the total. */
  groupLimits?: () => Record<string, number>;
  /** Re-queue tasks of a dead worker after this many minutes without a touch. */
  staleMinutes?: number;
}

/**
 * Pulls tasks from the queue and runs them. One instance per worker process.
 * `pump()` fills free slots; the worker calls it every few seconds.
 */
export class JobRunner {
  readonly store: JobStore;
  private readonly workerId = `${hostname()}:${process.pid}`;
  private readonly active = new Set<Promise<void>>();
  private readonly activeGroups = new Map<string, number>();
  private stopping = false;
  private lastStaleCheck = 0;

  constructor(private readonly opts: RunnerOptions) {
    this.store = new JobStore(opts.db, opts.summarizers);
  }

  get busy(): number {
    return this.active.size;
  }

  /** Claims tasks until all slots are busy or the queue is empty. Returns how many started. */
  async pump(): Promise<number> {
    if (this.stopping) return 0;
    if (Date.now() - this.lastStaleCheck > 60_000) {
      this.lastStaleCheck = Date.now();
      const n = await this.store.requeueStale(this.opts.staleMinutes ?? 15);
      if (n > 0) this.opts.log.warn({ tasks: n }, "Re-queued tasks left running by a stopped worker");
    }
    let started = 0;
    while (!this.stopping && this.active.size < Math.max(1, this.opts.concurrency())) {
      const limits = this.opts.groupLimits?.() ?? {};
      const full = Object.entries(limits)
        .filter(([g, n]) => (this.activeGroups.get(g) ?? 0) >= Math.max(1, n))
        .map(([g]) => g);
      const task = await this.store.claim(this.workerId, undefined, full);
      if (!task) break;
      const group = task.kind.split(".")[0] ?? task.kind;
      this.activeGroups.set(group, (this.activeGroups.get(group) ?? 0) + 1);
      const run = this.run(task).finally(() => {
        this.active.delete(run);
        this.activeGroups.set(group, (this.activeGroups.get(group) ?? 1) - 1);
      });
      this.active.add(run);
      started++;
    }
    return started;
  }

  /** Runs every runnable task to the end, one at a time (CLI and tests); `onlyJobId` limits it to one job. */
  async drain(maxTasks = 10_000, onlyJobId?: bigint): Promise<number> {
    let n = 0;
    for (; n < maxTasks; n++) {
      const task = await this.store.claim(this.workerId, onlyJobId);
      if (!task) break;
      await this.run(task);
    }
    return n;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.active]);
  }

  private async run(task: ClaimedTask): Promise<void> {
    const log = this.opts.log.child({ taskId: String(task.id), jobId: String(task.jobId), kind: task.kind });
    const handler = this.opts.handlers[task.kind];
    if (!handler) {
      await this.store.fail(task, `No handler for task kind "${task.kind}"`, { retry: false, failJob: true });
      return;
    }
    const job = await this.store.getJob(task.jobId);
    if (!job) return;

    const ctx: TaskContext = {
      db: this.opts.db,
      log,
      settings: this.opts.settings(),
      env: this.opts.env,
      task,
      job,
      event: (level, message, data) => this.store.event(task.jobId, level, message, data),
      touch: () => this.store.touch(task.id),
    };

    const started = Date.now();
    try {
      const outcome = await handler(ctx);
      await this.store.complete(task, { ...outcome.result, ms: Date.now() - started }, outcome.newTasks);
      log.debug({ ms: Date.now() - started }, "Task done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof RequeueTask) {
        log.info({ err: message }, "Task put back in the queue");
        await this.store.requeue(task);
        return;
      }
      if (err instanceof FatalTaskError) {
        log.warn({ err: message }, "Task stopped");
        await this.store.fail(task, message, { retry: false, failJob: !err.pauseJob, pauseJob: err.pauseJob });
        await this.store.event(task.jobId, "error", err.pauseJob ? `Paused: ${message}` : `Stopped: ${message}`);
        return;
      }
      const outcome = await this.store.fail(task, message, { retry: true, failJob: task.kind.endsWith(".plan") });
      log.warn({ err: message, outcome }, "Task failed");
      await this.store.event(
        task.jobId,
        outcome === "retry" ? "warn" : "error",
        outcome === "retry" ? `A step failed and will be retried: ${message}` : `A step failed: ${message}`,
      );
    }
  }
}
