import { describe, expect, it } from "vitest";
import { gapAfter, inWindow, localClock } from "../src/campaigns/engine.js";
import { defaultSettings } from "../src/settings/definitions.js";

const s = defaultSettings().sending;

describe("campaign clock", () => {
  it("reads the recipient's local weekday and time", () => {
    // Monday 30 Nov 2026, 14:30 UTC = 08:30 in Chicago, 14:30 in London, 01:30 Tuesday in Sydney.
    const t = new Date("2026-11-30T14:30:00Z");
    expect(localClock(t, "America/Chicago")).toEqual({ weekday: 1, minutes: 8 * 60 + 30 });
    expect(localClock(t, "Europe/London")).toEqual({ weekday: 1, minutes: 14 * 60 + 30 });
    expect(localClock(t, "Australia/Sydney")).toEqual({ weekday: 2, minutes: 60 + 30 });
    expect(localClock(t, "Not/AZone")).toEqual({ weekday: 1, minutes: 14 * 60 + 30 }); // unknown zone: UTC
  });

  it("sends only on weekdays, 09:00-17:00 in the recipient's time zone", () => {
    const t = new Date("2026-11-30T14:30:00Z");
    expect(inWindow(t, "Europe/London", s)).toBe(true);
    expect(inWindow(t, "America/Chicago", s)).toBe(false); // 08:30
    expect(inWindow(t, "Australia/Sydney", s)).toBe(false); // 01:30
    expect(inWindow(new Date("2026-11-28T12:00:00Z"), "Europe/London", s)).toBe(false); // Saturday
    expect(inWindow(new Date("2026-11-30T17:00:00Z"), "Europe/London", s)).toBe(false); // 17:00 is closed
  });

  it("waits a random 2-6 minutes after each e-mail, the same for every worker", () => {
    const gaps = Array.from({ length: 50 }, (_, i) => gapAfter(BigInt(i + 1), s));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2 * 60_000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6 * 60_000);
    expect(new Set(gaps).size).toBeGreaterThan(10);
    expect(gapAfter(7n, s)).toBe(gapAfter(7n, s));
  });
});
