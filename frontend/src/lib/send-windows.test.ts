import { describe, expect, it } from "vitest";
import { MARKETS, computeWindows, formatDuration, isOpenAt, localParts } from "./send-windows";

const DHAKA = "Asia/Dhaka";
const market = (id: string) => MARKETS.find((m) => m.id === id)!;

describe("localParts", () => {
  it("reads time and weekday in a time zone", () => {
    // 2026-10-14 is a Wednesday. 08:00 UTC = 09:00 BST in London, 14:00 in Dhaka.
    const t = new Date("2026-10-14T08:00:00Z");
    expect(localParts(t, "Europe/London")).toMatchObject({ weekday: 3, hhmm: "09:00" });
    expect(localParts(t, DHAKA)).toMatchObject({ weekday: 3, hhmm: "14:00" });
  });
});

describe("isOpenAt", () => {
  it("is open on weekdays 09:00 to 17:00 local, end exclusive", () => {
    expect(isOpenAt(new Date("2026-10-14T08:00:00Z"), "Europe/London")).toBe(true); // 09:00 BST
    expect(isOpenAt(new Date("2026-10-14T07:59:00Z"), "Europe/London")).toBe(false); // 08:59
    expect(isOpenAt(new Date("2026-10-14T16:00:00Z"), "Europe/London")).toBe(false); // 17:00
  });
  it("is closed at the weekend", () => {
    expect(isOpenAt(new Date("2026-10-17T10:00:00Z"), "Europe/London")).toBe(false); // Saturday
  });
});

describe("computeWindows", () => {
  it("UK window falls on 14:00-22:00 Dhaka time during British Summer Time", () => {
    const w = computeWindows(new Date("2026-10-14T05:00:00Z"), DHAKA); // 11:00 Dhaka
    const uk = w.markets.find((m) => m.market.id === "uk-ie")!;
    expect(uk.segments).toEqual([[14 * 60, 22 * 60]]);
    expect(uk.open).toBe(false);
    expect(uk.summary).toBe("Opens in 3 h");
    expect(w.viewerTime).toBe("11:00");
  });

  it("moves one hour later after the clocks change (GMT)", () => {
    const w = computeWindows(new Date("2026-11-04T05:00:00Z"), DHAKA, [market("uk-ie")]);
    expect(w.markets[0]?.segments).toEqual([[15 * 60, 23 * 60]]);
  });

  it("US East window wraps past the viewer's midnight into two stretches", () => {
    // NY 09:00-17:00 EDT = 13:00-21:00 UTC = 19:00-03:00 Dhaka: Tuesday's window ends at 03:00 Wednesday.
    const w = computeWindows(new Date("2026-10-14T05:00:00Z"), DHAKA, [market("us-east")]);
    expect(w.markets[0]?.segments).toEqual([
      [0, 3 * 60],
      [19 * 60, 24 * 60],
    ]);
  });

  it("says how long an open window stays open", () => {
    const w = computeWindows(new Date("2026-10-14T13:45:00Z"), DHAKA, [market("uk-ie")]); // 14:45 BST
    expect(w.markets[0]).toMatchObject({ open: true, summary: "Open for 2 h 15 min more", localTime: "14:45" });
  });

  it("on Friday evening the next opening is Monday", () => {
    const w = computeWindows(new Date("2026-10-16T18:00:00Z"), DHAKA, [market("uk-ie")]); // Fri 19:00 BST
    expect(w.markets[0]?.open).toBe(false);
    expect(w.markets[0]?.summary).toBe("Opens Mon 09:00, in 2 days 14 h");
  });

  it("has no open stretch on the viewer's Sunday for the UK", () => {
    const w = computeWindows(new Date("2026-10-18T06:00:00Z"), DHAKA, [market("uk-ie")]); // Sunday
    expect(w.markets[0]?.segments).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("formats minutes, hours and days", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(135)).toBe("2 h 15 min");
    expect(formatDuration(1500)).toBe("1 day 1 h");
    expect(formatDuration(2880)).toBe("2 days");
  });
});
