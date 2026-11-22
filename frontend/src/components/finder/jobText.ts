import type { JobListItem } from "@/lib/finder";

export function jobKindLabel(j: Pick<JobListItem, "kind" | "dryRun">): string {
  if (j.kind === "geonames") return "Regions and cities";
  if (j.kind === "crawl") return "Website crawl";
  return j.dryRun ? "Estimate" : "Import";
}

export function jobTitle(j: Pick<JobListItem, "kind" | "params" | "summary">): string {
  if (j.kind === "geonames") return (j.params.countries ?? []).join(", ");
  return j.params.label ?? j.summary?.area ?? j.params.country ?? (j.kind === "crawl" ? "Website crawl" : "Job");
}

export function when(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
