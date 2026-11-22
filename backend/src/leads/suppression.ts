import { normalizeEmail } from "../crawler/emails.js";
import type { Db } from "../db/client.js";
import { websiteDomain } from "../finder/domain.js";

export const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "replied_no", "manual", "client"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface SuppressionTarget {
  kind: "email" | "domain";
  value: string;
}

/** "Info@Acme.com" -> e-mail; "https://www.acme.com/x" or "acme.com" or "@acme.com" -> domain. */
export function suppressionTarget(input: string): SuppressionTarget | null {
  const raw = input.trim().replace(/^mailto:/i, "");
  if (!raw) return null;
  if (raw.startsWith("@")) {
    const d = websiteDomain(raw.slice(1));
    return d ? { kind: "domain", value: d } : null;
  }
  if (raw.includes("@")) {
    const e = normalizeEmail(raw);
    return e ? { kind: "email", value: e } : null;
  }
  const d = websiteDomain(raw);
  return d ? { kind: "domain", value: d } : null;
}

/** Every address or domain in a pasted text or a one-column file (comma, semicolon, space or line separated). */
export function parseSuppressionList(text: string): { targets: SuppressionTarget[]; invalid: string[] } {
  const seen = new Set<string>();
  const targets: SuppressionTarget[] = [];
  const invalid: string[] = [];
  for (const token of text.replace(/^\uFEFF/, "").split(/[\s,;]+/)) {
    const t = token.trim().replace(/^["']|["']$/g, "");
    if (!t || /^(e-?mail|domain|address|value)$/i.test(t)) continue; // header words
    const target = suppressionTarget(t);
    if (!target) {
      if (invalid.length < 50) invalid.push(t);
      continue;
    }
    const key = `${target.kind}:${target.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  }
  return { targets, invalid };
}

/**
 * Brings `places.suppressed` and the list rows in step with the suppression table.
 * A lead is suppressed when its primary address, that address's domain or its website's
 * domain is on the list. Runs after every change of the list (and for crawled leads).
 */
export async function refreshSuppressed(db: Db, placeIds?: bigint[]): Promise<{ places: number; listRows: number }> {
  const onlyPlaces = placeIds && placeIds.length > 0 ? placeIds : null;
  const places = await db.$executeRaw`
    UPDATE places p SET suppressed = x.s
      FROM (
        SELECT p2.id,
               (EXISTS (SELECT 1 FROM suppression s WHERE s.kind = 'email' AND s.value = p2.primary_email)
                OR EXISTS (SELECT 1 FROM suppression s WHERE s.kind = 'domain'
                           AND (s.value = p2.website_domain OR s.value = split_part(p2.primary_email, '@', 2)))) AS s
          FROM places p2
         WHERE ${onlyPlaces}::bigint[] IS NULL OR p2.id = ANY(${onlyPlaces}::bigint[])
      ) x
     WHERE p.id = x.id AND p.suppressed IS DISTINCT FROM x.s`;
  if (onlyPlaces) return { places, listRows: 0 };
  const toSuppressed = await db.$executeRaw`
    UPDATE list_leads l SET status = 'suppressed', note = 'On the suppression list'
     WHERE l.status IN ('ok', 'duplicate')
       AND (EXISTS (SELECT 1 FROM suppression s WHERE s.kind = 'email' AND s.value = l.email)
            OR EXISTS (SELECT 1 FROM suppression s WHERE s.kind = 'domain' AND (s.value = l.domain OR s.value = split_part(l.email, '@', 2))))`;
  // Rows no longer covered by the list: first back to ok, then (a separate statement, so it sees
  // the first one's result) duplicates of a found lead or of an older list are marked again.
  const freed = await db.$queryRaw<{ id: bigint }[]>`
    UPDATE list_leads l SET status = 'ok', note = NULL
     WHERE l.status = 'suppressed'
       AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.kind = 'email' AND s.value = l.email)
       AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.kind = 'domain' AND (s.value = l.domain OR s.value = split_part(l.email, '@', 2)))
    RETURNING l.id`;
  if (freed.length > 0) {
    const ids = freed.map((f) => f.id);
    await db.$executeRaw`
      UPDATE list_leads l SET status = 'duplicate', note = d.note
        FROM (
          SELECT l2.id,
                 COALESCE(
                   (SELECT 'Already a found lead (' || pl.name || ')' FROM emails em JOIN places pl ON pl.id = em.place_id
                     WHERE em.email = l2.email LIMIT 1),
                   (SELECT 'Already in the list "' || li.name || '"' FROM list_leads ll JOIN lead_lists li ON li.id = ll.list_id
                     WHERE ll.email = l2.email AND ll.list_id < l2.list_id AND ll.status IN ('ok', 'duplicate')
                     ORDER BY ll.list_id LIMIT 1)) AS note
            FROM list_leads l2
           WHERE l2.id = ANY(${ids}::bigint[])
        ) d
       WHERE l.id = d.id AND d.note IS NOT NULL`;
  }
  const backToOk = freed.length;
  return { places, listRows: toSuppressed + backToOk };
}

/** Which of these addresses (or their domains) are suppressed. */
export async function suppressedSet(db: Db, emails: string[], domains: string[]): Promise<{ emails: Set<string>; domains: Set<string> }> {
  const emailDomains = emails.map((e) => e.split("@")[1] ?? "").filter(Boolean);
  const rows = await db.suppression.findMany({
    where: {
      OR: [
        { kind: "email", value: { in: emails } },
        { kind: "domain", value: { in: [...new Set([...domains, ...emailDomains])] } },
      ],
    },
    select: { kind: true, value: true },
  });
  return {
    emails: new Set(rows.filter((r) => r.kind === "email").map((r) => r.value)),
    domains: new Set(rows.filter((r) => r.kind === "domain").map((r) => r.value)),
  };
}
