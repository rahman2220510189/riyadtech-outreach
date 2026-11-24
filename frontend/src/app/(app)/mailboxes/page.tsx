import type { Metadata } from "next";
import { Suspense } from "react";
import { MailboxesView } from "@/components/mail/MailboxesView";

export const metadata: Metadata = { title: "Mailboxes" };

export default function MailboxesPage() {
  // The view reads ?gmail=… after Google's sign-in (useSearchParams needs a Suspense boundary).
  return (
    <Suspense fallback={<p className="text-ink-2">Loading…</p>}>
      <MailboxesView />
    </Suspense>
  );
}
