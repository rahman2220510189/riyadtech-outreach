"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SEGMENT_LABELS, type Segment, formatNumber } from "@/lib/finder";
import { type CrawlParams, useCrawlCount, useStartCrawl } from "@/lib/leads";

/**
 * Start a crawl for the leads the page is filtered to (segment, country, city).
 * Shows how many leads and websites it covers before starting.
 */
export function CrawlPanel({
  segment,
  country,
  city,
  hiring = false,
}: {
  segment?: Segment;
  country?: string;
  city?: string;
  hiring?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(30);
  const [onlyNew, setOnlyNew] = useState(true);
  const [onlyReadable, setOnlyReadable] = useState(false);
  // On the Hiring view the crawl re-checks the companies shown there (job adverts change often).
  const onlyHiring = hiring;
  const params: CrawlParams = {
    ...(segment ? { segment } : {}),
    ...(country ? { country } : {}),
    ...(city ? { city } : {}),
    onlyNew: onlyHiring ? false : onlyNew,
    ...(!onlyHiring && !onlyNew && onlyReadable ? { onlyReadable: true } : {}),
    ...(onlyHiring ? { onlyHiring: true } : {}),
    limit: Math.max(1, Math.min(5000, Math.round(limit) || 1)),
  };
  const count = useCrawlCount(params, open);
  const start = useStartCrawl();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90"
      >
        Crawl websites…
      </button>
    );
  }

  return (
    <section aria-labelledby="crawl-title" className="w-full rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="crawl-title" className="font-semibold">
            Crawl lead websites
          </h2>
          <p className="mt-1 max-w-prose text-sm text-ink-2">
            Reads up to 8 pages per website (contact, about, careers…) for public e-mail addresses and signals. It follows robots.txt, waits
            at least 1.5 s between pages of one site, and stops when a site blocks bots.
          </p>
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink-2 underline underline-offset-4">
          Close
        </button>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-4 text-sm">
        <p>
          <span className="text-ink-2">Leads: </span>
          {segment ? SEGMENT_LABELS[segment].name : "both segments"}
          {country ? `, ${country}` : ", all countries"}
          {city ? `, ${city}` : ""}
          {onlyHiring ? ", hiring developers" : ""}
          <span className="block text-xs text-ink-3">Change these with the filters below.</span>
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-ink-2">At most</span>
          <input
            type="number"
            min={1}
            max={5000}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="w-28 rounded-lg border border-line px-3 py-2"
          />
        </label>
        {onlyHiring ? (
          <p className="max-w-xs pb-2 text-ink-2">
            Checks the companies in the Hiring view again: adverts that are gone disappear, new ones show up.
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 pb-2">
              <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} className="size-4" />
              Only leads not crawled yet
            </label>
            {!onlyNew && (
              <label className="flex items-center gap-2 pb-2">
                <input type="checkbox" checked={onlyReadable} onChange={(e) => setOnlyReadable(e.target.checked)} className="size-4" />
                Only websites that could be read before
              </label>
            )}
          </>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          disabled={start.isPending || !count.data || count.data.leads === 0}
          onClick={() =>
            start.mutate(params, {
              onSuccess: (id) => router.push(`/finder/jobs/${id}`),
            })
          }
          className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50"
        >
          {start.isPending ? "Starting…" : "Start crawl"}
        </button>
        <p className="text-sm text-ink-2" aria-live="polite">
          {count.isPending
            ? "Counting…"
            : count.data
              ? count.data.leads === 0
                ? "No leads to crawl with these filters."
                : `${formatNumber(count.data.leads)} lead(s) on ${formatNumber(count.data.sites)} website(s)${count.data.matching > count.data.leads ? ` (${formatNumber(count.data.matching)} match; the best scored first)` : ""}. About ${Math.max(1, Math.round((count.data.sites * 20) / 5 / 60))} min with the worker running.`
              : ""}
        </p>
      </div>
      {(start.error ?? count.error) && <p className="mt-2 text-sm text-bad">{(start.error ?? count.error)?.message}</p>}
    </section>
  );
}
