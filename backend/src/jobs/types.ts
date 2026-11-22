import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { Settings } from "../settings/definitions.js";

export type JobStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type EventLevel = "info" | "warn" | "error";
export type Json = Prisma.InputJsonValue;
export type JsonObject = Prisma.InputJsonObject;

export interface NewTask {
  kind: string;
  payload: JsonObject;
  maxAttempts?: number;
}

export interface ClaimedTask {
  id: bigint;
  jobId: bigint;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export interface JobInfo {
  id: bigint;
  kind: string;
  status: JobStatus;
  dryRun: boolean;
  params: Record<string, unknown>;
}

export interface TaskContext {
  db: Db;
  log: Logger;
  settings: Settings;
  env: { OVERTURE_STAC_URL: string; GEONAMES_BASE_URL: string; GROQ_API_KEY?: string | undefined; GROQ_MODEL?: string };
  task: ClaimedTask;
  job: JobInfo;
  event(level: EventLevel, message: string, data?: JsonObject): Promise<void>;
  /** Marks the task as alive (long tasks call this between steps). */
  touch(): Promise<void>;
}

export interface TaskOutcome {
  result: JsonObject;
  newTasks?: NewTask[];
}

export type TaskHandler = (ctx: TaskContext) => Promise<TaskOutcome>;

/** Throw for errors that retrying cannot fix (bad input, storage limit). The job stops with the message. */
export class FatalTaskError extends Error {
  constructor(
    message: string,
    /** Pause the job instead of failing it (e.g. storage limit: free space, then resume). */
    readonly pauseJob = false,
  ) {
    super(message);
    this.name = "FatalTaskError";
  }
}

/** Throw when the task was interrupted by Pause/Cancel: it goes back to the queue without using an attempt. */
export class RequeueTask extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequeueTask";
  }
}
