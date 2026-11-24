"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  type DnsResult,
  type Mailbox,
  type MailboxInput,
  type TestResult,
  useConnectGmail,
  useDeleteMailbox,
  useDisconnectGmail,
  useDnsCheck,
  useMailboxes,
  useSaveMailbox,
  useTestMailbox,
} from "@/lib/mail";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

const PRESETS: Record<string, Pick<MailboxInput, "smtpHost" | "smtpPort" | "smtpSecurity" | "imapHost" | "imapPort">> = {
  gmail: { smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecurity: "ssl", imapHost: "imap.gmail.com", imapPort: 993 },
  zoho: { smtpHost: "smtp.zoho.eu", smtpPort: 465, smtpSecurity: "ssl", imapHost: "imap.zoho.eu", imapPort: 993 },
  hostinger: { smtpHost: "smtp.hostinger.com", smtpPort: 465, smtpSecurity: "ssl", imapHost: "imap.hostinger.com", imapPort: 993 },
  outlook: { smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecurity: "starttls", imapHost: "outlook.office365.com", imapPort: 993 },
};

const STATUS_STYLE = { ok: "text-go", warn: "text-warn", bad: "text-bad", info: "text-ink-2" } as const;
const STATUS_MARK = { ok: "✓", warn: "!", bad: "✕", info: "i" } as const;

