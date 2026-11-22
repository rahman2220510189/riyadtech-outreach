import { z } from "zod";
import { isJunkEmail, normalizeEmail } from "../crawler/emails.js";
import type { Db } from "../db/client.js";
import { websiteDomain } from "../finder/domain.js";
import type { Prisma } from "../generated/prisma/client.js";
import { loadSeedData } from "../seed/files.js";
import { type MappedField, parseCsv, variableName } from "./csv.js";
import { suppressedSet } from "./suppression.js";

export const mappingSchema = z
  .object({
    email: z.string().min(1),
    first_name: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    website: z.string().min(1).optional(),
    country: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    /** Extra columns kept as template variables. */
    custom: z.array(z.string().min(1)).max(20).default([]),
  })
  .strict();
export type ListMapping = z.infer<typeof mappingSchema>;

export const importSchema = z.object({
  name: z.string().trim().min(1).max(100),
  fileName: z.string().trim().max(200).optional(),
  text: z.string().min(1).max(6_000_000),
  mapping: mappingSchema,
});

export interface ImportCounts {
  ok: number;
  suppressed: number;
  duplicate: number;
  invalid: number;
  [key: string]: number;
}

let countryNames: Map<string, string> | undefined;
/** "Germany", "deutschland", "DE" -> "DE". */
export function countryCode(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase() === "UK" ? "GB" : v.toUpperCase();
  if (!countryNames) {
    countryNames = new Map(loadSeedData().countries.map((c) => [c.name.toLowerCase(), c.code]));
    for (const [alias, code] of Object.entries({
      uk: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB", usa: "US", "united states of america": "US",
      deutschland: "DE", "österreich": "AT", osterreich: "AT", schweiz: "CH", nederland: "NL", holland: "NL", "the netherlands": "NL",
      france: "FR", polska: "PL", "españa": "ES", espana: "ES", italia: "IT", eire: "IE",
    })) {
      countryNames.set(alias, code);
    }
  }
  return countryNames.get(v.toLowerCase()) ?? null;
}

/**
 * Imports a CSV as a lead list. Same rules as found leads: one row per address in the list,
 * suppressed addresses/domains are marked (never contacted), addresses that are already a
 * found lead or in another list are marked as duplicates, invalid addresses are skipped.
 */
export async function importList(db: Db, input: z.infer<typeof importSchema>, actor: string | null) {
  const csv = parseCsv(input.text);
  const col = (h: string | undefined) => (h ? csv.headers.indexOf(h) : -1);
  const idx: Record<MappedField, number> = {
    email: col(input.mapping.email),
    first_name: col(input.mapping.first_name),
    company: col(input.mapping.company),
    website: col(input.mapping.website),
    country: col(input.mapping.country),
    city: col(input.mapping.city),
  };
  if (idx.email < 0) throw new Error(`Column "${input.mapping.email}" is not in the file`);
  for (const [field, i] of Object.entries(idx)) {
    const h = input.mapping[field as MappedField];
    if (h && i < 0) throw new Error(`Column "${h}" is not in the file`);
  }
  const custom = input.mapping.custom.map((h) => ({ h, i: csv.headers.indexOf(h), key: variableName(h) }));
  const missing = custom.find((c) => c.i < 0);
  if (missing) throw new Error(`Column "${missing.h}" is not in the file`);

  const get = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() || null : null);
  const counts: ImportCounts = { ok: 0, suppressed: 0, duplicate: 0, invalid: 0 };
  const seen = new Set<string>();
  const rows: Omit<Prisma.ListLeadCreateManyInput, "listId">[] = [];
  csv.rows.forEach((row, n) => {
    const email = normalizeEmail(get(row, idx.email) ?? "");
    if (!email || isJunkEmail(email)) {
      counts.invalid++;
      return;
    }
    if (seen.has(email)) {
      counts.duplicate++; // twice in the same file: the first row is kept
      return;
    }
    seen.add(email);
    const emailDomain = email.split("@")[1]!;
    const website = get(row, idx.website);
    const domain = websiteDomain(website) ?? emailDomain;
    rows.push({
      rowNumber: n + 1,
      email,
      domain,
      firstName: get(row, idx.first_name),
      company: get(row, idx.company),
      website,
      country: countryCode(get(row, idx.country) ?? undefined),
      city: get(row, idx.city),
      custom: Object.fromEntries(custom.map((c) => [c.key, get(row, c.i)])),
      status: "ok",
    });
  });

  // Suppression and duplicates, in chunks (large files).
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const emails = chunk.map((r) => r.email);
    const domains = chunk.map((r) => r.domain);
    const sup = await suppressedSet(db, emails, domains);
    const [knownEmails, inLists, places] = await Promise.all([
      db.email.findMany({ where: { email: { in: emails } }, select: { email: true, place: { select: { name: true } } } }),
      db.listLead.findMany({ where: { email: { in: emails }, status: { in: ["ok", "duplicate"] } }, select: { email: true, list: { select: { name: true } } } }),
      db.place.findMany({ where: { websiteDomain: { in: [...new Set(domains)] } }, select: { id: true, websiteDomain: true } }),
    ]);
    const known = new Map(knownEmails.map((k) => [k.email, k.place.name]));
    const listed = new Map(inLists.map((k) => [k.email, k.list.name]));
    const placeByDomain = new Map(places.map((p) => [p.websiteDomain, p.id]));
    for (const r of chunk) {
      r.placeId = placeByDomain.get(r.domain) ?? null;
      if (sup.emails.has(r.email) || sup.domains.has(r.domain) || sup.domains.has(r.email.split("@")[1]!)) {
        r.status = "suppressed";
        r.note = "On the suppression list";
      } else if (known.has(r.email)) {
        r.status = "duplicate";
        r.note = `Already a found lead (${known.get(r.email)})`;
      } else if (listed.has(r.email)) {
        r.status = "duplicate";
        r.note = `Already in the list "${listed.get(r.email)}"`;
      }
      const st = r.status as "ok" | "suppressed" | "duplicate";
      counts[st] += 1;
    }
  }

  const list = await db.$transaction(
    async (tx) => {
      const l = await tx.leadList.create({
        data: {
          name: input.name,
          fileName: input.fileName ?? null,
          mapping: input.mapping,
          rowsTotal: csv.rows.length,
          counts: counts,
          createdBy: actor,
        },
      });
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.listLead.createMany({ data: rows.slice(i, i + 1000).map((r) => ({ ...r, listId: l.id })) });
      }
      await tx.auditLog.create({
        data: {
          actor,
          action: "list.import",
          entity: "lead_list",
          entityId: String(l.id),
          details: { name: input.name, fileName: input.fileName ?? null, rows: csv.rows.length, ...counts },
        },
      });
      return l;
    },
    { timeout: 120_000 },
  );
  return { id: Number(list.id), rows: csv.rows.length, truncated: csv.truncated, counts };
}
