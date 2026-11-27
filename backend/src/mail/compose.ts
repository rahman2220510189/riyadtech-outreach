import type { Env } from "../config/env.js";
import { stackWords } from "../crawler/analyze.js";
import type { Db } from "../db/client.js";
import { loadSeedData } from "../seed/files.js";
import type { Settings } from "../settings/definitions.js";
import { unsubscribeToken } from "./crypto.js";
import { renderText } from "./render.js";

/**
 * Building a complete outreach e-mail for one recipient: variables from the lead, the
 * template rendered (spintax seeded by the lead), the mandatory footer, and the
 * List-Unsubscribe headers (mailto + one-click https).
 */

export interface Recipient {
  /** Seed for spintax: the same recipient always gets the same choices. */
  key: string;
  label: string;
  email: string | null;
  vars: Record<string, string | null>;
  suppressed: boolean;
}

export interface ComposeInput {
  kind: "outreach" | "job";
  subject: string;
  body: string;
  templateKey: string;
  recipient: Recipient;
  /** The address the e-mail really goes to (a test: my own address). */
  to: string;
  mailbox: { fromName: string; fromEmail: string; replyTo: string | null };
  company: Settings["company"];
  env: Pick<Env, "ENCRYPTION_KEY" | "PUBLIC_BASE_URL">;
}

export interface ComposedMail {
  subject: string;
  text: string;
  headers: Record<string, string>;
  missing: string[];
  unknown: string[];
  warnings: string[];
  unsubscribeUrl: string | null;
}

let countryNames: Map<string, string> | undefined;
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  countryNames ??= new Map(loadSeedData().countries.map((c) => [c.code, c.name]));
  return countryNames.get(code) ?? code;
}

function stackOf(role: string | null): string | null {
  if (!role) return null;
  const r = ` ${role.toLowerCase()} `;
  const hit = stackWords().filter((w) => w.trim().length >= 3 && r.includes(w.trim()));
  return hit.length ? [...new Set(hit.map((h) => h.trim()))].slice(0, 3).join(", ") : null;
}

export function senderName(company: Settings["company"], mailbox: { fromName: string }): string {
  return company.senderName.trim() || mailbox.fromName;
}

/** The mandatory footer of every outreach e-mail (§8.2). */
export function footerText(company: Settings["company"], sender: string, unsubscribeUrl: string): string {
  const lines = ["--", `${sender} · ${company.name}`];
  if (company.postalAddress.trim()) lines.push(company.postalAddress.trim().replace(/\s*\n\s*/g, ", "));
  lines.push(`Reply "no" and I won't email again, or unsubscribe here: ${unsubscribeUrl}`);
  return lines.join("\n");
}

