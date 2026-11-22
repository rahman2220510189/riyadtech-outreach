"use client";

import { useCategories } from "@/lib/finder";

/** Attribution required by the data licences (Overture: CDLA Permissive 2.0, GeoNames: CC BY 4.0). */
export function DataSources() {
  const { data } = useCategories();
  if (!data) return null;
  return (
    <footer className="text-sm text-ink-3">
      <p>
        Data:{" "}
        {data.dataSources.map((d, i) => (
          <span key={d.name}>
            {i > 0 && "; "}
            <a href={d.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {d.name}
            </a>{" "}
            ({d.use.toLowerCase()}, {d.licence.split(" (")[0]})
          </span>
        ))}
        . Categories follow the Overture taxonomy of {data.taxonomyRelease}.
      </p>
    </footer>
  );
}
