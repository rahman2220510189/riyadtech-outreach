import type { Metadata } from "next";
import { DataSources } from "@/components/finder/DataSources";
import { FinderForm } from "@/components/finder/FinderForm";
import { JobsList } from "@/components/finder/JobsList";

export const metadata: Metadata = { title: "Finder" };

export default function FinderPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Finder</h1>
        <p className="mt-1 max-w-prose text-ink-2">
          Find agencies and businesses with their own website in one area. Estimate first, then import.
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,40rem)_minmax(0,1fr)]">
        <FinderForm />
        <JobsList />
      </div>
      <DataSources />
    </div>
  );
}
