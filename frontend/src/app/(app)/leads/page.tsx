import type { Metadata } from "next";
import { Suspense } from "react";
import { LeadsView } from "@/components/leads/LeadsView";

export const metadata: Metadata = { title: "Leads" };

export default function LeadsPage() {
  return (
    <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
      <LeadsView />
    </Suspense>
  );
}
