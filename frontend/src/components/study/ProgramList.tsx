"use client";

import Link from "next/link";
import { useState } from "react";
import { ENGLISH_LABELS, FIT_LEVEL_STYLE, FIT_LEVEL_TEXT, LEVEL_LABELS, type Program, STATUS_LABELS, urgency, usePrograms, WINDOW_TEXT, whenText } from "@/lib/study";
import { StudyNav } from "./StudyNav";

export const FIT_STYLE = { yes: "bg-go-soft text-go", maybe: "bg-warn-soft text-warn", no: "bg-bad-soft text-bad" } as const;
export const FIT_TEXT = { yes: "English: fits", maybe: "English: check", no: "English: not yet" } as const;
const DATE_STYLE = { red: "text-bad", orange: "text-warn", calm: "text-ink-2" } as const;

const select = "rounded-lg border border-line bg-surface px-3 py-2 text-sm";

export function ProgramList() {
  const [status, setStatus] = useState("active");
  const [level, setLevel] = useState("");
  const [fit, setFit] = useState("");
  const [kind, setKind] = useState("");
  const [country, setCountry] = useState("");
  const [sort, setSort] = useState("fit");
  const q = usePrograms({
    status: status === "open" ? "active" : status,
    ...(status === "open" ? { open: "1" } : {}),
    ...(level ? { level } : {}),
    ...(fit ? { fit } : {}),
    ...(kind === "auto" ? { origin: "auto" } : {}),
    sort,
  });
  const countries = [...new Set((q.data ?? []).map((p) => p.country))].sort((a, b) => a.localeCompare(b));
  const shown = (q.data ?? []).filter((p) => (!kind || kind === "auto" || p.kind === kind) && (!country || p.country === country));
  return (
    <div className="space-y-6">
      <StudyNav title="Scholarships & programmes" intro="Sorted by how well the subject suits you (change it under Sort). Facts were collected from official sites but can change — open the official page and tick “checked” once you have confirmed them." />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Show</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={select}>
            <option value="active">Active (not rejected / not now)</option>
            <option value="open">Applications open now</option>
            <option value="all">All</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={select}>
            <option value="">All</option>
            <option value="scholarship">Scholarships</option>
            <option value="programme">Universities and country guides</option>
            <option value="auto">Found automatically</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Country</span>
          <select value={country} onChange={(e) => setCountry(e.target.value)} className={select}>
            <option value="">All countries</option>
            {countries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Level</span>
          <select value={level} onChange={(e) => setLevel(e.target.value)} className={select}>
            <option value="">Any</option>
            <option value="master">Master</option>
            <option value="bachelor">Bachelor</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">English</span>
          <select value={fit} onChange={(e) => setFit(e.target.value)} className={select}>
            <option value="">Any</option>
            <option value="yes">Fits me now</option>
            <option value="maybe">Need to check</option>
            <option value="no">Not yet</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)} className={select}>
            <option value="fit">Best match for me</option>
            <option value="date">Nearest date</option>
          </select>
        </label>
        <Link href="/study/programs/new" className="ml-auto rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
          Add a programme
        </Link>
      </div>
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {q.data && (
        <p className="text-sm text-ink-2">
          {shown.length} shown{shown.length !== q.data.length ? ` of ${q.data.length}` : ""} · {shown.filter((p) => p.kind === "scholarship").length} scholarships,{" "}
          {shown.filter((p) => p.kind === "programme" && p.origin !== "auto").length} country guides, {shown.filter((p) => p.origin === "auto").length} found automatically
        </p>
      )}
      {q.data && shown.length === 0 && <p className="rounded-xl border border-line bg-surface px-5 py-6 text-ink-2">Nothing matches these filters.</p>}
      <ul className="grid gap-4 lg:grid-cols-2">
        {shown.map((p) => (
          <ProgramCard key={p.id} p={p} />
        ))}
      </ul>
    </div>
  );
}

function ProgramCard({ p }: { p: Program }) {
  return (
    <li className="flex flex-col rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
            {p.country} · {p.kind === "scholarship" ? "Scholarship" : "Programme"} · {LEVEL_LABELS[p.level]}
          </p>
          <h2 className="mt-0.5 text-lg font-semibold leading-snug">
            <Link href={`/study/programs/${p.id}`} className="hover:underline">
              {p.name}
            </Link>
          </h2>
        </div>
        <span className="shrink-0 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium">{STATUS_LABELS[p.status]}</span>
      </div>
      {p.funding && <p className="mt-2 line-clamp-2 text-sm text-ink-2">{p.funding}</p>}
      <p className="mt-2 text-sm">
        <span className={`mr-2 rounded-full px-2.5 py-0.5 text-xs font-medium ${FIT_LEVEL_STYLE[p.subjectFit.level]}`}>{FIT_LEVEL_TEXT[p.subjectFit.level]}</span>
        <span className="text-ink-2">{p.subjectFit.reasons[0]}</span>
      </p>
      {p.subjectFit.warnings.map((w) => (
        <p key={w} className="mt-1 text-sm font-medium text-bad">
          ⚠ {w}
        </p>
      ))}
      <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
        <span className={`rounded-full px-2.5 py-1 ${FIT_STYLE[p.english.fit]}`} title={p.english.why}>
          {FIT_TEXT[p.english.fit]}
        </span>
        <span className="rounded-full bg-paper px-2.5 py-1 text-ink-2">{ENGLISH_LABELS[p.englishRequirement]}</span>
        <span className={`rounded-full px-2.5 py-1 ${p.docsMissing ? "bg-warn-soft text-warn" : "bg-go-soft text-go"}`}>
          {p.docsMissing ? `${p.docsMissing} document${p.docsMissing === 1 ? "" : "s"} missing` : "Documents ready"}
        </span>
        {!p.verified && <span className="rounded-full bg-paper px-2.5 py-1 text-ink-3">Not checked yet</span>}
        {p.origin === "auto" && <span className="rounded-full bg-paper px-2.5 py-1 text-ink-3">Found automatically</span>}
        {p.window && (
          <span className={`rounded-full px-2.5 py-1 ${p.window.state === "opens_soon" ? "bg-warn-soft text-warn" : "bg-go text-white"}`} title={p.window.fromWebsite ? "Date found on the website, not confirmed yet" : undefined}>
            {WINDOW_TEXT[p.window.state]}
            {p.window.state === "opens_soon" ? ` · ${p.window.opensOn}` : ` · ${p.window.daysLeft} days left`}
          </span>
        )}
        {(p.newFindings ?? 0) > 0 && <span className="rounded-full bg-ink px-2.5 py-1 text-white">{p.newFindings} new from the website</span>}
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 pt-4 text-sm">
        {p.nextDate ? (
          <span className={DATE_STYLE[urgency(p.nextDate.daysLeft)]}>
            <strong>{p.nextDate.label}</strong> {whenText(p.nextDate.daysLeft)} · {p.nextDate.dueOn}
            {p.nextDate.confirmed ? "" : " (expected)"}
          </span>
        ) : (
          <span className="text-ink-3">No date yet</span>
        )}
        <span className="flex shrink-0 items-center gap-3">
          {p.applyUrl && (
            <a href={p.applyUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white hover:bg-ink/90">
              Apply ↗
            </a>
          )}
          <Link href={`/study/programs/${p.id}`} className="font-medium underline underline-offset-4">
            Open
          </Link>
        </span>
      </div>
    </li>
  );
}
