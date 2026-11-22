"use client";

import Link from "next/link";
import { useState } from "react";
import { formatNumber } from "@/lib/finder";
import { type CsvPreview, type ListMapping, type MappedField, useImportList, usePreviewCsv } from "@/lib/leads";

const FIELDS: { key: MappedField; label: string; hint: string }[] = [
  { key: "email", label: "E-mail", hint: "Required" },
  { key: "first_name", label: "First name", hint: "For “Hi {first_name}”" },
  { key: "company", label: "Company", hint: "" },
  { key: "website", label: "Website", hint: "Matches found leads by domain" },
  { key: "country", label: "Country", hint: "Name or code (DE, Germany)" },
  { key: "city", label: "City", hint: "" },
];

const MAX_BYTES = 5 * 1024 * 1024;

/** Reads the file as UTF-8, or as Windows-1252 when it is not valid UTF-8 (CSV saved by Excel). */
async function readFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export function ImportWizard() {
  const preview = usePreviewCsv();
  const importList = useImportList();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mapping, setMapping] = useState<Partial<Record<MappedField, string>>>({});
  const [custom, setCustom] = useState<string[]>([]);

  const onFile = async (f: File | undefined) => {
    setFileError(null);
    importList.reset();
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setFileError("The file is larger than 5 MB. Split it into smaller files.");
      return;
    }
    const text = await readFile(f);
    setFile({ name: f.name, text });
    setName(f.name.replace(/\.(csv|txt)$/i, ""));
    preview.mutate(text, {
      onSuccess: (p: CsvPreview) => {
        setMapping(p.suggested);
        setCustom([]);
      },
    });
  };

  const p = preview.data;
  const used = new Set(Object.values(mapping).filter(Boolean));
  const canImport = !!file && !!p && !!mapping.email && name.trim().length > 0 && !importList.isPending;
  const submit = () => {
    if (!file || !mapping.email) return;
    const m: ListMapping = { email: mapping.email, custom };
    for (const f of FIELDS) if (f.key !== "email" && mapping[f.key]) m[f.key] = mapping[f.key];
    importList.mutate({ name: name.trim(), fileName: file.name, text: file.text, mapping: m });
  };
  const result = importList.data;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/leads" className="text-sm text-ink-2 underline underline-offset-4">
          Leads
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Import a CSV</h1>
        <p className="mt-1 max-w-prose text-ink-2">
          Your own list of contacts (first line = column names, up to 20,000 rows). Addresses on the suppression list are
          marked and never contacted; addresses that are already leads are marked as duplicates.
        </p>
      </div>

      <section className="rounded-xl border border-line bg-surface px-5 py-4">
        <h2 className="font-semibold">1. Choose the file</h2>
        <input
          type="file"
          accept=".csv,.txt,text/csv"
          aria-label="CSV file"
          onChange={(e) => void onFile(e.target.files?.[0])}
          className="mt-3 block text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:font-medium"
        />
        {fileError && <p className="mt-2 text-sm text-bad">{fileError}</p>}
        {preview.isPending && <p className="mt-2 text-sm text-ink-2">Reading the file…</p>}
        {preview.error && <p className="mt-2 text-sm text-bad">{preview.error.message}</p>}
        {p && (
          <p className="mt-2 text-sm text-ink-2">
            {formatNumber(p.rows)} rows, {p.headers.length} columns, separated by{" "}
            {p.delimiter === "\t" ? "tabs" : `“${p.delimiter}”`}.
            {p.truncated ? ` Only the first ${formatNumber(p.maxRows)} rows are imported.` : ""}
          </p>
        )}
      </section>

      {p && (
        <section className="rounded-xl border border-line bg-surface px-5 py-4">
          <h2 className="font-semibold">2. Which column is what?</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1 text-sm">
                <span className="font-medium">
                  {f.label} {f.hint && <span className="font-normal text-ink-3">· {f.hint}</span>}
                </span>
                <select
                  value={mapping[f.key] ?? ""}
                  onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })}
                  className="rounded-lg border border-line bg-surface px-2.5 py-2"
                >
                  <option value="">{f.key === "email" ? "Choose a column" : "Not in the file"}</option>
                  {p.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {p.headers.some((h) => !used.has(h)) && (
            <fieldset className="mt-4">
              <legend className="text-sm font-medium">Other columns to keep (usable in templates later)</legend>
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {p.headers
                  .filter((h) => !used.has(h))
                  .map((h) => (
                    <label key={h} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={custom.includes(h)}
                        onChange={(e) => setCustom(e.target.checked ? [...custom, h] : custom.filter((c) => c !== h))}
                        className="size-4"
                      />
                      {h}
                    </label>
                  ))}
              </div>
            </fieldset>
          )}
          <div className="mt-4 overflow-x-auto rounded-lg border border-line-soft">
            <table className="w-full text-left text-xs">
              <thead className="bg-paper text-ink-2">
                <tr>
                  {p.headers.map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                      {Object.entries(mapping).find(([, v]) => v === h) && (
                        <span className="ml-1 text-go">→ {FIELDS.find((f) => mapping[f.key] === h)?.label}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {p.sample.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {p.headers.map((h, j) => (
                      <td key={h} className="max-w-[14rem] truncate px-3 py-1.5">
                        {r[j] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {p && (
        <section className="rounded-xl border border-line bg-surface px-5 py-4">
          <h2 className="font-semibold">3. Import</h2>
          <label className="mt-3 flex max-w-md flex-col gap-1 text-sm">
            <span className="font-medium">Name of the list</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-line px-3 py-2" />
          </label>
          <button
            type="button"
            disabled={!canImport}
            onClick={submit}
            className="mt-4 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50"
          >
            {importList.isPending ? "Importing…" : `Import ${formatNumber(p.rows)} rows`}
          </button>
          {!mapping.email && <p className="mt-2 text-sm text-warn">Choose the e-mail column first.</p>}
          {importList.error && <p className="mt-2 text-sm text-bad">{importList.error.message}</p>}
          {result && (
            <div role="status" className="mt-4 rounded-lg bg-go-soft px-4 py-3 text-sm">
              <p className="font-semibold text-go">Imported.</p>
              <p className="mt-1">
                {formatNumber(result.counts.ok)} ready · {formatNumber(result.counts.suppressed)} suppressed ·{" "}
                {formatNumber(result.counts.duplicate)} duplicates · {formatNumber(result.counts.invalid)} invalid addresses skipped
              </p>
              <Link href={`/leads/lists/${result.id}`} className="mt-2 inline-block font-medium underline underline-offset-4">
                Open the list
              </Link>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
