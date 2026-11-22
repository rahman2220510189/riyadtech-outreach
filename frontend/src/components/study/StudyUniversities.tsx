"use client";

import Link from "next/link";
import { useState } from "react";
import { countryLabel, WORLD_COUNTRIES } from "@/lib/countries";
import { formatNumber } from "@/lib/finder";
import {
  type StudySettings,
  UNIVERSITY_STATUS,
  type UniversityStatus,
  type WatchJob,
  useAiSearch,
  useCheckUniversity,
  useRefreshDirectory,
  useSaveStudySettings,
  useSetUniversityStatus,
  useStartCheck,
  useUniversities,
} from "@/lib/study";
import { StudyNav } from "./StudyNav";

const select = "rounded-lg border border-line bg-surface px-3 py-2 text-sm";
const STATUS_STYLE: Record<UniversityStatus, string> = {
  new: "bg-paper text-ink-2",
  found: "bg-go-soft text-go",
  nothing: "bg-paper text-ink-3",
  unreadable: "bg-warn-soft text-warn",
  skipped: "bg-paper text-ink-3",
};

function JobLine({ title, job }: { title: string; job: WatchJob | null }) {
  if (!job) return <p className="text-sm text-ink-3">{title}: not run yet.</p>;
  const s = job.summary ?? {};
  const active = job.status === "running" || job.status === "queued";
  const parts = [
    s.read ? `${formatNumber(s.read)} read` : null,
    s.added ? `${formatNumber(s.added)} new` : null,
    s.sites ? `${s.sites} websites` : null,
    s.found ? `${s.found} useful` : null,
    s.programs ? `${s.programs} programmes re-checked` : null,
    s.findings ? `${s.findings} new facts` : null,
    s.countries ? `${s.countries} countr${s.countries === 1 ? "y" : "ies"} searched, ${s.proposed ?? 0} proposed, ${s.verified ?? 0} confirmed on their pages` : null,
  ].filter(Boolean);
  return (
    <p className="text-sm">
      <span className="font-medium">{title}:</span>{" "}
      <span className={active ? "text-warn" : job.status === "done" ? "text-ink-2" : "text-bad"}>{active ? "running now…" : job.status}</span>
      <span className="text-ink-3">
        {" "}
        · started {new Date(job.createdAt).toLocaleString()}
        {parts.length ? ` · ${parts.join(", ")}` : ""}
      </span>{" "}
      <Link href={`/finder/jobs/${job.id}`} className="underline underline-offset-4">
        Details
      </Link>
    </p>
  );
}

function SettingsForm({ s }: { s: StudySettings }) {
  const save = useSaveStudySettings();
  const [f, setF] = useState(s);
  const [saved, setSaved] = useState(s);
  const dirty = JSON.stringify(f) !== JSON.stringify(saved);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(f, { onSuccess: () => setSaved(f) });
      }}
      className="space-y-3"
    >
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={f.autoCheck} onChange={(e) => setF({ ...f, autoCheck: e.target.checked })} />
        Check automatically once a day (while the tool is running)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={f.aiSearch} onChange={(e) => setF({ ...f, aiSearch: e.target.checked })} />
        Also search scholarships with AI each day,
        <input type="number" min={1} max={20} value={f.aiCountriesPerDay} onChange={(e) => setF({ ...f, aiCountriesPerDay: Number(e.target.value) })} aria-label="Countries per day" className="w-16 rounded-lg border border-line px-2 py-1" />
        countries a day
      </label>
      <fieldset>
        <legend className="text-sm font-medium">Countries ({f.countries.length})</legend>
        <div className="mt-1 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {[...f.countries]
            .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)))
            .map((c) => (
              <span key={c} className="inline-flex items-center gap-1 rounded-full bg-paper px-2.5 py-0.5 text-xs">
                {countryLabel(c)}
                <button type="button" aria-label={`Remove ${countryLabel(c)}`} disabled={f.countries.length <= 1} onClick={() => setF({ ...f, countries: f.countries.filter((x) => x !== c) })} className="text-ink-3 hover:text-bad">
                  ×
                </button>
              </span>
            ))}
        </div>
        <select
          value=""
          onChange={(e) => e.target.value && setF({ ...f, countries: [...f.countries, e.target.value] })}
          aria-label="Add a country"
          className={`${select} mt-2 w-56`}
        >
          <option value="">Add a country…</option>
          {WORLD_COUNTRIES.filter((c) => !f.countries.includes(c))
            .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)))
            .map((c) => (
              <option key={c} value={c}>
                {countryLabel(c)}
              </option>
            ))}
        </select>
        <p className="mt-1 text-xs text-ink-3">After adding countries, press “Refresh the directory” to load their universities.</p>
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">New universities per day</span>
          <input type="number" min={0} max={300} value={f.newSitesPerDay} onChange={(e) => setF({ ...f, newSitesPerDay: Number(e.target.value) })} className={`${select} w-32`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Pages per university</span>
          <input type="number" min={1} max={20} value={f.maxPagesPerSite} onChange={(e) => setF({ ...f, maxPagesPerSite: Number(e.target.value) })} className={`${select} w-32`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">ROR client ID (optional)</span>
          <input value={f.rorClientId} onChange={(e) => setF({ ...f, rorClientId: e.target.value })} placeholder="faster ROR downloads" className={`${select} w-56`} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={!dirty || save.isPending} className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.isSuccess && !dirty && <span className="text-sm text-go">Saved.</span>}
        {save.error && <span className="text-sm text-bad">{save.error.message}</span>}
      </div>
    </form>
  );
}

