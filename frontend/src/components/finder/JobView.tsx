"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import {
  type JobDetail,
  SEGMENT_LABELS,
  SKIP_LABELS,
  type Segment,
  formatBytes,
  formatNumber,
  isActive,
  useCategories,
  useCreateJob,
  useJob,
  useJobAction,
} from "@/lib/finder";
import { CRAWL_STATUS_LABELS, type CrawlStatus, useSignalDefs, useStartCrawl } from "@/lib/leads";
import { StatusBadge } from "./StatusBadge";
import { jobKindLabel, jobTitle } from "./jobText";

function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="px-5 py-4">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className={`mt-1 text-2xl tracking-tight ${strong ? "font-bold" : "font-semibold"}`}>{value}</dd>
    </div>
  );
}

function Progress({ job }: { job: JobDetail }) {
  const done = (job.tasks.done ?? 0) + (job.tasks.failed ?? 0);
  const total = done + (job.tasks.queued ?? 0) + (job.tasks.running ?? 0) + (job.tasks.cancelled ?? 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const planning =
    ((job.kind === "finder" && (job.summary?.steps ?? 0) === 0) || (job.kind === "crawl" && total <= 1)) && isActive(job.status);
  const unit = job.kind === "crawl" ? "steps (one per website)" : "steps";
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-2">
          {planning ? (job.kind === "crawl" ? "Choosing the leads…" : "Finding the data files for this area…") : `${done} of ${total} ${unit}`}
        </span>
        <span className="font-medium">{pct}%</span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-paper"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full ${job.status === "failed" ? "bg-bad" : job.status === "paused" ? "bg-warn" : "bg-go"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Breakdown({ title, rows, empty }: { title: string; rows: [string, number][]; empty: string }) {
  return (
    <section className="rounded-xl border border-line bg-surface">
      <h2 className="border-b border-line-soft px-5 py-3 font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-2">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line-soft">
            {rows.map(([label, n]) => (
              <tr key={label}>
                <td className="px-5 py-2">{label}</td>
                <td className="px-5 py-2 text-right font-medium">{formatNumber(n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const sorted = (m: Record<string, number> | undefined) => Object.entries(m ?? {}).sort((a, b) => b[1] - a[1]);

export function JobView({ id }: { id: number }) {
  const router = useRouter();
  const job = useJob(id);
  const action = useJobAction(id);
  const create = useCreateJob();
  const crawl = useStartCrawl();
  const categories = useCategories();
  const signalDefs = useSignalDefs();
  const signalLabel = (key: string) => signalDefs.data?.find((d) => d.key === key)?.label ?? key.replaceAll("_", " ");

  if (job.isPending) return <p className="text-ink-2">Loading…</p>;
  if (job.isError) {
    return (
      <div>
        <p className="text-bad">{job.error instanceof ApiError && job.error.status === 404 ? "This job does not exist." : job.error.message}</p>
        <Link href="/finder" className="mt-4 inline-block font-medium underline underline-offset-4">
          Back to the finder
        </Link>
      </div>
    );
  }

  const j = job.data;
  const s = j.summary ?? {};
  const label = (key: string) => categories.data?.items.find((c) => c.key === key)?.label ?? key;
  const finder = j.kind === "finder";
  const isCrawl = j.kind === "crawl";
  const imported = (s.inserted ?? 0) + (s.updated ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/finder" className="text-sm text-ink-2 underline underline-offset-4">
          Finder
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{jobTitle(j)}</h1>
          <StatusBadge status={j.status} />
        </div>
        <p className="mt-1 text-ink-2">
          {jobKindLabel(j)}
          {finder && j.dryRun ? ": counts only, nothing is saved" : ""}
          {s.release ? `. Overture release ${s.release}` : ""}
        </p>
      </div>

      {j.error && (
        <p role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-sm text-bad">
          {j.error}
        </p>
      )}

      <section className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
        <Progress job={j} />
        <div className="flex flex-wrap gap-2">
          {j.status === "running" && (
            <button type="button" onClick={() => action.mutate("pause")} disabled={action.isPending} className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper">
              Pause
            </button>
          )}
          {j.status === "paused" && (
            <button type="button" onClick={() => action.mutate("resume")} disabled={action.isPending} className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90">
              Resume
            </button>
          )}
          {isActive(j.status) && (
            <button type="button" onClick={() => action.mutate("cancel")} disabled={action.isPending} className="rounded-lg border border-line px-3 py-2 text-sm font-medium text-bad hover:bg-bad-soft">
              Cancel
            </button>
          )}
          {finder && j.dryRun && j.status === "done" && (s.kept ?? 0) > 0 && (
            <button
              type="button"
              disabled={create.isPending}
              onClick={() =>
                create.mutate(
                  { params: { ...j.params, segments: j.params.segments }, dryRun: false },
                  { onSuccess: (newId) => router.push(`/finder/jobs/${newId}`) },
                )
              }
              className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90"
            >
              Import these {formatNumber(s.kept)} leads
            </button>
          )}
          {finder && !j.dryRun && j.status === "done" && imported > 0 && (
            <button
              type="button"
              disabled={crawl.isPending}
              onClick={() =>
                crawl.mutate(
                  { finderJobId: j.id, onlyNew: true, limit: Math.min(5000, imported) },
                  { onSuccess: (newId) => router.push(`/finder/jobs/${newId}`) },
                )
              }
              className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90"
            >
              Crawl the websites of these leads
            </button>
          )}
          {isCrawl && j.status === "done" && (
            <Link href="/leads?crawl=readable" className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper">
              Open the leads
            </Link>
          )}
        </div>
        {(action.error ?? create.error ?? crawl.error) && (
          <p className="text-sm text-bad">{(action.error ?? create.error ?? crawl.error)?.message}</p>
        )}
      </section>

      {finder && (
        <>
          <dl className="grid divide-y divide-line-soft rounded-xl border border-line bg-surface sm:grid-cols-4 sm:divide-x sm:divide-y-0">
            <Stat label="Places checked" value={formatNumber(s.scanned)} />
            <Stat label="Leads found" value={formatNumber(s.kept)} strong />
            {j.dryRun ? (
              <Stat label="Saved" value="No, estimate" />
            ) : (
              <Stat label="New / updated" value={`${formatNumber(s.inserted)} / ${formatNumber(s.updated)}`} />
            )}
            <Stat label="Downloaded" value={formatBytes(s.bytes)} />
          </dl>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
            <Breakdown
              title="Leads by kind of business"
              rows={sorted(s.byCategory).map(([k, n]) => [label(k), n])}
              empty="No leads yet."
            />
            <div className="space-y-6">
              <Breakdown
                title="Leads by segment"
                rows={sorted(s.bySegment).map(([k, n]) => [SEGMENT_LABELS[k as Segment]?.name ?? k, n])}
                empty="No leads yet."
              />
              <Breakdown
                title="Not used, and why"
                rows={sorted(s.skipped).map(([k, n]) => [SKIP_LABELS[k] ?? k, n])}
                empty="Nothing skipped yet."
              />
            </div>
          </div>

          {sorted(s.unmapped).length > 0 && (
            <details className="rounded-xl border border-line bg-surface">
              <summary className="cursor-pointer px-5 py-3 font-semibold">Most common categories we do not target</summary>
              <ul className="grid gap-x-6 px-5 pb-4 text-sm sm:grid-cols-2">
                {sorted(s.unmapped).map(([k, n]) => (
                  <li key={k} className="flex justify-between border-b border-line-soft py-1.5">
                    <span>{k.replaceAll("_", " ")}</span>
                    <span className="text-ink-2">{formatNumber(n)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {isCrawl && (
        <>
          <dl className="grid divide-y divide-line-soft rounded-xl border border-line bg-surface sm:grid-cols-4 sm:divide-x sm:divide-y-0">
            <Stat label="Websites crawled" value={`${formatNumber(s.sitesDone)} / ${formatNumber(s.sites)}`} />
            <Stat
              label="Readable"
              value={`${formatNumber(s.readable)}${s.sitesDone ? ` (${Math.round(((s.readable ?? 0) / s.sitesDone) * 100)}%)` : ""}`}
            />
            <Stat
              label="With an e-mail"
              value={`${formatNumber(s.sitesWithEmail)}${s.readable ? ` (${Math.round(((s.sitesWithEmail ?? 0) / s.readable) * 100)}%)` : ""}`}
              strong
            />
            <Stat label="Leads ready to contact" value={formatNumber(s.leadsWithPrimary)} />
          </dl>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
            <Breakdown
              title="Websites by result"
              rows={sorted(s.byStatus).map(([k, n]) => [CRAWL_STATUS_LABELS[k as CrawlStatus] ?? k, n])}
              empty="No websites crawled yet."
            />
            <Breakdown
              title="Signals found (websites)"
              rows={sorted(s.bySignal).map(([k, n]) => [signalLabel(k), n])}
              empty="No signals yet."
            />
          </div>
          <p className="text-sm text-ink-2">
            {formatNumber(s.emails)} e-mail addresses found on {formatNumber(s.pages)} pages. Job platforms (Personio,
            Greenhouse…): {formatNumber(s.jobBoards)}. Without a mail server (no MX):{" "}
            {formatNumber(s.noMx)}. Listed by Overture but not on the website (not used): {formatNumber(s.overtureOnly)}.
          </p>
        </>
      )}

      <section className="rounded-xl border border-line bg-surface">
        <h2 className="border-b border-line-soft px-5 py-3 font-semibold">What happened</h2>
        <ol className="divide-y divide-line-soft">
          {j.events.map((e) => (
            <li key={e.id} className="flex gap-4 px-5 py-2.5 text-sm">
              <time className="shrink-0 text-ink-3" dateTime={e.at}>
                {new Date(e.at).toLocaleTimeString("en-GB")}
              </time>
              <span className={e.level === "error" ? "text-bad" : e.level === "warn" ? "text-warn" : ""}>{e.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
