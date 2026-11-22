"use client";

import { useState } from "react";
import { type Level, type StudyProfile, useSaveStudyProfile, useStudyProfile } from "@/lib/study";
import { StudyNav } from "./StudyNav";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

export function StudyProfilePage() {
  const q = useStudyProfile();
  return (
    <div className="space-y-6">
      <StudyNav title="My profile" intro="Fill this in once. The checklists, the English fit and every e-mail draft use these facts — and only these." />
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {q.data && <ProfileForm initial={q.data} />}
    </div>
  );
}

type Form = Record<keyof StudyProfile, string | boolean>;

function toForm(p: StudyProfile): Form {
  const f = {} as Form;
  for (const [k, v] of Object.entries(p)) f[k as keyof StudyProfile] = typeof v === "boolean" ? v : Array.isArray(v) ? v.join(", ") : v === null ? "" : String(v);
  return f;
}

function ProfileForm({ initial }: { initial: StudyProfile }) {
  const save = useSaveStudyProfile();
  const [f, setF] = useState<Form>(() => toForm(initial));
  const [dirty, setDirty] = useState(false);
  const set = (k: keyof StudyProfile, v: string | boolean) => {
    setDirty(true);
    setF({ ...f, [k]: v });
  };
  const n = (k: keyof StudyProfile) => (String(f[k]).trim() === "" ? null : Number(f[k]));
  const t = (k: keyof StudyProfile) => (String(f[k]).trim() === "" ? null : String(f[k]).trim());
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDirty(false);
    save.mutate({
      fullName: String(f.fullName).trim(),
      nationality: String(f.nationality).trim() || "Bangladesh",
      dateOfBirth: t("dateOfBirth"),
      phone: t("phone"),
      targetLevel: f.targetLevel as Level,
      targetFields: String(f.targetFields)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      bscSubject: t("bscSubject"),
      bscUniversity: t("bscUniversity"),
      bscCgpa: n("bscCgpa"),
      bscCgpaScale: n("bscCgpaScale") ?? 4,
      bscYear: n("bscYear"),
      hscGpa: n("hscGpa"),
      hscYear: n("hscYear"),
      sscGpa: n("sscGpa"),
      sscYear: n("sscYear"),
      englishMedium: !!f.englishMedium,
      ieltsScore: n("ieltsScore"),
      duolingoScore: n("duolingoScore"),
      passportStatus: f.passportStatus as StudyProfile["passportStatus"],
      passportExpiry: t("passportExpiry"),
      workExperience: t("workExperience"),
      aboutMe: t("aboutMe"),
    });
  };
  const input = (k: keyof StudyProfile, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input value={String(f[k])} onChange={(e) => set(k, e.target.value)} className={field} {...props} />
      {hint && <span className="text-ink-3">{hint}</span>}
    </label>
  );
  const section = (title: string, children: React.ReactNode, note?: string) => (
    <fieldset className="rounded-xl border border-line bg-surface px-5 py-4">
      <legend className="sr-only">{title}</legend>
      <h2 className="font-semibold">{title}</h2>
      {note && <p className="mt-1 text-sm text-ink-2">{note}</p>}
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  );
  return (
    <form onSubmit={submit} className="space-y-5">
      {section(
        "About you",
        <>
          {input("fullName", "Full name (as in your passport)", { required: true })}
          {input("nationality", "Nationality")}
          {input("dateOfBirth", "Date of birth", { type: "date" })}
          {input("phone", "Phone (with country code)", { placeholder: "+880…" })}
        </>,
      )}
      {section(
        "What you want to study",
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Level</span>
            <select value={String(f.targetLevel)} onChange={(e) => set("targetLevel", e.target.value)} className={field}>
              <option value="master">Master&apos;s (with my BSc)</option>
              <option value="bachelor">Bachelor&apos;s (with SSC and HSC)</option>
              <option value="both">Both</option>
            </select>
          </label>
          <div className="sm:col-span-2">{input("targetFields", "Subjects", { placeholder: "Computer Science, Software Engineering, Data Science" }, "Comma separated.")}</div>
        </>,
      )}
      {section(
        "Bachelor (BSc)",
        <>
          {input("bscSubject", "Subject", { placeholder: "Computer Science and Engineering" })}
          {input("bscUniversity", "University")}
          {input("bscYear", "Year finished", { type: "number", min: 1990, max: 2035 })}
          {input("bscCgpa", "CGPA", { type: "number", step: 0.01, min: 0, max: 10, placeholder: "3.15" })}
          {input("bscCgpaScale", "Out of", { type: "number", step: 0.01, min: 1, max: 10 })}
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" className="size-4" checked={!!f.englishMedium} onChange={(e) => set("englishMedium", e.target.checked)} />
            My BSc was taught in English
          </label>
        </>,
        "Needed for master's applications.",
      )}
      {section(
        "School (SSC and HSC)",
        <>
          {input("hscGpa", "HSC GPA (out of 5)", { type: "number", step: 0.01, min: 0, max: 5 })}
          {input("hscYear", "HSC year", { type: "number", min: 1990, max: 2035 })}
          <span className="hidden lg:block" />
          {input("sscGpa", "SSC GPA (out of 5)", { type: "number", step: 0.01, min: 0, max: 5 })}
          {input("sscYear", "SSC year", { type: "number", min: 1990, max: 2035 })}
        </>,
        "Needed for bachelor's applications.",
      )}
      {section(
        "English",
        <>
          {input("ieltsScore", "IELTS overall (when you have it)", { type: "number", step: 0.5, min: 0, max: 9, placeholder: "e.g. 6.5" }, "Leave empty until you take the test. With a score, programmes are matched to it.")}
          {input("duolingoScore", "Duolingo English Test (optional)", { type: "number", min: 10, max: 160 })}
        </>,
      )}
      {section(
        "Passport",
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Passport</span>
            <select value={String(f.passportStatus)} onChange={(e) => set("passportStatus", e.target.value)} className={field}>
              <option value="none">Not yet</option>
              <option value="applied">Applied for</option>
              <option value="ready">Ready</option>
            </select>
          </label>
          {input("passportExpiry", "Valid until", { type: "date" })}
        </>,
      )}
      <fieldset className="rounded-xl border border-line bg-surface px-5 py-4">
        <h2 className="font-semibold">Facts the e-mails may use</h2>
        <p className="mt-1 text-sm text-ink-2">Short and true. The AI uses only what you write here and above; it is told never to invent anything.</p>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Work experience</span>
            <textarea rows={4} value={String(f.workExperience)} onChange={(e) => set("workExperience", e.target.value)} placeholder="Full-stack developer (Node.js, React) at Riyad Tech since 2025 …" className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">About me (projects, achievements, goals)</span>
            <textarea rows={4} value={String(f.aboutMe)} onChange={(e) => set("aboutMe", e.target.value)} className={field} />
          </label>
        </div>
      </fieldset>
      <div className="flex items-center gap-4">
        <button type="submit" disabled={save.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save profile"}
        </button>
        <span aria-live="polite" className="text-sm">
          {save.error ? <span className="text-bad">{save.error.message}</span> : save.isSuccess && !dirty ? <span className="text-go">Saved.</span> : dirty ? <span className="text-ink-3">Unsaved changes</span> : null}
        </span>
      </div>
    </form>
  );
}
