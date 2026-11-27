"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatNumber } from "@/lib/finder";
import {
  type CampaignDetail,
  LEAD_STATUS_TEXT,
  STATUS_TEXT,
  useCampaign,
  useCampaignAction,
  useCampaignOptions,
  useCampaignPreview,
  useDeleteCampaign,
  useStopCampaignLead,
} from "@/lib/campaigns";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

/** One campaign: what it sends, its controls, and every company in it. */
export function CampaignDetailView({ id }: { id: number }) {
  const q = useCampaign(id);
  if (q.isPending) return <p className="text-ink-2">Loading…</p>;
  if (q.isError) return <p className="text-bad">{q.error.message}</p>;
  const c = q.data;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/campaigns" className="text-sm underline underline-offset-4">
          ← All campaigns
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{c.name}</h1>
        <p className="mt-1 text-ink-2">
          {STATUS_TEXT[c.status]} · from {c.mailbox} · {formatNumber(c.leads.length)} companies · {formatNumber(c.sent)} sent
          {c.previews > 0 ? ` · ${formatNumber(c.previews)} previews` : ""}
        </p>
      </div>
      <Controls c={c} />
      {c.note && <p className="rounded-xl border border-line bg-paper px-5 py-3 text-sm">{c.note}</p>}
      <Preview id={id} />
      <Leads c={c} />
    </div>
  );
}

function Controls({ c }: { c: CampaignDetail }) {
  const action = useCampaignAction(c.id);
  const del = useDeleteCampaign();
  const opts = useCampaignOptions();
  const router = useRouter();
  const sending = opts.data?.sendingEnabled ?? false;
  const first = opts.data?.firstCampaign ?? false;
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface px-5 py-4">
      {(c.status === "draft" || c.status === "paused") && (
        <p className="text-sm text-ink-2">
          {!sending
            ? "Sending is switched off: Start writes each e-mail as a preview at the time it would go out. Nothing leaves."
            : first && c.status === "draft"
              ? "This is your first real campaign: it sends 5 e-mails and then pauses, so you can check them in your Sent folder before the rest go."
              : "E-mails go out one by one, in each company's office hours (weekdays 09:00–17:00 their time), 2–6 minutes apart, within the mailbox's daily warm-up limit."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {(c.status === "draft" || c.status === "paused") && (
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate("launch")}
            className="rounded-lg bg-go px-4 py-2.5 text-sm font-medium text-white hover:bg-go/90 disabled:opacity-50"
          >
            {c.status === "draft" ? (sending ? "Start sending" : "Start (preview only)") : "Resume"}
          </button>
        )}
        {c.status === "running" && (
          <button type="button" disabled={action.isPending} onClick={() => action.mutate("pause")} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium">
            Pause
          </button>
        )}
        {(c.status === "running" || c.status === "paused") && (
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => {
              if (window.confirm("Stop this campaign? Companies that did not get an e-mail yet will not get one.")) action.mutate("stop");
            }}
            className="text-sm text-bad underline underline-offset-4"
          >
            Stop campaign
          </button>
        )}
        {c.status === "draft" && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm("Delete this draft? The companies go back to Ready now.")) del.mutate(c.id, { onSuccess: () => router.push("/campaigns") });
            }}
            className="text-sm text-bad underline underline-offset-4"
          >
            Delete draft
          </button>
        )}
        {action.error && <span className="text-sm text-bad">{action.error.message}</span>}
      </div>
    </section>
  );
}

function Preview({ id }: { id: number }) {
  const [step, setStep] = useState(1);
  const p = useCampaignPreview(id, step);
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface px-5 py-4" aria-labelledby="preview-h">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="preview-h" className="font-semibold">
          What they will get
        </h2>
        <div role="tablist" aria-label="Step" className="inline-flex rounded-lg border border-line p-1 text-sm">
          {[1, 2, 3].map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={step === s}
              onClick={() => setStep(s)}
              className={`rounded-md px-3 py-1 ${step === s ? "bg-ink text-white" : "text-ink-2"}`}
            >
              {s === 1 ? "First e-mail" : `Follow-up ${s - 1}`}
            </button>
          ))}
        </div>
      </div>
      {p.isPending && <p className="text-sm text-ink-2">Loading…</p>}
      {p.data?.length === 0 && <p className="text-sm text-ink-2">No company is waiting for an e-mail.</p>}
      {p.data?.map((m) => (
        <article key={m.leadId} className="rounded-lg border border-line-soft">
          <header className="border-b border-line-soft px-4 py-2 text-sm">
            <div>
              <span className="text-ink-3">To:</span> {m.to} <span className="text-ink-3">({m.company})</span>
            </div>
            <div>
              <span className="text-ink-3">Subject:</span> <span className="font-medium">{m.subject}</span>
            </div>
          </header>
          {m.waitingForCrawl && m.missing.length > 0 ? (
            <p className="px-4 py-3 text-sm text-ink-2">The website is read first; the opening line comes from it.</p>
          ) : (
            <pre className="whitespace-pre-wrap px-4 py-3 font-[inherit] text-sm leading-relaxed">{m.text}</pre>
          )}
        </article>
      ))}
    </section>
  );
}

function Leads({ c }: { c: CampaignDetail }) {
  const stop = useStopCampaignLead(c.id);
  const [filter, setFilter] = useState("");
  const rows = c.leads.filter((l) => !filter || l.email.includes(filter.toLowerCase()) || l.company.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section className="space-y-3" aria-labelledby="leads-h">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="leads-h" className="font-semibold">
            Companies
          </h2>
          <p className="max-w-prose text-sm text-ink-2">
            Someone answered in your mailbox? Find them here and press &ldquo;They replied&rdquo;: no more follow-ups go to them.
          </p>
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find an address or company" aria-label="Find" className="w-64 rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
      </div>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="text-left text-ink-2">
            <tr className="border-b border-line-soft">
              <th className="px-4 py-2.5 font-medium">Company</th>
              <th className="px-4 py-2.5 font-medium">Address</th>
              <th className="px-4 py-2.5 font-medium">Sent</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Next</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {rows.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2.5">
                  <div className="font-medium">{l.company}</div>
                  <div className="text-xs text-ink-3">{l.website}</div>
                </td>
                <td className="px-4 py-2.5 break-all">{l.email}</td>
                <td className="px-4 py-2.5">{l.step} of 3</td>
                <td className="px-4 py-2.5">
                  {LEAD_STATUS_TEXT[l.status]}
                  {l.reason && <div className="text-xs text-ink-3">{l.reason}</div>}
                </td>
                <td className="px-4 py-2.5 text-ink-2">{l.status === "queued" ? when(l.nextAt) : "—"}</td>
                <td className="px-4 py-2.5 text-right">
                  {(l.status === "queued" || l.status === "waiting_crawl") && (
                    <span className="flex justify-end gap-3">
                      <button type="button" disabled={stop.isPending} onClick={() => stop.mutate({ leadId: l.id, reason: "replied" })} className="font-medium underline underline-offset-2">
                        They replied
                      </button>
                      <button type="button" disabled={stop.isPending} onClick={() => stop.mutate({ leadId: l.id, reason: "manual" })} className="text-ink-2 underline underline-offset-2">
                        Stop
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
