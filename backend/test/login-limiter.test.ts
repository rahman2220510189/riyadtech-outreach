import { describe, expect, it } from "vitest";
import { LoginLimiter } from "../src/auth/login-limiter.js";

describe("LoginLimiter", () => {
  it("blocks after maxFailures within the window and frees after it", () => {
    let t = 1_000;
    const l = new LoginLimiter({ maxFailures: 2, windowMs: 100, now: () => t });
    expect(l.retryAfterMs("a")).toBe(0);
    l.recordFailure("a");
    expect(l.retryAfterMs("a")).toBe(0);
    l.recordFailure("a");
    expect(l.retryAfterMs("a")).toBe(100);
    t += 60;
    expect(l.retryAfterMs("a")).toBe(40);
    t += 40;
    expect(l.retryAfterMs("a")).toBe(0);
  });

  it("reset clears a key; other keys are independent", () => {
    const l = new LoginLimiter({ maxFailures: 1, windowMs: 100, now: () => 0 });
    l.recordFailure("a");
    expect(l.retryAfterMs("a")).toBeGreaterThan(0);
    expect(l.retryAfterMs("b")).toBe(0);
    l.reset("a");
    expect(l.retryAfterMs("a")).toBe(0);
  });

  it("never holds more than maxKeys entries", () => {
    const l = new LoginLimiter({ maxFailures: 5, windowMs: 1_000, maxKeys: 10, now: () => 0 });
    for (let i = 0; i < 100; i++) l.recordFailure(`k${i}`);
    expect((l as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(10);
  });
});
