"use client";

import { useParams } from "next/navigation";
import { JobView } from "@/components/finder/JobView";

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return <p className="text-bad">This job does not exist.</p>;
  return <JobView id={n} />;
}
