import { randomUUID } from "node:crypto";
import type { AdminRecord, AuditEntry, AuthStore } from "../../src/auth/store.js";

/** In-memory AuthStore for unit tests. */
export class MemoryAuthStore implements AuthStore {
  admins = new Map<string, AdminRecord>();
  auditLog: AuditEntry[] = [];

  addAdmin(email: string, passwordHash: string): AdminRecord {
    const admin: AdminRecord = { id: randomUUID(), email, passwordHash, sessionVersion: 0, lastLoginAt: null };
    this.admins.set(admin.id, admin);
    return admin;
  }

  findAdminByEmail(email: string) {
    return Promise.resolve([...this.admins.values()].find((a) => a.email === email) ?? null);
  }
  findAdminById(id: string) {
    return Promise.resolve(this.admins.get(id) ?? null);
  }
  recordLogin(id: string, at: Date) {
    const a = this.admins.get(id);
    if (a) a.lastLoginAt = at;
    return Promise.resolve();
  }
  bumpSessionVersion(id: string) {
    const a = this.admins.get(id);
    if (!a) return Promise.reject(new Error("not found"));
    a.sessionVersion++;
    return Promise.resolve(a.sessionVersion);
  }
  audit(entry: AuditEntry) {
    this.auditLog.push(entry);
    return Promise.resolve();
  }
}
