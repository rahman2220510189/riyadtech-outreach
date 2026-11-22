"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useCreateApplication } from "@/lib/mail";
import { formatNumber } from "@/lib/finder";
import { FLAG_LABELS, type JobAd, type JobAdFilters, type JobSource, SOURCE_LABELS, useJobAdStats, useJobAds, useUpdateJobAd } from "@/lib/jobads";
import { SearchPanel } from "./SearchPanel";

const field = "rounded-lg border border-line bg-surface px-2.5 py-2";

function ago(iso: string | null): string {
  if (!iso) return "date unknown";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" });
}

function WriteApplication({ ad }: { ad: JobAd }) {
  const router = useRouter();
  const create = useCreateApplication();
  return (
    <>
      <button
        type="button"
        disabled={create.isPending}
        onClick={() =>
          create.mutate(
            { jobAdId: ad.id },
            {
              onSuccess: (a) => router.push(`/applications/${a.id}`),
              onError: (err) => {
                const existing = err instanceof ApiError ? (err.details as { applicationId?: number } | undefined)?.applicationId : undefined;
                if (existing) router.push(`/applications/${existing}`);
              },
            },
          )
        }
        className="font-medium underline underline-offset-4"
      >
        {create.isPending ? "Writing…" : "Write application"}
      </button>
      {create.error && !(create.error instanceof ApiError && create.error.status === 409) && <span className="text-bad">{create.error.message}</span>}
    </>
  );
}

