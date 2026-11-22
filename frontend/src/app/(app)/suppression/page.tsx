import type { Metadata } from "next";
import { SuppressionView } from "@/components/SuppressionView";

export const metadata: Metadata = { title: "Suppression" };

export default function SuppressionPage() {
  return <SuppressionView />;
}
