import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Integration tests use ONLY TEST_DATABASE_URL (environment or backend/.env),
 * never DATABASE_URL, so they cannot hit the wrong database by accident.
 */
export function testDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!existsSync(".env")) return undefined;
  return parseEnv(readFileSync(".env", "utf8")).TEST_DATABASE_URL || undefined;
}
