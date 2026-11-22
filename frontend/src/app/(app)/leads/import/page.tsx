import type { Metadata } from "next";
import { ImportWizard } from "@/components/leads/ImportWizard";

export const metadata: Metadata = { title: "Import CSV" };

export default function ImportPage() {
  return <ImportWizard />;
}