/** "Search this country with AI now": Groq proposes, the tool checks every page. */
function AiSearchBox({ countries, configured }: { countries: string[]; configured: boolean }) {
  const ai = useAiSearch();
  const [country, setCountry] = useState(countries[0] ?? "");
  if (!configured) return <p className="mt-4 text-sm text-ink-3">AI scholarship search needs GROQ_API_KEY in backend/.env.</p>;
  return (
    <div className="mt-4 border-t border-line-soft pt-3">
      <p className="text-sm font-medium">Search scholarships with AI</p>
      <p className="text-xs text-ink-3">Groq searches the web; the tool opens every proposed official page and keeps only those that name the scholarship. Results appear under “Found automatically”.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country to search" className={select}>
          {[...countries]
            .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)))
            .map((c) => (
              <option key={c} value={c}>
                {countryLabel(c)}
              </option>
            ))}
        </select>
        <button type="button" disabled={ai.isPending || !country} onClick={() => ai.mutate([country])} className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50">
          {ai.isPending ? "Starting…" : "Search now"}
        </button>
      </div>
      {ai.isSuccess && <p className="mt-2 text-sm text-go">Search started; it takes a few minutes.</p>}
      {ai.error && <p className="mt-2 text-sm text-bad">{ai.error.message}</p>}
    </div>
  );
}

