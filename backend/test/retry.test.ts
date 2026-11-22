import { describe, expect, it, vi } from "vitest";
import { isRetryableTxError, withTxRetry } from "../src/db/retry.js";

const noSleep = () => Promise.resolve();
const pgError = (code: string) => Object.assign(new Error("db error"), { code });

describe("isRetryableTxError", () => {
  it("detects deadlock and serialization failures", () => {
    expect(isRetryableTxError(pgError("40P01"))).toBe(true);
    expect(isRetryableTxError(pgError("40001"))).toBe(true);
    expect(isRetryableTxError(pgError("P2034"))).toBe(true);
  });

  it("finds codes nested in Prisma driver-adapter errors and causes", () => {
    const prismaLike = Object.assign(new Error("x"), {
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40P01", kind: "postgres" } } },
    });
    expect(isRetryableTxError(prismaLike)).toBe(true);
    expect(isRetryableTxError(new Error("outer", { cause: pgError("40001") }))).toBe(true);
    expect(isRetryableTxError(new Error("ERROR: deadlock detected"))).toBe(true);
  });

  it("does not retry other errors", () => {
    expect(isRetryableTxError(pgError("23505"))).toBe(false);
    expect(isRetryableTxError(new Error("boom"))).toBe(false);
    expect(isRetryableTxError(null)).toBe(false);
  });
});

describe("withTxRetry", () => {
  it("retries a deadlock and then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(pgError("40P01")).mockResolvedValueOnce("done");
    const onRetry = vi.fn();
    await expect(withTxRetry(fn, { sleep: noSleep, onRetry })).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("gives up after 4 retries (5 attempts)", async () => {
    const fn = vi.fn().mockRejectedValue(pgError("40001"));
    await expect(withTxRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ code: "40001" });
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(pgError("23505"));
    await expect(withTxRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ code: "23505" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits a random pause within the bounds", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(pgError("40P01")).mockRejectedValueOnce(pgError("40P01")).mockResolvedValue(1);
    await withTxRetry(fn, { minDelayMs: 30, maxDelayMs: 60, sleep: (ms) => (sleeps.push(ms), Promise.resolve()) });
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(30);
      expect(ms).toBeLessThanOrEqual(60);
    }
  });
});
