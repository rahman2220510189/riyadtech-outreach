"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/finder";
import {
  REASON_LABELS,
  type SuppressionReason,
  useAddSuppression,
  useImportSuppression,
  useRemoveSuppression,
  useSuppression,
} from "@/lib/leads";

const REASONS = Object.keys(REASON_LABELS) as SuppressionReason[];
const field = "rounded-lg border border-line bg-surface px-3 py-2";

function AddForm() {
  const add = useAddSuppression();
  const [value, setValue] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("manual");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ value: value.trim(), reason }, { onSuccess: () => setValue("") });
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-sm">
        <span className="font-medium">E-mail address or domain</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="info@acme.com or acme.com" className={field} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Reason</span>
        <select value={reason} onChange={(e) => setReason(e.target.value as SuppressionReason)} className={field}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={!value.trim() || add.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
        Add
      </button>
      <p aria-live="polite" className="w-full text-sm">
        {add.error ? <span className="text-bad">{add.error.message}</span> : add.isSuccess ? <span className="text-go">Added: {add.data.item.value}</span> : null}
      </p>
    </form>
  );
}

function ImportForm() {
  const imp = useImportSuppression();
  const [text, setText] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("manual");
  return (
    <details className="rounded-xl border border-line bg-surface">
      <summary className="cursor-pointer px-5 py-3 font-semibold">Import many (paste or a file)</summary>
      <div className="space-y-3 px-5 pb-4">
        <p className="text-sm text-ink-2">One address or domain per line (commas and semicolons work too). A one-column CSV file works as well.</p>
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          aria-label="Suppression file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then(setText);
          }}
          className="block text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:font-medium"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          aria-label="Addresses and domains"
          className={`${field} w-full font-mono text-xs`}
        />
        <div className="flex flex-wrap items-center gap-3">
          <select value={reason} onChange={(e) => setReason(e.target.value as SuppressionReason)} className={field} aria-label="Reason for all">
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {REASON_LABELS[r]}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!text.trim() || imp.isPending}
            onClick={() => imp.mutate({ text, reason }, { onSuccess: () => setText("") })}
            className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50"
          >
            {imp.isPending ? "Importing…" : "Import"}
          </button>
          <span aria-live="polite" className="text-sm">
            {imp.error ? (
              <span className="text-bad">{imp.error.message}</span>
            ) : imp.data ? (
              <span className="text-go">
                {formatNumber(imp.data.added)} added, {formatNumber(imp.data.alreadyListed)} already listed
                {imp.data.invalid.length ? `, not understood: ${imp.data.invalid.slice(0, 5).join(", ")}` : ""}
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </details>
  );
}

export function SuppressionView() {
  const [q, setQ] = useState("");
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);
  const list = useSuppression({ ...(q ? { q } : {}), ...(reason ? { reason } : {}), page });
  const remove = useRemoveSuppression();
  const d = list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Suppression</h1>
        <p className="mt-1 max-w-prose text-ink-2">
          Addresses and whole domains that are never contacted: checked when leads are found or imported, when a campaign
          queues an e-mail and again right before it is sent.
        </p>
      </div>
      <section className="rounded-xl border border-line bg-surface px-5 py-4">
        <AddForm />
      </section>
      <ImportForm />
      <section className="rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap items-end gap-3 border-b border-line-soft px-5 py-4">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-ink-2">Search</span>
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-2">Reason</span>
            <select
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setPage(1);
              }}
              className={field}
            >
              <option value="">All</option>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABELS[r]} ({formatNumber(d?.byReason[r] ?? 0)})
                </option>
              ))}
            </select>
          </label>
        </div>
        {list.isPending && <p className="px-5 py-6 text-ink-2">Loading…</p>}
        {list.isError && <p className="px-5 py-6 text-bad">{list.error.message}</p>}
        {d && d.items.length === 0 && <p className="px-5 py-6 text-ink-2">Nothing on the list{q || reason ? " for this search" : " yet"}.</p>}
        {d && d.items.length > 0 && (
          <ul className="divide-y divide-line-soft">
            {d.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="break-all font-medium">
                    {r.kind === "domain" ? `Everyone at ${r.value}` : r.value}
                  </p>
                  <p className="text-ink-3">
                    {REASON_LABELS[r.reason]} · {r.source} · {new Date(r.createdAt).toLocaleDateString("en-GB")}
                    {r.note ? ` · ${r.note}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(r.id)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper"
                  aria-label={`Remove ${r.value}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {d && d.total > d.pageSize && (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-line-soft px-5 py-3 text-sm">
            <span className="text-ink-2">
              {formatNumber(d.total)} entries · page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40">
                Previous
              </button>
              <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40">
                Next
              </button>
            </div>
          </nav>
        )}
      </section>
    </div>
  );
}
