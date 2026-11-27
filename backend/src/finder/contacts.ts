import { type CountryCode, parsePhoneNumberFromString } from "libphonenumber-js/max";

/**
 * Phone numbers and social links as Overture lists them, cleaned at import.
 * Phones become E.164 ("+441612345678") for the place's country; numbers that are not valid
 * there are dropped (a wrong number is worse than none).
 */
export function normalizePhone(raw: string | null | undefined, country: string): string | null {
  const s = raw?.trim();
  if (!s || s.length > 40) return null;
  const n = parsePhoneNumberFromString(s, country.toUpperCase() as CountryCode);
  return n?.isValid() ? n.number : null;
}

/** The first valid phone number of a place, in E.164. */
export function firstValidPhone(raws: (string | null)[] | null | undefined, country: string): string | null {
  for (const r of raws ?? []) {
    const p = normalizePhone(r, country);
    if (p) return p;
  }
  return null;
}

const MAX_SOCIALS = 5;

/** Social profile links: https URLs only, without tracking parameters, no duplicates, at most 5. */
export function cleanSocials(raws: (string | null)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const r of raws ?? []) {
    const s = r?.trim();
    if (!s || s.length > 300) continue;
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    u.protocol = "https:";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|igshid|ref)/i.test(k)) u.searchParams.delete(k);
    const v = u.toString().replace(/\/$/, "");
    if (!out.includes(v)) out.push(v);
    if (out.length >= MAX_SOCIALS) break;
  }
  return out;
}
