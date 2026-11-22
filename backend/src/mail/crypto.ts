import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { keyBytes } from "../config/env.js";
import { AppError } from "../lib/errors.js";

/**
 * Secrets at rest (mailbox passwords): AES-256-GCM with a key derived from ENCRYPTION_KEY.
 * Stored as "v1:<iv>:<tag>:<ciphertext>" (base64url). Unsubscribe tokens: HMAC-SHA256 with a
 * second derived key, so the two uses never share a key.
 */

function derive(master: string | undefined, purpose: "mailbox-passwords" | "unsubscribe"): Buffer {
  const raw = master ? keyBytes(master) : null;
  if (!raw) {
    throw new AppError(
      500,
      "ENCRYPTION_KEY_MISSING",
      "ENCRYPTION_KEY is not set in backend/.env (or on the hosting Environment page). See .env.example for how to create one.",
    );
  }
  return Buffer.from(hkdfSync("sha256", raw, Buffer.alloc(0), `riyadtech-outreach:${purpose}`, 32));
}

export function encryptSecret(master: string | undefined, plain: string): string {
  const key = derive(master, "mailbox-passwords");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

export function decryptSecret(master: string | undefined, stored: string): string {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new AppError(500, "SECRET_UNREADABLE", "A stored password has an unknown format");
  const key = derive(master, "mailbox-passwords");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError(
      500,
      "SECRET_UNREADABLE",
      "A stored mailbox password cannot be read: ENCRYPTION_KEY has changed since it was saved. Enter the password again.",
    );
  }
}

/** Unsubscribe token for an address: "<address, base64url>.<signature>". Works without login, cannot be forged. */
export function unsubscribeToken(master: string | undefined, email: string): string {
  const e = email.trim().toLowerCase();
  const sig = createHmac("sha256", derive(master, "unsubscribe")).update(e).digest().subarray(0, 18);
  return `${Buffer.from(e, "utf8").toString("base64url")}.${sig.toString("base64url")}`;
}

/** The address of a valid token, or null. */
export function readUnsubscribeToken(master: string | undefined, token: string): string | null {
  const [a, s] = token.split(".");
  if (!a || !s || a.length > 400) return null;
  const email = Buffer.from(a, "base64url").toString("utf8");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return null;
  const expected = Buffer.from(unsubscribeToken(master, email).split(".")[1]!, "base64url");
  const got = Buffer.from(s, "base64url");
  return got.length === expected.length && timingSafeEqual(got, expected) ? email : null;
}
