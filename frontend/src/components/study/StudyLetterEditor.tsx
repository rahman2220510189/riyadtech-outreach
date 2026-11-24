"use client";

import Link from "next/link";
import { useState } from "react";
import { type LetterPage, useDeleteLetter, useDraftLetter, useLetter, useSaveLetter, useStudyProfile } from "@/lib/study";
import { StudyNav } from "./StudyNav";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";
const card = "rounded-xl border border-line bg-surface px-5 py-4";

/** One motivation letter / statement of purpose per programme: AI draft from my facts, then my edits. */
export function StudyLetterEditor({ programId }: { programId: number }) {
  const q = useLetter(programId);
  return (
    <div className="space-y-6">
      <StudyNav title="Motivation letter" intro={q.data ? q.data.program.name : undefined} />
      <Link href={`/study/programs/${programId}`} className="text-sm underline underline-offset-4 print:hidden">
        ← {q.data?.program.name ?? "Programme"}
      </Link>
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {q.data && <Editor key={`${q.data.letter?.id ?? "new"}-${q.data.letter?.updatedAt ?? ""}`} page={q.data} programId={programId} />}
    </div>
  );
}

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const gapsIn = (t: string) => [...t.matchAll(/\[\[([^\]]{1,200})\]\]/g)].map((m) => m[1]!.trim());

