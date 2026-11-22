import { hostname } from "node:os";
import type { Logger } from "pino";
import { type Settings, defaultSettings } from "../settings/definitions.js";
import { changedKeys, resolveSettings } from "../settings/loader.js";
import type { JobRunner } from "../jobs/runner.js";
import { HEARTBEAT_INTERVAL_MS } from "./heartbeat.js";
import type { WorkerStore } from "./store.js";

/** Settings changes reach the running worker within this time (prompt §3: within a minute). */
export const SETTINGS_RELOAD_MS = 60_000;

export interface WorkerOptions {
  store: WorkerStore;
  log: Logger;
  version: string;
  heartbeatMs?: number;
  settingsReloadMs?: number;
  /** Background jobs; created by the caller with `() => worker.settings`. */
  jobs?: JobRunner;
  /** How often to look for new tasks when idle. */
  jobPollMs?: number;
  /** More periodic work (e.g. the daily university check schedule); gets the current settings. */
  periodic?: { name: string; ms: number; run: (settings: Settings) => Promise<void> }[];
}

/**
 * Runs `fn` every `ms`. Never overlaps (a slow run makes the next one wait),
 * never throws (errors are logged), and can be stopped and awaited.
 */
export class Ticker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly ms: number,
    private readonly fn: () => Promise<void>,
    private readonly log: Logger,
  ) {}

  /** Runs once now, then every `ms` after the previous run finished. */
  start(): Promise<void> {
    return this.run();
  }

  private run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.running = this.fn()
      .catch((err: unknown) => this.log.warn({ err, task: this.name }, `${this.name} failed; will retry`))
      .finally(() => {
        this.running = undefined;
        if (!this.stopped) this.timer = setTimeout(() => void this.run(), this.ms);
      });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}

export class Worker {
  private readonly startedAt = new Date();
  private settingsState: Settings = defaultSettings();
  private settingsLoadedAt: Date | null = null;
  private lastHeartbeatOk = false;
  private readonly tickers: Ticker[];

  constructor(private readonly opts: WorkerOptions) {
    this.tickers = [
      new Ticker("settings reload", opts.settingsReloadMs ?? SETTINGS_RELOAD_MS, () => this.reloadSettings(), opts.log),
      new Ticker("heartbeat", opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS, () => this.beat(), opts.log),
    ];
    const jobs = opts.jobs;
    if (jobs) {
      this.tickers.push(new Ticker("jobs", opts.jobPollMs ?? 3_000, async () => void (await jobs.pump()), opts.log));
    }
    for (const p of opts.periodic ?? []) this.tickers.push(new Ticker(p.name, p.ms, () => p.run(this.settingsState), opts.log));
  }

  /** Current settings (defaults until the first successful load). */
  get settings(): Settings {
    return this.settingsState;
  }

  async start(): Promise<void> {
    // Settings first, then the first heartbeat, so the heartbeat can report the load.
    for (const t of this.tickers) await t.start();
    this.opts.log.info({ heartbeatOk: this.lastHeartbeatOk }, "Worker started");
  }

  async stop(): Promise<void> {
    await Promise.all(this.tickers.map((t) => t.stop()));
    await this.opts.jobs?.stop();
    this.opts.log.info("Worker stopped");
  }

  async reloadSettings(): Promise<void> {
    const { settings, problems, unknownKeys } = resolveSettings(await this.opts.store.readSettingRows());
    for (const p of problems) {
      this.opts.log.warn({ key: p.key, issues: p.issues }, "Invalid setting in database; using defaults for this key");
    }
    if (unknownKeys.length > 0) this.opts.log.debug({ unknownKeys }, "Unknown settings keys ignored");

    const changed = this.settingsLoadedAt ? changedKeys(this.settingsState, settings) : [];
    if (changed.length > 0) this.opts.log.info({ changed }, "Settings changed");
    this.settingsState = settings;
    this.settingsLoadedAt = new Date();
  }

  async beat(): Promise<void> {
    try {
      await this.opts.store.writeHeartbeat({
        pid: process.pid,
        version: this.opts.version,
        startedAt: this.startedAt,
        info: {
          host: hostname(),
          settingsLoadedAt: this.settingsLoadedAt?.toISOString() ?? null,
          busyTasks: this.opts.jobs?.busy ?? 0,
        },
      });
      if (!this.lastHeartbeatOk) this.opts.log.info("Heartbeat written");
      this.lastHeartbeatOk = true;
    } catch (err) {
      this.lastHeartbeatOk = false;
      throw err;
    }
  }
}
