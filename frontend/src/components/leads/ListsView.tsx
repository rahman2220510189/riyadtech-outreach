"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DownloadButton } from "@/components/DownloadButton";
import { formatNumber } from "@/lib/finder";
import { listExportUrl, useDeleteList, useList, useLists } from "@/lib/leads";

function when(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function ListsView() {
  const lists = useLists();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/leads" className="text-sm text-ink-2 underline underline-offset-4">
            Leads
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Imported lists</h1>
          <p className="mt-1 text-ink-2">Your own CSV files. Campaigns (Phase 5) can use them next to the found leads.</p>
        </div>
        <Link href="/leads/import" className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
          Import CSV
        </Link>
      </div>
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        {lists.isPending && <p className="px-5 py-6 text-ink-2">Loading…</p>}
        {lists.isError && <p className="px-5 py-6 text-bad">{lists.error.message}</p>}
        {lists.data?.length === 0 && <p className="px-5 py-6 text-ink-2">No lists yet. Import a CSV file to start.</p>}
        {lists.data && lists.data.length > 0 && (
          <ul className="divide-y divide-line-soft">
            {lists.data.map((l) => (
              <li key={l.id}>
                <Link href={`/leads/lists/${l.id}`} className="block px-5 py-3 hover:bg-paper/60">
                  <p className="font-medium">{l.name}</p>
                  <p className="text-sm text-ink-2">
                    {formatNumber(l.counts.ok)} ready · {formatNumber(l.counts.suppressed)} suppressed · {formatNumber(l.counts.duplicate)} duplicates ·{" "}
                    {formatNumber(l.counts.invalid)} invalid · {l.fileName ?? "pasted"} · {when(l.createdAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const STATUS_TEXT = { ok: "Ready", suppressed: "Suppressed", duplicate: "Duplicate" } as const;
const STATUS_STYLE = {
  ok: "bg-go-soft text-go",
  suppressed: "bg-bad-soft text-bad",
  duplicate: "bg-paper text-ink-2",
} as const;

export function ListView({ id }: { id: number }) {
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(1);
  const del = useDeleteList();
  const list = useList(id, { ...(status ? { status } : {}), page }, del.isIdle || del.isError);
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const l = list.data;
  if (del.isPending || del.isSuccess) return <p className="text-ink-2">Deleting the list…</p>;
  if (list.isPending) return <p className="text-ink-2">Loading…</p>;
  if (list.isError || !l) return <p className="text-bad">{list.error?.message ?? "Not found"}</p>;
  const customKeys = [...new Set(l.items.flatMap((r) => Object.keys(r.custom ?? {})))];
  const pages = Math.max(1, Math.ceil(l.total / l.pageSize));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/leads/lists" className="text-sm text-ink-2 underline underline-offset-4">
            Imported lists
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{l.name}</h1>
          <p className="mt-1 text-ink-2">
            Now: {formatNumber(l.now.ok ?? 0)} ready · {formatNumber(l.now.suppressed ?? 0)} suppressed · {formatNumber(l.now.duplicate ?? 0)} duplicates
            {customKeys.length ? ` · extra columns: ${customKeys.map((k) => `{${k}}`).join(", ")}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DownloadButton url={listExportUrl(id)} fallbackName="list.csv" label="Export ready rows" />
          {confirm ? (
            <button
              type="button"
              onClick={() => del.mutate(id, { onSuccess: () => router.replace("/leads/lists") })}
              className="rounded-lg bg-bad px-4 py-2.5 text-sm font-medium text-white"
            >
              Yes, delete the list
            </button>
          ) : (
            <button type="button" onClick={() => setConfirm(true)} className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-bad hover:bg-bad-soft">
              Delete list
            </button>
          )}
        </div>
      </div>
      <div role="tablist" aria-label="Status" className="inline-flex rounded-lg border border-line bg-surface p-1 text-sm">
        {[
          ["", "All"],
          ["ok", "Ready"],
          ["suppressed", "Suppressed"],
          ["duplicate", "Duplicates"],
        ].map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={status === v}
            onClick={() => {
              setStatus(v!);
              setPage(1);
            }}
            className={`rounded-md px-3 py-1.5 font-medium ${status === v ? "bg-ink text-white" : "text-ink-2 hover:bg-paper"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="text-ink-2">
            <tr className="border-b border-line-soft">
              <th className="px-4 py-2.5 font-medium">Row</th>
              <th className="px-4 py-2.5 font-medium">E-mail</th>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Company</th>
              <th className="px-4 py-2.5 font-medium">Place</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {l.items.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-4 py-2.5 text-ink-3">{r.rowNumber}</td>
                <td className="break-all px-4 py-2.5">{r.email}</td>
                <td className="px-4 py-2.5">{r.firstName ?? "–"}</td>
                <td className="px-4 py-2.5">
                  {r.company ?? "–"}
                  {r.placeId && (
                    <Link href={`/leads?lead=${r.placeId}`} className="block text-xs text-ink-3 underline underline-offset-2">
                      Also a found lead
                    </Link>
                  )}
                </td>
                <td className="px-4 py-2.5 text-ink-2">{[r.city, r.country].filter(Boolean).join(", ") || "–"}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{STATUS_TEXT[r.status]}</span>
                  {r.note && <span className="mt-0.5 block text-xs text-ink-3">{r.note}</span>}
                </td>
              </tr>
            ))}
            {l.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-ink-2">
                  No rows with this status.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {l.total > l.pageSize && (
          <nav aria-label="Pages" className="flex items-center justify-between border-t border-line-soft px-4 py-3 text-sm">
            <span className="text-ink-2">
              Page {page} of {pages}
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
