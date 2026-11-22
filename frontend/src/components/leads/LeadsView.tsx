"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { SEGMENT_LABELS, type Segment, formatNumber, searchable, useCountries } from "@/lib/finder";
import { exportUrl, type LeadFilters, useLeadStats, useLeads, useSignalDefs } from "@/lib/leads";
import { DownloadButton } from "@/components/DownloadButton";
import { MoreFilters } from "./MoreFilters";
import { CrawlBadge, Score, SignalChip, SuppressedBadge } from "./bits";
import { CrawlPanel } from "./CrawlPanel";
import { LeadDrawer } from "./LeadDrawer";

const PAGE_SIZE = 25;

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="text-ink-2">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-line bg-surface px-2.5 py-2">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The advertised developer job: role, "our stack" marker and a link to the job page. */
const FLAG_TEXT: Record<string, string> = {
  remote: "Remote",
  visa: "Visa / relocation",
  english: "English team",
  local_lang: "Fluent local language",
};

function JobCell({
  role,
  url,
  stackMatch,
  flags = [],
  applyEmail = null,
}: {
  role: string | null;
  url: string | null;
  stackMatch: boolean | null;
  flags?: string[];
  applyEmail?: string | null;
}) {
  return (
    <div className="text-sm">
      <span className="font-medium">{role ?? "Developer"}</span>
      {stackMatch && <span className="ml-2 rounded-full bg-go-soft px-2 py-0.5 text-xs font-semibold text-go">Our stack</span>}
      {flags.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1">
          {flags.map((f) => (
            <span
              key={f}
              className={`rounded-md border px-1.5 py-0.5 text-xs ${f === "local_lang" ? "border-warn/40 text-warn" : "border-line text-ink-2"}`}
            >
              {FLAG_TEXT[f] ?? f}
            </span>
          ))}
        </span>
      )}
      {applyEmail && <span className="mt-0.5 block break-all text-ink-2">Apply: {applyEmail}</span>}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-0.5 block break-all text-ink-3 underline underline-offset-2">
          Job page
        </a>
      )}
    </div>
  );
}

