import type { Metadata } from "next";
import { StudyOverview } from "@/components/study/StudyOverview";

export const metadata: Metadata = { title: "Study abroad" };

export default function StudyPage() {
  return <StudyOverview />;
}
