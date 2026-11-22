/**
 * Helpers for PostgreSQL connection strings. Nothing here ever returns a password.
 */

/**
 * pg treats sslmode=prefer|require|verify-ca as verify-full and prints a warning.
 * Neon has valid certificates, so we ask for verify-full explicitly (same behaviour, no warning).
 */
export function normalizePgUrl(url: string): string {
  return url.replace(/([?&])sslmode=(prefer|require|verify-ca)(?=&|$)/, "$1sslmode=verify-full");
}

export interface PgUrlInfo {
  host: string;
  database: string;
  user: string;
  /** Neon pooled endpoints contain "-pooler" in the host name. */
  pooled: boolean;
  ssl: boolean;
}

/** Safe-to-log facts about a connection string (no password). */
export function describePgUrl(url: string): PgUrlInfo {
  const u = new URL(url);
  return {
    host: u.hostname,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    user: decodeURIComponent(u.username),
    pooled: u.hostname.includes("-pooler"),
    ssl: u.searchParams.has("sslmode") && u.searchParams.get("sslmode") !== "disable",
  };
}
