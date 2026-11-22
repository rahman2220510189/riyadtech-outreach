import type { Metadata } from "next";
import { StudyProfilePage } from "@/components/study/StudyProfileForm";

export const metadata: Metadata = { title: "My profile · Study" };

export default function Page() {
  return <StudyProfilePage />;
}
