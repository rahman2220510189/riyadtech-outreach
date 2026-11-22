"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ENGLISH_LABELS,
  FIT_LEVEL_STYLE,
  FIT_LEVEL_TEXT,
  LEVEL_LABELS,
  type Program,
  type ProgramStatus,
  STATUS_LABELS,
  type StudyDate,
  type StudyEmail,
  urgency,
  useAddDate,
  useCheckProgram,
  useFindings,
  usePasteText,
  useCreateStudyEmail,
  useDeleteDate,
  useDeleteProgram,
  useProgram,
  useSaveProgram,
  useUpdateDate,
  whenText,
} from "@/lib/study";
import { FindingCard } from "./FindingCard";
import { FIT_STYLE, FIT_TEXT } from "./ProgramList";
import { ProgramForm } from "./ProgramForm";
import { StudyNav } from "./StudyNav";

const card = "rounded-xl border border-line bg-surface px-5 py-4";
const DATE_STYLE = { red: "text-bad", orange: "text-warn", calm: "text-ink-2" } as const;

export function ProgramDetail({ id }: { id: number }) {
  const q = useProgram(id);
  const [editing, setEditing] = useState(false);
  if (q.isPending) return <p className="text-ink-2">Loading…</p>;
  if (q.isError) return <p className="text-bad">{q.error.message}</p>;
  const p = q.data;
  return (
    <div className="space-y-6">
      <StudyNav title={p.name} intro={`${p.country}${p.university ? ` · ${p.university}` : ""} · ${p.kind === "scholarship" ? "Scholarship" : "Programme"} · ${LEVEL_LABELS[p.level]}`} />
      <Link href="/study/programs" className="text-sm underline underline-offset-4">
        ← All programmes
      </Link>
      {editing ? (
        <>
          <ProgramForm initial={p} onDone={() => setEditing(false)} />
          <button type="button" onClick={() => setEditing(false)} className="text-sm underline underline-offset-4">
            Cancel
          </button>
        </>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-5">
            <Facts p={p} onEdit={() => setEditing(true)} />
            <Website p={p} />
            <Emails p={p} />
          </div>
          <div className="space-y-5">
            <StatusBox p={p} />
            <Dates p={p} />
            <Docs p={p} />
          </div>
        </div>
      )}
    </div>
  );
}

