import { describe, expect, it, vi } from "vitest";
import { awakeWindow, insideWindow, keepAwakeUrl, startKeepAwake } from "../src/keepawake.js";

const DAY = new Date("2026-11-23T06:00:00Z"); // 12:00 in Dhaka
const NIGHT = new Date("2026-11-23T18:00:00Z"); // 00:00 in Dhaka

describe("keep-awake", () => {
  it("uses Render's public address, an override, or nothing", () => {
    expect(keepAwakeUrl({ RENDER_EXTERNAL_URL: "https://outreach-api.onrender.com" })).toBe("https://outreach-api.onrender.com/health");
    expect(keepAwakeUrl({ RENDER_EXTERNAL_URL: "https://a.onrender.com", KEEP_AWAKE_URL: "https://b.example/" })).toBe("https://b.example/health");
    expect(keepAwakeUrl({ RENDER_EXTERNAL_URL: "https://a.onrender.com", KEEP_AWAKE: "false" })).toBeNull();
    expect(keepAwakeUrl({})).toBeNull();
    expect(keepAwakeUrl({ KEEP_AWAKE_URL: "not a url" })).toBeNull();
  });

  it("the daily window: 09:00–20:00 Dhaka by default, settable, wrong values fall back", () => {
    const w = awakeWindow({});
    expect(w).toEqual({ from: 9, to: 20, timeZone: "Asia/Dhaka" });
    expect(insideWindow(w, DAY)).toBe(true);
    expect(insideWindow(w, NIGHT)).toBe(false);
    expect(insideWindow(w, new Date("2026-11-23T02:59:00Z"))).toBe(false); // 08:59
    expect(insideWindow(w, new Date("2026-11-23T03:00:00Z"))).toBe(true); // 09:00
    expect(insideWindow(w, new Date("2026-11-23T14:00:00Z"))).toBe(false); // 20:00
    expect(insideWindow(awakeWindow({ KEEP_AWAKE_HOURS: "22-6" }), NIGHT)).toBe(true);
    expect(insideWindow(awakeWindow({ KEEP_AWAKE_HOURS: "0-24" }), NIGHT)).toBe(true);
    expect(awakeWindow({ KEEP_AWAKE_HOURS: "25-3", KEEP_AWAKE_TZ: "Mars/Base" })).toEqual({ from: 9, to: 20, timeZone: "Asia/Dhaka" });
  });

  it("requests /health on a timer inside the window and logs a failure once per streak", async () => {
    vi.useFakeTimers();
    const answers = [500, 500, 200];
    const fetchFn = vi.fn(() => Promise.resolve(new Response("", { status: answers.shift() ?? 200 })));
    const lines: string[] = [];
    const k = startKeepAwake({ RENDER_EXTERNAL_URL: "https://x.onrender.com" }, (l) => lines.push(l), { fetch: fetchFn as unknown as typeof fetch, everyMs: 1000, now: () => DAY });
    expect(k?.url).toBe("https://x.onrender.com/health");
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(lines.filter((l) => l.includes("did not answer"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("answers again"))).toBe(true);
    k?.stop();
    vi.useRealTimers();
  });

  it("stays quiet at night so Render and the database can sleep", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => Promise.resolve(new Response("")));
    const lines: string[] = [];
    const k = startKeepAwake({ RENDER_EXTERNAL_URL: "https://x.onrender.com" }, (l) => lines.push(l), { fetch: fetchFn as unknown as typeof fetch, everyMs: 1000, now: () => NIGHT });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(lines.filter((l) => l.includes("letting the service sleep"))).toHaveLength(1);
    k?.stop();
    vi.useRealTimers();
  });

  it("does nothing locally", () => {
    expect(startKeepAwake({}, () => undefined)).toBeNull();
  });
});
