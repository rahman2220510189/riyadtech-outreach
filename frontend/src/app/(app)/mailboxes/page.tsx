import type { Metadata } from "next";
import { MailboxesView } from "@/components/mail/MailboxesView";

export const metadata: Metadata = { title: "Mailboxes" };

export default function MailboxesPage() {
  return <MailboxesView />;
}
