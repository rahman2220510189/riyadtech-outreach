"use client";

import { useState } from "react";
import { useCategories, useRegions } from "@/lib/finder";
import type { LeadFilters } from "@/lib/leads";

const field = "rounded-lg border border-line bg-surface px-2.5 py-2";

/** Region, kind of business, minimum scores, offer and suppression: folded away until needed. */
export function MoreFilters({ filters, set }: { filters: LeadFilters; set: (changes: Record<string, string | undefined>) => void }) {
  const active = [filters.regionCode, filters.category, filters.minFit, filters.minNeed, filters.bestOffer, filters.suppressed, filters.city].filter(
    (v) => v !== undefined,
  ).length;
  const [open, setOpen] = useState(active > 0);
  const regions = useRegions(filters.country ?? null);
  const categories = useCategories();
  const cats = (categories.data?.items ?? []).filter((c) => !filters.segment || c.segment === filters.segment);

  return (
    <div className="col-span-full">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-sm font-medium underline underline-offset-4">
        {open ? "Fewer filters" : `More filters${active ? ` (${active} on)` : ""}`}
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-ink-2">Region</span>
            <select
              value={filters.regionCode ?? ""}
              disabled={!filters.country || (regions.data?.length ?? 0) === 0}
              onChange={(e) => set({ regionCode: e.target.value })}
              className={field}
            >
              <option value="">{filters.country ? "All" : "Choose a country"}</option>
              {(regions.data ?? [])
                .filter((r) => r.regionCode)
                .map((r) => (
                  <option key={r.regionCode} value={r.regionCode}>
                    {r.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-ink-2">City</span>
            <input
              type="text"
              defaultValue={filters.city ?? ""}
              placeholder="e.g. Berlin"
              onBlur={(e) => {
                if (e.target.value.trim() !== (filters.city ?? "")) set({ city: e.target.value.trim() });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") set({ city: (e.target as HTMLInputElement).value.trim() });
              }}
              className={field}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-ink-2">Kind of business</span>
            <select value={filters.category ?? ""} onChange={(e) => set({ category: e.target.value })} className={field}>
              <option value="">All</option>
              {cats.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-ink-2">Fit at least</span>
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              defaultValue={filters.minFit ?? ""}
              onBlur={(e) => set({ minFit: e.target.value || undefined })}
              className={field}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-ink-2">Need at least</span>
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              defaultValue={filters.minNeed ?? ""}
              onBlur={(e) => set({ minNeed: e.target.value || undefined })}
              className={field}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="text-ink-2">Offer / suppression</span>
            <select
              value={filters.suppressed === true ? "suppressed" : (filters.bestOffer ?? "")}
              onChange={(e) =>
                e.target.value === "suppressed"
                  ? set({ suppressed: "true", bestOffer: undefined })
                  : set({ bestOffer: e.target.value, suppressed: undefined })
              }
              className={field}
            >
              <option value="">Any</option>
              <option value="chatbot">AI chatbot leads</option>
              <option value="agent">AI agent leads</option>
              <option value="suppressed">Suppressed only</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
