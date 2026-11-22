/**
 * Website URL -> domain we use as the business's identity ("smile-dental.co.uk").
 * Lower-case host without "www."; null when the URL is not a usable public website.
 */
export function websiteDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;
  // "mailto:", "tel:", "javascript:" etc. are not websites ("host:8080" is, so allow a port).
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) && !/^https?:\/\//i.test(text)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return null; // no IPs, no localhost
  if (!/^[a-z0-9.-]+$/.test(host)) return null; // punycode is fine, raw unicode is not expected
  host = host.replace(/^www\d?\./, "");
  return host;
}

/** Normalised website URL to store (https if no scheme, no fragment). */
export function normalizeWebsite(raw: string): string | null {
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** True when the domain is a platform (or a subdomain of one), not the business's own site. */
export function isPlatformDomain(domain: string, platforms: Iterable<string>): boolean {
  for (const p of platforms) {
    if (domain === p || domain.endsWith(`.${p}`)) return true;
  }
  return false;
}

/**
 * The first website of the list that is the business's own (not a platform).
 * Returns the normalised URL and its domain.
 */
export function pickOwnWebsite(
  websites: readonly (string | null | undefined)[] | null | undefined,
  platforms: readonly string[],
): { website: string; domain: string } | null {
  for (const w of websites ?? []) {
    const domain = websiteDomain(w);
    if (!domain || isPlatformDomain(domain, platforms)) continue;
    const website = normalizeWebsite(w ?? "");
    if (website) return { website, domain };
  }
  return null;
}
