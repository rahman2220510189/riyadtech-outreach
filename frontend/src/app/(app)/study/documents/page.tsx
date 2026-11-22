import type { Metadata } from "next";
import { StudyDocuments } from "@/components/study/StudyDocuments";

export const metadata: Metadata = { title: "My documents · Study" };

export default function Page() {
  return <StudyDocuments />;
}
