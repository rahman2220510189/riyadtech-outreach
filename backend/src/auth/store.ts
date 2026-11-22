import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";

export interface AdminRecord {
  id: string;
  email: string;
  passwordHash: string;
  sessionVersion: number;
  lastLoginAt: Date | null;
}

export interface AuditEntry {
  actor?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  details?: Prisma.InputJsonObject | null;
  ip?: string | null;
}

/** Everything auth needs from storage. Prisma in the app, in-memory in unit tests. */
export interface AuthStore {
  findAdminByEmail(email: string): Promise<AdminRecord | null>;
  findAdminById(id: string): Promise<AdminRecord | null>;
  recordLogin(id: string, at: Date): Promise<void>;
  /** Increments session_version (revokes all existing sessions). Returns the new value. */
  bumpSessionVersion(id: string): Promise<number>;
  audit(entry: AuditEntry): Promise<void>;
}

const adminSelect = { id: true, email: true, passwordHash: true, sessionVersion: true, lastLoginAt: true } as const;

export function prismaAuthStore(db: Db): AuthStore {
  return {
    findAdminByEmail: (email) => db.adminUser.findUnique({ where: { email }, select: adminSelect }),
    findAdminById: (id) => db.adminUser.findUnique({ where: { id }, select: adminSelect }),
    async recordLogin(id, at) {
      await db.adminUser.update({ where: { id }, data: { lastLoginAt: at } });
    },
    async bumpSessionVersion(id) {
      const row = await db.adminUser.update({
        where: { id },
        data: { sessionVersion: { increment: 1 } },
        select: { sessionVersion: true },
      });
      return row.sessionVersion;
    },
    async audit(entry) {
      await db.auditLog.create({
        data: {
          actor: entry.actor ?? null,
          action: entry.action,
          entity: entry.entity ?? null,
          entityId: entry.entityId ?? null,
          details: entry.details ?? undefined,
          ip: entry.ip ?? null,
        },
      });
    },
  };
}
