/** How often the worker writes its heartbeat (prompt §3: every 30 s). */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** The UI warns when the last heartbeat is older than this (3 missed beats). */
export const HEARTBEAT_STALE_MS = 90_000;
export const WORKER_ID = "worker";

export interface HeartbeatRow {
  id: string;
  pid: number;
  version: string;
  startedAt: Date;
  lastBeatAt: Date;
  info: unknown;
}

export type WorkerState = "ok" | "stale" | "never";

export interface WorkerStatus {
  state: WorkerState;
  lastBeatAt: string | null;
  ageSeconds: number | null;
  startedAt: string | null;
  version: string | null;
  staleAfterSeconds: number;
}

export function workerStatus(row: HeartbeatRow | null, now: Date = new Date()): WorkerStatus {
  const staleAfterSeconds = HEARTBEAT_STALE_MS / 1000;
  if (!row) {
    return { state: "never", lastBeatAt: null, ageSeconds: null, startedAt: null, version: null, staleAfterSeconds };
  }
  const ageMs = Math.max(0, now.getTime() - row.lastBeatAt.getTime());
  return {
    state: ageMs > HEARTBEAT_STALE_MS ? "stale" : "ok",
    lastBeatAt: row.lastBeatAt.toISOString(),
    ageSeconds: Math.round(ageMs / 1000),
    startedAt: row.startedAt.toISOString(),
    version: row.version,
    staleAfterSeconds,
  };
}
