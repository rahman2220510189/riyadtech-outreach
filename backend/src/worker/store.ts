import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { SettingRow } from "../settings/loader.js";
import { type HeartbeatRow, WORKER_ID } from "./heartbeat.js";

export interface HeartbeatInput {
  pid: number;
  version: string;
  startedAt: Date;
  info: Prisma.InputJsonObject;
}

/** What the worker and the status API need from storage. */
export interface WorkerStore {
  writeHeartbeat(input: HeartbeatInput): Promise<void>;
  readHeartbeat(): Promise<HeartbeatRow | null>;
  readSettingRows(): Promise<SettingRow[]>;
}

export function prismaWorkerStore(db: Db): WorkerStore {
  return {
    async writeHeartbeat({ pid, version, startedAt, info }) {
      // Database clock (now()), so the age is right even if the laptop clock is off.
      await db.$executeRaw`
        INSERT INTO worker_heartbeat (id, pid, version, started_at, last_beat_at, info)
        VALUES (${WORKER_ID}, ${pid}, ${version}, ${startedAt}, now(), ${JSON.stringify(info)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          pid = EXCLUDED.pid,
          version = EXCLUDED.version,
          started_at = EXCLUDED.started_at,
          last_beat_at = EXCLUDED.last_beat_at,
          info = EXCLUDED.info`;
    },
    readHeartbeat: () => db.workerHeartbeat.findUnique({ where: { id: WORKER_ID } }),
    readSettingRows: () => db.setting.findMany({ select: { key: true, value: true } }),
  };
}