/** The leads list: filters live in the URL, so a filtered view can be bookmarked or linked. */
export function LeadsView() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const countries = useCountries();
  const signalDefs = useSignalDefs();
  const stats = useLeadStats();

  const filters: LeadFilters = useMemo(() => {
    const f: LeadFilters = { sort: (sp.get("sort") as LeadFilters["sort"]) ?? "score", page: Number(sp.get("page") ?? 1) || 1 };
    const seg = sp.get("segment");
    if (seg === "A" || seg === "B") f.segment = seg;
    for (const k of ["country", "regionCode", "city", "category", "signal", "q"] as const) {
      const v = sp.get(k);
      if (v) f[k] = v;
    }
    const crawl = sp.get("crawl");
    if (crawl === "new" || crawl === "crawled" || crawl === "readable" || crawl === "problem") f.crawl = crawl;
    const he = sp.get("hasEmail");
    if (he === "true" || he === "false") f.hasEmail = he === "true";
    const bo = sp.get("bestOffer");
    if (bo === "chatbot" || bo === "agent") f.bestOffer = bo;
    if (sp.get("hiring") === "true") f.hiring = true;
    const jf = sp.get("jobFlag");
    if (jf === "remote" || jf === "visa" || jf === "english" || jf === "no_local_lang") f.jobFlag = jf;
    for (const k of ["minFit", "minNeed"] as const) {
      const n = Number(sp.get(k));
      if (sp.get(k) && Number.isFinite(n)) f[k] = n;
    }
    const su = sp.get("suppressed");
    if (su === "true" || su === "false") f.suppressed = su === "true";
    return f;
  }, [sp]);
  const openId = Number(sp.get("lead")) || null;

  const set = useCallback(
    (changes: Record<string, string | undefined>, keepPage = false) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      if (!keepPage && !("page" in changes)) next.delete("page");
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [sp, router, pathname],
  );

  const leads = useLeads(filters);
  const total = stats.data?.reduce((n, s) => n + s.leads, 0) ?? 0;
  const withEmail = stats.data?.reduce((n, s) => n + s.withEmail, 0) ?? 0;
  const waiting = stats.data?.reduce((n, s) => n + s.waiting, 0) ?? 0;
  const hiringCount = stats.data?.reduce((n, s) => n + s.hiring, 0) ?? 0;
  const hiringView = filters.hiring === true;
  const signalLabel = (key: string) => signalDefs.data?.find((s) => s.key === key)?.label ?? key.replaceAll("_", " ");
  const pages = leads.data ? Math.max(1, Math.ceil(leads.data.total / PAGE_SIZE)) : 1;
  const usefulSignals = (signalDefs.data ?? []).filter(
    (s) => s.key !== "tech_stack" && (!filters.segment || s.segment === "*" || s.segment === filters.segment),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="mt-1 text-ink-2">
            {formatNumber(total)} saved · {formatNumber(withEmail)} with an e-mail · {formatNumber(waiting)} waiting for a crawl
          </p>
          <div role="tablist" aria-label="View" className="mt-3 inline-flex rounded-lg border border-line bg-surface p-1 text-sm">
            <button
              type="button"
              role="tab"
              aria-selected={!hiringView}
              onClick={() => set({ hiring: undefined, jobFlag: undefined })}
              className={`rounded-md px-3 py-1.5 font-medium ${!hiringView ? "bg-ink text-white" : "text-ink-2 hover:bg-paper"}`}
            >
              All leads
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hiringView}
              onClick={() => set({ hiring: "true", signal: undefined, sort: "newest" })}
              className={`rounded-md px-3 py-1.5 font-medium ${hiringView ? "bg-ink text-white" : "text-ink-2 hover:bg-paper"}`}
            >
              Hiring developers ({formatNumber(hiringCount)})
            </button>
          </div>
          {hiringView && (
            <p className="mt-2 max-w-prose text-sm text-ink-2">
              Companies whose own website advertises a developer job, in every country and both segments. For job
              applications: open the job page, apply there.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <DownloadButton
            url={exportUrl(filters)}
            fallbackName="leads.csv"
            label="Export CSV"
            title="The leads matching the filters, as a CSV file (suppressed leads are never included)"
          />
          <Link href="/leads/lists" className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium hover:bg-paper">
            Imported lists
          </Link>
          <Link href="/leads/import" className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium hover:bg-paper">
            Import CSV
          </Link>
          <CrawlPanel
            {...(filters.segment ? { segment: filters.segment } : {})}
            {...(filters.country ? { country: filters.country } : {})}
            {...(filters.city ? { city: filters.city } : {})}
            hiring={hiringView}
          />
        </div>
      </div>

      <section aria-label="Filters" className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-surface px-4 py-4 sm:grid-cols-3 lg:grid-cols-7">
        <Select
          label="Segment"
          value={filters.segment ?? ""}
          onChange={(v) => set({ segment: v, signal: undefined })}
          options={[["", "Both"], ...(["A", "B"] as Segment[]).map((s): [string, string] => [s, SEGMENT_LABELS[s].name])]}
        />
        <Select
          label="Country"
          value={filters.country ?? ""}
          onChange={(v) => set({ country: v, city: undefined })}
          options={[
            ["", "All"],
            ...(countries.data ?? [])
              .filter(searchable)
              .map((c): [string, string] => [c.code, c.enabled ? c.name : `${c.name} (job search)`]),
          ]}
        />
        <Select
          label="Crawl"
          value={filters.crawl ?? ""}
          onChange={(v) => set({ crawl: v })}
          options={[
            ["", "Any"],
            ["new", "Not crawled yet"],
            ["readable", "Read"],
            ["problem", "Could not read"],
          ]}
        />
        <Select
          label="E-mail"
          value={filters.hasEmail === undefined ? "" : String(filters.hasEmail)}
          onChange={(v) => set({ hasEmail: v })}
          options={[
            ["", "Any"],
            ["true", "Has a primary e-mail"],
            ["false", "No e-mail yet"],
          ]}
        />
        {hiringView ? (
          <Select
            label="Job"
            value={filters.jobFlag ?? ""}
            onChange={(v) => set({ jobFlag: v })}
            options={[
              ["", "Any developer job"],
              ["remote", "Remote / home office"],
              ["visa", "Visa or relocation help"],
              ["english", "English-speaking team"],
              ["no_local_lang", "No “fluent German/Dutch/French/Polish” demand"],
            ]}
          />
        ) : (
          <Select
            label="Signal"
            value={filters.signal ?? ""}
            onChange={(v) => set({ signal: v })}
            options={[["", "Any"], ...usefulSignals.map((s): [string, string] => [s.key, s.label])]}
          />
        )}
        <Select
          label="Sort by"
          value={filters.sort ?? "score"}
          onChange={(v) => set({ sort: v === "score" ? undefined : v })}
          options={[
            ["score", "Lead score"],
            ["fit", "Fit"],
            ["need", "Need"],
            ["name", "Name"],
            ["newest", "Newest"],
          ]}
        />
        <label className="col-span-2 flex flex-col gap-1 text-sm sm:col-span-3 lg:col-span-1">
          <span className="text-ink-2">Search</span>
          <input
            type="search"
            defaultValue={filters.q ?? ""}
            placeholder="Name, domain or e-mail"
            onKeyDown={(e) => {
              if (e.key === "Enter") set({ q: (e.target as HTMLInputElement).value.trim() });
            }}
            onBlur={(e) => {
              if (e.target.value.trim() !== (filters.q ?? "")) set({ q: e.target.value.trim() });
            }}
            className="rounded-lg border border-line px-2.5 py-2"
          />
        </label>
        <MoreFilters filters={filters} set={set} />
      </section>

      <section aria-label="Leads" className="overflow-hidden rounded-xl border border-line bg-surface">
        {leads.isPending && <p className="px-5 py-6 text-ink-2">Loading…</p>}
        {leads.isError && <p className="px-5 py-6 text-bad">{leads.error.message}</p>}
        {leads.data && leads.data.items.length === 0 && (
          <p className="px-5 py-6 text-ink-2">
            {total === 0
              ? "No leads saved yet. Import an area on the Finder page first."
              : hiringView
                ? "No company with a developer job found yet. Crawl more websites (agencies hire most often)."
                : "No leads match these filters."}
          </p>
        )}
        {leads.data && leads.data.items.length > 0 && (
          <ul className={`divide-y divide-line-soft md:hidden ${leads.isPlaceholderData ? "opacity-60" : ""}`}>
            {leads.data.items.map((l) => (
              <li key={l.id} className="px-4 py-3">
                <button type="button" onClick={() => set({ lead: String(l.id) }, true)} className="w-full text-left">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{l.name}</p>
                      <p className="truncate text-sm text-ink-3">
                        {l.domain} · {l.city ?? l.country}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-3 text-sm">
                      <Score value={l.fitScore} label="Fit" />
                      <Score value={l.needScore} label="Need" />
                    </div>
                  </div>
                  <div className="mt-2 text-sm">
                    {l.suppressed ? (
                      <SuppressedBadge />
                    ) : l.primaryEmail ? (
                      <span className="break-all">{l.primaryEmail}</span>
                    ) : (
                      <CrawlBadge status={l.crawlStatus} />
                    )}
                  </div>
                  {hiringView && (
                    <div className="mt-2">
                      <JobCell role={l.hiringRole} url={null} stackMatch={l.stackMatch} flags={l.jobFlags} applyEmail={l.applyEmail} />
                    </div>
                  )}
                  {!hiringView && l.signals.filter((k) => k !== "tech_stack").length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {l.signals
                        .filter((k) => k !== "tech_stack")
                        .slice(0, 3)
                        .map((k, i) => (
                          <SignalChip key={k} label={signalLabel(k)} strong={i === 0} />
                        ))}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {leads.data && leads.data.items.length > 0 && (
          <div className="hidden overflow-x-auto md:block">
            <table className={`w-full text-sm ${leads.isPlaceholderData ? "opacity-60" : ""}`}>
              <thead className="text-left text-ink-2">
                <tr className="border-b border-line-soft">
                  <th className="px-4 py-2.5 font-medium">Lead</th>
                  <th className="px-4 py-2.5 font-medium">Place</th>
                  <th className="px-4 py-2.5 font-medium">E-mail</th>
                  <th className="px-4 py-2.5 text-right font-medium">Fit</th>
                  <th className="px-4 py-2.5 text-right font-medium">Need</th>
                  {hiringView ? (
                    <th className="px-4 py-2.5 font-medium">Job</th>
                  ) : (
                    <th className="px-4 py-2.5 font-medium">Signals</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {leads.data.items.map((l) => (
                  <tr key={l.id} className="align-top hover:bg-paper/60">
                    <td className="max-w-[18rem] px-4 py-3">
                      <button
                        type="button"
                        onClick={() => set({ lead: String(l.id) }, true)}
                        className="text-left font-medium underline-offset-2 hover:underline"
                      >
                        {l.name}
                      </button>
                      <p className="truncate text-ink-3">{l.domain}</p>
                      <p className="text-xs text-ink-3">
                        {l.categoryLabel} · {l.segment}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-ink-2">
                      {l.city ?? "–"}
                      <span className="block text-xs text-ink-3">{l.country}</span>
                    </td>
                    <td className="max-w-[16rem] px-4 py-3">
                      {l.suppressed ? (
                        <SuppressedBadge />
                      ) : l.primaryEmail ? (
                        <span className="break-all">{l.primaryEmail}</span>
                      ) : (
                        <CrawlBadge status={l.crawlStatus} />
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Score value={l.fitScore} label="Fit" />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Score value={l.needScore} label="Need" />
                    </td>
                    {hiringView ? (
                      <td className="max-w-[20rem] px-4 py-3">
                        <JobCell role={l.hiringRole} url={l.jobUrl} stackMatch={l.stackMatch} flags={l.jobFlags} applyEmail={l.applyEmail} />
                      </td>
                    ) : (
                    <td className="px-4 py-3">
                      <div className="flex max-w-[20rem] flex-wrap gap-1">
                        {l.signals
                          .filter((k) => k !== "tech_stack")
                          .slice(0, 4)
                          .map((k, i) => (
                            <SignalChip key={k} label={signalLabel(k)} strong={i === 0} />
                          ))}
                        {l.bestOffer && <SignalChip label={l.bestOffer === "agent" ? "→ AI agent" : "→ AI chatbot"} />}
                      </div>
                    </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {leads.data && leads.data.total > PAGE_SIZE && (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-line-soft px-4 py-3 text-sm">
            <span className="text-ink-2">
              {formatNumber((filters.page! - 1) * PAGE_SIZE + 1)}–{formatNumber(Math.min(filters.page! * PAGE_SIZE, leads.data.total))} of{" "}
              {formatNumber(leads.data.total)}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={filters.page! <= 1}
                onClick={() => set({ page: String(filters.page! - 1) })}
                className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={filters.page! >= pages}
                onClick={() => set({ page: String(filters.page! + 1) })}
                className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </nav>
        )}
      </section>

      {openId !== null && <LeadDrawer id={openId} onClose={() => set({ lead: undefined }, true)} />}
    </div>
  );
}
