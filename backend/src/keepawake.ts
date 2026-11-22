/**
 * Keeps the free Render web service awake during working hours.
 *
 * Render spins a free service down after 15 minutes without inbound requests, which also stops
 * the worker (daily university check, jobs). While awake, the service requests its own public
 * /health every 10 minutes; the request comes back in through Render's front door, so it counts
 * as traffic.
 *
 * Only inside a daily window (default 09:00–20:00 Asia/Dhaka): Neon's free plan has 100 compute
 * hours a month, and the worker keeps the database busy while it runs. 0.25 CU × 24 h × 31 days
 * = 186 h would suspend the database mid-month; 11 h a day ≈ 88 h fits. Outside the window the
 * pings stop, Render and Neon go to sleep, and in the morning a GitHub Actions schedule
 * (.github/workflows/wake.yml) wakes the service again — a sleeping service cannot wake itself.
 *
 * On when Render's RENDER_EXTERNAL_URL is set; KEEP_AWAKE_URL overrides the address,
 * KEEP_AWAKE=false switches it off, KEEP_AWAKE_HOURS ("9-20") and KEEP_AWAKE_TZ set the window.
 */
export const KEEP_AWAKE_EVERY_MS = 10 * 60_000;

export function keepAwakeUrl(env: NodeJS.ProcessEnv): string | null {
  if ((env.KEEP_AWAKE ?? "").toLowerCase() === "false") return null;
  const base = env.KEEP_AWAKE_URL || env.RENDER_EXTERNAL_URL;
  if (!base || !/^https?:\/\//.test(base)) return null;
  return `${base.replace(/\/+$/, "")}/health`;
}

export interface AwakeWindow {
  from: number;
  to: number;
  timeZone: string;
}

/** "9-20" → 09:00 to 20:00 (to is exclusive); "0-24" = all day. Wrong values fall back to the default. */
export function awakeWindow(env: NodeJS.ProcessEnv): AwakeWindow {
  const timeZone = env.KEEP_AWAKE_TZ || "Asia/Dhaka";
  let tzOk = true;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    tzOk = false;
  }
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(env.KEEP_AWAKE_HOURS ?? "");
  const from = m ? Number(m[1]) : 9;
  const to = m ? Number(m[2]) : 20;
  const ok = from >= 0 && to <= 24 && from !== to && from < 24;
  return { from: ok ? from : 9, to: ok ? to : 20, timeZone: tzOk ? timeZone : "Asia/Dhaka" };
}

export function insideWindow(w: AwakeWindow, now: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: w.timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return w.from < w.to ? hour >= w.from && hour < w.to : hour >= w.from || hour < w.to;
}

export function startKeepAwake(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  deps: { fetch?: typeof fetch; everyMs?: number; now?: () => Date } = {},
): { stop(): void; url: string } | null {
  const url = keepAwakeUrl(env);
  if (!url) return null;
  const get = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const window = awakeWindow(env);
  let failures = 0;
  let resting = false;
  const ping = async () => {
    if (!insideWindow(window, now())) {
      if (!resting) log(`keep-awake: outside ${window.from}:00–${window.to}:00 (${window.timeZone}); letting the service sleep`);
      resting = true;
      return;
    }
    resting = false;
    try {
      const res = await get(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "RiyadTechBot keep-awake" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failures > 0) log(`keep-awake: ${url} answers again`);
      failures = 0;
    } catch (err) {
      // Logged once per failure streak, so a long outage does not flood the log.
      if (failures++ === 0) log(`keep-awake: ${url} did not answer (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  const every = deps.everyMs ?? KEEP_AWAKE_EVERY_MS;
  const timer = setInterval(() => void ping(), every);
  log(`keep-awake: requesting ${url} every ${Math.round(every / 60_000)} minutes, ${window.from}:00–${window.to}:00 ${window.timeZone}`);
  return { url, stop: () => clearInterval(timer) };
}
