import type { Metadata } from "next";
import { TemplateEditor } from "@/components/mail/TemplateEditor";

export const metadata: Metadata = { title: "Template" };

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplateEditor id={id === "new" ? null : Number(id)} />;
}
