import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy · Riyad Tech Outreach" };

const UPDATED = "25 November 2026";

/** Public privacy policy (Google requires one for apps that use Google sign-in in production). */
export default function PrivacyPage() {
  const h2 = "mt-8 text-lg font-semibold";
  const p = "mt-2 leading-relaxed text-ink-2";
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <p className="text-sm text-ink-3">Riyad Tech Outreach</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Privacy policy</h1>
      <p className="mt-2 text-sm text-ink-3">Last updated {UPDATED}</p>

      <p className={p}>
        Riyad Tech Outreach is a private tool used by one person, Md. Naymur Rahman (Riyad Tech, Dhaka, Bangladesh), to plan his own study applications and to
        find and contact business clients. There are no public accounts. This page explains what the tool does with data, including data from Google accounts.
      </p>

      <h2 className={h2}>Google account data</h2>
      <p className={p}>
        The owner can connect his own Gmail or Google Workspace mailboxes so that e-mails he writes in the tool are sent through the Gmail API. The tool asks
        only for the permission to <strong>send</strong> e-mail (gmail.send) and for the account&apos;s e-mail address (to check that the right account was
        connected). It cannot read, list, change or delete any e-mail in the mailbox.
      </p>
      <p className={p}>
        The only thing kept from Google is the long-term permission (a refresh token), stored encrypted (AES-256-GCM) in the tool&apos;s database and used only to
        send e-mails the owner has written and chosen to send. Google user data is not sold, not shared with anyone, not used for advertising and not used to
        train AI models. The use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" className="underline underline-offset-4">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2 className={h2}>Other data</h2>
      <p className={p}>
        The tool stores the owner&apos;s own profile and documents for applications, public information about universities and scholarships, and business contact
        details that companies publish on their own websites. Business e-mails include an unsubscribe link; anyone who unsubscribes or asks is added to a
        suppression list and never contacted again. Data is stored with Neon (PostgreSQL, EU region) and the service runs on Render and Vercel.
      </p>

      <h2 className={h2}>Removing access and data</h2>
      <p className={p}>
        A connected Google account can be disconnected in the tool (Mailboxes → Disconnect), which also revokes the permission at Google, or at any time under{" "}
        <a href="https://myaccount.google.com/permissions" className="underline underline-offset-4">
          myaccount.google.com/permissions
        </a>
        . To ask about or remove any data concerning you, write to the contact address below.
      </p>

      <h2 className={h2}>Contact</h2>
      <p className={p}>
        Md. Naymur Rahman, Riyad Tech, Dhaka, Bangladesh ·{" "}
        <a href="mailto:hello@riyadtech.xyz" className="underline underline-offset-4">
          hello@riyadtech.xyz
        </a>
      </p>
    </main>
  );
}
