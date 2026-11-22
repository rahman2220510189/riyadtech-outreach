import type { Metadata } from "next";
import { JobSearchView } from "@/components/jobsearch/JobSearchView";

export const metadata: Metadata = { title: "Job search" };

export default function JobSearchPage() {
  return <JobSearchView />;
}