export function composeMail(i: ComposeInput): ComposedMail {
  const sender = senderName(i.company, i.mailbox);
  const warnings: string[] = [];
  const base = i.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  let unsubscribeUrl: string | null = null;
  let oneClick: string | null = null;
  if (i.kind === "outreach") {
    const token = unsubscribeToken(i.env.ENCRYPTION_KEY, i.to);
    unsubscribeUrl = `${base}/u/${token}`;
    oneClick = `${base}/api/v1/u/${token}`;
    if (!i.company.postalAddress.trim()) warnings.push("Your postal address is empty (Settings → Company): the law in the US requires it in every e-mail. Campaigns will not start without it.");
  }
  const vars: Record<string, string | null> = {
    ...i.recipient.vars,
    sender_name: sender,
    company_address: i.company.postalAddress.trim() || null,
    unsubscribe_link: unsubscribeUrl,
  };
  const seed = `${i.templateKey}:${i.recipient.key}`;
  const subject = renderText(i.subject, vars, `${seed}:subject`);
  const body = renderText(i.body, vars, `${seed}:body`);
  const text = i.kind === "outreach" && unsubscribeUrl ? `${body.text}\n\n${footerText(i.company, sender, unsubscribeUrl)}` : body.text;
  const headers: Record<string, string> = {};
  if (oneClick) {
    const mailto = `mailto:${i.mailbox.replyTo ?? i.mailbox.fromEmail}?subject=unsubscribe`;
    headers["List-Unsubscribe"] = `<${mailto}>, <${oneClick}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  if (i.recipient.suppressed) warnings.push("This recipient is on the suppression list and would never be e-mailed.");
  return {
    subject: subject.text.replace(/\s+/g, " ").trim(),
    text,
    headers,
    missing: [...new Set([...subject.missing, ...body.missing])],
    unknown: [...new Set([...subject.unknown, ...body.unknown])],
    warnings,
    unsubscribeUrl,
  };
}

/** Recipients for a preview: found leads (filters) or rows of an imported list. */
export async function previewRecipients(
  db: Db,
  source: { listId?: number | undefined; segment?: "A" | "B" | undefined; country?: string | undefined; leadIds?: number[] | undefined; hiring?: boolean | undefined },
  take: number,
): Promise<Recipient[]> {
  if (source.listId) {
    const rows = await db.listLead.findMany({ where: { listId: BigInt(source.listId), status: { in: ["ok", "suppressed"] } }, orderBy: { rowNumber: "asc" }, take });
    return rows.map((r) => ({
      key: `list:${r.id}`,
      label: `${r.company ?? r.email} (list row ${r.rowNumber})`,
      email: r.email,
      suppressed: r.status === "suppressed",
      vars: {
        first_name: r.firstName,
        company: r.company,
        website: r.website ? r.domain : null,
        city: r.city,
        country: countryName(r.country),
        ...Object.fromEntries(Object.entries((r.custom as Record<string, string | null>) ?? {})),
      },
    }));
  }
  const places = await db.place.findMany({
    where: {
      ...(source.leadIds?.length ? { id: { in: source.leadIds.map((n) => BigInt(n)) } } : { primaryEmail: { not: null }, suppressed: false }),
      ...(source.segment ? { segment: source.segment } : {}),
      ...(source.country ? { country: source.country } : {}),
      ...(source.hiring ? { signals: { some: { key: { in: ["hiring_dev", "job_opening"] } } } } : {}),
    },
    orderBy: [{ leadScore: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take,
    include: { signals: { where: { key: { in: ["hiring_dev", "job_opening"] } }, select: { value: true } } },
  });
  return places.map((p) => placeRecipient(p));
}

const LEGAL = /[\s,]+(ltd\.?|limited|llc|l\.l\.c\.|inc\.?|incorporated|plc|llp|lp|pty\.?\s*ltd\.?|pty|gmbh|co\.?|corp\.?|corporation|company)$/i;

/**
 * The name as a person would write it in an e-mail: "BCN Group Ltd. Manchester" → "BCN Group",
 * "Pixel Studio Limited" → "Pixel Studio" (legal forms and the lead's own city at the end are dropped).
 */
export function shortCompany(name: string, city: string | null): string {
  let n = name.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3; i++) {
    const before = n;
    if (city && city.length > 2) {
      const c = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      n = n.replace(new RegExp(`[\\s,–—-]*(\\(?\\s*${c}\\s*\\)?)$`, "i"), "");
    }
    n = n.replace(LEGAL, "").replace(/[\s,.–—-]+$/, "");
    if (n === before) break;
  }
  return n.length >= 2 ? n : name.trim();
}

export function placeRecipient(p: {
  id: bigint;
  name: string;
  firstName: string | null;
  websiteDomain: string;
  city: string | null;
  country: string;
  signalLine: string | null;
  primaryEmail: string | null;
  suppressed: boolean;
  signals: { value: string | null }[];
}): Recipient {
  const role = p.signals.find((s) => s.value)?.value ?? null;
  return {
    key: `place:${p.id}`,
    label: `${p.name} (${p.websiteDomain})`,
    email: p.suppressed ? null : p.primaryEmail,
    suppressed: p.suppressed,
    vars: {
      first_name: p.firstName,
      company: shortCompany(p.name, p.city),
      website: p.websiteDomain,
      city: p.city,
      country: countryName(p.country),
      role,
      stack_match: stackOf(role),
      // Opening lines saved before names were shortened still carry the full name.
      signal_line: p.signalLine ? p.signalLine.split(p.name).join(shortCompany(p.name, p.city)) : null,
    },
  };
}

/** A made-up recipient for previews when no lead is chosen. */
export const SAMPLE_RECIPIENT: Recipient = {
  key: "sample",
  label: "Sample lead (made up)",
  email: null,
  suppressed: false,
  vars: {
    first_name: "Sarah",
    company: "Pixel Studio",
    website: "pixelstudio.example",
    city: "Manchester",
    country: "United Kingdom",
    role: "Senior React Developer",
    stack_match: "React",
    signal_line: "I saw Pixel Studio is hiring a Senior React Developer.",
    job_title: "Senior React Developer (m/w/d)",
    job_url: "https://example.com/jobs/123",
  },
};
