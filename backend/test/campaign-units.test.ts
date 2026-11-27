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

describe("company names in e-mails", async () => {
  const { shortCompany, placeRecipient } = await import("../src/mail/compose.js");
  it("drop legal forms and the lead's own city at the end", () => {
    expect(shortCompany("BCN Group Ltd. Manchester", "Manchester")).toBe("BCN Group");
    expect(shortCompany("Pixel Studio Limited", "Leeds")).toBe("Pixel Studio");
    expect(shortCompany("Harbour Web (Bristol)", "Bristol")).toBe("Harbour Web");
    expect(shortCompany("Copper Fox Creative LLC", null)).toBe("Copper Fox Creative");
    expect(shortCompany("Manchester Digital", "Manchester")).toBe("Manchester Digital"); // the city at the start stays
    expect(shortCompany("Ltd", null)).toBe("Ltd");
  });
  it("also in an opening line saved earlier", () => {
    const r = placeRecipient({ id: 1n, name: "BCN Group Ltd. Manchester", firstName: null, websiteDomain: "bcn.co.uk", city: "Manchester", country: "GB", signalLine: "I saw BCN Group Ltd. Manchester is hiring a software engineer.", primaryEmail: "info@bcn.co.uk", suppressed: false, signals: [] });
    expect(r.vars.company).toBe("BCN Group");
    expect(r.vars.signal_line).toBe("I saw BCN Group is hiring a software engineer.");
  });
});

describe("HTML version of an outreach e-mail", async () => {
  const { htmlVersion } = await import("../src/mail/compose.js");
  it("keeps the text, escapes it, and links the word unsubscribe", () => {
    const h = htmlVersion("Hi there,\n\nWe build <apps> & APIs.\nLine two", { lines: ["Riyad · Riyad Tech", "House 12, Dhaka"], unsubscribeUrl: "https://x.test/u/abc?d=1&e=2" });
    expect(h).toContain("<p>Hi there,</p>");
    expect(h).toContain("We build &lt;apps&gt; &amp; APIs.<br>\nLine two");
    expect(h).toContain('or <a href="https://x.test/u/abc?d=1&amp;e=2">unsubscribe</a>.');
    expect(h).not.toMatch(/<img|<script|<button/);
  });
});
