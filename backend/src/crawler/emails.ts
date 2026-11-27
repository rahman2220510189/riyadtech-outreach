import * as cheerio from "cheerio";
import { isFirstName, titleCase } from "./names.js";

/** An address seen on a page, with the text around it (proof and first-name source). */
export interface SeenEmail {
  email: string;
  sourceUrl: string;
  context: string;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}/gi;
const VALID_RE = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;

/** Turns "name [at] site (dot) com" and similar into a normal address. */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|<\s*at\s*>|\s+at\s+(?=[a-z0-9-]+\s*(?:\[|\(|\{|<)\s*dot))\s*/gi, "@")
    .replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|<\s*dot\s*>)\s*/gi, ".")
    .replace(/\s*\[\s*@\s*\]\s*/g, "@");
}

/** Cloudflare's e-mail protection: hex string, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

export function normalizeEmail(raw: string): string | null {
  let e = raw.trim().toLowerCase();
  try {
    e = decodeURIComponent(e);
  } catch {
    // keep as is
  }
  e = e.replace(/^mailto:/, "").split("?")[0]!.trim().replace(/^[<("'\s]+|[>)"'.,;:\s]+$/g, "");
  return VALID_RE.test(e) && !e.includes("..") ? e : null;
}

const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "domain.com", "yourdomain.com", "yoursite.com", "mydomain.com",
  "website.com", "yourwebsite.com", "company.com", "yourcompany.com", "test.com", "sample.com", "site.com",
  "mysite.com", "email.com", "address.com", "domain.co.uk", "yourdomain.co.uk", "example.co.uk", "sentry.io",
]);
/** Builders, CDNs, trackers and error reporters whose addresses appear in page code. */
const SERVICE_DOMAIN_SUFFIXES = [
  "sentry.io", "wixpress.com", "sentry-next.wixpress.com", "cloudflare.com", "amazonaws.com", "googleusercontent.com",
  "gstatic.com", "w3.org", "schema.org", "godaddy.com", "squarespace.com", "shopify.com", "webflow.io", "wordpress.com",
  "wordpress.org", "mailchimp.com", "list-manage.com", "sendgrid.net", "hubspot.com", "hs-sites.com", "wix.com",
  "jquery.com", "github.com", "gravatar.com", "fontawesome.com", "typekit.net",
];
const PLACEHOLDER_LOCALS = new Set([
  "your", "youremail", "your.email", "your-email", "yourname", "your.name", "name", "email", "e-mail", "user", "username",
  "someone", "john.doe", "jane.doe", "johndoe", "janedoe", "johnsmith", "john.smith", "firstname", "first.last",
  "firstname.lastname", "test", "example", "me", "you", "abc", "xyz",
]);
const NO_REPLY = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?)([._+-]|$)/;

/** True for addresses that are not a business's contact address. */
export function isJunkEmail(email: string): boolean {
  const [local = "", domain = ""] = email.split("@");
  if (/\.(png|jpe?g|gif|svg|webp|ico|bmp|avif|css|js)$/.test(domain) || /@\dx\./.test(email)) return true;
  if (PLACEHOLDER_DOMAINS.has(domain) || PLACEHOLDER_LOCALS.has(local)) return true;
  if (SERVICE_DOMAIN_SUFFIXES.some((s) => domain === s || domain.endsWith(`.${s}`))) return true;
  if (NO_REPLY.test(local)) return true;
  if (/^[0-9a-f]{16,}$/.test(local)) return true; // hashes (error reporters)
  if (local.length > 40) return true;
  return false;
}

function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function walkJson(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const v of value) walkJson(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.toLowerCase() === "email" && typeof v === "string") out.push(v);
      else walkJson(v, out, depth + 1);
    }
  }
}

/**
 * Every public address on a page: mailto links, Cloudflare-protected addresses,
 * JSON-LD "email", and addresses in the visible text (also "[at]"/"(dot)" forms).
 * Junk (image names, placeholders, service addresses) is dropped.
 */
