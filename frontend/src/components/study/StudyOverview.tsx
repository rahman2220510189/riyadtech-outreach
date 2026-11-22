"use client";

import Link from "next/link";
import { WINDOW_TEXT, STATUS_LABELS, type ProgramStatus, urgency, useAiTest, useStudyOverview, useUpcoming, useUpdateDate, whenText } from "@/lib/study";
import { StudyNav } from "./StudyNav";

const DOT = { red: "bg-bad", orange: "bg-warn", calm: "bg-ink-3" } as const;

export function StudyOverview() {
  const o = useStudyOverview();
  const dates = useUpcoming(365);
  const done = useUpdateDate();
  const ai = useAiTest();
  const d = o.data;
  return (
    <div className="space-y-6">
      <StudyNav title="Overview" intro="Everything for your applications in one place: what to do next, the dates that matter, and where you stand." />

      {d && d.subjects.length > 0 && (
        <section className="rounded-xl border border-line bg-surface px-5 py-4" aria-labelledby="subj-h">
          <h2 id="subj-h" className="font-semibold">
            Subjects that suit you
          </h2>
          <p className="mt-1 text-xs text-ink-3">From My profile. Apply for programmes in these subjects; the programme list is sorted by this (“Best match for me”).</p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-2">
            {d.subjects.map((s, i) => (
              <li key={s.topic} className="rounded-lg bg-paper/60 px-3 py-2 text-sm">
                <p className="font-medium">
                  {i + 1}. {s.label}
                </p>
                <p className="text-ink-3">{s.why}</p>
              </li>
            ))}
          </ol>
          {d.bestMatches.length > 0 && (
            <>
              <p className="mt-4 text-sm font-medium">Best matches in your list</p>
              <ul className="mt-1 divide-y divide-line-soft text-sm">
                {d.bestMatches.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                    <Link href={`/study/programs/${m.id}`} className="font-medium underline-offset-4 hover:underline">
                      {m.name}
                    </Link>
                    <span className="text-xs text-ink-3">
                      {m.country}
                      {m.window ? ` · ${WINDOW_TEXT[m.window.state]}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {d && d.openNow.length > 0 && (
        <section className="rounded-xl border border-go/40 bg-surface px-5 py-4" aria-labelledby="open-h">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="open-h" className="font-semibold">
              Applications open now
            </h2>
            <Link href="/study/programs" className="text-sm underline underline-offset-4">
              All programmes
            </Link>
          </div>
          <p className="mt-1 text-xs text-ink-3">From the programmes’ dates. “Probably open”: a deadline is near but the opening date is not known — check the official page.</p>
          <ul className="mt-3 divide-y divide-line-soft">
            {d.openNow.slice(0, 12).map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">
                  <Link href={`/study/programs/${o.id}`} className="font-medium underline-offset-4 hover:underline">
                    {o.name}
                  </Link>
                  <span className="text-ink-3"> · {o.country}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${o.window.state === "opens_soon" ? "bg-warn-soft text-warn" : o.window.daysLeft <= 14 ? "bg-bad-soft text-bad" : "bg-go-soft text-go"}`}>
                    {WINDOW_TEXT[o.window.state]} · {o.window.state === "opens_soon" ? `opens ${o.window.opensOn}` : `closes ${o.window.deadline} (${o.window.daysLeft} days)`}
                  </span>
                  {o.applyUrl && o.window.state !== "opens_soon" && (
                    <a href={o.applyUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-ink px-3 py-1 text-xs font-medium text-white hover:bg-ink/90">
                      Apply ↗
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="rounded-xl border border-line bg-surface px-5 py-4">
          <h2 className="font-semibold">What to do next</h2>
          {o.isPending && <p className="mt-3 text-ink-2">Loading…</p>}
          {d && d.steps.length === 0 && <p className="mt-3 text-go">Nothing waiting. Well done.</p>}
          <ol className="mt-3 space-y-2">
            {d?.steps.map((s, i) => (
              <li key={s.id} className={`flex gap-3 rounded-lg px-3 py-2 text-sm ${s.urgent ? "bg-bad-soft" : "bg-paper/60"}`}>
                <span className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.urgent ? "bg-bad text-white" : "bg-surface text-ink-2"}`}>{i + 1}</span>
                <Link href={s.link} className={`underline-offset-4 hover:underline ${s.urgent ? "font-medium text-bad" : ""}`}>
                  {s.text}
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-xl border border-line bg-surface px-5 py-4">
          <h2 className="font-semibold">Dates</h2>
          <p className="mt-1 text-xs text-ink-3">“Expected” dates come from last year or a guide: check the official page. Tick a date when it is handled.</p>
          {dates.data?.length === 0 && <p className="mt-3 text-sm text-ink-2">No dates yet.</p>}
          <ul className="mt-3 space-y-2">
            {dates.data?.map((x) => (
              <li key={x.id} className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1 size-4" aria-label={`Done: ${x.program} ${x.label}`} onChange={() => done.mutate({ id: x.id, done: true })} />
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[urgency(x.daysLeft)]}`} aria-hidden />
                <span className="min-w-0">
                  <Link href={`/study/programs/${x.programId}`} className="font-medium underline-offset-4 hover:underline">
                    {x.program}
                  </Link>
                  <span className="block text-ink-2">
                    {x.label} · {x.dueOn} ({whenText(x.daysLeft)}){x.confirmed ? "" : " · expected"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <section className="rounded-xl border border-line bg-surface px-5 py-4">
          <h2 className="font-semibold">Where you stand</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {(Object.keys(STATUS_LABELS) as ProgramStatus[]).map((s) =>
              d?.counts[s] ? (
                <li key={s} className="flex justify-between">
                  <span>{STATUS_LABELS[s]}</span>
                  <span className="tabular-nums">{d.counts[s]}</span>
                </li>
              ) : null,
            )}
            <li className="flex justify-between border-t border-line-soft pt-1 text-ink-2">
              <span>Documents uploaded</span>
              <span>{d?.documents ?? 0}</span>
            </li>
            <li className="flex justify-between text-ink-2">
              <span>E-mails sent</span>
              <span>{d?.sentEmails ?? 0}</span>
            </li>
            <li className="flex justify-between text-ink-2">
              <Link href="/study/updates" className="underline underline-offset-4">
                New facts from websites
              </Link>
              <span>{d?.findings ?? 0}</span>
            </li>
          </ul>
        </section>
        <section className="rounded-xl border border-line bg-surface px-5 py-4">
          <h2 className="font-semibold">AI for e-mail drafts</h2>
          {d && (
            <p className="mt-2 text-sm text-ink-2">
              {d.ai.configured ? (
                <>
                  Groq is set up (model {d.ai.model}). Drafts use only your profile facts; you read and edit every e-mail before it is sent.
                </>
              ) : (
                <>
                  The backend does not see a Groq key yet. Put <code>GROQ_API_KEY=</code> with your key on its own line in backend/.env, save, then restart the tool (Ctrl+C,
                  npm run dev:all). Until then, e-mails can be written by hand.
                </>
              )}
            </p>
          )}
          {d && (
            <button type="button" onClick={() => ai.mutate()} disabled={ai.isPending} className="mt-3 rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50">
              {ai.isPending ? "Testing…" : "Test the AI connection"}
            </button>
          )}
          {ai.data && <p className="mt-2 text-sm text-go">Works ({ai.data.ms} ms): “{ai.data.answer}”</p>}
          {ai.error && <p className="mt-2 text-sm text-bad">{ai.error.message}</p>}
        </section>
        <section className="rounded-xl border border-warn/40 bg-warn-soft px-5 py-4 text-sm text-warn">
          <h2 className="font-semibold">Be careful</h2>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Avoid universities in northern Cyprus: many countries do not recognise their degrees.</li>
            <li>Never pay an agent who “guarantees” admission or a visa.</li>
            <li>Apply on the official portal; an e-mail does not replace the application.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
