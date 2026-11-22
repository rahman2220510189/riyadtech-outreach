import type { Metadata } from "next";
import { ApplicationEditor } from "@/components/mail/ApplicationEditor";

export const metadata: Metadata = { title: "Application" };

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ApplicationEditor id={Number(id)} />;
}
