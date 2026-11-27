"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatNumber } from "@/lib/finder";
import { STATUS_TEXT, useCampaignOptions, useCampaigns, useCreateCampaign } from "@/lib/campaigns";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

/** Campaigns: one list, and a short form to start a new one from "Ready now" leads. */
export function CampaignsView() {
  const list = useCampaigns();
  const opts = useCampaignOptions();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campaigns</h1>
          <p className="mt-1 max-w-prose text-ink-2">
            First e-mail plus two follow-ups in the same thread, sent slowly in each company&apos;s office hours. Leads come from
            &ldquo;Ready now&rdquo;; websites not read yet are read first.
          </p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="rounded-lg bg-ink px-4 py-2.5 font-medium text-white hover:bg-ink/90">
            New campaign
          </button>
        )}
      </div>

      {opts.data && !opts.data.sendingEnabled && (
        <p className="rounded-xl border border-warn/40 bg-warn-soft px-5 py-3 text-sm text-warn">
          Sending is switched off (SENDING_ENABLED=false): campaigns write each e-mail as a preview at the time it would go out, and
          nothing leaves.
        </p>
      )}
      {opts.data && !opts.data.postalAddressSet && (
        <p className="rounded-xl border border-bad/40 bg-bad-soft px-5 py-3 text-sm text-bad">
          Add your postal address in{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Settings → Company
          </Link>{" "}
          first. The law requires it in every e-mail, so campaigns cannot start without it.
        </p>
      )}

      {open && <NewCampaign onClose={() => setOpen(false)} />}

      {list.isError && <p className="text-bad">{list.error.message}</p>}
      {list.data && list.data.length === 0 && !open && <p className="text-ink-2">No campaigns yet.</p>}
      {list.data && list.data.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="text-left text-ink-2">
              <tr className="border-b border-line-soft">
                <th className="px-5 py-2.5 font-medium">Campaign</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 text-right font-medium">Leads</th>
                <th className="px-5 py-2.5 text-right font-medium">Sent</th>
                <th className="px-5 py-2.5 text-right font-medium">Replied</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {list.data.map((c) => {
                const total = Object.values(c.leads).reduce((a, b) => a + b, 0);
                return (
                  <tr key={c.id}>
                    <td className="px-5 py-3">
                      <Link href={`/campaigns/${c.id}`} className="font-medium underline underline-offset-2">
                        {c.name}
                      </Link>
                      <div className="text-xs text-ink-3">
                        {c.country} · {c.segment === "A" ? "Agencies" : "Businesses"} · {c.mailbox}
                      </div>
                    </td>
                    <td className="px-5 py-3">{STATUS_TEXT[c.status]}</td>
                    <td className="px-5 py-3 text-right">{formatNumber(total)}</td>
                    <td className="px-5 py-3 text-right">
                      {formatNumber(c.sent)}
                      {c.previews > 0 ? <span className="text-ink-3"> (+{formatNumber(c.previews)} previews)</span> : null}
                    </td>
                    <td className="px-5 py-3 text-right">{formatNumber(c.leads.replied)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewCampaign({ onClose }: { onClose: () => void }) {
  const opts = useCampaignOptions();
  const create = useCreateCampaign();
  const router = useRouter();
  const [segment, setSegment] = useState<"A" | "B">("A");
  const [country, setCountry] = useState("");
  const [mailboxId, setMailboxId] = useState(0);
  const [size, setSize] = useState(20);
  const [cats, setCats] = useState<string[]>([]);
  const o = opts.data;
  // Default: the country with the most ready companies for this segment.
  const best = [...(o?.countries ?? [])].sort((a, b) => b.ready[segment] - a.ready[segment])[0];
  const countryValue = country || best?.code || "";
  const readyHere = o?.countries.find((c) => c.code === countryValue)?.ready[segment] ?? 0;
  const mailboxValue = mailboxId || o?.mailboxes.find((m) => m.gmail)?.id || o?.mailboxes[0]?.id || 0;
  const categories = (o?.categories ?? []).filter((c) => c.segment === segment);
  const countryName = o?.countries.find((c) => c.code === countryValue)?.name ?? countryValue;

  return (
    <form
      className="space-y-5 rounded-xl border border-line bg-surface px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          {
            name: `${segment === "A" ? "Agencies" : "Businesses"} · ${countryName} · ${new Date().toISOString().slice(0, 10)}`,
            segment,
            country: countryValue,
            categoryKeys: cats,
            mailboxId: mailboxValue,
            size,
          },
          { onSuccess: (r) => router.push(`/campaigns/${r.id}`) },
        );
      }}
    >
      <h2 className="font-semibold">New campaign</h2>
      {o && o.countries.length === 0 && <p className="text-sm text-bad">No country has outreach switched on (Settings → Countries).</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Who</span>
          <select value={segment} onChange={(e) => { setSegment(e.target.value as "A" | "B"); setCats([]); }} className={field}>
            <option value="A">Agencies (white-label development)</option>
            <option value="B">Businesses (AI chatbot or agent)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Country</span>
          <select value={countryValue} onChange={(e) => setCountry(e.target.value)} className={field}>
            {o?.countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({formatNumber(c.ready[segment])} ready)
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Send from</span>
          <select value={mailboxValue} onChange={(e) => setMailboxId(Number(e.target.value))} className={field}>
            {o?.mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fromEmail}
                {m.gmail ? " (Gmail)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">How many companies</span>
          <input type="number" min={1} max={200} value={size} onChange={(e) => setSize(Number(e.target.value) || 1)} className={field} />
          <span className="text-xs text-ink-3">{formatNumber(readyHere)} ready in this country</span>
        </label>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">Kinds of business (none ticked = all)</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {categories.map((c) => (
            <label key={c.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
              <input type="checkbox" className="size-4" checked={cats.includes(c.key)} onChange={(e) => setCats(e.target.checked ? [...cats, c.key] : cats.filter((x) => x !== c.key))} />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-ink-2">
        The best-scoring ready companies are chosen, one address per company, never one contacted in the last 90 days. Nothing is
        sent until you press Start on the next page.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={create.isPending || !countryValue || !mailboxValue || readyHere === 0} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
          {create.isPending ? "Choosing leads…" : "Choose leads"}
        </button>
        <button type="button" onClick={onClose} className="text-sm underline underline-offset-4">
          Cancel
        </button>
        {create.error && <span className="text-sm text-bad">{create.error.message}</span>}
      </div>
    </form>
  );
}
