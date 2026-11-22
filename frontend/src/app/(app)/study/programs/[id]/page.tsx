import type { Metadata } from "next";
import { ProgramDetail } from "@/components/study/ProgramDetail";

export const metadata: Metadata = { title: "Programme · Study" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProgramDetail id={Number(id)} />;
}
