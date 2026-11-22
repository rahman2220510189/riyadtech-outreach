import { parseEnv, type Env } from "../../src/config/env.js";

/** A valid env for unit tests. The database URL is never connected to. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pw@localhost:5432/unit_test_never_used",
    JWT_SECRET: "unit-test-jwt-key-0123456789abcdefghijklmnop",
    ENCRYPTION_KEY: "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
    ...overrides,
  });
}
