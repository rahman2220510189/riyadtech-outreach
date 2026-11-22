import type { Metadata } from "next";
import { StudyUniversities } from "@/components/study/StudyUniversities";

export const metadata: Metadata = { title: "Universities · Study" };

export default function Page() {
  return <StudyUniversities />;
}
