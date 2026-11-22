import { describe, expect, it } from "vitest";
import { defaultSettings } from "../src/settings/definitions.js";
import { changedKeys, resolveSettings } from "../src/settings/loader.js";

describe("settings", () => {
  it("defaults match the prompt", () => {
    const s = defaultSettings();
    expect(s.sending).toMatchObject({
      globalDailyCap: 100,
      mailboxDailyCap: 50,
      warmupStart: 10,
      warmupStepPerDay: 2,
      windowStart: "09:00",
      windowEnd: "17:00",
      minGapMinutes: 2,
      maxGapMinutes: 6,
      followUp1Days: 4,
      followUp2Days: 7,
      recontactDays: 90,
    });
    expect(s.crawler).toMatchObject({ maxPagesPerDomain: 8, concurrency: 5, minDelayMs: 1500, maxBytes: 5_000_000 });
    expect(s.storage.limitMb).toBe(900);
    expect(s.finder.minConfidence).toBe(0.6);
    expect(s.company.postalAddress).toBe("");
  });

  it("merges a partial stored row over the defaults", () => {
    const { settings, problems } = resolveSettings([{ key: "sending", value: { globalDailyCap: 20 } }]);
    expect(problems).toEqual([]);
    expect(settings.sending.globalDailyCap).toBe(20);
    expect(settings.sending.mailboxDailyCap).toBe(50);
  });

  it("falls back to defaults for an invalid row and reports it", () => {
    const { settings, problems } = resolveSettings([
      { key: "sending", value: { globalDailyCap: -5, windowStart: "9am" } },
      { key: "crawler", value: { minDelayMs: 200 } }, // below the polite minimum
    ]);
    expect(settings.sending.globalDailyCap).toBe(100);
    expect(settings.crawler.minDelayMs).toBe(1500);
    expect(problems.map((p) => p.key)).toEqual(["sending", "crawler"]);
    expect(problems[0]?.issues.join()).toMatch(/windowStart/);
  });

  it("ignores unknown keys", () => {
    const { unknownKeys } = resolveSettings([{ key: "future.thing", value: 1 }]);
    expect(unknownKeys).toEqual(["future.thing"]);
  });

  it("changedKeys lists only keys whose value changed", () => {
    const a = defaultSettings();
    const b = resolveSettings([{ key: "storage", value: { limitMb: 500 } }]).settings;
    expect(changedKeys(a, b)).toEqual(["storage"]);
    expect(changedKeys(a, defaultSettings())).toEqual([]);
  });
});
