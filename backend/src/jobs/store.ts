import type { Db } from "../db/client.js";
import { xactLock } from "../db/locks.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ClaimedTask, EventLevel, JobInfo, JobStatus, JsonObject, NewTask } from "./types.js";

interface TaskRow {
  id: bigint;
  job_id: bigint;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface TaskSnapshot {
  kind: string;
  status: string;
  result: Record<string, unknown> | null;
}

/** Builds a job's summary from its tasks when the job finishes (per job kind). */
export type Summarizer = (tasks: TaskSnapshot[]) => JsonObject;

/** Every database operation of the job queue. */
export class JobStore {
  constructor(
    private readonly db: Db,
    private readonly summarizers: Record<string, Summarizer> = {},
  ) {}

  /** Current summary of a job from its tasks (also used while it is still running). */
  async summarize(jobId: bigint, kind: string): Promise<JsonObject | null> {
    const fn = this.summarizers[kind];
    if (!fn) return null;
    const tasks = await this.db.jobTask.findMany({ where: { jobId }, select: { kind: true, status: true, result: true } });
    return fn(tasks.map((t) => ({ kind: t.kind, status: t.status, result: t.result as Record<string, unknown> | null })));
  }

  async createJob(input: {
    kind: string;
    params: JsonObject;
    dryRun?: boolean;
    tasks: NewTask[];
    message?: string;
  }): Promise<bigint> {
    return this.db.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: { kind: input.kind, status: "running", dryRun: input.dryRun ?? false, params: input.params, startedAt: new Date() },
        select: { id: true },
      });
      await this.insertTasks(tx, job.id, input.tasks);
      await tx.jobEvent.create({ data: { jobId: job.id, level: "info", message: input.message ?? "Job created" } });
      return job.id;
    });
  }

  private async insertTasks(tx: Prisma.TransactionClient, jobId: bigint, tasks: NewTask[]): Promise<void> {
    if (tasks.length === 0) return;
    await tx.jobTask.createMany({
      data: tasks.map((t) => ({ jobId, kind: t.kind, payload: t.payload, maxAttempts: t.maxAttempts ?? 3 })),
    });
  }

  /**
   * Claims the oldest runnable task of a running job. SKIP LOCKED lets several
   * workers (or several slots of one worker) claim different tasks safely.
   */
  async claim(workerId: string, onlyJobId?: bigint, skipGroups: readonly string[] = []): Promise<ClaimedTask | null> {
    if (onlyJobId !== undefined) return this.claimForJob(workerId, onlyJobId);
    // skipGroups: task kinds whose group ("crawl" of "crawl.site") has no free slot right now.
    const rows = await this.db.$queryRaw<TaskRow[]>`
      UPDATE job_tasks t
         SET status = 'running', attempts = t.attempts + 1, locked_at = now(), locked_by = ${workerId}
       WHERE t.id = (
         SELECT t2.id FROM job_tasks t2
           JOIN jobs j ON j.id = t2.job_id
          WHERE t2.status = 'queued' AND t2.run_after <= now() AND j.status = 'running'
            AND NOT (split_part(t2.kind, '.', 1) = ANY(${[...skipGroups]}::text[]))
          ORDER BY t2.job_id, t2.id
          FOR UPDATE OF t2 SKIP LOCKED
          LIMIT 1)
      RETURNING t.id, t.job_id, t.kind, t.payload, t.attempts, t.max_attempts`;
    const r = rows[0];
    if (!r) return null;
    return { id: r.id, jobId: r.job_id, kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts };
  }

  /** Same as claim, limited to one job (the CLI runs only the job it created). */
  private async claimForJob(workerId: string, jobId: bigint): Promise<ClaimedTask | null> {
    const rows = await this.db.$queryRaw<TaskRow[]>`
      UPDATE job_tasks t
         SET status = 'running', attempts = t.attempts + 1, locked_at = now(), locked_by = ${workerId}
       WHERE t.id = (
         SELECT t2.id FROM job_tasks t2
           JOIN jobs j ON j.id = t2.job_id
          WHERE t2.job_id = ${jobId} AND t2.status = 'queued' AND t2.run_after <= now() AND j.status = 'running'
          ORDER BY t2.id
          FOR UPDATE OF t2 SKIP LOCKED
          LIMIT 1)
      RETURNING t.id, t.job_id, t.kind, t.payload, t.attempts, t.max_attempts`;
    const r = rows[0];
    if (!r) return null;
    return { id: r.id, jobId: r.job_id, kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts };
  }

  async getJob(jobId: bigint): Promise<JobInfo | null> {
    const j = await this.db.job.findUnique({
      where: { id: jobId },
      select: { id: true, kind: true, status: true, dryRun: true, params: true },
    });
    if (!j) return null;
    return { id: j.id, kind: j.kind, status: j.status as JobStatus, dryRun: j.dryRun, params: j.params as Record<string, unknown> };
  }

  async touch(taskId: bigint): Promise<void> {
    await this.db.jobTask.update({ where: { id: taskId }, data: { lockedAt: new Date() } });
  }

  async event(jobId: bigint, level: EventLevel, message: string, data?: JsonObject): Promise<void> {
    await this.db.jobEvent.create({ data: { jobId, level, message: message.slice(0, 1000), ...(data ? { data } : {}) } });
  }

  async complete(task: ClaimedTask, result: JsonObject, newTasks: NewTask[] = []): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.jobTask.update({
        where: { id: task.id },
        data: { status: "done", result, finishedAt: new Date(), error: null, lockedBy: null },
      });
      await this.insertTasks(tx, task.jobId, newTasks);
      await this.finishJobIfIdle(tx, task.jobId);
    });
  }

  /** Retries with backoff (1, 4, 9 min...) while attempts remain; otherwise marks the task failed. */
  async fail(task: ClaimedTask, error: string, opts: { retry: boolean; failJob?: boolean; pauseJob?: boolean }): Promise<"retry" | "failed"> {
    return this.db.$transaction(async (tx) => {
      const retry = opts.retry && task.attempts < task.maxAttempts;
      if (retry) {
        await tx.jobTask.update({
          where: { id: task.id },
          data: {
            status: "queued",
            error: error.slice(0, 2000),
            lockedBy: null,
            runAfter: new Date(Date.now() + task.attempts * task.attempts * 60_000),
          },
        });
        return "retry";
      }
      await tx.jobTask.update({
        where: { id: task.id },
        data: { status: "failed", error: error.slice(0, 2000), finishedAt: new Date(), lockedBy: null },
      });
      if (opts.pauseJob) {
        await tx.job.update({ where: { id: task.jobId }, data: { status: "paused", error: error.slice(0, 2000) } });
        // The task can run again after "Resume".
        await tx.jobTask.update({ where: { id: task.id }, data: { status: "queued", finishedAt: null, attempts: 0 } });
      } else if (opts.failJob) {
        await xactLock(tx, `job:${task.jobId}`);
        await tx.jobTask.updateMany({ where: { jobId: task.jobId, status: "queued" }, data: { status: "cancelled" } });
        await tx.job.update({
          where: { id: task.jobId },
          data: { status: "failed", error: error.slice(0, 2000), finishedAt: new Date() },
        });
      } else {
        await this.finishJobIfIdle(tx, task.jobId);
      }
      return "failed";
    });
  }

  /** Puts an interrupted task back (no attempt used); in a cancelled job it is cancelled instead. */
  async requeue(task: ClaimedTask): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await xactLock(tx, `job:${task.jobId}`);
      const job = await tx.job.findUnique({ where: { id: task.jobId }, select: { status: true } });
      const cancelled = !job || job.status === "cancelled" || job.status === "failed";
      await tx.jobTask.update({
        where: { id: task.id },
        data: cancelled
          ? { status: "cancelled", lockedBy: null, finishedAt: new Date() }
          : { status: "queued", lockedBy: null, attempts: Math.max(0, task.attempts - 1), runAfter: new Date() },
      });
    });
  }

  /** When nothing is queued or running any more, the job is done. */
  private async finishJobIfIdle(tx: Prisma.TransactionClient, jobId: bigint): Promise<void> {
    await xactLock(tx, `job:${jobId}`);
    const open = await tx.jobTask.count({ where: { jobId, status: { in: ["queued", "running"] } } });
    if (open > 0) return;
    const job = await tx.job.findUnique({ where: { id: jobId }, select: { kind: true, status: true } });
    if (!job || (job.status !== "running" && job.status !== "paused")) return;
    const fn = this.summarizers[job.kind];
    let summary: JsonObject | undefined;
    if (fn) {
      const tasks = await tx.jobTask.findMany({ where: { jobId }, select: { kind: true, status: true, result: true } });
      summary = fn(tasks.map((t) => ({ kind: t.kind, status: t.status, result: t.result as Record<string, unknown> | null })));
    }
    await tx.job.update({
      where: { id: jobId },
      data: { status: "done", finishedAt: new Date(), ...(summary ? { summary } : {}) },
    });
  }

  /** Returns the job's status afterwards (null = no such job). Repeating an action changes nothing. */
  async setStatus(jobId: bigint, action: "pause" | "resume" | "cancel"): Promise<JobStatus | null> {
    return (await this.changeStatus(jobId, action))?.status ?? null;
  }

  async changeStatus(
    jobId: bigint,
    action: "pause" | "resume" | "cancel",
  ): Promise<{ status: JobStatus; changed: boolean } | null> {
    return this.db.$transaction(async (tx) => {
      await xactLock(tx, `job:${jobId}`);
      const job = await tx.job.findUnique({ where: { id: jobId }, select: { status: true } });
      if (!job) return null;
      const status = job.status as JobStatus;
      if (action === "pause" && status === "running") {
        await tx.job.update({ where: { id: jobId }, data: { status: "paused" } });
        return { status: "paused", changed: true };
      }
      if (action === "resume" && status === "paused") {
        await tx.job.update({ where: { id: jobId }, data: { status: "running", error: null } });
        return { status: "running", changed: true };
      }
      if (action === "cancel" && (status === "running" || status === "paused" || status === "queued")) {
        await tx.jobTask.updateMany({ where: { jobId, status: "queued" }, data: { status: "cancelled" } });
        await tx.job.update({ where: { id: jobId }, data: { status: "cancelled", finishedAt: new Date() } });
        return { status: "cancelled", changed: true };
      }
      return { status, changed: false };
    });
  }

  /** Tasks whose worker died (no touch for `minutes`) go back to the queue. */
  async requeueStale(minutes: number): Promise<number> {
    return this.db.$executeRaw`
      UPDATE job_tasks SET status = 'queued', locked_by = NULL, run_after = now()
       WHERE status = 'running' AND locked_at < now() - make_interval(mins => ${minutes})`;
  }
}
