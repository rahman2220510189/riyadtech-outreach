import type { Metadata } from "next";
import { ListsView } from "@/components/leads/ListsView";

export const metadata: Metadata = { title: "Imported lists" };

export default function ListsPage() {
  return <ListsView />;
}
