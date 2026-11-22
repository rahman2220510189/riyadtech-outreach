import type { Metadata } from "next";
import { ApplicationsView } from "@/components/mail/ApplicationsView";

export const metadata: Metadata = { title: "Applications" };

export default function ApplicationsPage() {
  return <ApplicationsView />;
}
