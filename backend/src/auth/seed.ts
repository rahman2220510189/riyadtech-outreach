import type { Db } from "../db/client.js";
import { BCRYPT_COST, PASSWORD_MIN_LENGTH, hashPassword, normalizeEmail } from "./password.js";

export interface SeedResult {
  action: "created" | "updated";
  id: string;
  email: string;
  /** Other admin e-mails already in the table (v1 expects exactly one admin). */
  otherAdmins: string[];
}

/** Returns a list of problems with the password (empty = fine). */
export function checkPassword(password: string, email: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.trim() !== password) problems.push("must not start or end with a space");
  const lower = password.toLowerCase();
  if (lower.includes(email.split("@")[0] ?? "\u0000")) problems.push("must not contain the e-mail name");
  if (/^(.)\1+$/.test(password)) problems.push("must not be one repeated character");
  if (/password|change-?me|riyadtech|123456|qwerty/i.test(password)) problems.push("is too easy to guess");
  return problems;
}

/**
 * Create the admin, or set a new password for it.
 * Setting a password bumps session_version, which logs out every existing session.
 */
export async function seedAdmin(db: Db, rawEmail: string, password: string, cost = BCRYPT_COST): Promise<SeedResult> {
  const email = normalizeEmail(rawEmail);
  const passwordHash = await hashPassword(password, cost);

  return db.$transaction(async (tx) => {
    const existing = await tx.adminUser.findUnique({ where: { email }, select: { id: true } });
    const row = existing
      ? await tx.adminUser.update({
          where: { id: existing.id },
          data: { passwordHash, sessionVersion: { increment: 1 } },
          select: { id: true, email: true },
        })
      : await tx.adminUser.create({ data: { email, passwordHash }, select: { id: true, email: true } });

    const action = existing ? "updated" : "created";
    await tx.auditLog.create({
      data: {
        actor: "cli",
        action: existing ? "admin.password_set" : "admin.create",
        entity: "admin_user",
        entityId: row.id,
        details: { email },
      },
    });
    const others = await tx.adminUser.findMany({ where: { email: { not: email } }, select: { email: true } });
    return { action, id: row.id, email: row.email, otherAdmins: others.map((o) => o.email) };
  });
}
