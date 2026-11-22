import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_STALE_MS, workerStatus } from "../src/worker/heartbeat.js";
import { Ticker, Worker } from "../src/worker/runner.js";
import type { HeartbeatInput, WorkerStore } from "../src/worker/store.js";
import type { SettingRow } from "../src/settings/loader.js";

const log = pino({ level: "silent" });

class MemoryWorkerStore implements WorkerStore {
  beats: HeartbeatInput[] = [];
  rows: SettingRow[] = [];
  failBeats = 0;
  writeHeartbeat(input: HeartbeatInput) {
    if (this.failBeats > 0) {
      this.failBeats--;
      return Promise.reject(new Error("database asleep"));
    }
    this.beats.push(input);
    return Promise.resolve();
  }
  readHeartbeat() {
    return Promise.resolve(null);
  }
  readSettingRows() {
    return Promise.resolve(this.rows);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("workerStatus", () => {
  const base = { id: "worker", pid: 1, version: "0.4.0", startedAt: new Date(0), info: null };
  it("never / ok / stale", () => {
    const now = new Date(1_000_000);
    expect(workerStatus(null, now).state).toBe("never");
    expect(workerStatus({ ...base, lastBeatAt: new Date(now.getTime() - 30_000) }, now)).toMatchObject({
      state: "ok",
      ageSeconds: 30,
    });
    expect(workerStatus({ ...base, lastBeatAt: new Date(now.getTime() - HEARTBEAT_STALE_MS - 1) }, now).state).toBe(
      "stale",
    );
  });
});

describe("Ticker", () => {
  it("never overlaps and keeps going after an error", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const t = new Ticker(
      "test",
      100,
      async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 250)); // slower than the interval
        active--;
        if (calls === 2) throw new Error("boom");
      },
      log,
    );
    const first = t.start();
    await vi.advanceTimersByTimeAsync(250);
    await first;
    await vi.advanceTimersByTimeAsync(2_000);
    const stopping = t.stop(); // waits for the run in progress
    await vi.advanceTimersByTimeAsync(300);
    await stopping;
    expect(maxActive).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(4);
  });
});

describe("Worker", () => {
  it("loads settings, writes a heartbeat every interval and survives database errors", async () => {
    vi.useFakeTimers();
    const store = new MemoryWorkerStore();
    store.rows = [{ key: "sending", value: { globalDailyCap: 20 } }];
    const w = new Worker({ store, log, version: "0.4.0", heartbeatMs: 30_000, settingsReloadMs: 60_000 });

    await w.start();
    expect(w.settings.sending.globalDailyCap).toBe(20);
    expect(store.beats).toHaveLength(1);
    expect(store.beats[0]).toMatchObject({ version: "0.4.0", pid: process.pid });
    expect(store.beats[0]?.info.settingsLoadedAt).toBeTruthy();

    store.failBeats = 1; // next beat fails (Neon waking up)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.beats).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.beats).toHaveLength(2);

    // A settings change is picked up within a minute, without a restart.
    store.rows = [{ key: "sending", value: { globalDailyCap: 35 } }];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.settings.sending.globalDailyCap).toBe(35);

    await w.stop();
    const after = store.beats.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.beats).toHaveLength(after);
  });

  it("keeps the defaults when settings cannot be read at start", async () => {
    const store = new MemoryWorkerStore();
    store.readSettingRows = () => Promise.reject(new Error("no database"));
    const w = new Worker({ store, log, version: "0.4.0" });
    await w.start();
    expect(w.settings.sending.globalDailyCap).toBe(100);
    expect(store.beats).toHaveLength(1);
    await w.stop();
  });
});
