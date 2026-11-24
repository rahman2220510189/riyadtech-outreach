"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  type Application,
  APPLICATION_STATUS_LABELS,
  type ApplicationStatus,
  useApplication,
  useApplicationTestSend,
  useCvFiles,
  useDeleteApplication,
  useMailboxes,
  useSendApplication,
  useTestAddresses,
  useUpdateApplication,
} from "@/lib/mail";
import { STATUS_STYLE } from "./ApplicationsView";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

export function ApplicationEditor({ id }: { id: number }) {
  const q = useApplication(id);
  if (q.isPending) return <p className="text-ink-2">Loading…</p>;
  if (q.isError) return <p className="text-bad">{q.error.message}</p>;
  return <Editor key={q.data.id} a={q.data} />;
}

function Editor({ a }: { a: Application }) {
  const router = useRouter();
  const update = useUpdateApplication(a.id);
  const send = useSendApplication(a.id);
  const test = useApplicationTestSend(a.id);
  const del = useDeleteApplication();
  const boxes = useMailboxes();
  const cvs = useCvFiles();
  const own = useTestAddresses();
  const [f, setF] = useState({ toEmail: a.toEmail ?? "", mailboxId: a.mailboxId ?? "", subject: a.subject, body: a.body, cvFileIds: a.cvFileIds });
  const [dirty, setDirty] = useState(false);
  const [to, setTo] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);
  const sent = a.status === "sent";
  const placeholders = /\[\[[\s\S]*?\]\]/.test(`${f.subject}\n${f.body}`);
  const set = (p: Partial<typeof f>) => {
    setDirty(true);
    setConfirmSend(false);
    setF({ ...f, ...p });
  };
  const saveDraft = (then?: () => void) =>
    update.mutate(
      { toEmail: f.toEmail || null, mailboxId: f.mailboxId ? Number(f.mailboxId) : null, subject: f.subject, body: f.body, cvFileIds: f.cvFileIds },
      { onSuccess: () => (setDirty(false), then?.()) },
    );
  const target = to || own.data?.[0] || "";
  const sendingEnabled = boxes.data?.sendingEnabled ?? false;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/applications" className="text-sm text-ink-2 underline underline-offset-4">
          Applications
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {a.role} · {a.company}
          </h1>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[a.status]}`}>{APPLICATION_STATUS_LABELS[a.status]}</span>
          {a.waiting && <span className="rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">waiting for your PC</span>}
        </div>
        {a.waiting && <p className="mt-2 text-sm text-warn">Waiting for your PC: it goes out when npm run mail:outbox runs there.</p>}
        {a.job && (
          <p className="mt-1 text-sm text-ink-2">
            Advert:{" "}
            <a href={a.job.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
              {a.job.title}
            </a>{" "}
            — read it before you write the personal sentence.
          </p>
        )}
        {a.error && <p className="mt-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{a.error}</p>}
      </div>

      <section className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Send to</span>
            <input type="email" disabled={sent} value={f.toEmail} onChange={(e) => set({ toEmail: e.target.value })} placeholder="jobs@company.com" className={field} />
            <span className="text-ink-3">Many adverts ask you to apply on their page instead; then use “Applied on their site” below.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">From</span>
            <select disabled={sent} value={f.mailboxId} onChange={(e) => set({ mailboxId: e.target.value ? Number(e.target.value) : "" })} className={field}>
              <option value="">Choose a mailbox</option>
              {boxes.data?.items.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fromName} &lt;{m.fromEmail}&gt;
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Subject</span>
          <input disabled={sent} value={f.subject} onChange={(e) => set({ subject: e.target.value })} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Text</span>
          <textarea disabled={sent} rows={18} value={f.body} onChange={(e) => set({ body: e.target.value })} className={`${field} leading-relaxed`} />
        </label>
        {placeholders && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">Replace the text in [[double brackets]] with your own words; it cannot be sent before.</p>}
        <fieldset>
          <legend className="text-sm font-medium">Attach</legend>
          <div className="mt-2 flex flex-wrap gap-4 text-sm">
            {cvs.data?.map((c) => (
              <label key={c.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4"
                  disabled={sent}
                  checked={f.cvFileIds.includes(c.id)}
                  onChange={(e) => set({ cvFileIds: e.target.checked ? [...f.cvFileIds, c.id] : f.cvFileIds.filter((x) => x !== c.id) })}
                />
                {c.label} ({c.fileName})
              </label>
            ))}
            {cvs.data?.length === 0 && (
              <span className="text-warn">
                No CV uploaded yet:{" "}
                <Link href="/applications" className="underline underline-offset-4">
                  add one
                </Link>
                .
              </span>
            )}
          </div>
        </fieldset>
        {!sent && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={!dirty || update.isPending} onClick={() => saveDraft()} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
              {update.isPending ? "Saving…" : "Save draft"}
            </button>
            {dirty ? <span className="text-sm text-ink-3">Unsaved changes</span> : update.isSuccess ? <span className="text-sm text-go">Saved.</span> : null}
            {update.error && <span className="text-sm text-bad">{update.error.message}</span>}
          </div>
        )}
      </section>

      {!sent && (
        <section className="space-y-3 rounded-xl border border-line bg-surface px-5 py-4">
          <h2 className="font-semibold">Check, then send</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-2">Test to myself:</span>
            <select value={target} onChange={(e) => setTo(e.target.value)} aria-label="Test address" className="rounded-lg border border-line bg-surface px-2.5 py-2">
              {own.data?.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={test.isPending || dirty || placeholders || !target}
              onClick={() => test.mutate(target)}
              className="rounded-lg border border-line px-3 py-2 font-medium hover:bg-paper disabled:opacity-50"
            >
              {test.isPending ? "Sending…" : "Send test"}
            </button>
            {dirty && <span className="text-ink-3">Save first.</span>}
            {test.error && <span className="text-bad">{test.error.message}</span>}
            {test.data && <span className="text-go">{test.data.queued ? `Test queued for ${test.data.to}. Waiting for your PC: it goes out when npm run mail:outbox runs there.` : `Test sent to ${test.data.to}, with the attachments.`}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3 text-sm">
            {!sendingEnabled ? (
              <span className="text-ink-2">Sending to the company is off (SENDING_ENABLED=false).</span>
            ) : confirmSend ? (
              <>
                <span>
                  Send to <strong>{f.toEmail}</strong> now?
                </span>
                <button type="button" disabled={send.isPending} onClick={() => send.mutate()} className="rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90">
                  {send.isPending ? "Sending…" : "Yes, send"}
                </button>
                <button type="button" onClick={() => setConfirmSend(false)} className="text-ink-2 underline underline-offset-4">
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={dirty || placeholders || !f.toEmail || !f.mailboxId}
                onClick={() => setConfirmSend(true)}
                className="rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90 disabled:opacity-50"
              >
                Send application
              </button>
            )}
            {send.error && <span className="text-bad">{send.error.message}</span>}
          </div>
        </section>
      )}

      <section className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface px-5 py-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Status</span>
          <select
            value={a.status}
            onChange={(e) => update.mutate({ status: e.target.value as ApplicationStatus })}
            className="rounded-lg border border-line bg-surface px-2.5 py-2"
          >
            {(Object.keys(APPLICATION_STATUS_LABELS) as ApplicationStatus[])
              .filter((s) => s !== "sent" || a.status === "sent")
              .map((s) => (
                <option key={s} value={s}>
                  {APPLICATION_STATUS_LABELS[s]}
                </option>
              ))}
          </select>
        </label>
        <NoteField a={a} onSave={(note) => update.mutate({ note })} />
        {!sent && (
          <button type="button" onClick={() => del.mutate(a.id, { onSuccess: () => router.replace("/applications") })} className="ml-auto text-bad underline underline-offset-4">
            Delete draft
          </button>
        )}
      </section>
    </div>
  );
}

function NoteField({ a, onSave }: { a: Application; onSave: (note: string | null) => void }) {
  const [note, setNote] = useState(a.note ?? "");
  return (
    <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
      <span className="font-medium">Note</span>
      <input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (a.note ?? "") && onSave(note || null)} placeholder="Interview on…, contact person…" className={field} />
    </label>
  );
}
