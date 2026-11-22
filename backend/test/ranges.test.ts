import { describe, expect, it } from "vitest";
import { Semaphore, coalesceRanges, segmentBuffer } from "../src/finder/overture/ranges.js";

describe("coalesceRanges", () => {
  it("merges ranges with small gaps and keeps far ones apart", () => {
    expect(
      coalesceRanges(
        [
          { start: 300, end: 400 },
          { start: 0, end: 100 },
          { start: 150, end: 250 },
          { start: 10_000, end: 10_100 },
        ],
        60,
      ),
    ).toEqual([
      { start: 0, end: 400 },
      { start: 10_000, end: 10_100 },
    ]);
  });
  it("handles overlaps", () => {
    expect(coalesceRanges([{ start: 0, end: 100 }, { start: 50, end: 80 }], 0)).toEqual([{ start: 0, end: 100 }]);
  });
});

describe("segmentBuffer", () => {
  it("answers from segments and falls back for the rest", async () => {
    const asked: [number, number | undefined][] = [];
    const inner = {
      byteLength: 1000,
      slice: (s: number, e?: number) => {
        asked.push([s, e]);
        return new Uint8Array((e ?? 1000) - s).fill(9).buffer;
      },
    };
    const seg = new Uint8Array(100).map((_, i) => i);
    const buf = segmentBuffer(inner, [{ start: 200, data: seg }]);
    expect([...new Uint8Array(await buf.slice(210, 215))]).toEqual([10, 11, 12, 13, 14]);
    expect(asked).toEqual([]);
    expect([...new Uint8Array(await buf.slice(290, 310))].every((b) => b === 9)).toBe(true); // crosses the end
    expect(asked).toEqual([[290, 310]]);
  });
});

describe("Semaphore", () => {
  it("never runs more than max at once", async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
  });
});
