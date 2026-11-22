import type { Metadata } from "next";
import { StudyUpdates } from "@/components/study/StudyUpdates";

export const metadata: Metadata = { title: "Updates · Study" };

export default function Page() {
  return <StudyUpdates />;
}
