"use client";

import Link from "next/link";
import { useStudyEmails } from "@/lib/study";
import { StudyNav } from "./StudyNav";

const STATUS_STYLE = { draft: "bg-paper text-ink-2", sent: "bg-go-soft text-go", failed: "bg-bad-soft text-bad" } as const;
const PURPOSE = { inquiry: "Question", application: "Application", follow_up: "Follow-up" } as const;

export function StudyEmails() {
  const q = useStudyEmails();
  return (
    <div className="space-y-6">
      <StudyNav title="E-mails" intro="Drafts and sent e-mails to universities. Start a new one from a programme page, so the right documents are attached." />
      {q.data && !q.data.sendingEnabled && (
        <p className="rounded-xl border border-warn/40 bg-warn-soft px-5 py-3 text-sm text-warn">Real sending is switched off (SENDING_ENABLED=false). You can write drafts and send tests to yourself.</p>
      )}
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {q.data?.items.length === 0 && (
        <p className="rounded-xl border border-line bg-surface px-5 py-6 text-ink-2">
          No e-mails yet. Open a{" "}
          <Link href="/study/programs" className="underline underline-offset-4">
            programme
          </Link>{" "}
          and use “Write a new e-mail”.
        </p>
      )}
      {q.data && q.data.items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-ink-3">
              <tr>
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">Programme</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {q.data.items.map((e) => (
                <tr key={e.id}>
                  <td className="max-w-xs truncate px-4 py-2">
                    <Link href={`/study/emails/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                      {e.subject || "(no subject)"}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-ink-2">{e.program ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-2">{e.toEmail ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-2">{PURPOSE[e.purpose]}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[e.status]}`}>{e.status === "sent" && e.waiting ? "waiting for your PC" : e.status === "sent" && e.sentAt ? `sent ${e.sentAt.slice(0, 10)}` : e.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
