import type { Metadata } from "next";
import { SendWindows } from "@/components/SendWindows";
import { LeadsCard } from "./LeadsCard";
import { SystemFacts } from "./SystemFacts";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <LeadsCard />

      <SendWindows />

      <SystemFacts />
    </div>
  );
}