function Editor({ page, programId }: { page: LetterPage; programId: number }) {
  const l = page.letter;
  const profile = useStudyProfile();
  const draft = useDraftLetter(programId);
  const save = useSaveLetter(programId);
  const del = useDeleteLetter(programId);
  const [title, setTitle] = useState(l?.title ?? `Statement of Purpose – ${page.program.name}`);
  const [body, setBody] = useState(l?.body ?? "");
  const [notes, setNotes] = useState(l?.notes ?? "");
  const [target, setTarget] = useState(l?.target ?? "");
  const [length, setLength] = useState<"standard" | "short">(l?.length ?? "standard");
  const dirty = title !== (l?.title ?? `Statement of Purpose – ${page.program.name}`) || body !== (l?.body ?? "") || target.trim() !== (l?.target ?? "");
  const gaps = gapsIn(body);
  const thinProfile = profile.data && !profile.data.workExperience && !profile.data.aboutMe;

  const write = () => {
    if (body.trim() && !window.confirm("The AI writes a new letter and replaces the text above. Continue?")) return;
    draft.mutate({ length, ...(notes.trim() ? { notes: notes.trim() } : {}), ...(target.trim() ? { target: target.trim() } : {}) });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4 print:hidden">
        {l?.aiModel && (
          <p className="rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
            Written by the AI ({l.aiModel}) from your profile and notes only. Read every sentence, make it sound like you, and fill in every [[double bracket]].
          </p>
        )}
        <div className={`space-y-4 ${card}`}>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Title</span>
            <input value={title} onChange={(x) => setTitle(x.target.value)} maxLength={200} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Letter</span>
            <textarea
              rows={22}
              value={body}
              onChange={(x) => setBody(x.target.value)}
              maxLength={20000}
              placeholder="Write the letter here, or let the AI write a first draft (right)."
              className={`${field} font-[inherit] leading-relaxed`}
            />
          </label>
          <p className="text-sm text-ink-2">
            {words(body)} words{length === "short" ? " · short version: 300–400" : " · aim for 500–650"}
          </p>
          {gaps.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
              <p className="font-medium">Still to fill in ({gaps.length}):</p>
              <ul className="mt-1 list-disc pl-5">
                {gaps.map((g, i) => (
                  <li key={`${g}-${i}`}>{g}</li>
                ))}
              </ul>
            </div>
          )}
          {l && !dirty && l.checks.length > 0 && (
            <div className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">
              <p className="font-medium">Check these before you submit:</p>
              <ul className="mt-1 list-disc pl-5">
                {l.checks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => save.mutate({ title: title.trim() || page.program.name, body, notes: notes.trim() || null, target: target.trim() || null })}
              disabled={save.isPending || (!dirty && !!l) || !body.trim()}
              className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : dirty || !l ? "Save" : "Saved"}
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!body.trim()}
              className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium hover:bg-paper disabled:opacity-50"
            >
              Print / Save as PDF
            </button>
            {l && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Delete this letter?")) del.mutate();
                }}
                className="text-sm text-bad underline underline-offset-4"
              >
                Delete letter
              </button>
            )}
            {save.error && <span className="text-sm text-bad">{save.error.message}</span>}
          </div>
          <p className="text-xs text-ink-3">
            “Print / Save as PDF” opens the print window with only the letter: choose “Save as PDF”, then upload the PDF under My documents → Motivation letter.
          </p>
        </div>
      </div>

      <div className="space-y-5 print:hidden">
        <section className={card} aria-labelledby="ai-h">
          <h2 id="ai-h" className="font-semibold">
            First draft with AI
          </h2>
          <p className="mt-1 text-sm text-ink-2">Uses only your profile (degree, work experience, about me) and the notes below. Nothing is invented; missing facts become [[gaps]].</p>
          {thinProfile && (
            <p className="mt-2 text-sm text-warn">
              Your profile has no work experience or “about me” yet, so the letter will be thin.{" "}
              <Link href="/study/profile" className="underline underline-offset-4">
                Fill in My profile
              </Link>
            </p>
          )}
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="font-medium">{page.isScholarship ? "Programme and university you apply to" : "Programme and university (if different)"}</span>
            <input
              value={target}
              onChange={(x) => setTarget(x.target.value)}
              maxLength={300}
              placeholder="MSc Computer Science, University of …"
              className={field}
            />
            {page.isScholarship && !target.trim() && (
              <span className="text-xs text-warn">A scholarship is not a programme: name the programme you apply to through it, or the letter leaves a gap for it.</span>
            )}
          </label>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="font-medium">Your points for this programme</span>
            <textarea
              rows={6}
              value={notes}
              onChange={(x) => setNotes(x.target.value)}
              maxLength={3000}
              placeholder={"Why this programme or university (a course, a research group, the country)\nWhat you want to do after the degree\nAnything they ask for in their letter instructions"}
              className={field}
            />
          </label>
          <fieldset className="mt-3 text-sm">
            <legend className="font-medium">Length</legend>
            <label className="mt-1 flex items-center gap-2">
              <input type="radio" name="len" checked={length === "standard"} onChange={() => setLength("standard")} /> Standard (500–650 words)
            </label>
            <label className="mt-1 flex items-center gap-2">
              <input type="radio" name="len" checked={length === "short"} onChange={() => setLength("short")} /> Short (300–400 words, for forms with a limit)
            </label>
          </fieldset>
          <button
            type="button"
            onClick={write}
            disabled={draft.isPending || !page.ai.configured}
            className="mt-4 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50"
          >
            {draft.isPending ? "Writing… (up to a minute)" : body.trim() ? "Write a new draft" : "Write a draft"}
          </button>
          {!page.ai.configured && <p className="mt-2 text-sm text-ink-2">The AI needs GROQ_API_KEY on the server; you can still write the letter by hand.</p>}
          {draft.error && <p className="mt-2 text-sm text-bad">{draft.error.message}</p>}
        </section>
        <section className={card} aria-labelledby="tips-h">
          <h2 id="tips-h" className="font-semibold">
            Before you submit
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
            <li>Follow the programme&apos;s own instructions (questions, word or page limit, file name).</li>
            <li>Name something real about this programme: a course, a research group, a lab.</li>
            <li>Every claim must be true and match your CV and transcript.</li>
            <li>Read it aloud once; change sentences that do not sound like you.</li>
          </ul>
        </section>
      </div>

      {/* Only this part is printed. */}
      <article className="print-area hidden whitespace-pre-line font-serif text-[11.5pt] leading-relaxed print:block">
        <h1 className="mb-6 text-[14pt] font-semibold">{title}</h1>
        {body}
      </article>
    </div>
  );
}
