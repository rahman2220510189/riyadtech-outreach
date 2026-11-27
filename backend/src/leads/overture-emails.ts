import { type ClassifiedEmail, classifyEmail, isJunkEmail, normalizeEmail, pickPrimary } from "../crawler/emails.js";
import { checkMx, type MxResolver } from "../crawler/mx.js";
import type { Db } from "../db/client.js";
import { type AddressRules, addressRules } from "./country-rules.js";
import { refreshSuppressed } from "./suppression.js";

/**
 * Addendum 2: Overture already lists e-mail addresses for many places. They are saved as e-mail
 * rows at import (origin "overture", on_site false), go through the same checks as crawled
 * addresses (syntax, junk, own/free domain, generic/named/department, MX), and can make a lead
 * usable before any crawl. A later crawl still runs for signals and a better address: an address
 * found on the website always wins over an Overture-only one.
 */

/** Not a web page: shown in the app as "Overture Maps open data". */
export const OVERTURE_SOURCE = "overture://places/";
export const overtureSourceUrl = (overtureId: string): string => `${OVERTURE_SOURCE}${overtureId}`;

/** Overture's addresses for one place, cleaned and classified like crawled ones; junk is dropped. */
export function classifyOvertureEmails(raw: string[], siteDomain: string, sourceFor: (email: string) => string | null): (ClassifiedEmail & { sourceId: string | null })[] {
  const out = new Map<string, ClassifiedEmail & { sourceId: string | null }>();
  for (const r of raw) {
    const email = normalizeEmail(r);
    if (!email || isJunkEmail(email) || out.has(email)) continue;
    const sourceId = sourceFor(email);
    out.set(email, { ...classifyEmail({ email, sourceUrl: overtureSourceUrl(sourceId ?? "unknown"), context: "" }, siteDomain), sourceId });
  }
  return [...out.values()];
}

export interface StoredEmail extends ClassifiedEmail {
  mxValid: boolean | null;
  onSite: boolean;
  origin: string;
}

/**
 * The address a campaign would use: one seen on the website first; otherwise an Overture-only
 * address, except where the law asks for addresses published on the business's own site (Australia).
 * Department addresses, addresses without a mail server and (in generic-only countries) personal
 * addresses are never chosen (same rules as the crawler). Overture-only addresses must be on the
 * website's own domain or a free-mail domain (small businesses often use Gmail).
 */
export function choosePrimary(rows: StoredEmail[], segment: "A" | "B", rules: AddressRules): StoredEmail | null {
  const site = pickPrimary(rows.filter((r) => r.onSite && r.origin !== "csv"), segment, rules.genericOnly) as StoredEmail | null;
  if (site || rules.publishedOnly) return site;
  // An Overture-only address on a third domain (a parent brand, an agency) is not the business's own contact.
  return pickPrimary(rows.filter((r) => !r.onSite && r.origin === "overture" && r.domainMatch !== "other"), segment, rules.genericOnly) as StoredEmail | null;
}

export function storedEmail(row: { email: string; domain: string; kind: string; domainMatch: string; firstName: string | null; context: string | null; sourceUrl: string; mxValid: boolean | null; onSite: boolean; origin: string }): StoredEmail {
  return {
    email: row.email,
    domain: row.domain,
    kind: row.kind as ClassifiedEmail["kind"],
    domainMatch: row.domainMatch as ClassifiedEmail["domainMatch"],
    firstName: row.firstName,
    context: row.context ?? "",
    sourceUrl: row.sourceUrl,
    mxValid: row.mxValid,
    onSite: row.onSite,
    origin: row.origin,
  };
}

export interface OvertureEmailResult {
  /** Places that had Overture addresses. */
  places: number;
  /** Addresses saved or refreshed. */
  emails: number;
  /** Addresses held back: no mail server. */
  noMx: number;
  /** Places that got a usable address from Overture in this step. */
  ready: number;
}

/**
 * Saves the Overture addresses of these places and picks a primary address where a lead has none
 * (or only an Overture-only one). `sources` maps "segment|domain" to the Overture id of each address.
 */
