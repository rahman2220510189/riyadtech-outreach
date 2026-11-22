"use client";

import Link from "next/link";
import { useState } from "react";
import { useFindings } from "@/lib/study";
import { FindingCard } from "./FindingCard";
import { StudyNav } from "./StudyNav";

export function StudyUpdates() {
  const [status, setStatus] = useState<"new" | "accepted" | "dismissed">("new");
  const q = useFindings({ status });
  return (
    <div className="space-y-6">
      <StudyNav
        title="Updates from university websites"
        intro="The daily check reads university pages and shows here what it found: dates, IELTS scores, sentences about English-medium degrees, admission addresses. Nothing changes until you accept it — read the sentence, open the page if unsure."
      />
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Show">
        {(["new", "accepted", "dismissed"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${status === s ? "bg-ink text-white" : "border border-line bg-surface hover:bg-paper"}`}
          >
            {s === "new" ? `To check${q.data && status === "new" ? ` (${q.data.newTotal})` : ""}` : s === "accepted" ? "Accepted" : "Dismissed"}
          </button>
        ))}
      </div>
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {q.data?.items.length === 0 && (
        <p className="rounded-xl border border-line bg-surface px-5 py-6 text-ink-2">
          {status === "new" ? (
            <>
              Nothing new to check. The check runs once a day while the tool is running; see{" "}
              <Link href="/study/universities" className="underline underline-offset-4">
                Universities
              </Link>{" "}
              for its progress.
            </>
          ) : (
            "Nothing here yet."
          )}
        </p>
      )}
      <ul className="space-y-3">
        {q.data?.items.map((f) => (
          <FindingCard key={f.id} f={f} />
        ))}
      </ul>
    </div>
  );
}
