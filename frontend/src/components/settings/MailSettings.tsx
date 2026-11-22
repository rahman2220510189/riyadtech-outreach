"use client";

import { useState } from "react";
import { useSettings, useUpdateSettings } from "@/lib/leads";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

interface Company {
  name: string;
  senderName: string;
  website: string;
  postalAddress: string;
}
interface Sending {
  globalDailyCap: number;
  mailboxDailyCap: number;
  warmupStart: number;
  warmupStepPerDay: number;
  windowStart: string;
  windowEnd: string;
  weekdaysOnly: boolean;
  minGapMinutes: number;
  maxGapMinutes: number;
  followUp1Days: number;
  followUp2Days: number;
  recontactDays: number;
  testAddresses: string[];
  applicationsPerDay: number;
}

function Saved({ save, dirty }: { save: ReturnType<typeof useUpdateSettings>; dirty: boolean }) {
  return (
    <span aria-live="polite" className="text-sm">
      {save.error ? <span className="text-bad">{save.error.message}</span> : save.isSuccess && !dirty ? <span className="text-go">Saved.</span> : null}
    </span>
  );
}

/** Company name, sender name and postal address: the footer of every outreach e-mail. */
export function CompanySettings() {
  const settings = useSettings();
  const save = useUpdateSettings("company");
  if (!settings.data) return null;
  const c = settings.data.values.company as Company;
  return <CompanyForm key={JSON.stringify(c)} current={c} save={save} />;
}

function CompanyForm({ current, save }: { current: Company; save: ReturnType<typeof useUpdateSettings> }) {
  const [f, setF] = useState(current);
  const [dirty, setDirty] = useState(false);
  const set = (p: Partial<Company>) => {
    setDirty(true);
    setF({ ...f, ...p });
  };
  return (
    <section aria-labelledby="company-title" className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="company-title" className="font-semibold">
          Company and e-mail footer
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          Every outreach e-mail ends with your name, the company, your postal address and an unsubscribe link. The US law (CAN-SPAM) requires a valid postal
          address; campaigns will not start without one.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDirty(false);
          save.mutate(f);
        }}
        className="grid gap-4 px-5 py-4 sm:grid-cols-2"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Company name</span>
          <input required value={f.name} onChange={(e) => set({ name: e.target.value })} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Your name (sender)</span>
          <input value={f.senderName} onChange={(e) => set({ senderName: e.target.value })} placeholder="Empty: the mailbox's sender name" className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Website</span>
          <input value={f.website} onChange={(e) => set({ website: e.target.value })} className={field} />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="font-medium">Postal address</span>
          <textarea rows={2} value={f.postalAddress} onChange={(e) => set({ postalAddress: e.target.value })} placeholder="Street and number, postcode and city, country" className={field} />
          <span className="text-ink-3">A real address where you receive post (a business address or a P.O. box works too).</span>
        </label>
        <div className="flex items-center gap-4 sm:col-span-2">
          <button type="submit" disabled={save.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
            {save.isPending ? "Saving…" : "Save company"}
          </button>
          <Saved save={save} dirty={dirty} />
        </div>
      </form>
    </section>
  );
}

/** Caps, warm-up, sending window, follow-up delays, own test addresses, applications per day. */
export function SendingSettings() {
  const settings = useSettings();
  const save = useUpdateSettings("sending");
  if (!settings.data) return null;
  const s = settings.data.values.sending as Sending;
  return <SendingForm key={JSON.stringify(s)} current={s} save={save} />;
}

