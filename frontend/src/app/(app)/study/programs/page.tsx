import type { Metadata } from "next";
import { ProgramList } from "@/components/study/ProgramList";

export const metadata: Metadata = { title: "Scholarships & programmes · Study" };

export default function Page() {
  return <ProgramList />;
}
