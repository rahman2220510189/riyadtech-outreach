import { describe, expect, it } from "vitest";
import { describePgUrl, normalizePgUrl } from "../src/db/url.js";

const NEON_POOLED =
  "postgresql://neondb_owner:s3cret@ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("normalizePgUrl", () => {
  it("turns sslmode=require into verify-full and keeps other params", () => {
    expect(normalizePgUrl(NEON_POOLED)).toBe(NEON_POOLED.replace("sslmode=require", "sslmode=verify-full"));
  });
  it("leaves disable and verify-full alone", () => {
    expect(normalizePgUrl("postgresql://u@h/db?sslmode=disable")).toBe("postgresql://u@h/db?sslmode=disable");
    expect(normalizePgUrl("postgresql://u@h/db?sslmode=verify-full")).toBe("postgresql://u@h/db?sslmode=verify-full");
  });
});

describe("describePgUrl", () => {
  it("reports host, db, user and pooling without the password", () => {
    const info = describePgUrl(NEON_POOLED);
    expect(info).toEqual({
      host: "ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech",
      database: "neondb",
      user: "neondb_owner",
      pooled: true,
      ssl: true,
    });
    expect(JSON.stringify(info)).not.toContain("s3cret");
  });
  it("detects a direct endpoint", () => {
    expect(describePgUrl(NEON_POOLED.replace("-pooler", "")).pooled).toBe(false);
  });
});
