"use client";

import { useState } from "react";
import { type DocKind, ENGLISH_LABELS, type EnglishRequirement, type Level, type Program, type ProgramInput, useSaveProgram, useStudyDocuments } from "@/lib/study";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

/** Create or edit a programme. */
export function ProgramForm({ initial, onDone }: { initial?: Program; onDone: (p: Program) => void }) {
  const save = useSaveProgram();
  const kinds = useStudyDocuments().data?.kinds ?? [];
  const [f, setF] = useState({
    name: initial?.name ?? "",
    kind: initial?.kind ?? "programme",
    country: initial?.country ?? "",
    university: initial?.university ?? "",
    level: initial?.level ?? "master",
    field: initial?.field ?? "",
    englishRequirement: initial?.englishRequirement ?? "varies",
    minIelts: initial?.minIelts?.toString() ?? "",
    funding: initial?.funding ?? "",
    costs: initial?.costs ?? "",
    workWhileStudying: initial?.workWhileStudying ?? "",
    applyUrl: initial?.applyUrl ?? "",
    infoUrl: initial?.infoUrl ?? "",
    contactEmail: initial?.contactEmail ?? "",
    howToApply: initial?.howToApply ?? "",
    notes: initial?.notes ?? "",
  });
  const [docs, setDocs] = useState<DocKind[]>(initial?.requiredDocs ?? []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const t = (v: string) => (v.trim() ? v.trim() : null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: ProgramInput & { id?: number } = {
      ...(initial ? { id: initial.id } : {}),
      name: f.name.trim(),
      kind: f.kind as Program["kind"],
      country: f.country.trim(),
      university: t(f.university),
      level: f.level as Level,
      field: t(f.field),
      englishRequirement: f.englishRequirement as EnglishRequirement,
      minIelts: f.minIelts.trim() ? Number(f.minIelts) : null,
      funding: t(f.funding),
      costs: t(f.costs),
      workWhileStudying: t(f.workWhileStudying),
      applyUrl: t(f.applyUrl),
      infoUrl: t(f.infoUrl),
      contactEmail: t(f.contactEmail),
      howToApply: t(f.howToApply),
      notes: t(f.notes),
      requiredDocs: docs,
    };
    save.mutate(body, { onSuccess: onDone });
  };
  const text = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input value={f[k]} onChange={set(k)} className={field} {...props} />
    </label>
  );
  const area = (k: keyof typeof f, label: string) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea rows={3} value={f[k]} onChange={set(k)} className={field} />
    </label>
  );
  return (
    <form onSubmit={submit} className="space-y-5 rounded-xl border border-line bg-surface px-5 py-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2">{text("name", "Name", { required: true, minLength: 2, placeholder: "MSc Computer Science, University of Debrecen" })}</div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Type</span>
          <select value={f.kind} onChange={set("kind")} className={field}>
            <option value="programme">Programme (a university course)</option>
            <option value="scholarship">Scholarship</option>
          </select>
        </label>
        {text("country", "Country", { required: true, minLength: 2 })}
        {text("university", "University")}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Level</span>
          <select value={f.level} onChange={set("level")} className={field}>
            <option value="master">Master</option>
            <option value="bachelor">Bachelor</option>
            <option value="both">Both</option>
          </select>
        </label>
        {text("field", "Subject")}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">English proof</span>
          <select value={f.englishRequirement} onChange={set("englishRequirement")} className={field}>
            {Object.entries(ENGLISH_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {text("minIelts", "Minimum IELTS (if a test is needed)", { type: "number", step: 0.5, min: 0, max: 9 })}
        {text("applyUrl", "Official application page", { type: "url", placeholder: "https://…" })}
        {text("infoUrl", "Official information page", { type: "url", placeholder: "https://…" })}
        {text("contactEmail", "Admissions e-mail", { type: "email" })}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {area("funding", "Scholarship / funding")}
        {area("costs", "Costs (tuition, fees, living)")}
        {area("workWhileStudying", "Work while studying (hours a week, conditions)")}
        {area("howToApply", "How to apply")}
        {area("notes", "My notes")}
      </div>
      <fieldset>
        <legend className="text-sm font-medium">Documents this programme asks for (besides your degree papers and English proof, which are added automatically)</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {kinds.map(({ kind, label }) => (
            <label key={kind} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
              <input type="checkbox" className="size-4" checked={docs.includes(kind)} onChange={(e) => setDocs(e.target.checked ? [...docs, kind] : docs.filter((d) => d !== kind))} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={save.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
          {save.isPending ? "Saving…" : initial ? "Save changes" : "Add programme"}
        </button>
        {save.error && <span className="text-sm text-bad">{save.error.message}</span>}
      </div>
    </form>
  );
}
