"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  type City,
  type Country,
  type FinderParams,
  SEGMENT_LABELS,
  type Segment,
  formatNumber,
  searchable,
  useCategories,
  useCitySearch,
  useCountries,
  useCreateJob,
  useLoadGeonames,
  useRegions,
} from "@/lib/finder";

type AreaMode = "city" | "region" | "country";

const field = "mt-1.5 block w-full rounded-lg border border-line bg-surface px-3 py-2.5 outline-none focus:border-ink focus:ring-2 focus:ring-ink/15";

function Fieldset({ legend, hint, children }: { legend: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="border-t border-line-soft px-5 py-5 first:border-t-0">
      <legend className="sr-only">{legend}</legend>
      <p className="font-semibold" aria-hidden>
        {legend}
      </p>
      {hint && <p className="mt-0.5 text-sm text-ink-2">{hint}</p>}
      <div className="mt-3">{children}</div>
    </fieldset>
  );
}

function LoadAreas({ country, enabled }: { country: Country; enabled: Country[] }) {
  const load = useLoadGeonames();
  return (
    <div className="rounded-lg bg-warn-soft px-4 py-3 text-sm text-warn">
      <p className="font-semibold">Regions and cities for {country.name} are not loaded yet.</p>
      <p className="mt-0.5">
        They come from GeoNames and are needed to pick an area. This loads them for{" "}
        {enabled.map((c) => c.name).join(", ")} at once and takes about a minute.
      </p>
      <button
        type="button"
        onClick={() => load.mutate(enabled.map((c) => c.code))}
        disabled={load.isPending || load.isSuccess}
        className="mt-3 rounded-lg bg-ink px-3 py-2 font-medium text-white hover:bg-ink/90 disabled:opacity-60"
      >
        {load.isSuccess ? "Loading… (see Recent jobs)" : "Load regions and cities"}
      </button>
      {load.error && <p className="mt-2 text-bad">{load.error.message}</p>}
    </div>
  );
}

function CityPicker({
  country,
  city,
  onPick,
}: {
  country: string;
  city: City | null;
  onPick: (c: City | null) => void;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useCitySearch(city ? null : country, debounced);

  if (city) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
        <div>
          <p className="font-medium">{city.name}</p>
          <p className="text-sm text-ink-2">
            {[city.regionName, `${formatNumber(city.population)} people`].filter(Boolean).join(", ")}
          </p>
        </div>
        <button type="button" onClick={() => onPick(null)} className="text-sm font-medium underline underline-offset-4">
          Change
        </button>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="city-search" className="block text-sm font-medium">
        City
      </label>
      <input
        id="city-search"
        type="search"
        autoComplete="off"
        placeholder="Start typing, e.g. Manchester"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className={field}
      />
      <ul className="mt-2 divide-y divide-line-soft rounded-lg border border-line" aria-label="Matching cities">
        {(results.data ?? []).map((c) => (
          <li key={c.geonameId}>
            <button
              type="button"
              onClick={() => onPick(c)}
              className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-paper"
            >
              <span className="font-medium">{c.name}</span>
              <span className="text-sm text-ink-3">
                {[c.regionName, formatNumber(c.population)].filter(Boolean).join(", ")}
              </span>
            </button>
          </li>
        ))}
        {results.data?.length === 0 && <li className="px-3 py-2 text-sm text-ink-2">No city starts with “{debounced}”.</li>}
      </ul>
    </div>
  );
}