export function extractEmails(html: string, text: string, pageUrl: string): SeenEmail[] {
  const $ = cheerio.load(html);
  const found = new Map<string, SeenEmail>();
  const add = (raw: string, context: string) => {
    const email = normalizeEmail(raw);
    if (!email || isJunkEmail(email) || found.has(email)) return;
    found.set(email, { email, sourceUrl: pageUrl, context: context.replace(/\s+/g, " ").trim().slice(0, 200) });
  };

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (/^mailto:/i.test(href)) {
      const ctx = $(el).parent().text() || $(el).text();
      for (const part of href.replace(/^mailto:/i, "").split("?")[0]!.split(/[,;]/)) add(part, ctx);
    }
    const cf = /\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/i.exec(href);
    if (cf?.[1]) {
      const decoded = decodeCfEmail(cf[1]);
      if (decoded) add(decoded, $(el).parent().text());
    }
  });
  $("[data-cfemail]").each((_, el) => {
    const decoded = decodeCfEmail($(el).attr("data-cfemail") ?? "");
    if (decoded) add(decoded, $(el).parent().text());
  });
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const list: string[] = [];
      walkJson(JSON.parse($(el).text()), list);
      for (const e of list) add(e, "Listed in the page's structured data (JSON-LD)");
    } catch {
      // broken JSON-LD is common; ignore it
    }
  });
  const plain = deobfuscate(text);
  for (const m of plain.matchAll(EMAIL_RE)) add(m[0], contextAround(plain, m.index, m[0].length));
  return [...found.values()];
}

/* ------------------------------ classification ------------------------------ */

const FREE_MAIL = [
  /^(gmail|googlemail|hotmail|outlook|live|msn|aol|icloud|me|mac|yahoo|ymail|protonmail|proton|gmx|yandex|mail|zoho|fastmail|tutanota|hey)\.[a-z.]+$/,
  /^(btinternet|btopenworld|sky|virginmedia|ntlworld|talktalk|tiscali|blueyonder|eircom|iol|bigpond|optusnet|iinet|tpg|internode|comcast|verizon|att|sbcglobal|cox|charter|earthlink|bellsouth|rocketmail)\.[a-z.]+$/,
];

export function isFreeMail(domain: string): boolean {
  return FREE_MAIL.some((re) => re.test(domain));
}

/** Addresses for departments that must not get sales e-mails (privacy, careers, invoices…). */
const ROLE_LOCALS = /^(privacy|gdpr|dpo|data-?protection|dataprotection|legal|compliance|abuse|webmaster|hostmaster|careers?|jobs?|recruit(ment|ing)?|hr|cv|vacancies|bewerbung(en)?|karriere|talent|people|personal|vacatures?|werkenbij|sollicitaties?|sollicitatie|recrutement|rh|emplois?|candidatures?|rekrutacja|kariera|praca|press|media|pr|invoices?|billing|accounts-?payable|payments?|payroll|unsubscribe|complaints?|safeguarding|security|it|ict|helpdesk|servicedesk|feedback|newsletter|marketing-?optout|accessibility|ada|disability|franchis(e|ing)|investors?|ir|ethics|whistleblow(ing|er)?|fraud|procurement|purchasing|suppliers?|vendors?|donations?|sponsorships?)$/;
const GENERIC_LOCALS = /^(info|information|hello|hi|hey|hallo|kontakt|anfrage|buero|post|mail|bonjour|accueil|biuro|sekretariat|contact|contactus|enquiries|enquiry|inquiries|inquiry|office|admin|administration|studio|team|mail|email|reception|frontdesk|front-?desk|bookings?|appointments?|reservations?|sales|support|help|accounts|general|newbusiness|new-?business|business|projects|work|design|web|dev|digital|partners?|partnerships?|agency|creative|hq|practice|clinic|surgery|dental|smile|vets?|law|lawyers|legal-?team|lettings|sales-?team|property|properties|homes|hotel|stay|frontoffice|school|tutors?|insurance|quotes?|service|services|customerservice|customer-?service|care|ops|operations|manager|management)$/;

export interface ClassifiedEmail extends SeenEmail {
  domain: string;
  kind: "generic" | "named" | "role";
  domainMatch: "own" | "free" | "other";
  firstName: string | null;
}

