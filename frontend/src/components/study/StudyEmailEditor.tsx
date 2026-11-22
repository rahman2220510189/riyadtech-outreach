"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMailboxes } from "@/lib/mail";
import {
  type StudyEmail,
  useDeleteStudyEmail,
  useRedraftStudyEmail,
  useStudyDocuments,
  useStudyEmail,
  useStudySend,
  useStudyTestSend,
  useUpdateStudyEmail,
} from "@/lib/study";
import { StudyNav } from "./StudyNav";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

export function StudyEmailEditor({ id }: { id: number }) {
  const q = useStudyEmail(id);
  return (
    <div className="space-y-6">
      <StudyNav title="E-mail" />
      <Link href={q.data?.programId ? `/study/programs/${q.data.programId}` : "/study/emails"} className="text-sm underline underline-offset-4">
        ← {q.data?.program ?? "All e-mails"}
      </Link>
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {q.data && <Editor key={`${q.data.id}-${q.data.updatedAt}`} e={q.data} />}
    </div>
  );
}

function Editor({ e }: { e: StudyEmail }) {
  const router = useRouter();
  const docs = useStudyDocuments();
  const boxes = useMailboxes();
  const update = useUpdateStudyEmail(e.id);
  const redraft = useRedraftStudyEmail(e.id);
  const del = useDeleteStudyEmail();
  const test = useStudyTestSend(e.id);
  const send = useStudySend(e.id);
  const [to, setTo] = useState(e.toEmail ?? "");
  const [mailboxId, setMailboxId] = useState(e.mailboxId ?? 0);
  const [subject, setSubject] = useState(e.subject);
  const [body, setBody] = useState(e.body);
  const [attached, setAttached] = useState<number[]>(e.documentIds);
  const [instruction, setInstruction] = useState("");
  const [testTo, setTestTo] = useState("");
  const sent = e.status === "sent";
  const dirty = to !== (e.toEmail ?? "") || mailboxId !== (e.mailboxId ?? 0) || subject !== e.subject || body !== e.body || attached.join() !== e.documentIds.join();
  const placeholders = /\[\[[^\]]*\]\]/.test(subject + body);
  const mailbox = boxes.data?.items.find((b) => b.id === mailboxId);
  const size = (docs.data?.items ?? []).filter((d) => attached.includes(d.id)).reduce((s, d) => s + d.size, 0);

  const doSave = (then?: () => void) =>
    update.mutate({ toEmail: to.trim() || null, mailboxId: mailboxId || null, subject, body, documentIds: attached }, { onSuccess: () => then?.() });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        {e.aiModel && !sent && (
          <p className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
            Written by the AI ({e.aiModel}). Read every sentence: check names, numbers and claims, and replace everything in [[double brackets]].
          </p>
        )}
        {sent && <p className="rounded-xl border border-go/40 bg-go-soft px-4 py-3 text-sm text-go">Sent {e.sentAt?.slice(0, 16).replace("T", " ")}. It can no longer be changed.</p>}
        {e.status === "failed" && e.error && <p className="rounded-xl border border-bad/40 bg-bad-soft px-4 py-3 text-sm text-bad">Sending failed: {e.error}</p>}
        <div className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">To (admissions e-mail)</span>
              <input type="email" value={to} onChange={(x) => setTo(x.target.value)} disabled={sent} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">From (mailbox)</span>
              <select value={mailboxId} onChange={(x) => setMailboxId(Number(x.target.value))} disabled={sent} className={field}>
                <option value={0}>Choose…</option>
                {boxes.data?.items.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} — {b.fromEmail}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Subject</span>
            <input value={subject} onChange={(x) => setSubject(x.target.value)} disabled={sent} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Text</span>
            <textarea rows={16} value={body} onChange={(x) => setBody(x.target.value)} disabled={sent} className={`${field} font-[inherit] leading-relaxed`} />
          </label>
          {placeholders && !sent && <p className="text-sm text-warn">Still has [[…]] gaps to fill in. It cannot be sent until they are gone.</p>}
          {!sent && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => doSave()} disabled={update.isPending || !dirty} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
                {update.isPending ? "Saving…" : dirty ? "Save" : "Saved"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Delete this draft?")) del.mutate(e.id, { onSuccess: () => router.push(e.programId ? `/study/programs/${e.programId}` : "/study/emails") });
                }}
                className="text-sm text-bad underline underline-offset-4"
              >
                Delete draft
              </button>
              {update.error && <span className="text-sm text-bad">{update.error.message}</span>}
            </div>
          )}
        </div>
        {!sent && (
          <div className="space-y-2 rounded-xl border border-line bg-surface px-5 py-4">
            <h2 className="font-semibold">Ask the AI for a new version</h2>
            <p className="text-sm text-ink-2">Replaces the subject and text above (unsaved edits are lost).</p>
            <textarea rows={2} value={instruction} onChange={(x) => setInstruction(x.target.value)} maxLength={1000} placeholder="Shorter. Also ask about the application fee." aria-label="Instruction for the AI" className={field} />
            <button
              type="button"
              disabled={redraft.isPending}
              onClick={() => {
                if (!dirty || window.confirm("Your unsaved edits will be replaced. Continue?")) redraft.mutate(instruction.trim());
              }}
              className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50"
            >
              {redraft.isPending ? "Writing… (up to a minute)" : "Rewrite with AI"}
            </button>
            {redraft.error && <p className="text-sm text-bad">{redraft.error.message}</p>}
          </div>
        )}
      </div>

      <div className="space-y-5">
        <section className="rounded-xl border border-line bg-surface px-5 py-4" aria-labelledby="att-h">
          <h2 id="att-h" className="font-semibold">
            Attachments
          </h2>
          {docs.data?.items.length === 0 && (
            <p className="mt-2 text-sm text-ink-3">
              No documents yet.{" "}
              <Link href="/study/documents" className="underline underline-offset-4">
                Upload them
              </Link>
              .
            </p>
          )}
          <ul className="mt-2 space-y-1.5 text-sm">
            {docs.data?.items.map((d) => (
              <li key={d.id}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4" disabled={sent} checked={attached.includes(d.id)} onChange={(x) => setAttached(x.target.checked ? [...attached, d.id] : attached.filter((a) => a !== d.id))} />
                  <span>
                    <span className="font-medium">{d.kindLabel}</span> <span className="text-ink-3">{d.fileName}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className={`mt-2 text-xs ${size > 20 * 1024 * 1024 ? "text-bad" : "text-ink-3"}`}>Total {(size / 1024 / 1024).toFixed(1)} MB (max 20 MB)</p>
          {attached.length === 0 && !sent && <p className="mt-2 text-sm text-warn">Nothing is attached. Tick your transcript (and MOI letter) if the e-mail mentions them, then Save.</p>}
        </section>

        {!sent && (
          <section className="space-y-2 rounded-xl border border-line bg-surface px-5 py-4" aria-labelledby="test-h">
            <h2 id="test-h" className="font-semibold">
              1. Test to myself
            </h2>
            <p className="text-sm text-ink-2">See exactly how it arrives, with attachments. Only to your own mailbox addresses.</p>
            <input type="email" value={testTo} onChange={(x) => setTestTo(x.target.value)} placeholder={mailbox?.fromEmail ?? "you@…"} aria-label="Send the test to" className={field} />
            <button
              type="button"
              disabled={test.isPending || dirty}
              onClick={() => test.mutate(testTo.trim() || mailbox?.fromEmail || "")}
              className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50"
            >
              {test.isPending ? "Sending test…" : "Send test"}
            </button>
            {dirty && <p className="text-xs text-ink-3">Save first.</p>}
            {test.isSuccess && <p className="text-sm text-go">Test sent to {test.data.to}. Check that inbox.</p>}
            {test.error && <p className="text-sm text-bad">{test.error.message}</p>}
          </section>
        )}

        {!sent && (
          <section className="space-y-2 rounded-xl border border-line bg-surface px-5 py-4" aria-labelledby="send-h">
            <h2 id="send-h" className="font-semibold">
              2. Send to the university
            </h2>
            <button
              type="button"
              disabled={send.isPending || dirty || placeholders || !to.trim() || !mailboxId}
              onClick={() => {
                if (window.confirm(`Send “${subject}” to ${to} from ${mailbox?.fromEmail ?? "the chosen mailbox"} with ${attached.length === 0 ? "NO attachments" : `${attached.length} attachment(s)`}? This cannot be undone.`)) send.mutate();
              }}
              className="w-full rounded-lg bg-go px-4 py-2.5 text-sm font-medium text-white hover:bg-go/90 disabled:opacity-50"
            >
              {send.isPending ? "Sending…" : "Send now"}
            </button>
            <ul className="list-inside list-disc text-xs text-ink-3">
              {dirty && <li>Save your changes first.</li>}
              {placeholders && <li>Fill in the [[…]] gaps.</li>}
              {!to.trim() && <li>Add the admissions e-mail.</li>}
              {!mailboxId && <li>Choose the mailbox to send from.</li>}
            </ul>
            {send.error && <p className="text-sm text-bad">{send.error.message}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
