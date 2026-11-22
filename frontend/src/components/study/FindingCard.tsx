"use client";

import Link from "next/link";
import { type Finding, useDecideFinding, whenText } from "@/lib/study";

const TYPE_TEXT: Record<Finding["type"], string> = { deadline: "Date", ielts: "IELTS", moi: "English-medium degree", email: "Admissions e-mail" };
const ACCEPT_TEXT: Record<Finding["type"], string> = {
  deadline: "Add as confirmed date",
  ielts: "Use as minimum IELTS",
  moi: "Mark as “MOI letter accepted”",
  email: "Use this address",
};

function daysTo(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`).getTime();
  const t = new Date();
  return Math.round((d - Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) / 86_400_000);
}

/** One fact found on a university page: what, the sentence it came from, the page, and accept / dismiss. */
export function FindingCard({ f, showProgram = true }: { f: Finding; showProgram?: boolean }) {
  const decide = useDecideFinding();
  const value =
    f.type === "deadline" ? `${f.label ? `${f.label}: ` : ""}${f.value} (${whenText(daysTo(f.value))})` : f.type === "ielts" ? `IELTS ${f.value}` : f.type === "email" ? f.value : "The page talks about English-medium degrees";
  return (
    <li className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm">
          <span className="mr-2 rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-ink-2">{TYPE_TEXT[f.type]}</span>
          <strong>{value}</strong>
        </p>
        {showProgram && (
          <Link href={`/study/programs/${f.programId}`} className="text-sm underline underline-offset-4">
            {f.program}
            <span className="text-ink-3"> · {f.country}</span>
          </Link>
        )}
      </div>
      <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm text-ink-2">“{f.snippet}”</blockquote>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        {/^https?:/.test(f.url) && (
          <a href={f.url} target="_blank" rel="noopener noreferrer" className="max-w-full truncate text-ink-3 underline underline-offset-4">
            Open the page to check
          </a>
        )}
        {f.status === "new" ? (
          <span className="ml-auto flex gap-2">
            <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ id: f.id, action: "accept" })} className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white hover:bg-ink/90 disabled:opacity-50">
              {ACCEPT_TEXT[f.type]}
            </button>
            <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ id: f.id, action: "dismiss" })} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-paper disabled:opacity-50">
              Not right
            </button>
          </span>
        ) : (
          <span className="ml-auto text-xs text-ink-3">{f.status === "accepted" ? "Accepted" : "Dismissed"}</span>
        )}
      </div>
      {decide.error && <p className="mt-1 text-sm text-bad">{decide.error.message}</p>}
    </li>
  );
}
