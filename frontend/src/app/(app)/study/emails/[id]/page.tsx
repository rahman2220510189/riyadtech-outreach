import type { Metadata } from "next";
import { StudyEmailEditor } from "@/components/study/StudyEmailEditor";

export const metadata: Metadata = { title: "E-mail · Study" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudyEmailEditor id={Number(id)} />;
}
