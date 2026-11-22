import bcrypt from "bcryptjs";

/** bcrypt cost. 12 is about 0.3-1 s in pure JS: slow for attackers, fine for one admin. */
export const BCRYPT_COST = 12;

export const PASSWORD_MIN_LENGTH = 12;

export function hashPassword(plain: string, cost = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(plain, cost);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * A real bcrypt hash of a random value, used when the e-mail is unknown so the
 * response takes as long as for a wrong password (no user enumeration by timing).
 */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(cost = BCRYPT_COST): Promise<string> {
  dummyHash ??= bcrypt.hash(`dummy-${Math.random()}-${Date.now()}`, cost);
  return dummyHash;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
