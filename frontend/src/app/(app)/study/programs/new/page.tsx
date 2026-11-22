"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ProgramForm } from "@/components/study/ProgramForm";
import { StudyNav } from "@/components/study/StudyNav";

export default function Page() {
  const router = useRouter();
  return (
    <div className="space-y-6">
      <StudyNav title="Add a programme" intro="Copy the facts from the official university or scholarship page, not from agents or forums." />
      <Link href="/study/programs" className="text-sm underline underline-offset-4">
        ← All programmes
      </Link>
      <ProgramForm onDone={(p) => router.push(`/study/programs/${p.id}`)} />
    </div>
  );
}
