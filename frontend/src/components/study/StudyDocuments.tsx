"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/finder";
import { type DocKind, studyDocumentUrl, useDeleteStudyDocument, usePrograms, useStudyDocuments, useUploadStudyDocument } from "@/lib/study";
import { StudyNav } from "./StudyNav";

const HINTS: Partial<Record<DocKind, string>> = {
  passport: "The page with your photo and details.",
  photo: "Recent passport-style photo (JPG or PNG).",
  bsc_transcript: "The marksheet with all courses and grades.",
  moi_letter: "From your university's registrar: “the medium of instruction was English”.",
  cv: "In English, one to two pages.",
  motivation_letter: "One page: why this subject, this country, your plans.",
  recommendation: "Signed by a teacher or supervisor, on letterhead.",
  ielts_result: "Add when you have it.",
};

async function toBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function StudyDocuments() {
  const docs = useStudyDocuments();
  const programs = usePrograms({ status: "active" });
  const upload = useUploadStudyDocument();
  const del = useDeleteStudyDocument();
  const [busyKind, setBusyKind] = useState<DocKind | null>(null);
  const [error, setError] = useState<{ kind: DocKind; text: string } | null>(null);
  const neededBy = new Map<DocKind, number>();
  for (const p of programs.data ?? []) for (const d of p.docsNeeded) neededBy.set(d.kind, (neededBy.get(d.kind) ?? 0) + 1);

  const onFile = async (kind: DocKind, f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return setError({ kind, text: "The file is larger than 8 MB. Scan at 150–200 dpi or compress the PDF." });
    setBusyKind(kind);
    upload.mutate(
      { kind, fileName: f.name, dataBase64: await toBase64(f) },
      { onError: (e) => setError({ kind, text: e.message }), onSettled: () => setBusyKind(null) },
    );
  };

  return (
    <div className="space-y-6">
      <StudyNav title="My documents" intro="Upload each paper once (PDF best, photos work too, max 8 MB). E-mails attach them with one tick; every programme shows what is still missing." />
      {docs.isPending && <p className="text-ink-2">Loading…</p>}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {docs.data?.kinds.map(({ kind, label }) => {
          const files = docs.data.items.filter((d) => d.kind === kind);
          const needed = neededBy.get(kind) ?? 0;
          return (
            <li key={kind} className={`flex flex-col rounded-xl border bg-surface px-4 py-3 ${files.length ? "border-go/40" : needed ? "border-warn/50" : "border-line"}`}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-semibold">
                  {files.length ? <span className="mr-1 text-go">✓</span> : null}
                  {label}
                </h2>
                {needed > 0 && <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${files.length ? "bg-go-soft text-go" : "bg-warn-soft text-warn"}`}>needed by {needed}</span>}
              </div>
              {HINTS[kind] && <p className="mt-1 text-xs text-ink-3">{HINTS[kind]}</p>}
              <ul className="mt-2 flex-1 space-y-1 text-sm">
                {files.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2">
                    <a href={studyDocumentUrl(d.id)} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate underline underline-offset-4" title={d.fileName}>
                      {d.fileName}
                    </a>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-ink-3">
                      {formatNumber(Math.max(1, Math.round(d.size / 1024)))} KB
                      <button type="button" onClick={() => del.mutate(d.id)} className="text-bad underline underline-offset-2" aria-label={`Delete ${d.fileName}`}>
                        Delete
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <label className="mt-3 inline-flex cursor-pointer items-center justify-center rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper">
                {busyKind === kind ? "Uploading…" : files.length ? "Add another file" : "Upload"}
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" className="sr-only" aria-label={`Upload ${label}`} onChange={(e) => void onFile(kind, e.target.files?.[0])} />
              </label>
              {error?.kind === kind && <p className="mt-2 text-sm text-bad">{error.text}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
