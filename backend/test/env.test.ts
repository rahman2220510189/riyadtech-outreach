import { describe, expect, it } from "vitest";
import { EnvError, parseEnv, resolveListenHost } from "../src/config/env.js";

const DB = "postgresql://u:p@localhost:5432/db";
const JWT = "k".repeat(40);
const NEON = "postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";

describe("parseEnv", () => {
  it("applies safe defaults for local development", () => {
    const env = parseEnv({ NODE_ENV: "development", DATABASE_URL: DB, JWT_SECRET: JWT });
    expect(env.PORT).toBe(4000);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.CORS_ORIGIN).toEqual(["http://localhost:3000"]);
    expect(env.listenHost).toBe("127.0.0.1");
  });

  it("splits and trims a comma-separated CORS_ORIGIN and drops trailing slashes", () => {
    const env = parseEnv({ DATABASE_URL: DB, JWT_SECRET: JWT, CORS_ORIGIN: " https://a.example.com/ , https://b.example.com " });
    expect(env.CORS_ORIGIN).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("parses TRUST_PROXY and PORT from strings", () => {
    const env = parseEnv({ DATABASE_URL: DB, JWT_SECRET: JWT, TRUST_PROXY: "true", PORT: "10000" });
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.PORT).toBe(10000);
  });

  it("rejects an invalid PORT without echoing values", () => {
    expect(() => parseEnv({ DATABASE_URL: DB, JWT_SECRET: JWT, PORT: "abc" })).toThrow(EnvError);
  });

  it("rejects localhost CORS_ORIGIN in production", () => {
    expect(() => parseEnv({ NODE_ENV: "production", DATABASE_URL: NEON, JWT_SECRET: JWT })).toThrow(/CORS_ORIGIN/);
  });

  it("accepts a real production config", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: NEON, JWT_SECRET: JWT,
      CORS_ORIGIN: "https://outreach.example.com",
      PUBLIC_BASE_URL: "https://outreach.example.com",
      ENCRYPTION_KEY: "ab".repeat(32),
    });
    expect(env.listenHost).toBe("0.0.0.0");
    expect(env.SENDING_ENABLED).toBe(false);
  });

  it("ENCRYPTION_KEY: 32 bytes as hex or base64, required in production, never echoed", () => {
    const base = { DATABASE_URL: DB, JWT_SECRET: JWT };
    expect(parseEnv({ ...base, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }).ENCRYPTION_KEY).toBeTruthy();
    expect(parseEnv({ ...base, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url") }).ENCRYPTION_KEY).toBeTruthy();
    let message = "";
    try {
      parseEnv({ ...base, ENCRYPTION_KEY: "too-short-secret" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ENCRYPTION_KEY: must be 32 random bytes/);
    expect(message).not.toContain("too-short-secret");
    expect(() =>
      parseEnv({ NODE_ENV: "production", DATABASE_URL: NEON, JWT_SECRET: JWT, CORS_ORIGIN: "https://o.example.com", PUBLIC_BASE_URL: "https://o.example.com" }),
    ).toThrow(/ENCRYPTION_KEY: is required in production/);
    expect(parseEnv({ ...base, SENDING_ENABLED: "true" }).SENDING_ENABLED).toBe(true);
  });
});

describe("database env", () => {
  it("requires DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL and never echoes the value", () => {
    try {
      parseEnv({ DATABASE_URL: "mysql://secretuser:secretpass@host/db", JWT_SECRET: JWT });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as Error).message).toMatch(/DATABASE_URL/);
      expect((err as Error).message).not.toContain("secretpass");
    }
  });

  it("requires sslmode in production", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "production",
        CORS_ORIGIN: "https://x.example.com",
        DATABASE_URL: "postgresql://u:p@ep-x-pooler.neon.tech/db",
        JWT_SECRET: JWT,
      }),
    ).toThrow(/SSL/);
  });

  it("defaults DB_POOL_MAX to 5 and keeps DIRECT_URL optional", () => {
    const env = parseEnv({ DATABASE_URL: DB, JWT_SECRET: JWT });
    expect(env.DB_POOL_MAX).toBe(5);
    expect(env.DIRECT_URL).toBeUndefined();
  });
});

describe("JWT_SECRET", () => {
  it("is required and must be at least 32 characters", () => {
    expect(() => parseEnv({ DATABASE_URL: DB })).toThrow(/JWT_SECRET/);
    expect(() => parseEnv({ DATABASE_URL: DB, JWT_SECRET: "short" })).toThrow(/32 characters/);
  });

  it("rejects an obvious placeholder in production", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "production",
        CORS_ORIGIN: "https://x.example.com",
        DATABASE_URL: NEON,
        JWT_SECRET: "change-me-change-me-change-me-change-me",
      }),
    ).toThrow(/placeholder/);
  });

  it("defaults SESSION_DAYS to 7", () => {
    expect(parseEnv({ DATABASE_URL: DB, JWT_SECRET: JWT }).SESSION_DAYS).toBe(7);
  });
});

describe("resolveListenHost", () => {
  it("forces 0.0.0.0 on Render even if HOST is set", () => {
    expect(resolveListenHost({ RENDER: "true", HOST: "127.0.0.1", NODE_ENV: "production" })).toBe("0.0.0.0");
  });
  it("never defaults a production server to 127.0.0.1", () => {
    expect(resolveListenHost({ NODE_ENV: "production" })).toBe("0.0.0.0");
  });
  it("uses HOST when set locally", () => {
    expect(resolveListenHost({ HOST: "0.0.0.0", NODE_ENV: "development" })).toBe("0.0.0.0");
  });
  it("defaults local development to 127.0.0.1", () => {
    expect(resolveListenHost({ NODE_ENV: "development" })).toBe("127.0.0.1");
  });
});