export function StudyUniversities() {
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const data = useUniversities({ ...(country ? { country } : {}), ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}), page });
  const refresh = useRefreshDirectory();
  const check = useStartCheck();
  const checkOne = useCheckUniversity();
  const setUni = useSetUniversityStatus();
  const d = data.data;
  const total = d ? Object.values(d.counts).reduce((a, b) => a + (b ?? 0), 0) : 0;

  return (
    <div className="space-y-6">
      <StudyNav
        title="Universities"
        intro="Universities in the countries you choose (below) from three open lists (GitHub university list, ROR, Wikidata). Every day the tool reads a few of their websites — politely, as RiyadTechBot, following robots.txt — and turns the ones that say something about English proof or deadlines into programmes."
      />
      {data.isError && <p className="text-bad">{data.error.message}</p>}
      {d && (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="rounded-xl border border-line bg-surface px-5 py-4" aria-labelledby="dir-h">
            <h2 id="dir-h" className="font-semibold">
              Directory: {formatNumber(total)} universities
            </h2>
            <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {(Object.keys(UNIVERSITY_STATUS) as UniversityStatus[]).map((k) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="text-ink-2">{UNIVERSITY_STATUS[k]}</span>
                  <span className="tabular-nums">{formatNumber(d.counts[k] ?? 0)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-ink-3">Sources: {d.sources.map((s) => `${s.name} ${formatNumber(s.n)}`).join(" · ")}</p>
            <div className="mt-3 space-y-1">
              <JobLine title="Directory refresh" job={d.lastDirectoryJob} />
              <JobLine title="Last check" job={d.lastCheckJob} />
              <JobLine title="Last AI search" job={d.lastAiJob} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => check.mutate({})} disabled={check.isPending} className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
                {check.isPending ? "Starting…" : "Check now"}
              </button>
              <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending} className="rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50">
                {refresh.isPending ? "Starting…" : "Refresh the directory"}
              </button>
            </div>
            {(check.error ?? refresh.error) && <p className="mt-2 text-sm text-bad">{(check.error ?? refresh.error)?.message}</p>}
            <AiSearchBox countries={d.settings.countries} configured={d.aiConfigured} />
            {total === 0 && !d.lastDirectoryJob && <p className="mt-3 text-sm text-ink-2">The directory loads by itself a few minutes after the tool starts (ROR alone takes about half an hour).</p>}
          </section>
          <section className="rounded-xl border border-line bg-surface px-5 py-4" aria-labelledby="set-h">
            <h2 id="set-h" className="font-semibold">
              Daily check
            </h2>
            <p className="mt-1 mb-3 text-sm text-ink-2">
              Followed programmes are re-read every day. Sites that refuse bots, or show nothing without JavaScript, are marked “Could not be read”: open them yourself and paste the text on the programme page.
            </p>
            <SettingsForm s={d.settings} />
          </section>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Country</span>
          <select
            value={country}
            onChange={(e) => {
              setCountry(e.target.value);
              setPage(1);
            }}
            className={select}
          >
            <option value="">All countries</option>
            {d?.countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.n})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Status</span>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className={select}
          >
            <option value="">Any</option>
            {(Object.keys(UNIVERSITY_STATUS) as UniversityStatus[]).map((k) => (
              <option key={k} value={k}>
                {UNIVERSITY_STATUS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Search</span>
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Name or website"
            className={select}
          />
        </label>
      </div>

      {d && d.items.length === 0 && <p className="rounded-xl border border-line bg-surface px-5 py-6 text-ink-2">No universities match.</p>}
      {d && d.items.length > 0 && (
        <div className="relative overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-ink-3">
              <tr>
                <th className="px-4 py-2 font-medium">University</th>
                <th className="px-4 py-2 font-medium">Country</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {d.items.map((u) => (
                <tr key={u.id} className="align-top">
                  <td className="px-4 py-2">
                    <p className="font-medium">{u.programId ? <Link href={`/study/programs/${u.programId}`} className="underline underline-offset-4">{u.name}</Link> : u.name}</p>
                    <a href={u.website} target="_blank" rel="noopener noreferrer" className="text-xs text-ink-3 underline underline-offset-2">
                      {u.domain}
                    </a>
                    {u.note && <p className="mt-0.5 line-clamp-2 max-w-xl text-xs text-ink-3">{u.note}</p>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-ink-2">{u.country}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[u.status]}`}>{UNIVERSITY_STATUS[u.status]}</span>
                    {u.lastCheckedAt && <p className="mt-0.5 text-xs text-ink-3">{u.lastCheckedAt.slice(0, 10)}</p>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <button type="button" onClick={() => checkOne.mutate(u.id)} disabled={checkOne.isPending} className="text-xs underline underline-offset-2 disabled:opacity-50">
                      Check now
                    </button>
                    {u.status !== "skipped" ? (
                      <button type="button" onClick={() => setUni.mutate({ id: u.id, status: "skipped" })} className="ml-3 text-xs text-ink-3 underline underline-offset-2">
                        Skip
                      </button>
                    ) : (
                      <button type="button" onClick={() => setUni.mutate({ id: u.id, status: "new" })} className="ml-3 text-xs text-ink-3 underline underline-offset-2">
                        Un-skip
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && d.total > 50 && (
        <div className="flex items-center justify-between text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40">
            ← Previous
          </button>
          <span className="text-ink-2">
            Page {page} of {Math.ceil(d.total / 50)} ({formatNumber(d.total)})
          </span>
          <button type="button" disabled={page * 50 >= d.total} onClick={() => setPage(page + 1)} className="rounded-lg border border-line px-3 py-1.5 disabled:opacity-40">
            Next →
          </button>
        </div>
      )}
      {checkOne.isSuccess && <p className="text-sm text-go">Check started; results appear here and under Updates in a minute or two.</p>}
    </div>
  );
}
