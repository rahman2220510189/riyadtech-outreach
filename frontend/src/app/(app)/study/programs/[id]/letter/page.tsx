import type { Metadata } from "next";
import { StudyLetterEditor } from "@/components/study/StudyLetterEditor";

export const metadata: Metadata = { title: "Motivation letter · Study" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudyLetterEditor programId={Number(id)} />;
}