const NUMBERS: { key: keyof Sending; label: string; hint: string; min: number; max: number }[] = [
  { key: "globalDailyCap", label: "All mailboxes per day", hint: "Hard cap for the whole tool.", min: 0, max: 1000 },
  { key: "mailboxDailyCap", label: "Per mailbox per day (max)", hint: "Each mailbox also has its own cap.", min: 1, max: 500 },
  { key: "warmupStart", label: "Warm-up: first day", hint: "E-mails on a new mailbox's first day.", min: 1, max: 100 },
  { key: "warmupStepPerDay", label: "Warm-up: more each day", hint: "Added every day up to the cap.", min: 0, max: 50 },
  { key: "minGapMinutes", label: "Gap between e-mails, from (min)", hint: "Random gap per mailbox.", min: 0, max: 120 },
  { key: "maxGapMinutes", label: "Gap, up to (min)", hint: "", min: 0, max: 240 },
  { key: "followUp1Days", label: "Follow-up 1 after (days)", hint: "", min: 1, max: 60 },
  { key: "followUp2Days", label: "Follow-up 2 after (days)", hint: "After follow-up 1.", min: 1, max: 60 },
  { key: "recontactDays", label: "Same company again after (days)", hint: "Across campaigns.", min: 0, max: 3650 },
  { key: "applicationsPerDay", label: "Job applications per day", hint: "All mailboxes together.", min: 1, max: 100 },
];

function SendingForm({ current, save }: { current: Sending; save: ReturnType<typeof useUpdateSettings> }) {
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(NUMBERS.map((n) => [n.key, String(current[n.key])])));
  const [win, setWin] = useState({ windowStart: current.windowStart, windowEnd: current.windowEnd, weekdaysOnly: current.weekdaysOnly });
  const [tests, setTests] = useState(current.testAddresses.join("\n"));
  const [dirty, setDirty] = useState(false);
  const touch = () => setDirty(true);
  return (
    <section aria-labelledby="sending-title" className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line-soft px-5 py-4">
        <h2 id="sending-title" className="font-semibold">
          Sending
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-2">
          Limits and timing for campaigns (Phase 5) and applications. The sending window is in the recipient&apos;s time zone.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setDirty(false);
          save.mutate({
            ...Object.fromEntries(NUMBERS.map((n) => [n.key, Number(f[n.key])])),
            ...win,
            testAddresses: tests
              .split(/[\s,;]+/)
              .map((t) => t.trim())
              .filter(Boolean),
          });
        }}
        className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {NUMBERS.map((n) => (
          <label key={n.key} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{n.label}</span>
            <input
              type="number"
              min={n.min}
              max={n.max}
              step={n.key.includes("Gap") ? 0.5 : 1}
              value={f[n.key] ?? ""}
              onChange={(e) => {
                touch();
                setF({ ...f, [n.key]: e.target.value });
              }}
              className={field}
            />
            {n.hint && <span className="text-ink-3">{n.hint}</span>}
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Sending window</span>
          <span className="flex items-center gap-2">
            <input type="time" value={win.windowStart} onChange={(e) => (touch(), setWin({ ...win, windowStart: e.target.value }))} className={field} aria-label="Window start" />
            –
            <input type="time" value={win.windowEnd} onChange={(e) => (touch(), setWin({ ...win, windowEnd: e.target.value }))} className={field} aria-label="Window end" />
          </span>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="size-4" checked={win.weekdaysOnly} onChange={(e) => (touch(), setWin({ ...win, weekdaysOnly: e.target.checked }))} />
          Weekdays only
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2 lg:col-span-3">
          <span className="font-medium">My own addresses for tests</span>
          <textarea rows={2} value={tests} onChange={(e) => (touch(), setTests(e.target.value))} placeholder="one per line" className={`${field} font-mono text-xs`} />
          <span className="text-ink-3">“Send test to myself” may go to these, your login address and your mailboxes&apos; own addresses, nowhere else.</span>
        </label>
        <div className="flex items-center gap-4 sm:col-span-2 lg:col-span-3">
          <button type="submit" disabled={save.isPending} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90">
            {save.isPending ? "Saving…" : "Save sending settings"}
          </button>
          <Saved save={save} dirty={dirty} />
        </div>
      </form>
    </section>
  );
}