/** Is the address on the business's own domain (or a subdomain / parent of it)? */
function matchDomain(emailDomain: string, siteDomain: string): ClassifiedEmail["domainMatch"] {
  if (emailDomain === siteDomain || emailDomain.endsWith(`.${siteDomain}`) || siteDomain.endsWith(`.${emailDomain}`)) return "own";
  return isFreeMail(emailDomain) ? "free" : "other";
}

/** A first name from the address itself ("john@", "john.smith@") or from "John Smith - jsmith@" next to it. */
export function firstNameFor(local: string, context: string): string | null {
  const tokens = local.split(/[._-]+/).filter(Boolean);
  const first = tokens[0];
  if (first && /^[a-z]{2,}$/.test(first) && isFirstName(first) && !GENERIC_LOCALS.test(first) && !ROLE_LOCALS.test(first)) {
    return titleCase(first);
  }
  // "Sarah Jones ... sjones@" or "Sarah Jones ... sarah.j@": the name must belong to this address.
  const re = /\b([A-Z][a-z]{1,15})(?=\s+([A-Z][a-z'’-]{1,24})\b)/g;
  for (const m of context.matchAll(re)) {
    const given = m[1]!.toLowerCase();
    const family = m[2]!.toLowerCase().replace(/[^a-z]/g, "");
    if (!isFirstName(given) || family.length < 2) continue;
    const flat = local.replace(/[^a-z]/g, "");
    if (flat.includes(family) || flat === `${given[0]}${family}` || flat.startsWith(given)) return titleCase(given);
  }
  return null;
}

export function classifyEmail(seen: SeenEmail, siteDomain: string): ClassifiedEmail {
  const [local = "", domain = ""] = seen.email.split("@");
  const head = local.split(/[._+-]/)[0] ?? local;
  let kind: ClassifiedEmail["kind"];
  if (ROLE_LOCALS.test(local) || ROLE_LOCALS.test(head)) kind = "role";
  else if (GENERIC_LOCALS.test(local) || GENERIC_LOCALS.test(head)) kind = "generic";
  else kind = "named";
  return {
    ...seen,
    domain,
    kind,
    domainMatch: matchDomain(domain, siteDomain),
    firstName: kind === "named" ? firstNameFor(local, seen.context) : null,
  };
}

const FOUNDER = /\b(founder|co-?founder|owner|director|managing director|ceo|principal|partner|head of studio|creative director)\b/i;
const GENERIC_RANK = ["hello", "info", "enquiries", "enquiry", "contact", "office", "studio", "team", "reception", "bookings"];

/**
 * The address a campaign would use, or null.
 * Segment B: own-domain generic first. Segment A: a named founder, then hello@.
 * Countries with "generic only" rules (UK, Ireland) never get a named address as primary.
 * Addresses without MX (mxValid === false) and department addresses are never primary.
 */
export function pickPrimary(
  emails: (ClassifiedEmail & { mxValid: boolean | null })[],
  segment: "A" | "B",
  genericOnly: boolean,
): ClassifiedEmail | null {
  const usable = emails.filter((e) => e.kind !== "role" && e.mxValid !== false && (!genericOnly || e.kind === "generic"));
  if (usable.length === 0) return null;
  const local = (e: ClassifiedEmail) => e.email.split("@")[0] ?? "";
  const genericRank = (e: ClassifiedEmail) => {
    const i = GENERIC_RANK.indexOf(local(e).split(/[._+-]/)[0] ?? "");
    return i === -1 ? GENERIC_RANK.length : i;
  };
  const domainRank = { own: 0, other: 1, free: 2 } as const;
  const score = (e: ClassifiedEmail): number[] => {
    if (segment === "A") {
      const founder = e.kind === "named" && FOUNDER.test(e.context) ? 0 : 1;
      const hello = local(e) === "hello" ? 0 : 1;
      return [domainRank[e.domainMatch], founder, hello, e.kind === "named" ? 0 : 1, genericRank(e)];
    }
    return [domainRank[e.domainMatch], e.kind === "generic" ? 0 : 1, genericRank(e)];
  };
  const sorted = [...usable].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i]! - sb[i]!;
    return a.email.localeCompare(b.email);
  });
  return sorted[0] ?? null;
}
