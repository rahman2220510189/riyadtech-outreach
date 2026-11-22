"use client";

import { useState } from "react";
import { StatusBadge } from "@/components/finder/StatusBadge";
import { formatNumber } from "@/lib/finder";
import { type JobAdStats, type JobSource, SOURCE_LABELS, useCancelJobSearch, useStartJobSearch } from "@/lib/jobads";

const DEFAULT_KEYWORDS = "Softwareentwickler, Webentwickler, Frontend Developer, Full Stack Developer, JavaScript, TypeScript, React, Node.js";
const field = "rounded-lg border border-line bg-surface px-3 py-2";

/** Starts a search of the job APIs and shows the last search. */
export function SearchPanel({ stats }: { stats: JobAdStats | undefined }) {
  const start = useStartJobSearch();
  const cancel = useCancelJobSearch();
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<JobSource[]>(["ba", "arbeitnow"]);
  const [keywords, setKeywords] = useState(DEFAULT_KEYWORDS);
  const [where, setWhere] = useState("");
  const [radiusKm, setRadiusKm] = useState(50);
  const [days, setDays] = useState(30);
  const [maxPages, setMaxPages] = useState(3);
  const [details, setDetails] = useState(100);
  const last = stats?.lastFetch ?? null;
  const running = last?.status === "running" || last?.status === "queued";
  const words = keywords
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 15);

  const submit = () =>
    start.mutate(
      { sources, keywords: words, ...(where.trim() ? { where: where.trim() } : {}), radiusKm, days, maxPages, details },
      { onSuccess: () => setOpen(false) },
    );

  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Search for new jobs</h2>
          {last ? (
            <div className="mt-1 text-sm text-ink-2">
              <p className="flex flex-wrap items-center gap-2">
                <StatusBadge status={last.status} />
                <span>
                  {last.label ?? "Last search"} · {new Date(last.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </p>
              {last.summary && (
                <p className="mt-1">
                  {formatNumber(last.summary.ads ?? 0)} adverts read, {formatNumber(last.summary.dev ?? 0)} developer jobs ({formatNumber(last.summary.stack ?? 0)} with our stack,{" "}
                  {formatNumber(last.summary.english ?? 0)} in English or with an English team, {formatNumber(last.summary.visa ?? 0)} with visa help),{" "}
                  {formatNumber(last.summary.added ?? 0)} new, {formatNumber(last.summary.linked ?? 0)} also among your leads.
                </p>
              )}
              {last.error && <p className="mt-1 text-bad">{last.error}</p>}
              {running && last.events.length > 0 && <p className="mt-1 text-ink-3">{last.events[last.events.length - 1]!.message}</p>}
              {!running && last.events.some((e) => e.level !== "info") && (
                <ul className="mt-1 space-y-0.5 text-xs">
                  {last.events
                    .filter((e) => e.level !== "info")
                    .map((e, i) => (
                      <li key={i} className={e.level === "error" ? "text-bad" : "text-warn"}>
                        {e.message}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="mt-1 max-w-prose text-sm text-ink-2">
              Reads the public job APIs of the Bundesagentur für Arbeit (all of Germany) and Arbeitnow (jobs in Germany, many in English). Takes a few minutes; one request per second.
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {running && last && (
            <button type="button" onClick={() => cancel.mutate(last.id)} disabled={cancel.isPending} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-bad hover:bg-bad-soft">
              Stop search
            </button>
          )}
          {!open && (
            <button type="button" disabled={running} onClick={() => setOpen(true)} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
              {running ? "Searching…" : "New search…"}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="space-y-4 border-t border-line-soft pt-4 text-sm">
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-1 font-medium">Sources</legend>
            {(Object.keys(SOURCE_LABELS) as JobSource[]).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={sources.includes(s)}
                  onChange={(e) => setSources(e.target.checked ? [...sources, s] : sources.filter((x) => x !== s))}
                />
                {SOURCE_LABELS[s]}
              </label>
            ))}
          </fieldset>
          {sources.includes("ba") && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
                <span className="font-medium">Search words (Bundesagentur, one search each, comma separated)</span>
                <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={2} className={field} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium">Town or postcode</span>
                <input value={where} onChange={(e) => setWhere(e.target.value)} placeholder="All of Germany" className={field} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium">Radius (km)</span>
                <input type="number" min={0} max={200} value={radiusKm} disabled={!where.trim()} onChange={(e) => setRadiusKm(Number(e.target.value))} className={field} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium">Published in the last</span>
                <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={field}>
                  {[3, 7, 14, 30, 60, 100].map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-medium">Read the full text of</span>
                <select value={details} onChange={(e) => setDetails(Number(e.target.value))} className={field}>
                  {[0, 50, 100, 200, 300].map((d) => (
                    <option key={d} value={d}>
                      {d === 0 ? "no adverts (faster)" : `up to ${d} new adverts`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <label className="flex max-w-xs flex-col gap-1">
            <span className="font-medium">Pages per search (100 adverts each)</span>
            <input type="number" min={1} max={20} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} className={field} />
          </label>
          <p className="text-ink-3">
            About {formatNumber((sources.includes("ba") ? words.length * maxPages + details : 0) + (sources.includes("arbeitnow") ? maxPages * 2 : 0))} requests at most, one per
            second. Remote, visa and English flags for Bundesagentur adverts come from the full text.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={start.isPending || sources.length === 0 || (sources.includes("ba") && words.length === 0)}
              onClick={submit}
              className="rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90 disabled:opacity-50"
            >
              {start.isPending ? "Starting…" : "Start search"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="text-ink-2 underline underline-offset-4">
              Close
            </button>
            {start.error && <span className="text-bad">{start.error.message}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
