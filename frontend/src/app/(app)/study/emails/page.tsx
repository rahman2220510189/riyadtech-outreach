import type { Metadata } from "next";
import { StudyEmails } from "@/components/study/StudyEmails";

export const metadata: Metadata = { title: "E-mails · Study" };

export default function Page() {
  return <StudyEmails />;
}