function DnsView({ dns }: { dns: DnsResult }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-ink-2">
        DNS of <strong>{dns.domain}</strong> · sending service: {dns.provider} · checked {new Date(dns.checkedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
      </p>
      <ul className="space-y-2">
        {dns.items.map((i) => (
          <li key={i.key} className="rounded-lg border border-line-soft px-3 py-2 text-sm">
            <p className={`font-semibold ${STATUS_STYLE[i.status]}`}>
              <span aria-hidden className="mr-1.5 inline-flex size-5 items-center justify-center rounded-full border text-xs">
                {STATUS_MARK[i.status]}
              </span>
              {i.title}
            </p>
            <p className="mt-0.5 text-ink-2">{i.detail}</p>
            {i.records.length > 0 && <p className="mt-1 break-all font-mono text-xs text-ink-3">{i.records.join(" · ")}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TestView({ t }: { t: TestResult }) {
  return (
    <ul className="space-y-1 text-sm">
      {(["gmail", "smtp", "imap"] as const).map((k) => {
        const r = t[k];
        return r ? (
          <li key={k} className={r.ok ? "text-go" : "text-bad"}>
            {r.ok ? "✓" : "✕"} {r.message}
          </li>
        ) : null;
      })}
    </ul>
  );
}

function MailboxForm({ initial, onDone }: { initial?: Mailbox; onDone: () => void }) {
  const save = useSaveMailbox();
  const [f, setF] = useState<MailboxInput>(
    initial
      ? { ...initial, smtpPassword: "", imapPassword: "" }
      : {
          label: "Gmail – hello@riyadtech.xyz",
          fromName: "",
          fromEmail: "",
          ...PRESETS.gmail,
          smtpUser: "",
          imapUser: "",
          imapSameAsSmtp: true,
          dailyCap: 50,
          active: true,
          smtpPassword: "",
        },
  );
  const set = (patch: Partial<MailboxInput>) => setF({ ...f, ...patch });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: MailboxInput & { id?: number } = {
      ...(initial ? { id: initial.id } : {}),
      label: f.label,
      fromName: f.fromName,
      fromEmail: f.fromEmail,
      replyTo: f.replyTo || null,
      smtpHost: f.smtpHost,
      smtpPort: Number(f.smtpPort),
      smtpSecurity: f.smtpSecurity,
      smtpUser: f.smtpUser,
      imapHost: f.imapHost,
      imapPort: Number(f.imapPort),
      imapUser: f.imapUser || f.smtpUser,
      imapSameAsSmtp: f.imapSameAsSmtp,
      dailyCap: Number(f.dailyCap),
      dkimSelector: f.dkimSelector || null,
      active: f.active,
      ...(f.smtpPassword ? { smtpPassword: f.smtpPassword } : {}),
      ...(!f.imapSameAsSmtp && f.imapPassword ? { imapPassword: f.imapPassword } : {}),
    };
    save.mutate(body, { onSuccess: onDone });
  };
  const input = (key: keyof MailboxInput, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        value={(f[key] as string | number | null | undefined) ?? ""}
        onChange={(e) => set({ [key]: e.target.value })}
        className={field}
        {...props}
      />
      {hint && <span className="text-ink-3">{hint}</span>}
    </label>
  );
  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">{initial ? `Edit ${initial.fromEmail}` : "Add a mailbox"}</h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-ink-2">Fill in for</span>
          <select onChange={(e) => e.target.value && set(PRESETS[e.target.value]!)} defaultValue="" className="rounded-lg border border-line bg-surface px-2.5 py-2">
            <option value="">Choose a provider…</option>
            <option value="gmail">Gmail (personal or Workspace)</option>
            <option value="zoho">Zoho Mail (EU)</option>
            <option value="hostinger">Hostinger</option>
            <option value="outlook">Microsoft 365</option>
          </select>
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {input("label", "Label", { required: true })}
        {input("fromName", "Sender name", { required: true, placeholder: "Riyad from Riyad Tech" })}
        {input("fromEmail", "Send as (From address)", { required: true, type: "email", placeholder: "hello@riyadtech.xyz" })}
        {input("replyTo", "Reply-To (optional)", { type: "email" }, "Empty: replies go to the From address.")}
        {input("dailyCap", "Daily cap", { type: "number", min: 1, max: 500 }, "Warm-up starts at 10 a day and adds 2 a day up to this.")}
        {input("dkimSelector", "DKIM selector (optional)", { placeholder: "google" }, "Only if your mail provider gave you one.")}
      </div>
      <fieldset className="grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-semibold">Sending (SMTP)</legend>
        {input("smtpHost", "Server", { required: true })}
        {input("smtpPort", "Port", { required: true, type: "number" })}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Security</span>
          <select value={f.smtpSecurity} onChange={(e) => set({ smtpSecurity: e.target.value as "ssl" | "starttls" })} className={field}>
            <option value="ssl">SSL/TLS (port 465)</option>
            <option value="starttls">STARTTLS (port 587)</option>
          </select>
        </label>
        {input("smtpUser", "User name", { required: true, placeholder: "you@gmail.com" }, "Gmail: your Gmail address.")}
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="font-medium">Password {initial?.smtpPasswordSet && <span className="font-normal text-go">· saved</span>}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={f.smtpPassword ?? ""}
            onChange={(e) => set({ smtpPassword: e.target.value })}
            placeholder={initial?.smtpPasswordSet ? "Leave empty to keep the saved password" : "Gmail: the 16-character App Password"}
            className={field}
          />
          <span className="text-ink-3">Stored encrypted; never shown again. Gmail needs an App Password, not your normal password.</span>
        </label>
      </fieldset>
      <fieldset className="grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="mb-2 text-sm font-semibold">Inbox (IMAP, for replies in Phase 6)</legend>
        {input("imapHost", "Server", { required: true })}
        {input("imapPort", "Port", { required: true, type: "number" })}
        {input("imapUser", "User name", { placeholder: "Same as SMTP" })}
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="size-4" checked={!!f.imapSameAsSmtp} onChange={(e) => set({ imapSameAsSmtp: e.target.checked })} />
          Same password as SMTP
        </label>
        {!f.imapSameAsSmtp && (
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="font-medium">IMAP password {initial && !initial.imapSameAsSmtp && initial.imapPasswordSet && <span className="font-normal text-go">· saved</span>}</span>
            <input type="password" autoComplete="new-password" value={f.imapPassword ?? ""} onChange={(e) => set({ imapPassword: e.target.value })} className={field} />
          </label>
        )}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4" checked={!!f.active} onChange={(e) => set({ active: e.target.checked })} />
        Active (can send)
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={save.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
          {save.isPending ? "Saving…" : "Save mailbox"}
        </button>
        <button type="button" onClick={onDone} className="text-sm text-ink-2 underline underline-offset-4">
          Cancel
        </button>
        {save.error && <span className="text-sm text-bad">{save.error.message}</span>}
      </div>
    </form>
  );
}

function GmailBox({ m, available, delivery }: { m: Mailbox; available: boolean; delivery: "direct" | "outbox" }) {
  const connect = useConnectGmail();
  const disconnect = useDisconnectGmail();
  const btn = "rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50";
  if (!/gmail\.com$/i.test(m.smtpHost) && !m.gmailConnected) return null;
  return (
    <div className="rounded-lg border border-line-soft bg-paper/50 px-4 py-3 text-sm">
      <p className="font-medium">Gmail API (sends over HTTPS, no SMTP, no PC needed)</p>
      {m.gmailConnected ? (
        <p className={m.gmailError ? "text-bad" : "text-go"}>
          {m.gmailError ? `✕ ${m.gmailError}` : `✓ Connected ${m.gmailConnectedAt?.slice(0, 10) ?? ""}: e-mails from ${m.fromEmail} go out through Gmail right away.`}
        </p>
      ) : (
        <p className="text-ink-2">
          {available
            ? `Not connected. ${delivery === "outbox" ? "Until you connect it, e-mails wait for the outbox on your PC." : "Until you connect it, e-mails go through SMTP."}`
            : "Not available yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set on the server."}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {available && (
          <button type="button" className={btn} disabled={connect.isPending} onClick={() => connect.mutate(m.id)}>
            {connect.isPending ? "Opening Google…" : m.gmailConnected ? "Connect again" : "Connect Gmail"}
          </button>
        )}
        {m.gmailConnected && (
          <button type="button" className={`${btn} text-bad`} disabled={disconnect.isPending} onClick={() => disconnect.mutate(m.id)}>
            Disconnect
          </button>
        )}
      </div>
      {(connect.error ?? disconnect.error) && <p className="mt-1 text-bad">{(connect.error ?? disconnect.error)?.message}</p>}
    </div>
  );
}

function MailboxCard({ m, onEdit, gmailAvailable, delivery }: { m: Mailbox; onEdit: () => void; gmailAvailable: boolean; delivery: "direct" | "outbox" }) {
  const test = useTestMailbox();
  const dns = useDnsCheck();
  const del = useDeleteMailbox();
  const [confirm, setConfirm] = useState(false);
  const btn = "rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-paper disabled:opacity-50";
  const lastTest = test.data ?? m.lastTest;
  const lastDns = dns.data ?? m.lastDns;
  return (
    <li className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">
            {m.label} {!m.active && <span className="ml-1 rounded-full bg-paper px-2 py-0.5 text-xs text-ink-3">off</span>}
          </p>
          <p className="text-sm text-ink-2">
            {m.fromName} &lt;{m.fromEmail}&gt;{m.replyTo ? ` · replies to ${m.replyTo}` : ""}
          </p>
          <p className="text-sm text-ink-3">
            SMTP {m.smtpHost}:{m.smtpPort} ({m.smtpSecurity}) as {m.smtpUser} · password {m.smtpPasswordSet ? "set" : <span className="text-bad">not set</span>} · IMAP {m.imapHost}:{m.imapPort}
          </p>
          <p className="text-sm text-ink-3">
            Warm-up: {m.allowedToday} e-mails today (cap {m.dailyCap}, started {m.warmupStartedOn})
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={test.isPending || !m.smtpPasswordSet} onClick={() => test.mutate(m.id)}>
            {test.isPending ? "Testing…" : "Test connection"}
          </button>
          <button type="button" className={btn} disabled={dns.isPending} onClick={() => dns.mutate(m.id)}>
            {dns.isPending ? "Checking…" : "DNS check"}
          </button>
          <button type="button" className={btn} onClick={onEdit}>
            Edit
          </button>
          {confirm ? (
            <button type="button" className="rounded-lg bg-bad px-3 py-2 text-sm font-medium text-white" onClick={() => del.mutate(m.id)}>
              Yes, delete
            </button>
          ) : (
            <button type="button" className={`${btn} text-bad`} onClick={() => setConfirm(true)}>
              Delete
            </button>
          )}
        </div>
      </div>
      <GmailBox m={m} available={gmailAvailable} delivery={delivery} />
      {(test.error ?? dns.error) && <p className="text-sm text-bad">{(test.error ?? dns.error)?.message}</p>}
      {lastTest && (
        <div>
          <p className="mb-1 text-sm font-medium">Connection test (nothing is sent)</p>
          <TestView t={lastTest} />
        </div>
      )}
      {lastDns && <DnsView dns={lastDns} />}
    </li>
  );
}

export function MailboxesView() {
  const q = useMailboxes();
  const params = useSearchParams();
  const gmailResult = params.get("gmail");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mailboxes</h1>
          <p className="mt-1 max-w-prose text-ink-2">
            The addresses you send from. “Test connection” only logs in; “DNS check” explains whether your domain is set up for sending.
          </p>
        </div>
        {editing === null && (
          <button type="button" onClick={() => setEditing("new")} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
            Add mailbox
          </button>
        )}
      </div>
      {d && !d.encryptionKeySet && (
        <p role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-sm text-bad">
          ENCRYPTION_KEY is not set in backend/.env. Mailbox passwords cannot be saved until it is (see the setup steps).
        </p>
      )}
      {d && (
        <p className={`rounded-lg px-4 py-3 text-sm ${d.sendingEnabled ? "bg-warn-soft text-warn" : "bg-go-soft text-go"}`}>
          {d.sendingEnabled
            ? "Sending is ON (SENDING_ENABLED=true): applications and approved campaigns send real e-mails."
            : "Sending is off (SENDING_ENABLED=false): only tests to your own addresses are sent."}
        </p>
      )}
      {gmailResult === "connected" && (
        <p role="status" className="rounded-lg bg-go-soft px-4 py-3 text-sm text-go">
          Gmail is connected for {params.get("mailbox")}. E-mails from it now go out through the Gmail API. Send a test to yourself to check.
        </p>
      )}
      {gmailResult === "error" && (
        <p role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-sm text-bad">
          Gmail was not connected: {params.get("reason") ?? "unknown reason"}
        </p>
      )}
      {editing === "new" && <MailboxForm onDone={() => setEditing(null)} />}
      {q.isPending && <p className="text-ink-2">Loading…</p>}
      {q.isError && <p className="text-bad">{q.error.message}</p>}
      {d && d.items.length === 0 && editing === null && <p className="rounded-xl border border-line bg-surface px-5 py-6 text-ink-2">No mailbox yet. Add the address you send from.</p>}
      <ul className="space-y-4">
        {d?.items.map((m) =>
          editing === m.id ? (
            <li key={m.id}>
              <MailboxForm initial={m} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <MailboxCard key={m.id} m={m} onEdit={() => setEditing(m.id)} gmailAvailable={d.gmail.available} delivery={d.mailDelivery} />
          ),
        )}
      </ul>
    </div>
  );
}
