import type { Db } from "../db/client.js";

/** The parts of a country's outreach rules that decide which address a lead may use. */
export interface AddressRules {
  /** UK, Ireland and most of Europe: generic company addresses only (info@, hello@). */
  genericOnly: boolean;
  /** Australia (Spam Act): only addresses the business publishes on its own site, so Overture-only addresses wait for a crawl. */
  publishedOnly: boolean;
}

const cache = new Map<string, AddressRules>();

export async function addressRules(db: Db, country: string): Promise<AddressRules> {
  const hit = cache.get(country);
  if (hit) return hit;
  const c = await db.country.findUnique({ where: { code: country }, select: { outreachRules: true } });
  const r = (c?.outreachRules ?? {}) as { genericOnly?: boolean; conspicuouslyPublishedOnly?: boolean };
  const rules = { genericOnly: Boolean(r.genericOnly), publishedOnly: Boolean(r.conspicuouslyPublishedOnly) };
  cache.set(country, rules);
  return rules;
}

export function clearAddressRulesCache(): void {
  cache.clear();
}
