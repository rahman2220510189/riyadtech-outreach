import { parse } from "csv-parse/sync";

/** Pure CSV helpers: reading uploaded lists and writing exports. */

export const MAX_IMPORT_ROWS = 20_000;

/** The delimiter used in the header line: comma, semicolon (Excel in Germany/France), tab or pipe. */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t", "|"]) {
    // Count outside quotes only.
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export interface ParsedCsv {
  delimiter: string;
  headers: string[];
  rows: string[][];
  /** Data rows beyond MAX_IMPORT_ROWS are not read. */
  truncated: boolean;
}

/** Reads a CSV text (header line first). Throws with a readable message for broken files. */
export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^\uFEFF/, "");
  if (!clean.trim()) throw new Error("The file is empty");
  const delimiter = detectDelimiter(clean);
  let records: string[][];
  try {
    records = parse(clean, {
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: true,
      to: MAX_IMPORT_ROWS + 2,
    });
  } catch (err) {
    throw new Error(`The file could not be read as CSV: ${(err as Error).message}`, { cause: err });
  }
  const [header, ...rest] = records;
  if (!header || header.every((h) => !h)) throw new Error("The first line must contain the column names");
  const headers = header.map((h, i) => h || `Column ${i + 1}`);
  // Two columns with the same name: keep both, numbered.
  const seen = new Map<string, number>();
  const unique = headers.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h} (${n})` : h;
  });
  const rows = rest.slice(0, MAX_IMPORT_ROWS).filter((r) => r.some((c) => c));
  return { delimiter, headers: unique, rows, truncated: rest.length > MAX_IMPORT_ROWS };
}

export type MappedField = "email" | "first_name" | "company" | "website" | "country" | "city";

const GUESS: Record<MappedField, RegExp> = {
  email: /^(e-?mail|email address|e-?mail address|mail|e-?mail-?adresse|adresse e-?mail|courriel)$/i,
  first_name: /^(first ?name|firstname|given ?name|vorname|pr[ée]nom|voornaam|imi[ęe]|name \(first\))$/i,
  company: /^(company|company name|firma|unternehmen|organi[sz]ation|business|bedrijf|entreprise|soci[ée]t[ée]|firma nazwa|account|name)$/i,
  website: /^(website|web ?site|url|web|homepage|domain|webseite|site web|strona)$/i,
  country: /^(country|land|pays|kraj|country code|countrycode)$/i,
  city: /^(city|town|stadt|ort|ville|stad|plaats|miasto|location)$/i,
};

/** Best guess of which column holds which field (by header name, then by content for e-mail). */
export function suggestMapping(headers: string[], rows: string[][]): Partial<Record<MappedField, string>> {
  const out: Partial<Record<MappedField, string>> = {};
  const used = new Set<string>();
  for (const field of Object.keys(GUESS) as MappedField[]) {
    const h = headers.find((x) => !used.has(x) && GUESS[field].test(x.trim()));
    if (h) {
      out[field] = h;
      used.add(h);
    }
  }
  if (!out.email) {
    // The column where most sample values look like an address.
    let best: { h: string; n: number } | null = null;
    headers.forEach((h, i) => {
      const n = rows.slice(0, 50).filter((r) => /@[^@\s]+\.[a-z]{2,}/i.test(r[i] ?? "")).length;
      if (n > 0 && (!best || n > best.n)) best = { h, n };
    });
    if (best) out.email = (best as { h: string }).h;
  }
  return out;
}

/** Column name -> template variable name ("Industry Type" -> "industry_type"). */
export function variableName(header: string): string {
  return (
    header
      .replace(/ß/g, "ss")
      .replace(/ł/g, "l")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "column"
  );
}

/** One CSV cell; values that a spreadsheet would run as a formula get a leading apostrophe. */
export function csvCell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") s = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") s = value.toString();
  else if (value instanceof Date) s = value.toISOString();
  else if (Array.isArray(value)) s = value.map((v) => csvCell(v)).join(" ");
  else s = JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvCell).join(",");
}
