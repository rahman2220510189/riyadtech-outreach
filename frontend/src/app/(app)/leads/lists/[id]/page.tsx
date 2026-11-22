import type { Metadata } from "next";
import { ListView } from "@/components/leads/ListsView";

export const metadata: Metadata = { title: "Imported list" };

export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListView id={Number(id)} />;
}
