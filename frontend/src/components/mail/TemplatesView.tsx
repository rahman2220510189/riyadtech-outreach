"use client";

import Link from "next/link";
import { type Template, useTemplates } from "@/lib/mail";

function group(t: Template): string {
  if (t.kind === "job") return "Job applications";
  if (t.segment === "A") return "Agencies (Segment A)";
  if (t.segment === "B") return t.offer === "agent" ? "Businesses · AI agent (Segment B)" : "Businesses · AI chatbot (Segment B)";
  return "Other outreach";
}
const STEP = ["", "First e-mail", "Follow-up 1", "Follow-up 2"];

export function TemplatesView() {
  const q = useTemplates();
  const groups = new Map<string, Template[]>();
  for (const t of q.data?.items ?? []) groups.set(group(t), [...(groups.get(group(t)) ?? []), t]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
          <p className="mt-1 max-w-prose text-ink-2">
            Outreach e-mails get the footer (your name, postal address, unsubscribe link) automatically. Variables like {"{company}"} and spintax like{" "}
            {"{Hi|Hello}"} are filled per lead, the same way every time.
          </p>
        </div>
        <Link href="/templates/new" className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
          New template
        </Link>
      </div>
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {[...groups.entries()].map(([title, items]) => (
        <section key={title} className="overflow-hidden rounded-xl border border-line bg-surface">
          <h2 className="border-b border-line-soft px-5 py-3 font-semibold">{title}</h2>
          <ul className="divide-y divide-line-soft">
            {items.map((t) => (
              <li key={t.id}>
                <Link href={`/templates/${t.id}`} className="block px-5 py-3 hover:bg-paper/60">
                  <p className="font-medium">{t.name}</p>
                  <p className="truncate text-sm text-ink-2">
                    {t.kind === "outreach" ? `${STEP[t.step]} · ` : ""}
                    {t.subject ? `Subject: ${t.subject}` : "Same thread (Re: first subject)"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
