"use client";

import Link from "next/link";
import { useState } from "react";
import { KIND_TEXT, type ReplyKind, useCheckReplies, useReplies, useReplyDone } from "@/lib/replies";

const BADGE: Record<ReplyKind, string> = {
  reply: "bg-go text-white",
  unsubscribe: "bg-paper text-ink-2",
  auto_reply: "bg-paper text-ink-2",
  bounce: "bg-bad-soft text-bad",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

/** Answers to campaign e-mails, read from the mailbox. Real replies stay until marked handled. */
export function RepliesView() {
  const [show, setShow] = useState<"open" | "all">("open");
  const q = useReplies(show);
  const done = useReplyDone();
  const check = useCheckReplies();
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Replies</h1>
          <p className="mt-1 max-w-prose text-ink-2">
            Read from your mailbox every 5 minutes (read only: nothing is moved, marked or deleted). A reply stops the follow-ups;
            &ldquo;no&rdquo; and bounces also go on the suppression list. Answer the person from your mailbox.
          </p>
        </div>
        <button type="button" disabled={check.isPending} onClick={() => check.mutate()} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-medium disabled:opacity-50">
          {check.isPending ? "Checking…" : "Check now"}
        </button>
      </div>

      {d?.mailboxes.map((m) => (
        <p key={m.id} className={`rounded-xl border px-5 py-3 text-sm ${m.error ? "border-bad/40 bg-bad-soft text-bad" : "border-line bg-surface text-ink-2"}`}>
          {m.fromEmail}: {m.error ? m.error : `last checked ${when(m.checkedAt)}`}
          {m.error && (
            <>
              {" "}
              <Link href="/mailboxes" className="underline underline-offset-2">
                Mailboxes
              </Link>
            </>
          )}
        </p>
      ))}
      {check.error && <p className="text-sm text-bad">{check.error.message}</p>}

      <div role="tablist" aria-label="Show" className="inline-flex rounded-lg border border-line bg-surface p-1 text-sm">
        {(["open", "all"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={show === s} onClick={() => setShow(s)} className={`rounded-md px-3 py-1.5 font-medium ${show === s ? "bg-ink text-white" : "text-ink-2"}`}>
            {s === "open" ? `To answer (${d?.open ?? 0})` : "All"}
          </button>
        ))}
      </div>

      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {d && d.items.length === 0 && <p className="text-ink-2">{show === "open" ? "Nothing to answer right now." : "No replies yet."}</p>}
      <ul className="space-y-3">
        {d?.items.map((r) => (
          <li key={r.id} className="rounded-xl border border-line bg-surface px-5 py-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[r.kind]}`}>{KIND_TEXT[r.kind]}</span>
              <span className="font-medium">{r.company ?? r.fromEmail}</span>
              <span className="text-ink-3">{r.fromEmail}</span>
              <span className="ml-auto text-ink-3">{when(r.receivedAt)}</span>
            </div>
            <p className="mt-1 text-sm font-medium">{r.subject}</p>
            {r.snippet && <pre className="mt-2 whitespace-pre-wrap font-[inherit] text-sm leading-relaxed text-ink-2">{r.snippet}</pre>}
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
              {r.campaignId && (
                <Link href={`/campaigns/${r.campaignId}`} className="underline underline-offset-2">
                  {r.campaign}
                </Link>
              )}
              <button type="button" disabled={done.isPending} onClick={() => done.mutate({ id: r.id, done: !r.done })} className="font-medium underline underline-offset-2">
                {r.done ? "Back to answer" : "Answered, done"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
