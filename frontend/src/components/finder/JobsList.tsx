"use client";

import Link from "next/link";
import { formatNumber, useJobs } from "@/lib/finder";
import { StatusBadge } from "./StatusBadge";
import { jobKindLabel, jobTitle, when } from "./jobText";

export function JobsList() {
  const { data, isPending, isError, error } = useJobs();

  return (
    <section aria-labelledby="jobs-title" className="rounded-xl border border-line bg-surface">
      <h2 id="jobs-title" className="border-b border-line-soft px-5 py-4 text-base font-semibold">
        Recent jobs
      </h2>
      {isPending && <p className="px-5 py-6 text-sm text-ink-2">Loading…</p>}
      {isError && <p className="px-5 py-6 text-sm text-bad">{error.message}</p>}
      {data && data.items.length === 0 && (
        <p className="px-5 py-6 text-sm text-ink-2">
          No jobs yet. Start with an estimate: it counts the leads in an area without saving anything.
        </p>
      )}
      {data && data.items.length > 0 && (
        <ul className="divide-y divide-line-soft">
          {data.items.map((j) => {
            const s = j.summary;
            const result =
              j.kind === "geonames"
                ? null
                : j.kind === "crawl"
                  ? `${formatNumber(s?.sitesDone)} of ${formatNumber(s?.sites)} sites, ${formatNumber(s?.leadsWithPrimary)} with an e-mail`
                  : j.dryRun
                  ? `${formatNumber(s?.kept)} leads found`
                  : `${formatNumber(s?.inserted)} new, ${formatNumber(s?.updated)} updated`;
            return (
              <li key={j.id}>
                <Link href={`/finder/jobs/${j.id}`} className="block px-5 py-3 hover:bg-paper/60">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate font-medium">{jobTitle(j)}</p>
                    <StatusBadge status={j.status} />
                  </div>
                  <p className="mt-0.5 text-sm text-ink-2">
                    {jobKindLabel(j)}, {when(j.createdAt)}
                    {result && j.status !== "failed" ? `: ${result}` : ""}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
