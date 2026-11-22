"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { type Country, formatNumber, useCountries, useJobSearchCountry, useSwitchCountry } from "@/lib/finder";

function importMode(c: Country): string {
  if (c.regionImports) return "By state or city";
  if (c.allowWholeCountry) return "Whole country or city";
  return "By city";
}

function RulesBadge({ c }: { c: Country }) {
  if (c.blocked) return <span className="rounded-full bg-bad-soft px-2 py-0.5 text-xs font-semibold text-bad">Blocked by default</span>;
  if (c.outreachRules.verified) return <span className="rounded-full bg-go-soft px-2 py-0.5 text-xs font-semibold text-go">Rules checked</span>;
  return <span className="rounded-full bg-warn-soft px-2 py-0.5 text-xs font-semibold text-warn">Rules not verified</span>;
}

function Switch({ on, label, onClick, disabled }: { on: boolean; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? "bg-go" : "bg-line"}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow-sm transition-transform ${on ? "translate-x-5.5" : "translate-x-0.5"}`} />
    </button>
  );
}

function Row({ c }: { c: Country }) {
  const toggle = useSwitchCountry();
  const jobs = useJobSearchCountry();
  const [confirming, setConfirming] = useState(false);
  const [rulesOk, setRulesOk] = useState(false);
  const [legalOk, setLegalOk] = useState(false);
  const needsConfirm = !c.outreachRules.verified || c.blocked;

  const onSwitch = () => {
    if (c.enabled) toggle.mutate({ code: c.code, enabled: false });
    else if (needsConfirm) setConfirming((v) => !v);
    else toggle.mutate({ code: c.code, enabled: true });
  };
  const turnOn = () =>
    toggle.mutate(
      { code: c.code, enabled: true, confirmRules: rulesOk, ...(c.blocked ? { confirmBlocked: legalOk } : {}) },
      { onSuccess: () => setConfirming(false) },
    );

  return (
    <li className="px-5 py-3.5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{c.name}</p>
            <RulesBadge c={c} />
          </div>
          <p className="mt-0.5 text-sm text-ink-2">
            {c.outreachRules.law}. {importMode(c)}.{" "}
            {c.cities > 0 ? `${formatNumber(c.cities)} cities loaded.` : "Cities not loaded yet."}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2 text-xs text-ink-2">
            <span>Outreach</span>
            <Switch on={c.enabled} label={`${c.name} outreach ${c.enabled ? "on" : "off"}`} onClick={onSwitch} disabled={toggle.isPending} />
          </div>
          {!c.enabled && (
            <div className="flex items-center gap-2 text-xs text-ink-2">
              <span>Job search</span>
              <Switch
                on={c.jobSearch}
                label={`${c.name} job search ${c.jobSearch ? "on" : "off"}`}
                onClick={() => jobs.mutate({ code: c.code, jobSearch: !c.jobSearch })}
                disabled={jobs.isPending}
              />
            </div>
          )}
        </div>
      </div>

      {confirming && !c.enabled && (
        <div className={`mt-3 rounded-lg px-4 py-3 text-sm ${c.blocked ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
          <p>{c.outreachRules.notes}</p>
          <label className="mt-3 flex gap-2 text-ink">
            <input type="checkbox" checked={rulesOk} onChange={(e) => setRulesOk(e.target.checked)} className="mt-0.5 accent-ink" />
            <span>I have checked the cold e-mail rules for {c.name} and they allow this outreach.</span>
          </label>
          {c.blocked && (
            <label className="mt-2 flex gap-2 text-ink">
              <input type="checkbox" checked={legalOk} onChange={(e) => setLegalOk(e.target.checked)} className="mt-0.5 accent-ink" />
              <span>I have legal advice that cold e-mail to businesses in {c.name} is allowed.</span>
            </label>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={turnOn}
              disabled={!rulesOk || (c.blocked && !legalOk) || toggle.isPending}
              className="rounded-lg bg-ink px-3 py-2 font-medium text-white hover:bg-ink/90 disabled:opacity-50"
            >
              Turn on {c.name}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-lg border border-line px-3 py-2 font-medium text-ink hover:bg-surface">
              Keep off
            </button>
          </div>
        </div>
      )}

      {(c.enabled || c.jobSearch) && c.cities === 0 && (
        <p className="mt-2 text-sm text-ink-2">
          Next: load its regions and cities on the{" "}
          <Link href="/finder" className="font-medium underline underline-offset-4">
            Finder
          </Link>{" "}
          page.
        </p>
      )}
      {(toggle.error ?? jobs.error) && <p className="mt-2 text-sm text-bad">{(toggle.error ?? jobs.error)?.message}</p>}
    </li>
  );
}

export function CountriesSettings() {
  const countries = useCountries();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (countries.data ?? []).filter((c) => !term || c.name.toLowerCase().includes(term) || c.code.toLowerCase() === term);
  }, [countries.data, q]);
  const on = list.filter((c) => c.enabled);
  const jobsOnly = list.filter((c) => !c.enabled && c.jobSearch);
  const off = list.filter((c) => !c.enabled && !c.jobSearch);

  return (
    <section aria-labelledby="countries-title" className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line-soft px-5 py-4">
        <div>
          <h2 id="countries-title" className="text-base font-semibold">
            Countries
          </h2>
          <p className="mt-0.5 max-w-prose text-sm text-ink-2">
            Outreach on: leads can be found and e-mailed. Job search only: companies can be found and crawled so you can
            apply for jobs; nothing is ever sent to them. Not legal advice: check each country&apos;s rules before turning
            outreach on.
          </p>
        </div>
        <input
          type="search"
          aria-label="Search countries"
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-44 rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-ink"
        />
      </div>
      {countries.isPending && <p className="px-5 py-4 text-ink-2">Loading…</p>}
      {countries.isError && <p className="px-5 py-4 text-bad">{countries.error.message}</p>}
      {countries.data && (
        <>
          <h3 className="bg-paper/60 px-5 py-2 text-sm font-medium text-ink-2">On ({on.length})</h3>
          <ul className="divide-y divide-line-soft">
            {on.map((c) => (
              <Row key={c.code} c={c} />
            ))}
            {on.length === 0 && <li className="px-5 py-3 text-sm text-ink-2">No country matches.</li>}
          </ul>
          {jobsOnly.length > 0 && (
            <>
              <h3 className="border-t border-line-soft bg-paper/60 px-5 py-2 text-sm font-medium text-ink-2">
                Job search only ({jobsOnly.length})
              </h3>
              <ul className="divide-y divide-line-soft">
                {jobsOnly.map((c) => (
                  <Row key={c.code} c={c} />
                ))}
              </ul>
            </>
          )}
          <h3 className="border-t border-line-soft bg-paper/60 px-5 py-2 text-sm font-medium text-ink-2">Off ({off.length})</h3>
          <ul className="divide-y divide-line-soft">
            {off.map((c) => (
              <Row key={c.code} c={c} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