export async function applyOvertureEmails(
  db: Db,
  placeIds: bigint[],
  opts: { release?: string; sources?: Map<string, Map<string, string>>; mxResolve?: MxResolver; touch?: () => Promise<void> },
): Promise<OvertureEmailResult> {
  const result: OvertureEmailResult = { places: 0, emails: 0, noMx: 0, ready: 0 };
  if (placeIds.length === 0) return result;
  const places = await db.place.findMany({
    where: { id: { in: placeIds } },
    select: { id: true, segment: true, websiteDomain: true, country: true, overtureEmails: true, primaryEmail: true, sourceIds: true, release: true },
    orderBy: { id: "asc" },
  });
  const plan = places.map((p) => {
    const ids = opts.sources?.get(`${p.segment}|${p.websiteDomain}`);
    const fallback = p.sourceIds.length === 1 ? p.sourceIds[0]! : null;
    return { place: p, emails: classifyOvertureEmails(p.overtureEmails, p.websiteDomain, (e) => ids?.get(e) ?? fallback) };
  });

  const mx = new Map<string, boolean | null>();
  for (const d of [...new Set(plan.flatMap((x) => x.emails.map((e) => e.domain)))].sort()) {
    mx.set(d, (await checkMx(db, d, opts.mxResolve)).hasMx);
    await opts.touch?.();
  }

  for (const { place, emails } of plan) {
    if (emails.length > 0) result.places++;
    const rules = await addressRules(db, place.country);
    const wasReady = place.primaryEmail !== null;
    await db.$transaction(async (tx) => {
      for (const e of emails) {
        const mxValid = mx.get(e.domain) ?? null;
        if (mxValid === false) result.noMx++;
        // An address already saved for another lead stays with that lead (one row per address).
        const rows = await tx.$queryRaw<{ email: string }[]>`
          INSERT INTO emails (place_id, email, domain, kind, domain_match, is_primary, first_name, context, mx_valid, source_url,
                              origin, on_site, source_id, source_release, updated_at)
          VALUES (${place.id}, ${e.email}, ${e.domain}, ${e.kind}, ${e.domainMatch}, false, ${e.firstName}, '', ${mxValid}, ${e.sourceUrl},
                  'overture', false, ${e.sourceId}, ${opts.release ?? place.release}, now())
          ON CONFLICT (email) DO UPDATE SET
            origin = 'overture',
            kind = CASE WHEN emails.on_site THEN emails.kind ELSE EXCLUDED.kind END,
            domain_match = CASE WHEN emails.on_site THEN emails.domain_match ELSE EXCLUDED.domain_match END,
            first_name = CASE WHEN emails.on_site THEN emails.first_name ELSE EXCLUDED.first_name END,
            mx_valid = CASE WHEN emails.on_site THEN emails.mx_valid ELSE EXCLUDED.mx_valid END,
            source_id = COALESCE(emails.source_id, EXCLUDED.source_id),
            source_release = EXCLUDED.source_release,
            updated_at = now()
          WHERE emails.place_id = EXCLUDED.place_id
          RETURNING email`;
        if (rows.length > 0) result.emails++;
      }

      await tx.place.update({ where: { id: place.id }, data: { overtureCheckedAt: new Date() } });
      const current = await tx.email.findMany({ where: { placeId: place.id } });
      const primaryRow = current.find((r) => r.email === place.primaryEmail);
      // Never replace an address the crawler found on the website (or one from my own CSV).
      if (primaryRow && (primaryRow.onSite || primaryRow.origin !== "overture")) return;
      const primary = choosePrimary(current.map(storedEmail), place.segment as "A" | "B", rules);
      if ((primary?.email ?? null) === place.primaryEmail) return;
      await tx.email.updateMany({ where: { placeId: place.id }, data: { isPrimary: false } });
      if (primary) await tx.email.update({ where: { email: primary.email }, data: { isPrimary: true } });
      await tx.place.update({ where: { id: place.id }, data: { primaryEmail: primary?.email ?? null, firstName: primary?.firstName ?? null } });
      if (primary && !wasReady) result.ready++;
    });
  }
  await refreshSuppressed(db, places.map((p) => p.id));
  return result;
}

/**
 * Leads whose addresses have not been checked yet (saved before step 5.1, or flagged again after a
 * rule change): their Overture addresses are saved and checked and the primary address is picked
 * again, once, a batch at a time, by the worker. Returns how many places had Overture addresses.
 */
export async function catchUpOvertureEmails(db: Db, opts: { batch?: number; mxResolve?: MxResolver } = {}): Promise<OvertureEmailResult & { left: number }> {
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM places WHERE overture_checked_at IS NULL ORDER BY id LIMIT ${opts.batch ?? 300}`;
  const r = await applyOvertureEmails(db, rows.map((x) => x.id), opts.mxResolve ? { mxResolve: opts.mxResolve } : {});
  const [{ left } = { left: 0n }] = await db.$queryRaw<{ left: bigint }[]>`
    SELECT count(*) AS left FROM places WHERE overture_checked_at IS NULL`;
  return { ...r, left: Number(left) };
}
