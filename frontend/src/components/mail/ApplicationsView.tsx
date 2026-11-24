"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatNumber } from "@/lib/finder";
import {
  APPLICATION_STATUS_LABELS,
  type ApplicationStatus,
  cvDownloadUrl,
  useApplications,
  useCreateApplication,
  useCvFiles,
  useDeleteCv,
  useUploadCv,
} from "@/lib/mail";

const field = "rounded-lg border border-line bg-surface px-3 py-2";

export const STATUS_STYLE: Record<ApplicationStatus, string> = {
  draft: "bg-paper text-ink-2",
  sent: "bg-go-soft text-go",
  failed: "bg-bad-soft text-bad",
  applied_elsewhere: "bg-go-soft text-go",
  interview: "bg-ink text-white",
  rejected: "bg-paper text-ink-3",
  offer: "bg-go text-white",
  no_answer: "bg-paper text-ink-3",
};

function CvPanel() {
  const files = useCvFiles();
  const upload = useUploadCv();
  const del = useDeleteCv();
  const [label, setLabel] = useState("CV (English)");
  const [error, setError] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setError("The file is larger than 5 MB.");
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    upload.mutate({ label: label.trim() || f.name, fileName: f.name, dataBase64: btoa(bin) });
  };
  return (
    <section className="rounded-xl border border-line bg-surface px-5 py-4">
      <h2 className="font-semibold">CV files</h2>
      <p className="mt-1 text-sm text-ink-2">Attached to applications (PDF is best, at most 5 MB). The newest one is chosen for new drafts.</p>
      <ul className="mt-3 divide-y divide-line-soft">
        {files.data?.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span>
              <strong>{f.label}</strong> · {f.fileName} · {formatNumber(Math.round(f.size / 1024))} KB
            </span>
            <span className="flex gap-2">
              <a href={cvDownloadUrl(f.id)} className="underline underline-offset-4">
                Download
              </a>
              <button type="button" onClick={() => del.mutate(f.id)} className="text-bad underline underline-offset-4" aria-label={`Delete ${f.label}`}>
                Delete
              </button>
            </span>
          </li>
        ))}
        {files.data?.length === 0 && <li className="py-2 text-sm text-ink-2">No CV yet.</li>}
      </ul>
      <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={field} />
        </label>
        <input
          type="file"
          accept=".pdf,.doc,.docx"
          aria-label="CV file"
          onChange={(e) => void onFile(e.target.files?.[0])}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:font-medium"
        />
        {upload.isPending && <span className="text-ink-2">Uploading…</span>}
        {(error ?? upload.error?.message) && <span className="text-bad">{error ?? upload.error?.message}</span>}
        {upload.isSuccess && <span className="text-go">Saved.</span>}
      </div>
    </section>
  );
}

function NewApplication() {
  const router = useRouter();
  const create = useCreateApplication();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ company: "", role: "", toEmail: "" });
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium hover:bg-paper">
        New application without an advert
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ company: f.company, role: f.role, ...(f.toEmail ? { toEmail: f.toEmail } : {}) }, { onSuccess: (a) => router.push(`/applications/${a.id}`) });
      }}
      className="flex w-full flex-wrap items-end gap-3 rounded-xl border border-line bg-surface px-5 py-4 text-sm"
    >
      <label className="flex flex-col gap-1">
        <span className="font-medium">Company</span>
        <input required value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Role</span>
        <input required value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-medium">Send to (optional)</span>
        <input type="email" value={f.toEmail} onChange={(e) => setF({ ...f, toEmail: e.target.value })} className={field} />
      </label>
      <button type="submit" disabled={create.isPending} className="rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90">
        Write it
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-ink-2 underline underline-offset-4">
        Cancel
      </button>
      {create.error && <span className="text-bad">{create.error.message}</span>}
    </form>
  );
}

const TABS: [string, string][] = [
  ["all", "All"],
  ["open", "To send"],
  ["sent", "Sent"],
  ["applied_elsewhere", "Applied on their site"],
  ["interview", "Interview"],
  ["offer", "Offer"],
  ["rejected", "Rejected"],
  ["no_answer", "No answer"],
];

export function ApplicationsView() {
  const [status, setStatus] = useState("all");
  const q = useApplications(status);
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Applications</h1>
          <p className="mt-1 max-w-prose text-ink-2">
            Write an application from a job advert (Job search → “Write application”), check it, send a test to yourself, then send it. One by one, never in bulk.
          </p>
        </div>
        <NewApplication />
      </div>
      {d && (
        <p className={`rounded-lg px-4 py-3 text-sm ${d.sendingEnabled ? "bg-warn-soft text-warn" : "bg-paper text-ink-2"}`}>
          {d.sendingEnabled
            ? `Sending is ON: “Send” e-mails the company. ${d.sentToday} of ${d.perDay} applications sent today.`
            : "Sending is off (SENDING_ENABLED=false): you can write applications and send tests to yourself; “Send” to a company is blocked."}
        </p>
      )}
      <CvPanel />
      <div role="tablist" aria-label="Status" className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface p-1 text-sm">
        {TABS.map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={status === v}
            onClick={() => setStatus(v)}
            className={`rounded-md px-3 py-1.5 font-medium ${status === v ? "bg-ink text-white" : "text-ink-2 hover:bg-paper"}`}
          >
            {label}
            {d?.byStatus[v as ApplicationStatus] ? ` (${d.byStatus[v as ApplicationStatus]})` : ""}
          </button>
        ))}
      </div>
      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        {q.isPending && <p className="px-5 py-6 text-ink-2">Loading…</p>}
        {q.isError && <p className="px-5 py-6 text-bad">{q.error.message}</p>}
        {d?.items.length === 0 && <p className="px-5 py-6 text-ink-2">No applications here yet.</p>}
        <ul className="divide-y divide-line-soft">
          {d?.items.map((a) => (
            <li key={a.id}>
              <Link href={`/applications/${a.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 hover:bg-paper/60">
                <span className="min-w-0">
                  <span className="block font-medium">
                    {a.role} · {a.company}
                  </span>
                  <span className="block text-sm text-ink-2">
                    {a.toEmail ?? "no address yet"}
                    {a.sentAt ? ` · sent ${new Date(a.sentAt).toLocaleDateString("en-GB")}` : ` · updated ${new Date(a.updatedAt).toLocaleDateString("en-GB")}`}
                    {a.note ? ` · ${a.note}` : ""}
                  </span>
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${a.waiting ? "bg-warn-soft text-warn" : STATUS_STYLE[a.status]}`}>
                  {a.waiting ? "waiting for your PC" : APPLICATION_STATUS_LABELS[a.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
