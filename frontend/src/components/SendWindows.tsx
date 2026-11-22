"use client";

import { useEffect, useState } from "react";
import { type WindowsToday, computeWindows, minuteLabel } from "@/lib/send-windows";

const TICKS = [0, 180, 360, 540, 720, 900, 1080, 1260, 1440];
/** Every 6 h is always labelled; the 3-hour labels only when the card is wide enough. */
const isMajor = (t: number) => t % 360 === 0;
const pct = (minute: number) => `${(minute / 1440) * 100}%`;

function useWindowsNow(): WindowsToday | null {
  const [data, setData] = useState<WindowsToday | null>(null);
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const update = () => setData(computeWindows(new Date(), tz));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);
  return data;
}

/**
 * When each market's 09:00-17:00 weekday window falls on the viewer's own clock today.
 * One vertical line marks "now"; a filled band means that market is open right now.
 */
export function SendWindows({ compact = false }: { compact?: boolean }) {
  const data = useWindowsNow();

  return (
    <section aria-labelledby="send-windows-title" className="@container rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line-soft px-5 py-4">
        <h2 id="send-windows-title" className="text-base font-semibold">
          Sending windows today
        </h2>
        <p className="text-sm text-ink-2">
          {data ? (
            <>
              Your time <span className="font-semibold text-ink">{data.viewerTime}</span>, {data.viewerTimeZone}
            </>
          ) : (
            <span aria-hidden>&nbsp;</span>
          )}
        </p>
      </header>

      <div className="px-5 pb-5 pt-3">
        {!compact && (
          <p className="mb-4 max-w-prose text-sm text-ink-2">
            Emails go out on weekdays between 09:00 and 17:00 in the recipient&apos;s time zone. The bands show when that
            is on your clock.
          </p>
        )}

        {/* Hour scale, aligned with the bars below (hidden on small screens). */}
        <div className="hidden grid-cols-[11rem_1fr_15rem] gap-x-5 @2xl:grid" aria-hidden>
          <span />
          <div className="relative h-5 text-[0.6875rem] text-ink-3">
            {TICKS.map((t) => (
              <span
                key={t}
                className={`absolute top-0 -translate-x-1/2 first:translate-x-0 last:-translate-x-full ${
                  isMajor(t) ? "" : "hidden @4xl:inline"
                }`}
                style={{ left: pct(t) }}
              >
                {t === 1440 ? "24:00" : minuteLabel(t)}
              </span>
            ))}
          </div>
          <span />
        </div>

        <ul className="divide-y divide-line-soft">
          {(data?.markets ?? []).map((m) => (
            <li key={m.market.id} className="grid gap-x-5 gap-y-2 py-3 @2xl:grid-cols-[11rem_1fr_15rem] @2xl:items-center">
              <div className="flex items-baseline justify-between gap-3 @2xl:block">
                <p className="font-medium">{m.market.name}</p>
                <p className="whitespace-nowrap text-sm text-ink-3">
                  {m.market.city}, {m.localDay} {m.localTime}
                </p>
              </div>

              <div className="relative h-7 overflow-hidden rounded-md bg-paper" aria-hidden>
                {TICKS.slice(1, -1).map((t) => (
                  <span key={t} className="absolute inset-y-0 w-px bg-line-soft" style={{ left: pct(t) }} />
                ))}
                {m.segments.map(([from, to]) => (
                  <span
                    key={from}
                    className={`absolute inset-y-1 rounded ${m.open ? "bg-go" : "border border-go/40 bg-go-soft"}`}
                    style={{ left: pct(from), width: pct(to - from) }}
                  />
                ))}
                {data && (
                  <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: pct(data.viewerMinutes) }} />
                )}
              </div>

              <p className={`text-sm @2xl:text-right ${m.open ? "font-semibold text-go" : "text-ink-2"}`}>
                {m.summary}
                <span className="sr-only">
                  {m.segments.length > 0
                    ? `. On your clock today: ${m.segments.map(([a, b]) => `${minuteLabel(a)} to ${minuteLabel(b)}`).join(" and ")}.`
                    : ". No sending window on your clock today."}
                </span>
              </p>
            </li>
          ))}
          {!data &&
            Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="py-3">
                <div className="h-7 animate-pulse rounded-md bg-paper" />
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
}
