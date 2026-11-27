"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { SEGMENT_LABELS, formatNumber } from "@/lib/finder";
import { type LeadDetail, type SuppressionReason, useAddSuppression, useLead } from "@/lib/leads";
import { CrawlBadge, Score, SuppressedBadge } from "./bits";

function host(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-t border-line-soft px-5 py-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const KIND_TEXT = { generic: "General", named: "Person", role: "Department (not used)" } as const;
const MATCH_TEXT = { own: "own domain", free: "free mail", other: "other domain" } as const;

function Emails({ lead }: { lead: LeadDetail }) {
  if (lead.emails.length === 0) {
    return (
      <p className="text-sm text-ink-2">
        {lead.crawlStatus === null ? "Not crawled yet." : "No public e-mail address was found on the website."}
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {lead.emails.map((e) => (
        <li key={e.email} className="text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-medium">{e.email}</span>
            {e.isPrimary && <span className="rounded-full bg-ink px-2 py-0.5 text-xs font-semibold text-white">Primary</span>}
            {e.mxValid === false && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-xs font-semibold text-bad">No mail server</span>}
            {e.suppressed && <SuppressedBadge />}
          </div>
          <p className="mt-0.5 text-ink-2">
            {KIND_TEXT[e.kind]}, {MATCH_TEXT[e.domainMatch]}
            {e.firstName ? `, first name ${e.firstName}` : ""}
            {e.mxValid === null ? ", mail server not checked" : ""}
          </p>
          {e.onSite ? (
            <p className="mt-0.5 text-ink-3">
              Published on{" "}
              <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
                {host(e.sourceUrl)}
              </a>
              {e.origin === "overture" ? " (also listed by Overture)" : ""}
            </p>
          ) : (
            <p className="mt-0.5 text-ink-3">
              From Overture Maps open data{e.sourceRelease ? ` (release ${e.sourceRelease})` : ""}. Not seen on the website yet.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Quick suppression: this address, or the whole company (domain), never contacted again. */
function NeverContact({ lead }: { lead: LeadDetail }) {
  const add = useAddSuppression();
  const [done, setDone] = useState<string | null>(null);
  const act = (value: string, reason: SuppressionReason, label: string) =>
    add.mutate({ value, reason, note: `From the lead "${lead.name}"` }, { onSuccess: () => setDone(label) });
  if (lead.suppressed) return <p className="text-sm text-ink-2">This lead is on the suppression list and is never contacted.</p>;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        {lead.primaryEmail && (
          <button
            type="button"
            disabled={add.isPending}
            onClick={() => act(lead.primaryEmail!, "manual", "Address suppressed.")}
            className="rounded-lg border border-line px-3 py-1.5 font-medium hover:bg-paper"
          >
            Suppress {lead.primaryEmail}
          </button>
        )}
        <button
          type="button"
          disabled={add.isPending}
          onClick={() => act(lead.domain, "manual", "Whole domain suppressed.")}
          className="rounded-lg border border-line px-3 py-1.5 font-medium hover:bg-paper"
        >
          Suppress all of {lead.domain}
        </button>
        <button
          type="button"
          disabled={add.isPending}
          onClick={() => act(lead.domain, "client", "Marked as client or partner.")}
          className="rounded-lg border border-line px-3 py-1.5 font-medium hover:bg-paper"
        >
          Existing client or partner
        </button>
      </div>
      {done && <p className="text-go">{done}</p>}
      {add.error && <p className="text-bad">{add.error.message}</p>}
    </div>
  );
}

function Signals({ lead }: { lead: LeadDetail }) {
  if (lead.signals.length === 0) {
    return <p className="text-sm text-ink-2">{lead.crawlStatus === null ? "Not crawled yet." : "No signals found."}</p>;
  }
  return (
    <ul className="space-y-3">
      {lead.signals.map((s) => (
        <li key={s.key} className="text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {s.label}
              {s.value ? <span className="font-normal text-ink-2">: {s.value}</span> : null}
            </span>
            <span className="text-xs text-ink-3">
              {s.score === "need" ? "need" : "fit"} +{s.weight}
            </span>
          </div>
          {s.snippet && <p className="mt-1 rounded-md bg-paper px-2.5 py-1.5 text-ink-2">{s.snippet}</p>}
          {s.evidenceUrl && (
            <a href={s.evidenceUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block break-all text-ink-3 underline underline-offset-2">
              {host(s.evidenceUrl)}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function Crawl({ lead }: { lead: LeadDetail }) {
  const c = lead.crawl;
  if (!c) return <p className="text-sm text-ink-2">This website has not been crawled yet.</p>;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-2">
        {lead.crawlStatusText ? `${lead.crawlStatusText[0]?.toUpperCase()}${lead.crawlStatusText.slice(1)}` : c.status}
        {c.error ? `: ${c.error}` : ""}. Checked {new Date(c.finishedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
        {c.jobId ? (
          <>
            {" "}
            (
            <Link href={`/finder/jobs/${c.jobId}`} className="underline underline-offset-2">
              crawl #{c.jobId}
            </Link>
            )
          </>
        ) : null}
        .
      </p>
      {c.robots && c.robots.status !== "not_read" && (
        <p className="text-ink-2">
          robots.txt: {c.robots.note}
          {c.robots.crawlDelaySeconds ? `, Crawl-delay ${c.robots.crawlDelaySeconds} s (respected)` : ""}.
        </p>
      )}
      {c.tech.length > 0 && <p className="text-ink-2">Website built with: {c.tech.join(", ")}.</p>}
      {c.jobBoard && (
        <p className="text-ink-2">
          Job platform:{" "}
          <a href={c.jobBoard.boardUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {c.jobBoard.provider}
          </a>
          {c.jobBoard.note && c.jobBoard.jobs === 0
            ? ` (${c.jobBoard.note})`
            : `, ${c.jobBoard.jobs} open job(s), ${c.jobBoard.developerJobs} for developers`}
          .
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-ink-3">
            <tr>
              <th className="py-1 pr-3 font-medium">Page</th>
              <th className="py-1 pr-3 font-medium">Kind</th>
              <th className="py-1 font-medium">Answer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {c.pages.map((p, i) => (
              <tr key={`${p.url}-${i}`} className="align-top">
                <td className="max-w-[16rem] break-all py-1.5 pr-3">{host(p.url)}</td>
                <td className="py-1.5 pr-3 text-ink-2">{p.kind}</td>
                <td className="py-1.5 text-ink-2">
                  {p.status ?? "–"}
                  {p.note ? <span className="block text-xs text-ink-3">{p.note}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Side panel with everything known about one lead, and the proof for it. */
export function LeadDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const lead = useLead(id);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const l = lead.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-title"
        className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-surface shadow-xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-surface px-5 py-4">
          <div className="min-w-0">
            <h2 id="lead-title" className="text-lg font-semibold leading-snug">
              {l?.name ?? "Lead"}
            </h2>
            {l && (
              <p className="mt-0.5 text-sm text-ink-2">
                {l.categoryLabel} · {SEGMENT_LABELS[l.segment].name}
                {l.city ? ` · ${l.city}` : ""} · {l.country}
              </p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper"
          >
            Close
          </button>
        </div>

        {lead.isPending && <p className="px-5 py-6 text-ink-2">Loading…</p>}
        {lead.isError && (
          <p className="px-5 py-6 text-bad">
            {lead.error instanceof ApiError && lead.error.status === 404 ? "This lead no longer exists." : lead.error.message}
          </p>
        )}
        {l && (
          <>
            <div className="space-y-3 px-5 py-4">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <a href={l.website} target="_blank" rel="noopener noreferrer" className="break-all font-medium underline underline-offset-2">
                  {l.domain}
                </a>
                <CrawlBadge status={l.crawlStatus} />
                {l.bestOffer && (
                  <span className="rounded-full border border-line px-2 py-0.5 text-xs font-medium">
                    Best offer: {l.bestOffer === "agent" ? "AI agent" : "AI chatbot"}
                  </span>
                )}
              </div>
              <dl className="grid grid-cols-3 gap-3 rounded-lg bg-paper px-4 py-3 text-sm">
                <div>
                  <dt className="text-ink-2">Fit</dt>
                  <dd className="mt-1">
                    <Score value={l.fitScore} label="Fit" />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-2">Need</dt>
                  <dd className="mt-1">
                    <Score value={l.needScore} label="Need" />
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-2">Lead score</dt>
                  <dd className="mt-1">
                    <Score value={l.leadScore} label="Lead score" />
                  </dd>
                </div>
              </dl>
              {l.jobSearchOnly && (
                <p className="rounded-lg bg-paper px-3 py-2 text-sm text-ink-2">
                  {l.country} is set to job search only: this company is here so you can apply for a job. It is never
                  e-mailed for sales.
                </p>
              )}
              {l.signalLine && !l.jobSearchOnly && (
                <figure className="text-sm">
                  <figcaption className="text-ink-3">Opening line for the e-mail</figcaption>
                  <blockquote className="mt-1 border-l-2 border-ink/40 pl-3">{l.signalLine}</blockquote>
                </figure>
              )}
              <p className="text-sm text-ink-2">
                {[l.address, l.postcode].filter(Boolean).join(", ") || "No street address"}
                {l.phone ? ` · ${l.phone}` : ""}
                {l.locationCount > 1 ? ` · ${formatNumber(l.locationCount)} locations` : ""}
              </p>
              {l.socials.length > 0 && (
                <p className="flex flex-wrap gap-x-3 text-sm">
                  {l.socials.map((u) => (
                    <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="break-all text-ink-2 underline underline-offset-2">
                      {host(u)}
                    </a>
                  ))}
                </p>
              )}
            </div>
            <Section title="E-mail addresses">
              <Emails lead={l} />
              {l.emails.some((e) => !e.onSite && e.origin === "overture") && (
                <p className="mt-3 text-xs text-ink-3">
                  Addresses from Overture are checked like the ones on websites (junk, department addresses, mail server) and can be
                  used before the crawl. An address found on the website always wins. In countries that only allow addresses published
                  on the business&apos;s own site (Australia), they wait for the crawl.
                </p>
              )}
            </Section>
            <Section title="Signals" aside={<span className="text-xs text-ink-3">with the text they were found in</span>}>
              <Signals lead={l} />
            </Section>
            <Section title="Website crawl">
              <Crawl lead={l} />
            </Section>
            <Section title="History">
              <p className="text-sm text-ink-2">No e-mails sent yet. Sends and replies show here once campaigns are running.</p>
            </Section>
            <Section title="Never contact">
              <NeverContact lead={l} />
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
