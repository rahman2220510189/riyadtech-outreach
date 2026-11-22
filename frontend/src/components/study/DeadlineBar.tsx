"use client";

import Link from "next/link";
import { urgency, useUpcoming, whenText } from "@/lib/study";

const STYLE = {
  red: "bg-bad-soft text-bad",
  orange: "bg-warn-soft text-warn",
  calm: "bg-paper text-ink-2",
} as const;

/** A thin bar on every page with the next study dates (deadlines first), coloured by how close they are. */
export function DeadlineBar() {
  const q = useUpcoming(90);
  const items = q.data ?? [];
  if (items.length === 0) return null;
  const deadlines = items.filter((i) => i.kind === "deadline");
  const shown = [...deadlines, ...items.filter((i) => i.kind !== "deadline")].slice(0, 3);
  const level = urgency(Math.min(...shown.map((s) => s.daysLeft)));
  return (
    <div role="region" aria-label="Upcoming study dates" className={`border-b border-line px-5 py-2 text-sm sm:px-8 ${STYLE[level]}`}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1">
        <span aria-hidden>⏰</span>
        {shown.map((d) => (
          <Link key={d.id} href={`/study/programs/${d.programId}`} className="underline-offset-4 hover:underline">
            <strong>{d.program}</strong>: {d.kind === "opens" ? "opens" : d.kind === "reminder" ? "to do" : "deadline"} {whenText(d.daysLeft)} ({d.dueOn}
            {d.confirmed ? "" : ", expected"})
          </Link>
        ))}
        {items.length > shown.length && (
          <Link href="/study" className="ml-auto font-medium underline underline-offset-4">
            All dates ({items.length})
          </Link>
        )}
      </div>
    </div>
  );
}