export function FinderForm() {
  const router = useRouter();
  const countries = useCountries();
  const categories = useCategories();
  const create = useCreateJob();

  const enabled = useMemo(() => (countries.data ?? []).filter(searchable), [countries.data]);
  const [code, setCode] = useState<string | null>(null);
  const country = enabled.find((c) => c.code === code) ?? enabled[0] ?? null;
  const [mode, setMode] = useState<AreaMode>("city");
  const [city, setCity] = useState<City | null>(null);
  const [radius, setRadius] = useState<string>("");
  const [regionCode, setRegionCode] = useState<string>("");
  const [segments, setSegments] = useState<Segment[]>(["A", "B"]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const regions = useRegions(country && mode === "region" ? country.code : null);

  const pickCountry = (next: string) => {
    setCode(next);
    setCity(null);
    setRegionCode("");
    setMode("city");
  };

  const visibleCategories = (categories.data?.items ?? []).filter((c) => segments.includes(c.segment));
  const chosenKeys = visibleCategories.filter((c) => !unchecked.has(c.key)).map((c) => c.key);
  const needsAreas = !!country && country.cities === 0;

  const params: FinderParams | null = (() => {
    if (!country || segments.length === 0 || chosenKeys.length === 0) return null;
    const base = {
      country: country.code,
      segments,
      ...(chosenKeys.length < visibleCategories.length ? { categoryKeys: chosenKeys } : {}),
    };
    if (mode === "city") {
      if (!city) return null;
      const r = Number(radius);
      return { ...base, cityGeonameId: city.geonameId, ...(radius && r >= 1 && r <= 50 ? { radiusKm: r } : {}) };
    }
    if (mode === "region") return regionCode ? { ...base, regionCode } : null;
    return country.allowWholeCountry ? base : null;
  })();

  const submit = (dryRun: boolean) => {
    if (!params) return;
    create.mutate({ params, dryRun }, { onSuccess: (id) => router.push(`/finder/jobs/${id}`) });
  };

  const toggleSegment = (s: Segment) =>
    setSegments((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s].sort()));
  const toggleCategory = (key: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (countries.isPending) return <p className="text-ink-2">Loading…</p>;
  if (countries.isError) return <p className="text-bad">{countries.error.message}</p>;
  if (!country) {
    return (
      <p className="text-ink-2">
        No country is on. Turn one on in{" "}
        <a href="/settings" className="font-medium underline underline-offset-4">
          Settings
        </a>
        .
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(true);
      }}
      className="rounded-xl border border-line bg-surface"
    >
      <Fieldset
        legend="Country"
        hint={
          country.enabled
            ? `${country.outreachRules.law}. ${country.outreachRules.notes}`
            : "Job search only: find and crawl companies here to apply for developer jobs. No sales e-mail is ever sent to this country."
        }
      >
        <select
          aria-label="Country"
          value={country.code}
          onChange={(e) => pickCountry(e.target.value)}
          className={field.replace("mt-1.5 ", "")}
        >
          {enabled.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
              {!c.enabled ? " (job search only)" : ""}
            </option>
          ))}
        </select>
      </Fieldset>

      <Fieldset legend="Area" hint="Imports are per city or region, so each one stays small.">
        {needsAreas ? (
          <LoadAreas country={country} enabled={enabled} />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Area type">
              {(
                [
                  ["city", "A city"],
                  ...(country.regionImports ? [["region", "A state"]] : []),
                  ...(country.allowWholeCountry ? [["country", `All of ${country.name}`]] : []),
                ] as [AreaMode, string][]
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                    mode === m ? "border-ink bg-ink text-white" : "border-line hover:bg-paper"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "city" && (
              <>
                <CityPicker
                  country={country.code}
                  city={city}
                  onPick={(c) => {
                    setCity(c);
                    setRadius(c ? String(c.defaultRadiusKm) : "");
                  }}
                />
                {city && (
                  <div className="max-w-48">
                    <label htmlFor="radius" className="block text-sm font-medium">
                      Distance from the centre (km)
                    </label>
                    <input
                      id="radius"
                      type="number"
                      min={1}
                      max={50}
                      step={0.1}
                      value={radius}
                      onChange={(e) => setRadius(e.target.value)}
                      className={field}
                    />
                  </div>
                )}
              </>
            )}

            {mode === "region" && (
              <div>
                <label htmlFor="region" className="block text-sm font-medium">
                  State
                </label>
                <select id="region" value={regionCode} onChange={(e) => setRegionCode(e.target.value)} className={field}>
                  <option value="">Choose a state</option>
                  {(regions.data ?? []).map((r) => (
                    <option key={r.regionCode} value={r.regionCode}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </Fieldset>

      <Fieldset legend="Who to find">
        <div className="grid gap-2 sm:grid-cols-2">
          {(["A", "B"] as Segment[]).map((s) => (
            <label
              key={s}
              className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2.5 ${
                segments.includes(s) ? "border-ink" : "border-line"
              }`}
            >
              <input type="checkbox" checked={segments.includes(s)} onChange={() => toggleSegment(s)} className="mt-1 accent-ink" />
              <span>
                <span className="block font-medium">{SEGMENT_LABELS[s].name}</span>
                <span className="block text-sm text-ink-2">{SEGMENT_LABELS[s].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Fieldset>

      <Fieldset legend="Kinds of business" hint={`${chosenKeys.length} of ${visibleCategories.length} selected`}>
        {(["A", "B"] as Segment[])
          .filter((s) => segments.includes(s))
          .map((s) => (
            <div key={s} className="mb-3 last:mb-0">
              <p className="text-sm text-ink-3">{SEGMENT_LABELS[s].name}</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {visibleCategories
                  .filter((c) => c.segment === s)
                  .map((c) => {
                    const on = !unchecked.has(c.key);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleCategory(c.key)}
                        className={`rounded-full border px-3 py-1 text-sm ${
                          on ? "border-ink bg-paper font-medium text-ink" : "border-line text-ink-3 line-through"
                        }`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
        {segments.length === 0 && <p className="text-sm text-bad">Choose agencies, businesses or both.</p>}
      </Fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-5 py-4">
        <button
          type="submit"
          disabled={!params || create.isPending}
          className="rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Estimate
        </button>
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={!params || create.isPending}
          className="rounded-lg border border-ink px-4 py-2.5 font-medium hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
        >
          Import leads
        </button>
        <p className="text-sm text-ink-2">An estimate counts leads without saving anything.</p>
        {create.error && (
          <p role="alert" className="w-full rounded-lg bg-bad-soft px-3 py-2.5 text-sm text-bad">
            {create.error.message}
          </p>
        )}
      </div>
    </form>
  );
}
