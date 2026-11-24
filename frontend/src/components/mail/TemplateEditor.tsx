"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useLists } from "@/lib/leads";
import { type PreviewSource, type Template, type TemplateKind, useDeleteTemplate, useMailboxes, usePreview, useSaveTemplate, useTemplates, useTestAddresses, useTestSend } from "@/lib/mail";

const field = "w-full rounded-lg border border-line bg-surface px-3 py-2";

type Draft = Pick<Template, "kind" | "name" | "segment" | "offer" | "step" | "subject" | "body">;
const EMPTY: Draft = { kind: "outreach", name: "", segment: null, offer: null, step: 1, subject: "", body: "{Hi|Hello} {first_name|there},\n\n{signal_line}\n\n\n\n{sender_name}" };

export function TemplateEditor({ id }: { id: number | null }) {
  const q = useTemplates();
  if (q.isPending) return <p className="text-ink-2">Loading…</p>;
  if (q.isError) return <p className="text-bad">{q.error.message}</p>;
  const t = id ? q.data.items.find((x) => x.id === id) : null;
  if (id && !t) return <p className="text-bad">This template does not exist.</p>;
  return <Editor key={id ?? "new"} initial={t ?? null} variables={q.data.variables} />;
}

function Editor({ initial, variables }: { initial: Template | null; variables: { name: string; help: string }[] }) {
  const router = useRouter();
  const save = useSaveTemplate();
  const del = useDeleteTemplate();
  const [d, setD] = useState<Draft>(initial ? { kind: initial.kind, name: initial.name, segment: initial.segment, offer: initial.offer, step: initial.step, subject: initial.subject, body: initial.body } : EMPTY);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<Draft>) => {
    setDirty(true);
    setD({ ...d, ...patch });
  };
  const insert = (name: string) => {
    const el = bodyRef.current;
    const token = name === "first_name" ? "{first_name|there}" : `{${name}}`;
    if (!el) return set({ body: d.body + token });
    const start = el.selectionStart;
    const end = el.selectionEnd;
    set({ body: d.body.slice(0, start) + token + d.body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate(
      { ...(initial ? { id: initial.id } : {}), ...d },
      {
        onSuccess: (t) => {
          setDirty(false);
          if (!initial) router.replace(`/templates/${t.id}`);
        },
      },
    );
  };
  return (
    <div className="space-y-6">
      <div>
        <Link href="/templates" className="text-sm text-ink-2 underline underline-offset-4">
          Templates
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{initial ? initial.name : "New template"}</h1>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              <span className="font-medium">Name</span>
              <input required value={d.name} onChange={(e) => set({ name: e.target.value })} className={field} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Kind</span>
              <select value={d.kind} onChange={(e) => set({ kind: e.target.value as TemplateKind })} className={field}>
                <option value="outreach">Outreach (footer + unsubscribe)</option>
                <option value="job">Job application (no footer)</option>
              </select>
            </label>
            {d.kind === "outreach" && (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Step</span>
                  <select value={d.step} onChange={(e) => set({ step: Number(e.target.value) })} className={field}>
                    <option value={1}>First e-mail</option>
                    <option value={2}>Follow-up 1 (same thread)</option>
                    <option value={3}>Follow-up 2 (same thread)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Segment</span>
                  <select value={d.segment ?? ""} onChange={(e) => set({ segment: (e.target.value || null) as Draft["segment"] })} className={field}>
                    <option value="">Both</option>
                    <option value="A">A · Agencies</option>
                    <option value="B">B · Businesses</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Offer</span>
                  <select value={d.offer ?? ""} onChange={(e) => set({ offer: (e.target.value || null) as Draft["offer"] })} className={field}>
                    <option value="">Any</option>
                    <option value="chatbot">AI chatbot</option>
                    <option value="agent">AI agent</option>
                  </select>
                </label>
              </>
            )}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Subject</span>
            <input value={d.subject} onChange={(e) => set({ subject: e.target.value })} placeholder={d.step > 1 ? "Empty: “Re: ” + the first subject" : ""} className={field} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Text</span>
            <textarea ref={bodyRef} required rows={16} value={d.body} onChange={(e) => set({ body: e.target.value })} className={`${field} font-mono text-[13px] leading-relaxed`} />
          </label>
          <div>
            <p className="text-sm font-medium">Insert a variable</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {variables
                .filter((v) => (d.kind === "job" ? !["unsubscribe_link", "signal_line", "company_address"].includes(v.name) : !["job_title", "job_url"].includes(v.name)))
                .map((v) => (
                  <button key={v.name} type="button" title={v.help} onClick={() => insert(v.name)} className="rounded-md border border-line px-2 py-1 font-mono text-xs hover:bg-paper">
                    {`{${v.name}}`}
                  </button>
                ))}
            </div>
            <p className="mt-2 text-xs text-ink-3">
              {"{name|fallback}"} uses the fallback when empty. {"{a|b|c}"} picks one, the same for the same lead. A variable without fallback that is empty for a
              lead skips that lead. Text in [[double brackets]] must be replaced before sending.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={save.isPending || !dirty} className="rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50">
              {save.isPending ? "Saving…" : "Save template"}
            </button>
            {save.isSuccess && !dirty && <span className="text-sm text-go">Saved.</span>}
            {save.error && <span className="text-sm text-bad">{save.error.message}</span>}
            {initial &&
              (confirm ? (
                <button type="button" onClick={() => del.mutate(initial.id, { onSuccess: () => router.replace("/templates") })} className="ml-auto rounded-lg bg-bad px-3 py-2 text-sm font-medium text-white">
                  Yes, delete
                </button>
              ) : (
                <button type="button" onClick={() => setConfirm(true)} className="ml-auto rounded-lg border border-line px-3 py-2 text-sm font-medium text-bad hover:bg-bad-soft">
                  Delete
                </button>
              ))}
          </div>
        </form>
        <PreviewPanel draft={d} templateId={initial?.id} />
      </div>
    </div>
  );
}

function PreviewPanel({ draft, templateId }: { draft: Draft; templateId: number | undefined }) {
  const preview = usePreview();
  const boxes = useMailboxes();
  const lists = useLists();
  const own = useTestAddresses();
  const testSend = useTestSend();
  const [source, setSource] = useState<string>(draft.segment ? `segment:${draft.segment}` : "segment:A");
  const [mailboxId, setMailboxId] = useState<number | "">("");
  const [to, setTo] = useState("");
  const [index, setIndex] = useState(0);
  const box = mailboxId || boxes.data?.items[0]?.id;
  const src = (): PreviewSource => {
    const [k, v] = source.split(":");
    if (k === "list") return { listId: Number(v) };
    if (k === "hiring") return { hiring: true, segment: "A" };
    return { segment: v as "A" | "B" };
  };
  const run = () => {
    setIndex(0);
    preview.mutate({ ...(templateId ? { templateId } : {}), kind: draft.kind, subject: draft.subject, body: draft.body, ...(box ? { mailboxId: box } : {}), source: src() });
  };
  const p = preview.data;
  const item = p?.items[index];
  const target = to || own.data?.[0] || "";
  const [kind, rawId] = (item?.key ?? "sample").split(":");
  const forLead = kind === "place" ? { leadId: Number(rawId) } : kind === "list" ? { listLeadId: Number(rawId) } : {};
  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface px-5 py-4">
      <h2 className="font-semibold">Preview with real leads</h2>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-ink-2">Leads</span>
          <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded-lg border border-line bg-surface px-2.5 py-2">
            <option value="segment:A">Top 10 agencies (A) with e-mail</option>
            <option value="hiring:A">Top 10 agencies hiring developers</option>
            <option value="segment:B">Top 10 businesses (B) with e-mail</option>
            {lists.data?.map((l) => (
              <option key={l.id} value={`list:${l.id}`}>
                List: {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-2">From</span>
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value ? Number(e.target.value) : "")} className="rounded-lg border border-line bg-surface px-2.5 py-2">
            {boxes.data?.items.length ? null : <option value="">No mailbox yet</option>}
            {boxes.data?.items.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fromEmail}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={run} disabled={preview.isPending || !draft.body.trim()} className="rounded-lg bg-ink px-4 py-2 font-medium text-white hover:bg-ink/90 disabled:opacity-50">
          {preview.isPending ? "Rendering…" : "Preview"}
        </button>
      </div>
      {preview.error && <p className="text-sm text-bad">{preview.error.message}</p>}
      {p && (
        <>
          {p.problems.map((x) => (
            <p key={x} className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              {x}
            </p>
          ))}
          {p.sample && <p className="text-sm text-ink-2">No matching leads with an e-mail yet: showing a made-up sample.</p>}
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Recipients">
            {p.items.map((it, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === index}
                onClick={() => setIndex(i)}
                className={`rounded-md px-2 py-1 text-xs font-medium ${i === index ? "bg-ink text-white" : it.willSkip ? "bg-bad-soft text-bad" : "bg-paper text-ink-2"}`}
                title={it.recipient}
              >
                {i + 1}
                {it.willSkip ? " ✕" : ""}
              </button>
            ))}
          </div>
          {item && (
            <div className="space-y-2">
              <p className="text-sm text-ink-2">
                {item.recipient} · to {item.to ?? "(no address)"}
              </p>
              {(item.missing.length > 0 || item.unknown.length > 0) && (
                <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
                  Skipped: {[...item.missing.map((m) => `{${m}} is empty`), ...item.unknown.map((u) => `{${u}} is not a known variable`)].join(", ")}
                </p>
              )}
              {item.warnings.map((w) => (
                <p key={w} className="text-sm text-warn">
                  {w}
                </p>
              ))}
              <div className="rounded-lg border border-line-soft">
                <p className="border-b border-line-soft px-3 py-2 text-sm">
                  <span className="text-ink-3">Subject: </span>
                  <strong>{item.subject || "(Re: first subject)"}</strong>
                </p>
                <pre className="whitespace-pre-wrap break-words px-3 py-3 font-sans text-sm leading-relaxed">{item.text}</pre>
              </div>
            </div>
          )}
        </>
      )}
      <div className="space-y-2 border-t border-line-soft pt-4">
        <h3 className="text-sm font-semibold">Send a test to myself</h3>
        <p className="text-xs text-ink-3">
          One e-mail to your own address, rendered for {item ? <strong>{item.recipient}</strong> : "the sample lead (preview first to choose a real one)"}. Works while sending is off.
        </p>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <select value={target} onChange={(e) => setTo(e.target.value)} aria-label="Send the test to" className="rounded-lg border border-line bg-surface px-2.5 py-2">
            {own.data?.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={testSend.isPending || !box || !target}
            onClick={() => testSend.mutate({ kind: draft.kind, subject: draft.subject || "(follow-up)", body: draft.body, mailboxId: Number(box), to: target, ...forLead })}
            className="rounded-lg border border-line px-3 py-2 font-medium hover:bg-paper disabled:opacity-50"
          >
            {testSend.isPending ? "Sending…" : "Send test"}
          </button>
        </div>
        <p aria-live="polite" className="text-sm">
          {testSend.error ? (
            <span className="text-bad">{testSend.error.message}</span>
          ) : testSend.data ? (
            <span className="text-go">
              {testSend.data.queued ? "Queued for" : "Sent to"} {testSend.data.to}: “{testSend.data.subject}” (as for {testSend.data.recipient}).{" "}
              {testSend.data.queued ? "Waiting for your PC: it goes out when npm run mail:outbox runs there." : "Check your inbox and spam folder."}
            </span>
          ) : null}
        </p>
      </div>
    </section>
  );
}
