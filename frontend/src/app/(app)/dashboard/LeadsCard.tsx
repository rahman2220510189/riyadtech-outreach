"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { SEGMENT_LABELS, type Segment, formatNumber, useCountries } from "@/lib/finder";
import { useLeadStats } from "@/lib/leads";

interface Stat {
  country: string;
  segment: Segment;
  places: number;
}

export function LeadsCard() {
  const stats = useQuery({
    queryKey: ["finder", "places", "stats"],
    queryFn: async () => (await api.get<{ items: Stat[] }>("/finder/places/stats")).data.items,
  });
  const countries = useCountries();
  const leadStats = useLeadStats();
  const withEmail = leadStats.data?.reduce((n, s) => n + s.withEmail, 0) ?? 0;
  const waiting = leadStats.data?.reduce((n, s) => n + s.waiting, 0) ?? 0;
  const rows = stats.data ?? [];
  const total = rows.reduce((n, r) => n + r.places, 0);

  if (stats.isPending) return null;
  if (total === 0) {
    return (
      <section className="rounded-xl border border-dashed border-line px-5 py-6">
        <h2 className="font-semibold">No leads yet</h2>
        <p className="mt-1 max-w-prose text-ink-2">
          Find agencies and businesses in a city first. Sent emails, replies and warm-up progress will show here later.
        </p>
        <Link href="/finder" className="mt-4 inline-block rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90">
          Open the finder
        </Link>
      </section>
    );
  }

  const name = (code: string) => countries.data?.find((c) => c.code === code)?.name ?? code;
  const byCountry = [...new Set(rows.map((r) => r.country))];
  return (
    <section aria-labelledby="leads-title">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="leads-title" className="text-base font-semibold">
          Leads saved: {formatNumber(total)}
        </h2>
        <Link href="/finder" className="text-sm font-medium underline underline-offset-4">
          Find more
        </Link>
      </div>
      {leadStats.data && (
        <p className="mb-3 text-sm text-ink-2">
          <Link href="/leads?hasEmail=true" className="underline underline-offset-2">
            {formatNumber(withEmail)} with an e-mail
          </Link>
          {" · "}
          <Link href="/leads?crawl=new" className="underline underline-offset-2">
            {formatNumber(waiting)} waiting for a website crawl
          </Link>
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="text-left text-ink-2">
            <tr className="border-b border-line-soft">
              <th className="px-5 py-2.5 font-medium">Country</th>
              {(["A", "B"] as Segment[]).map((s) => (
                <th key={s} className="px-5 py-2.5 text-right font-medium">
                  {SEGMENT_LABELS[s].name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {byCountry.map((c) => (
              <tr key={c}>
                <td className="px-5 py-2.5">{name(c)}</td>
                {(["A", "B"] as Segment[]).map((s) => (
                  <td key={s} className="px-5 py-2.5 text-right font-medium">
                    {formatNumber(rows.find((r) => r.country === c && r.segment === s)?.places)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
