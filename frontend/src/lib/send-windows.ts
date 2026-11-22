/**
 * Sending windows: emails go out on weekdays between 09:00 and 17:00 in the
 * RECIPIENT's time zone (prompt §8.3). This module answers, for each market:
 * is the window open right now, when does it change, and where does it fall
 * on the viewer's own clock today.
 */

export interface Market {
  id: string;
  name: string;
  /** City shown next to the name, for orientation. */
  city: string;
  timeZone: string;
}

/** Markets in the order of the prompt (UK, Ireland, US, Australia). */
export const MARKETS: Market[] = [
  { id: "uk-ie", name: "UK & Ireland", city: "London", timeZone: "Europe/London" },
  { id: "us-east", name: "US East", city: "New York", timeZone: "America/New_York" },
  { id: "us-central", name: "US Central", city: "Chicago", timeZone: "America/Chicago" },
  { id: "us-west", name: "US West", city: "Los Angeles", timeZone: "America/Los_Angeles" },
  { id: "au-east", name: "Australia East", city: "Sydney", timeZone: "Australia/Sydney" },
  { id: "au-west", name: "Australia West", city: "Perth", timeZone: "Australia/Perth" },
];

export interface SendWindow {
  /** "HH:MM" local to the recipient. */
  start: string;
  end: string;
  weekdaysOnly: boolean;
}

/** Defaults from the prompt; later read from Settings (`sending`). */
export const DEFAULT_WINDOW: SendWindow = { start: "09:00", end: "17:00", weekdaysOnly: true };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const STEP_MIN = 15;

interface LocalParts {
  /** 0 = Sunday. */
  weekday: number;
  minutes: number;
  hhmm: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekday = DAYS.indexOf(get("weekday") as (typeof DAYS)[number]);
  return {
    weekday,
    minutes: hour * 60 + minute,
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function isWorkday(weekday: number, w: SendWindow): boolean {
  return !w.weekdaysOnly || (weekday >= 1 && weekday <= 5);
}

export function isOpenAt(date: Date, timeZone: string, w: SendWindow = DEFAULT_WINDOW): boolean {
  const p = localParts(date, timeZone);
  return isWorkday(p.weekday, w) && p.minutes >= toMinutes(w.start) && p.minutes < toMinutes(w.end);
}

/** "2 h 15 min", "45 min", "1 day 3 h". */
export function formatDuration(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (days > 0) return hours > 0 ? `${days} day${days > 1 ? "s" : ""} ${hours} h` : `${days} day${days > 1 ? "s" : ""}`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
}

export interface MarketWindow {
  market: Market;
  open: boolean;
  /** Recipient's local time now, "HH:MM", and weekday. */
  localTime: string;
  localDay: string;
  /** Minutes until the window closes (open) or opens (closed). */
  minutesToChange: number;
  /** Plain sentence for the UI. */
  summary: string;
  /** Open stretches on the VIEWER's clock today, as [startMinute, endMinute) of 0..1440. */
  segments: [number, number][];
}

export interface WindowsToday {
  viewerTimeZone: string;
  viewerTime: string;
  /** Minutes since the viewer's midnight (position of the "now" line). */
  viewerMinutes: number;
  markets: MarketWindow[];
}

export function computeWindows(
  now: Date,
  viewerTimeZone: string,
  markets: Market[] = MARKETS,
  w: SendWindow = DEFAULT_WINDOW,
): WindowsToday {
  const viewer = localParts(now, viewerTimeZone);
  // Viewer's midnight. Exact for time zones without DST (Asia/Dhaka); on a DST
  // change day elsewhere the strip is off by up to an hour, which is fine here.
  const midnight = new Date(now.getTime() - viewer.minutes * 60_000 - (now.getTime() % 60_000));
  const startMin = toMinutes(w.start);
  const endMin = toMinutes(w.end);

  const result = markets.map((market): MarketWindow => {
    const local = localParts(now, market.timeZone);
    const open = isWorkday(local.weekday, w) && local.minutes >= startMin && local.minutes < endMin;

    let minutesToChange: number;
    let summary: string;
    if (open) {
      minutesToChange = endMin - local.minutes;
      summary = `Open for ${formatDuration(minutesToChange)} more`;
    } else {
      let d = 0;
      while (d < 8) {
        const weekday = (local.weekday + d) % 7;
        if (isWorkday(weekday, w) && (d > 0 || local.minutes < startMin)) break;
        d++;
      }
      minutesToChange = d * 1440 + startMin - local.minutes;
      const opensDay = DAYS[(local.weekday + d) % 7] ?? "";
      summary =
        d === 0
          ? `Opens in ${formatDuration(minutesToChange)}`
          : `Opens ${opensDay} ${w.start}, in ${formatDuration(minutesToChange)}`;
    }

    const segments: [number, number][] = [];
    for (let k = 0; k < 1440 / STEP_MIN; k++) {
      const t = new Date(midnight.getTime() + k * STEP_MIN * 60_000);
      if (!isOpenAt(t, market.timeZone, w)) continue;
      const from = k * STEP_MIN;
      const last = segments[segments.length - 1];
      if (last && last[1] === from) last[1] = from + STEP_MIN;
      else segments.push([from, from + STEP_MIN]);
    }

    return {
      market,
      open,
      localTime: local.hhmm,
      localDay: DAYS[local.weekday] ?? "",
      minutesToChange,
      summary,
      segments,
    };
  });

  return { viewerTimeZone, viewerTime: viewer.hhmm, viewerMinutes: viewer.minutes, markets: result };
}

/** "09:00" style label for a minute of the viewer's day. */
export function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
