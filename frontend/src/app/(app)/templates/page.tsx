import type { Metadata } from "next";
import { TemplatesView } from "@/components/mail/TemplatesView";

export const metadata: Metadata = { title: "Templates" };

export default function TemplatesPage() {
  return <TemplatesView />;
}
