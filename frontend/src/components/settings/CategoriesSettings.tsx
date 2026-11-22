"use client";

import { SEGMENT_LABELS, type Segment, useCategories } from "@/lib/finder";

/** The reviewed category map (seed/categories.json), read-only. */
export function CategoriesSettings() {
  const { data } = useCategories();
  if (!data) return null;
  return (
    <section aria-labelledby="categories-title" className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="categories-title" className="text-base font-semibold">
          Kinds of business
        </h2>
        <p className="mt-0.5 text-sm text-ink-2">
          Read-only. Mapped from the Overture taxonomy of {data.taxonomyRelease}; changed in the reviewed file
          seed/categories.json.
        </p>
      </div>
      <div className="grid gap-x-8 px-5 py-4 md:grid-cols-2">
        {(["A", "B"] as Segment[]).map((s) => (
          <div key={s}>
            <h3 className="font-medium">{SEGMENT_LABELS[s].name}</h3>
            <ul className="mt-2 divide-y divide-line-soft text-sm">
              {data.items
                .filter((c) => c.segment === s)
                .map((c) => (
                  <li key={c.key} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span>{c.label}</span>
                    <span className="text-ink-3" title="Value for the fit score, 1 to 5">
                      {"●".repeat(c.value)}
                      <span className="text-line">{"●".repeat(5 - c.value)}</span>
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