function AdCard({ ad }: { ad: JobAd }) {
  const update = useUpdateJobAd();
  const set = (status: JobAd["status"]) => update.mutate({ id: ad.id, status });
  const btn = "rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper disabled:opacity-50";
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <a href={ad.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline-offset-4 hover:underline">
            {ad.title}
          </a>
          <p className="text-sm text-ink-2">
            {ad.company}
            {ad.location ? ` · ${ad.location}` : ""} · {ago(ad.postedAt)} · {ad.sourceLabel}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ad.status === "saved" ? (
            <button type="button" className={btn} disabled={update.isPending} onClick={() => set("new")}>
              Saved ✓
            </button>
          ) : ad.status !== "applied" ? (
            <button type="button" className={btn} disabled={update.isPending} onClick={() => set("saved")}>
              Save
            </button>
          ) : null}
          {ad.status === "applied" ? (
            <button type="button" className={btn} disabled={update.isPending} onClick={() => set("saved")}>
              Applied ✓
            </button>
          ) : (
            <button type="button" className={btn} disabled={update.isPending} onClick={() => set("applied")}>
              I applied
            </button>
          )}
          {ad.status === "hidden" ? (
            <button type="button" className={btn} disabled={update.isPending} onClick={() => set("new")}>
              Show again
            </button>
          ) : (
            <button type="button" className={`${btn} text-ink-2`} disabled={update.isPending} onClick={() => set("hidden")} aria-label={`Hide ${ad.title}`}>
              Hide
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {ad.stackMatch && <span className="rounded-full bg-go-soft px-2 py-0.5 text-xs font-semibold text-go">Our stack</span>}
        {ad.flags.map((f) => (
          <span
            key={f}
            className={`rounded-md border px-1.5 py-0.5 text-xs ${f === "local_lang" ? "border-warn/40 text-warn" : "border-line text-ink-2"}`}
          >
            {FLAG_LABELS[f] ?? f}
          </span>
        ))}
        {ad.jobTypes.slice(0, 2).map((t) => (
          <span key={t} className="rounded-md bg-paper px-1.5 py-0.5 text-xs text-ink-3">
            {t}
          </span>
        ))}
      </div>
      {ad.excerpt && <p className="mt-2 line-clamp-2 max-w-prose text-sm text-ink-2">{ad.excerpt}</p>}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <a href={ad.url} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
          Open the advert
        </a>
        <WriteApplication ad={ad} />
        {ad.externalUrl && (
          <a href={ad.externalUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
            Employer&apos;s page
          </a>
        )}
        {ad.lead && (
          <span className="text-ink-2">
            Also your lead{" "}
            <Link href={`/leads?lead=${ad.lead.id}`} className="underline underline-offset-4">
              {ad.lead.name}
            </Link>
            {ad.lead.applyEmail ? ` · apply: ${ad.lead.applyEmail}` : ""}
          </span>
        )}
      </div>
      {update.error && <p className="mt-1 text-sm text-bad">{update.error.message}</p>}
    </li>
  );
}

const STATUS_TABS: [NonNullable<JobAdFilters["status"]>, string][] = [
  ["open", "Open"],
  ["saved", "Saved"],
  ["applied", "Applied"],
  ["hidden", "Hidden"],
  ["all", "All"],
];

export function JobSearchView() {
  const [f, setF] = useState<JobAdFilters>({ status: "open", sort: "newest", page: 1 });
  const set = (patch: Partial<JobAdFilters>) => setF({ ...f, ...patch, page: patch.page ?? 1 });
  const stats = useJobAdStats();
  const ads = useJobAds(f);
  const d = ads.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const counts = stats.data?.byStatus ?? {};

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Job search</h1>
        <p className="mt-1 max-w-prose text-ink-2">
          Developer jobs in Germany from public job boards. Apply on the advert&apos;s page, or to the company&apos;s own address when it is also one of your
          leads. Companies found by crawling are in Leads → Hiring developers.
        </p>
      </div>

      <SearchPanel stats={stats.data} />

      <section aria-label="Filters" className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-surface px-4 py-4 sm:grid-cols-3 lg:grid-cols-6">
        <label className="col-span-2 flex flex-col gap-1 text-sm">
          <span className="text-ink-2">Search</span>
          <input type="search" value={f.q ?? ""} onChange={(e) => set({ q: e.target.value || undefined })} placeholder="Title, company or text" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-2">Town or postcode</span>
          <input value={f.place ?? ""} onChange={(e) => set({ place: e.target.value || undefined })} placeholder="Berlin, 10…" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-2">Language and more</span>
          <select value={f.flag ?? ""} onChange={(e) => set({ flag: (e.target.value || undefined) as JobAdFilters["flag"] })} className={field}>
            <option value="">Any</option>
            <option value="english">English advert or team</option>
            <option value="no_local_lang">German not required</option>
            <option value="remote">Remote possible</option>
            <option value="visa">Visa / relocation help</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-2">Published</span>
          <select value={f.days ?? ""} onChange={(e) => set({ days: e.target.value ? Number(e.target.value) : undefined })} className={field}>
            <option value="">Any time</option>
            {[3, 7, 14, 30].map((n) => (
              <option key={n} value={n}>
                Last {n} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-2">Source</span>
          <select value={f.source ?? ""} onChange={(e) => set({ source: (e.target.value || undefined) as JobSource | undefined })} className={field}>
            <option value="">Both</option>
            {(Object.keys(SOURCE_LABELS) as JobSource[]).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <div className="col-span-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm sm:col-span-3 lg:col-span-6">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={f.stack === true} onChange={(e) => set({ stack: e.target.checked ? true : undefined })} />
            Our stack only (React, Node.js, TypeScript…)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={f.linked === true} onChange={(e) => set({ linked: e.target.checked ? true : undefined })} />
            Also one of my leads
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4" checked={f.dev === false} onChange={(e) => set({ dev: e.target.checked ? false : undefined })} />
            Show non-developer adverts too
          </label>
          <label className="ml-auto flex items-center gap-2">
            <span className="text-ink-2">Sort</span>
            <select value={f.sort} onChange={(e) => set({ sort: e.target.value as JobAdFilters["sort"] })} className={field}>
              <option value="newest">Newest first</option>
              <option value="company">Company A–Z</option>
            </select>
          </label>
        </div>
      </section>

      <div role="tablist" aria-label="Status" className="inline-flex flex-wrap rounded-lg border border-line bg-surface p-1 text-sm">
        {STATUS_TABS.map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={f.status === v}
            onClick={() => set({ status: v })}
            className={`rounded-md px-3 py-1.5 font-medium ${f.status === v ? "bg-ink text-white" : "text-ink-2 hover:bg-paper"}`}
          >
            {label}
            {v === "open" && stats.data ? ` (${formatNumber(stats.data.openDev)})` : v !== "all" && v !== "open" && counts[v] ? ` (${formatNumber(counts[v])})` : ""}
          </button>
        ))}
      </div>

      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        {ads.isPending && <p className="px-5 py-6 text-ink-2">Loading…</p>}
        {ads.isError && <p className="px-5 py-6 text-bad">{ads.error.message}</p>}
        {d && d.items.length === 0 && (
          <p className="px-5 py-6 text-ink-2">
            {stats.data && stats.data.sources.every((s) => s.ads === 0) ? "No adverts yet. Start a search above." : "No adverts match these filters."}
          </p>
        )}
        {d && d.items.length > 0 && (
          <>
            <p className="border-b border-line-soft px-5 py-2.5 text-sm text-ink-2">{formatNumber(d.total)} adverts</p>
            <ul className="divide-y divide-line-soft">
              {d.items.map((ad) => (
                <AdCard key={ad.id} ad={ad} />
              ))}
            </ul>
          </>
        )}
        {d && d.total > d.pageSize && (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-line-soft px-5 py-3 text-sm">
            <span className="text-ink-2">
              Page {f.page} of {pages}
            </span>
            <div className="flex gap-2">
              <button type="button" disabled={(f.page ?? 1) <= 1} onClick={() => set({ page: (f.page ?? 1) - 1 })} className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40">
                Previous
              </button>
              <button type="button" disabled={(f.page ?? 1) >= pages} onClick={() => set({ page: (f.page ?? 1) + 1 })} className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40">
                Next
              </button>
            </div>
          </nav>
        )}
      </section>
    </div>
  );
}
