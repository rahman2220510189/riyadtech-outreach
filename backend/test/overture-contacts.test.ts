import { describe, expect, it } from "vitest";
import { cleanSocials, firstValidPhone, normalizePhone } from "../src/finder/contacts.js";
import { choosePrimary, classifyOvertureEmails, OVERTURE_SOURCE, type StoredEmail } from "../src/leads/overture-emails.js";

describe("phones from Overture", () => {
  it("become E.164 for the place's country", () => {
    expect(normalizePhone("020 7946 0018", "GB")).toBe("+442079460018");
    expect(normalizePhone("+44 20 7946 0018", "GB")).toBe("+442079460018");
    expect(normalizePhone("(512) 555-0199", "US")).toMatch(/^\+1512/);
    expect(normalizePhone("02 9374 4000", "AU")).toBe("+61293744000");
  });

  it("drops numbers that are not valid there", () => {
    expect(normalizePhone("12345", "GB")).toBeNull();
    expect(normalizePhone("not a number", "US")).toBeNull();
    expect(normalizePhone("", "IE")).toBeNull();
    expect(normalizePhone(null, "IE")).toBeNull();
    expect(firstValidPhone(["123", null, "020 7946 0018"], "GB")).toBe("+442079460018");
    expect(firstValidPhone([], "GB")).toBeNull();
  });
});

describe("social links from Overture", () => {
  it("are https, without tracking parameters, unique, at most 5", () => {
    expect(cleanSocials(["http://www.facebook.com/brightsmile/?utm_source=x", "https://www.facebook.com/brightsmile", "instagram.com/bright", null, "javascript:alert(1)"])).toEqual([
      "https://www.facebook.com/brightsmile",
      "https://instagram.com/bright",
    ]);
    expect(cleanSocials(Array.from({ length: 8 }, (_, i) => `https://x.com/u${i}`))).toHaveLength(5);
  });
});

describe("Overture e-mail addresses", () => {
  it("go through the same cleaning and classification as crawled ones", () => {
    const out = classifyOvertureEmails(
      ["Hello@SmileDental.co.uk", "privacy@smiledental.co.uk", "noreply@smiledental.co.uk", "sarah.jones@gmail.com", "not-an-address", "hello@smiledental.co.uk"],
      "smiledental.co.uk",
      () => "ov-1",
    );
    expect(out.map((e) => [e.email, e.kind, e.domainMatch])).toEqual([
      ["hello@smiledental.co.uk", "generic", "own"],
      ["privacy@smiledental.co.uk", "role", "own"],
      ["sarah.jones@gmail.com", "named", "free"],
    ]);
    expect(out[0]).toMatchObject({ sourceId: "ov-1", sourceUrl: `${OVERTURE_SOURCE}ov-1` });
    expect(out[2]!.firstName).toBe("Sarah");
  });

  const row = (email: string, kind: StoredEmail["kind"], over: Partial<StoredEmail> = {}): StoredEmail => ({
    email,
    domain: email.split("@")[1]!,
    kind,
    domainMatch: "own",
    firstName: null,
    context: "",
    sourceUrl: "x",
    mxValid: true,
    onSite: false,
    origin: "overture",
    ...over,
  });
  const open = { genericOnly: false, publishedOnly: false };

  it("an Overture address makes a lead usable; privacy@ and no-MX addresses never", () => {
    expect(choosePrimary([row("privacy@a.com", "role"), row("info@a.com", "generic")], "B", open)?.email).toBe("info@a.com");
    expect(choosePrimary([row("privacy@a.com", "role")], "B", open)).toBeNull();
    expect(choosePrimary([row("info@a.com", "generic", { mxValid: false })], "B", open)).toBeNull();
  });

  it("generic-only countries skip personal addresses; Australia waits for the website", () => {
    expect(choosePrimary([row("sarah@a.com", "named")], "A", { genericOnly: true, publishedOnly: false })).toBeNull();
    expect(choosePrimary([row("sarah@a.com", "named")], "A", open)?.email).toBe("sarah@a.com");
    expect(choosePrimary([row("info@a.com", "generic")], "B", { genericOnly: false, publishedOnly: true })).toBeNull();
    expect(choosePrimary([row("info@a.com", "generic", { onSite: true, origin: "crawl" })], "B", { genericOnly: false, publishedOnly: true })?.email).toBe("info@a.com");
  });

  it("department addresses like accessibility@ or investors@ are never used", () => {
    const out = classifyOvertureEmails(["accessibility@wyndham.com", "investors@brand.com", "franchise@brand.com", "ir@brand.com"], "wyndhamhotels.com", () => "ov-2");
    expect(out.map((e) => e.kind)).toEqual(["role", "role", "role", "role"]);
  });

  it("an Overture-only address on a third domain (a parent brand) is not used; free mail is", () => {
    expect(choosePrimary([row("info@wyndham.com", "generic", { domainMatch: "other" })], "B", open)).toBeNull();
    expect(choosePrimary([row("smiledental@gmail.com", "generic", { domainMatch: "free" })], "B", open)?.email).toBe("smiledental@gmail.com");
    // On the website, a third-domain address is still allowed (the business publishes it itself).
    expect(choosePrimary([row("info@wyndham.com", "generic", { domainMatch: "other", onSite: true, origin: "crawl" })], "B", open)?.email).toBe("info@wyndham.com");
  });

  it("an address seen on the website wins over an Overture-only one", () => {
    const rows = [row("hello@a.com", "generic"), row("office@a.com", "generic", { onSite: true, origin: "crawl" })];
    expect(choosePrimary(rows, "B", open)?.email).toBe("office@a.com");
  });
});

describe("crawled today", () => {
  it("starts at midnight in Dhaka", async () => {
    const { startOfToday } = await import("../src/routes/leads.js");
    // 20:30 UTC on 27 Nov = 02:30 on 28 Nov in Dhaka (UTC+6) -> midnight Dhaka = 18:00 UTC on 27 Nov.
    expect(startOfToday(new Date("2026-11-27T20:30:00Z")).toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(startOfToday(new Date("2026-11-27T10:15:30.500Z")).toISOString()).toBe("2026-11-26T18:00:00.000Z");
  });
});
