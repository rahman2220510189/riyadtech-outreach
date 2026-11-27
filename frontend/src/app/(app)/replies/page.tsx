import type { Metadata } from "next";
import { RepliesView } from "@/components/replies/RepliesView";

export const metadata: Metadata = { title: "Replies" };

export default function RepliesPage() {
  return <RepliesView />;
}