function Facts({ p, onEdit }: { p: Program; onEdit: () => void }) {
  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <div className="grid gap-1 border-t border-line-soft py-3 sm:grid-cols-[11rem_1fr]">
        <dt className="text-sm font-medium text-ink-3">{label}</dt>
        <dd className="whitespace-pre-line text-sm">{value}</dd>
      </div>
    ) : null;
  const link = (u: string | null) =>
    u ? (
      <a href={u} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-4">
        {u}
      </a>
    ) : null;
  return (
    <section className={card} aria-labelledby="facts-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="facts-h" className="font-semibold">
          Facts
        </h2>
        <button type="button" onClick={onEdit} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper">
          Edit
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
        <span className={`rounded-full px-2.5 py-1 ${FIT_STYLE[p.english.fit]}`}>{FIT_TEXT[p.english.fit]}</span>
        <span className="rounded-full bg-paper px-2.5 py-1 text-ink-2">{ENGLISH_LABELS[p.englishRequirement]}</span>
      </div>
      <p className="mt-2 text-sm text-ink-2">{p.english.why}</p>
      <div className="mt-3 rounded-lg bg-paper/60 px-3 py-2 text-sm">
        <p>
          <span className="font-medium">Does the subject suit me? </span>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${FIT_LEVEL_STYLE[p.subjectFit.level]}`}>{FIT_LEVEL_TEXT[p.subjectFit.level]}</span>
        </p>
        {p.subjectFit.reasons.map((r) => (
          <p key={r} className="mt-1 text-ink-2">
            {r}
          </p>
        ))}
        {p.subjectFit.warnings.map((w) => (
          <p key={w} className="mt-1 font-medium text-bad">
            ⚠ {w}
          </p>
        ))}
        <p className="mt-1 text-xs text-ink-3">Based on My profile (bachelor’s subject, subjects, work experience, about me). Fill those in for better advice.</p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {p.applyUrl ? (
          <a href={p.applyUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90">
            Apply online ↗
          </a>
        ) : (
          <span className="text-sm text-ink-3">{p.kind === "programme" && !p.university ? "A country guide: pick a university, then add its application page with Edit." : "No application link yet — the daily check adds it when it finds one, or add it with Edit."}</span>
        )}
        {p.infoUrl && p.infoUrl !== p.applyUrl && (
          <a href={p.infoUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-line px-4 py-2 text-sm font-medium hover:bg-paper">
            Official information ↗
          </a>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-3">After applying online: set Status to “Applied”, write the application number in My notes, then send a short follow-up e-mail below.</p>
      <dl className="mt-3">
        {row("Funding", p.funding)}
        {row("Costs", p.costs)}
        {row("Work while studying", p.workWhileStudying)}
        {row("Subject", p.field)}
        {row("Minimum IELTS", p.minIelts?.toString())}
        {row("How to apply", p.howToApply)}
        {row("Apply here", link(p.applyUrl))}
        {row("More information", link(p.infoUrl))}
        {row("Admissions e-mail", p.contactEmail)}
        {row("My notes", p.notes)}
      </dl>
    </section>
  );
}

function StatusBox({ p }: { p: Program }) {
  const save = useSaveProgram();
  const del = useDeleteProgram();
  const router = useRouter();
  return (
    <section className={card} aria-labelledby="status-h">
      <h2 id="status-h" className="font-semibold">
        Where I am
      </h2>
      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="font-medium">Status</span>
        <select value={p.status} onChange={(e) => save.mutate({ id: p.id, status: e.target.value as ProgramStatus })} className="rounded-lg border border-line bg-surface px-3 py-2">
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={p.verified} onChange={(e) => save.mutate({ id: p.id, verified: e.target.checked })} />
        <span>I checked these facts and dates on the official page.</span>
      </label>
      {save.error && <p className="mt-2 text-sm text-bad">{save.error.message}</p>}
      <button
        type="button"
        onClick={() => {
          if (window.confirm(`Delete “${p.name}” with its dates? E-mails stay.`)) del.mutate(p.id, { onSuccess: () => router.push("/study/programs") });
        }}
        className="mt-4 text-sm text-bad underline underline-offset-4"
      >
        Delete this programme
      </button>
    </section>
  );
}

function DateRow({ d }: { d: StudyDate }) {
  const upd = useUpdateDate();
  const del = useDeleteDate();
  return (
    <li className={`flex items-start gap-3 py-2 ${d.done ? "opacity-60" : ""}`}>
      <input type="checkbox" className="mt-1 size-4" aria-label={`Done: ${d.label}`} checked={d.done} onChange={(e) => upd.mutate({ id: d.id, done: e.target.checked })} />
      <div className="min-w-0 flex-1 text-sm">
        <p className={d.done ? "line-through" : "font-medium"}>{d.label}</p>
        <p className={d.done ? "text-ink-3" : DATE_STYLE[urgency(d.daysLeft)]}>
          {d.dueOn} · {whenText(d.daysLeft)}
          {d.confirmed ? "" : " · expected, not confirmed"}
        </p>
        {d.note && <p className="text-ink-3">{d.note}</p>}
        {!d.confirmed && !d.done && (
          <button type="button" onClick={() => upd.mutate({ id: d.id, confirmed: true })} className="text-xs underline underline-offset-2">
            Mark as confirmed
          </button>
        )}
      </div>
      <button type="button" onClick={() => del.mutate(d.id)} className="text-xs text-bad underline underline-offset-2" aria-label={`Delete date ${d.label}`}>
        Delete
      </button>
    </li>
  );
}

function Dates({ p }: { p: Program }) {
  const add = useAddDate(p.id);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<StudyDate["kind"]>("deadline");
  const [dueOn, setDueOn] = useState("");
  const [confirmed, setConfirmed] = useState(true);
  return (
    <section className={card} aria-labelledby="dates-h">
      <h2 id="dates-h" className="font-semibold">
        Dates
      </h2>
      <p className="mt-1 text-xs text-ink-3">Deadlines show in the bar at the top of every page.</p>
      {p.deadlines.length === 0 ? <p className="mt-2 text-sm text-ink-3">No dates yet.</p> : <ul className="mt-2 divide-y divide-line-soft">{p.deadlines.map((d) => <DateRow key={d.id} d={d} />)}</ul>}
      <form
        className="mt-3 space-y-2 border-t border-line-soft pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { label: label.trim(), kind, dueOn, confirmed },
            {
              onSuccess: () => {
                setLabel("");
                setDueOn("");
              },
            },
          );
        }}
      >
        <p className="text-sm font-medium">Add a date</p>
        <input value={label} onChange={(e) => setLabel(e.target.value)} required minLength={2} placeholder="Application deadline" aria-label="What" className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as StudyDate["kind"])} aria-label="Kind" className="rounded-lg border border-line bg-surface px-2 py-2 text-sm">
            <option value="deadline">Deadline</option>
            <option value="opens">Opens</option>
            <option value="reminder">To do</option>
          </select>
          <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} required aria-label="Date" className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Confirmed on the official page
        </label>
        <button type="submit" disabled={add.isPending} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper disabled:opacity-50">
          Add date
        </button>
        {add.error && <p className="text-sm text-bad">{add.error.message}</p>}
      </form>
    </section>
  );
}

function Docs({ p }: { p: Program }) {
  return (
    <section className={card} aria-labelledby="docs-h">
      <h2 id="docs-h" className="font-semibold">
        Documents for this one
      </h2>
      <ul className="mt-2 space-y-1 text-sm">
        {p.docsNeeded.map((d) => (
          <li key={d.kind} className="flex items-center gap-2">
            <span aria-hidden className={d.have ? "text-go" : "text-warn"}>
              {d.have ? "✓" : "○"}
            </span>
            <span className={d.have ? "" : "font-medium"}>{d.label}</span>
            <span className="sr-only">{d.have ? "uploaded" : "missing"}</span>
          </li>
        ))}
      </ul>
      {p.docsMissing > 0 && (
        <Link href="/study/documents" className="mt-3 inline-block text-sm font-medium underline underline-offset-4">
          Upload the missing ones
        </Link>
      )}
    </section>
  );
}

const PURPOSE_TEXT: Record<StudyEmail["purpose"], string> = { inquiry: "Question", application: "Application", follow_up: "Follow-up" };

function Emails({ p }: { p: Program }) {
  const create = useCreateStudyEmail();
  const router = useRouter();
  const [purpose, setPurpose] = useState<StudyEmail["purpose"]>("inquiry");
  const [extra, setExtra] = useState("");
  const [useAi, setUseAi] = useState(true);
  return (
    <section className={card} aria-labelledby="emails-h">
      <h2 id="emails-h" className="font-semibold">
        E-mails
      </h2>
      {p.emails && p.emails.length > 0 && (
        <ul className="mt-2 divide-y divide-line-soft text-sm">
          {p.emails.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2">
              <Link href={`/study/emails/${e.id}`} className="min-w-0 truncate underline-offset-4 hover:underline">
                {e.subject}
              </Link>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${e.status === "sent" ? "bg-go-soft text-go" : e.status === "failed" ? "bg-bad-soft text-bad" : "bg-paper text-ink-2"}`}>{e.status}</span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 space-y-3 border-t border-line-soft pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ programId: p.id, purpose, useAi, ...(extra.trim() ? { extra: extra.trim() } : {}) }, { onSuccess: (m) => router.push(`/study/emails/${m.id}`) });
        }}
      >
        <p className="text-sm font-medium">Write a new e-mail</p>
        {!p.contactEmail && <p className="text-sm text-warn">No admissions e-mail saved for this programme — add it with Edit, or type it in the e-mail.</p>}
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Purpose">
          {(Object.keys(PURPOSE_TEXT) as StudyEmail["purpose"][]).map((k) => (
            <label key={k} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm ${purpose === k ? "border-ink bg-ink text-white" : "border-line"}`}>
              <input type="radio" name="purpose" value={k} checked={purpose === k} onChange={() => setPurpose(k)} className="sr-only" />
              {PURPOSE_TEXT[k]}
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Anything special to ask or say? (optional)</span>
          <textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={1000} placeholder="Ask whether my English-medium letter is enough instead of IELTS." className="rounded-lg border border-line px-3 py-2" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
          Let the AI write the first draft (you check and edit it before anything is sent)
        </label>
        <button type="submit" disabled={create.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
          {create.isPending ? (useAi ? "The AI is writing… (up to a minute)" : "Creating…") : "Create draft"}
        </button>
        {create.error && <p className="text-sm text-bad">{create.error.message}</p>}
      </form>
    </section>
  );
}

/** What the daily check found on this programme's pages, "check now", and pasting a page the tool cannot read. */
function Website({ p }: { p: Program }) {
  const findings = useFindings({ programId: p.id });
  const check = useCheckProgram();
  const paste = usePasteText(p.id);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pageUrl, setPageUrl] = useState("");
  const items = findings.data?.items ?? [];
  return (
    <section className={card} aria-labelledby="web-h">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="web-h" className="font-semibold">
          From the official website
        </h2>
        <button
          type="button"
          onClick={() => check.mutate(p.id)}
          disabled={check.isPending || (!p.infoUrl && !p.applyUrl)}
          title={!p.infoUrl && !p.applyUrl ? "Add the official page with Edit first" : undefined}
          className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-paper disabled:opacity-50"
        >
          {check.isPending ? "Starting…" : "Check the website now"}
        </button>
      </div>
      <p className="mt-1 text-sm text-ink-2">
        The tool re-reads {p.infoUrl || p.applyUrl ? "this programme's pages" : "the official page (add it with Edit)"} every day and shows new dates, IELTS scores and English-medium rules here.
      </p>
      {check.isSuccess && <p className="mt-2 text-sm text-go">Check started; new facts appear here in a minute or two (reload the page).</p>}
      {check.error && <p className="mt-2 text-sm text-bad">{check.error.message}</p>}
      {items.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {items.map((f) => (
            <FindingCard key={f.id} f={f} showProgram={false} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink-3">Nothing new to check.</p>
      )}
      <div className="mt-4 border-t border-line-soft pt-3">
        {!open ? (
          <button type="button" onClick={() => setOpen(true)} className="text-sm underline underline-offset-4">
            The tool cannot read the page? Paste its text
          </button>
        ) : (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              paste.mutate({ text, ...(pageUrl.trim() ? { url: pageUrl.trim() } : {}) }, { onSuccess: () => setText("") });
            }}
          >
            <p className="text-sm text-ink-2">Open the page in your browser, press Ctrl+A then Ctrl+C, and paste it here. The tool looks for dates, IELTS scores, English-medium rules and addresses.</p>
            <input type="url" value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="Page address (optional), https://…" aria-label="Page address" className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} required minLength={20} aria-label="Page text" className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
            <div className="flex items-center gap-3">
              <button type="submit" disabled={paste.isPending} className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
                {paste.isPending ? "Reading…" : "Find facts in this text"}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="text-sm underline underline-offset-4">
                Close
              </button>
              {paste.data && <span className="text-sm text-go">{paste.data.added === 0 ? "Nothing new found." : `${paste.data.added} new fact${paste.data.added === 1 ? "" : "s"} — see above.`}</span>}
              {paste.error && <span className="text-sm text-bad">{paste.error.message}</span>}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
