"use client";

import { useState } from "react";
import { SEGMENT_LABELS } from "@/lib/finder";
import {
  type CrawlerSettings as Crawler,
  type ScoreSettings as Scores,
  type SignalDef,
  useSettings,
  useSignalDefs,
  useUpdateSettings,
} from "@/lib/leads";

interface FieldDef {
  key: keyof Crawler;
  label: string;
  hint: string;
  min: number;
  max: number;
  /** Shown in seconds, stored in milliseconds. */
  ms?: boolean;
}

const FIELDS: FieldDef[] = [
  { key: "maxPagesPerDomain", label: "Pages per website", hint: "Home page included.", min: 1, max: 30 },
  { key: "concurrency", label: "Websites at once", hint: "Each website still gets one request at a time.", min: 1, max: 10 },
  { key: "minDelayMs", label: "Pause between pages (s)", hint: "At least 1.5 s; longer when robots.txt asks.", min: 1.5, max: 60, ms: true },
  { key: "timeoutMs", label: "Page time limit (s)", hint: "A page that takes longer is skipped.", min: 1, max: 60, ms: true },
  { key: "maxCrawlDelaySeconds", label: "Longest Crawl-delay accepted (s)", hint: "Sites asking for more are skipped.", min: 2, max: 120 },
  { key: "recrawlDays", label: "Crawl again after (days)", hint: "For “only leads not crawled yet”.", min: 1, max: 3650 },
];

const input = "w-full rounded-lg border border-line px-3 py-2";

export function CrawlerSettings() {
  const settings = useSettings();
  const save = useUpdateSettings("crawler");
  if (settings.isPending) return null;
  if (settings.isError) return <p className="text-bad">{settings.error.message}</p>;
  const current = settings.data.values.crawler;
  // A new key after saving starts the form again from the stored values.
  return <CrawlerForm key={JSON.stringify(current)} current={current} save={save} />;
}

function CrawlerForm({ current, save }: { current: Crawler; save: ReturnType<typeof useUpdateSettings> }) {
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, String(f.ms ? current[f.key] / 1000 : current[f.key])])),
  );
  const [dirty, setDirty] = useState(false);
  const saved = save.isSuccess && !dirty;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDirty(false);
    const body = Object.fromEntries(
      FIELDS.map((f) => {
        const n = Number(form[f.key]);
        return [f.key, f.ms ? Math.round(n * 1000) : Math.round(n)];
      }),
    );
    save.mutate(body);
  };

  return (
    <section aria-labelledby="crawler-title" className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="crawler-title" className="font-semibold">
          Website crawler
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          The crawler calls itself RiyadTechBot, follows robots.txt and stops at bot blocks. Changes reach the worker within a
          minute.
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{f.label}</span>
            <input
              type="number"
              step={f.ms ? 0.1 : 1}
              min={f.min}
              max={f.max}
              value={form[f.key] ?? ""}
              onChange={(e) => {
                setDirty(true);
                setForm({ ...form, [f.key]: e.target.value });
              }}
              className={input}
            />
            <span className="text-ink-3">{f.hint}</span>
          </label>
        ))}
        <div className="flex items-center gap-4 sm:col-span-2 lg:col-span-3">
          <button type="submit" disabled={save.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
            {save.isPending ? "Saving…" : "Save crawler settings"}
          </button>
          <span aria-live="polite" className="text-sm">
            {save.error ? <span className="text-bad">{save.error.message}</span> : saved ? <span className="text-go">Saved.</span> : null}
          </span>
        </div>
      </form>
    </section>
  );
}

/** Signal weights (Settings → scores). Empty field = the default from the rules file. */
export function ScoreSettings() {
  const settings = useSettings();
  const defs = useSignalDefs();
  const save = useUpdateSettings("scores");
  if (settings.isPending || defs.isPending) return null;
  if (settings.isError || defs.isError) return null;
  const current = settings.data.values.scores;
  return <ScoreForm key={JSON.stringify(current)} current={current} defs={defs.data} save={save} />;
}

function ScoreForm({ current, defs, save }: { current: Scores; defs: SignalDef[]; save: ReturnType<typeof useUpdateSettings> }) {
  const [weights, setWeights] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(current.weights).map(([k, v]) => [k, String(v)])),
  );
  const [threshold, setThreshold] = useState(String(current.agentThreshold));
  const [dirty, setDirty] = useState(false);
  const saved = save.isSuccess && !dirty;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setDirty(false);
    const w: Record<string, number> = {};
    for (const [k, v] of Object.entries(weights)) if (v.trim() !== "") w[k] = Math.round(Number(v));
    save.mutate({ weights: w, agentThreshold: Math.round(Number(threshold)) });
  };

  const groups = [
    { title: `${SEGMENT_LABELS.A.name} (Segment A)`, items: defs.filter((d) => d.segment === "A") },
    { title: `${SEGMENT_LABELS.B.name} (Segment B)`, items: defs.filter((d) => d.segment === "B") },
    { title: "Both segments", items: defs.filter((d) => d.segment === "*") },
  ];

  return (
    <section aria-labelledby="scores-title" className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="scores-title" className="font-semibold">
          Scores
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          Fit = category value × 10 plus the fit signals; need = the need signals; both 0 to 100. Lists sort by fit × need.
          New weights apply to the next crawl of a lead.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-5 px-5 py-4">
        <div className="grid gap-6 lg:grid-cols-3">
          {groups.map((g) => (
            <fieldset key={g.title}>
              <legend className="mb-2 text-sm font-semibold">{g.title}</legend>
              <div className="space-y-2">
                {g.items.map((d) => (
                  <label key={d.key} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      {d.label} <span className="text-ink-3">({d.score})</span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      placeholder={String(d.weight)}
                      value={weights[d.key] ?? ""}
                      onChange={(e) => {
                        setDirty(true);
                        setWeights({ ...weights, [d.key]: e.target.value });
                      }}
                      className="w-20 rounded-lg border border-line px-2 py-1.5 text-right"
                      aria-label={`Weight for ${d.label}`}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <label className="flex max-w-md flex-col gap-1 text-sm">
          <span className="font-medium">AI agent offer from (Segment B)</span>
          <input
            type="number"
            min={1}
            max={100}
            value={threshold}
            onChange={(e) => {
              setDirty(true);
              setThreshold(e.target.value);
            }}
            className="w-28 rounded-lg border border-line px-3 py-2"
          />
          <span className="text-ink-3">
            When quote requests, manual paperwork and CRM tools add up to this, the lead gets the AI agent offer instead of the
            chatbot.
          </span>
        </label>
        <div className="flex items-center gap-4">
          <button type="submit" disabled={save.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
            {save.isPending ? "Saving…" : "Save weights"}
          </button>
          <span aria-live="polite" className="text-sm">
            {save.error ? <span className="text-bad">{save.error.message}</span> : saved ? <span className="text-go">Saved.</span> : null}
          </span>
        </div>
      </form>
    </section>
  );
}
