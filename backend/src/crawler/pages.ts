import * as cheerio from "cheerio";

/** What a page is about, from its URL path and link text. */
export type PageKind =
  | "home"
  | "contact"
  | "careers"
  | "about"
  | "team"
  | "services"
  | "work"
  | "faq"
  | "booking"
  | "locations"
  | "legal";

/**
 * Checked in this order; the first that matches wins. A whole path part, then the link text.
 * Words in English, German, Dutch, French and Polish; paths and texts are compared without
 * accents ("über-uns" = "uber-uns", "carrières" = "carrieres", "zespół" = "zespol").
 */
const EXT = String.raw`(\.(html?|php|aspx?))?`;
const rule = (kind: Exclude<PageKind, "home">, path: string, text: string) => ({
  kind,
  path: new RegExp(`^(${path})${EXT}$`, "i"),
  text: new RegExp(`\\b(${text})\\b`, "i"),
});
const KIND_RULES: { kind: Exclude<PageKind, "home">; path: RegExp; text: RegExp }[] = [
  rule(
    "careers",
    [
      "careers?|jobs?|vacanc(y|ies)|hiring|join-?(us|the-?team|our-?team)|work-?with-?us|recruitment|opportunities",
      "karriere|stellenangebote|stellen|offene-?stellen|jobs-?und-?karriere|wir-?stellen-?ein",
      "vacatures?|werken-?bij(-?[a-z0-9-]+)?|carriere|banen|solliciteren",
      "carrieres?|recrutement|emplois?|nous-?rejoindre|rejoignez-?nous|offres?-?d-?emploi",
      "kariera|praca|oferty-?pracy|dolacz-?do-?nas",
    ].join("|"),
    [
      "careers?|jobs|vacancies|we'?re hiring|join (us|our team|the team)|work with us",
      "karriere|stellenangebote|offene stellen|jobs & karriere",
      "vacatures|werken bij|werkenbij|carriere",
      "carrieres?|recrutement|nous rejoindre|rejoignez-nous|emplois?",
      "kariera|praca|dolacz do nas",
    ].join("|"),
  ),
  rule(
    "contact",
    "contact(-?us)?|get-?in-?touch|enquir(y|e|ies)|inquir(y|e|ies)|find-?us|reach-?us|kontakt|kontaktformular|contactez-?nous|nous-?contacter",
    "contact( us)?|get in touch|enquir(e|ies|y)|inquir(e|ies|y)|find us|kontakt|contactez-nous|nous contacter",
  ),
  rule(
    "team",
    "team|our-?team|people|our-?people|staff|meet-?(the-?team|us|our-?team)|leadership|dentists|doctors|clinicians|lawyers|solicitors|attorneys|unser-?team|mitarbeiter|ons-?team|equipe|notre-?equipe|zespol|nasz-?zespol",
    "our team|the team|meet (the|our) team|our people|team|staff|leadership|ons team|equipe|notre equipe|zespol",
  ),
  rule(
    "about",
    "about(-?us)?|who-?we-?are|our-?story|company|the-?practice|our-?practice|ueber-?uns|uber-?uns|unternehmen|over-?ons|a-?propos|qui-?sommes-?nous|o-?nas",
    "about( us)?|who we are|our story|uber uns|over ons|a propos|qui sommes-nous|o nas",
  ),
  rule(
    "services",
    "services?|what-?we-?do|solutions|expertise|capabilities|treatments?|practice-?areas|offering|products|leistungen|dienstleistungen|angebot|diensten|prestations|nos-?services|uslugi|oferta",
    "services|what we do|solutions|expertise|capabilities|treatments|practice areas|leistungen|diensten|prestations|uslugi",
  ),
  rule(
    "work",
    "work|our-?work|portfolio|case-?stud(y|ies)|projects|clients|showcase|referenzen|projekte|kunden|projecten|cases|realisations|references|projets|realizacje|projekty",
    "our work|work|portfolio|case stud(y|ies)|projects|clients|referenzen|projekte|projecten|realisations|references|realizacje",
  ),
  rule("faq", "faqs?|frequently-?asked-?questions|questions|help|veelgestelde-?vragen|pytania", "faqs?|frequently asked questions|veelgestelde vragen"),
  rule(
    "booking",
    "book(ing|-?now|-?online|-?an-?appointment)?|appointments?|reservations?|schedule|termin|afspraak|rendez-?vous|rezerwacja",
    "book (now|online|an appointment|a consultation)|appointments?|reservations?|termin|afspraak maken|rendez-vous",
  ),
  rule(
    "locations",
    "locations?|branches|offices|our-?clinics|our-?practices|stores|standorte|vestigingen|agences|oddzialy",
    "our locations|locations|branches|our offices|our clinics|our practices|standorte|vestigingen",
  ),
  rule(
    "legal",
    "imprint|impressum|legal(-?notice)?|privacy(-?policy)?|terms(-?(and|&)-?conditions|-?of-?(use|service))?|cookie-?policy|datenschutz(erklaerung)?|agb|colofon|algemene-?voorwaarden|mentions-?legales|politique-?de-?confidentialite|cgv|polityka-?prywatnosci|regulamin",
    "imprint|impressum|legal notice|privacy( policy)?|terms( and conditions| of (use|service))?|datenschutz|mentions legales",
  ),
];

/** Lower case, accents removed ("Über uns" -> "uber uns", "Zespół" -> "zespol"). */
export function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Which page kinds to read for a segment, most useful first. */
export const KIND_ORDER: Record<"A" | "B", Exclude<PageKind, "home">[]> = {
  A: ["contact", "careers", "about", "team", "services", "work", "legal", "faq"],
  // Careers too: businesses hiring developers are shown under "Hiring developers" (job applications).
  B: ["contact", "about", "services", "careers", "faq", "booking", "locations", "team", "legal"],
};

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|rar|docx?|xlsx?|pptx?|mp[34]|mov|avi|wav|css|js|json|xml|rss|txt)$/i;

/** "www.x.com" and "x.com" are the same site; so are subdomains of the lead's domain. */
export function sameSite(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\d?\./, "");
  return h === domain || h.endsWith(`.${domain}`);
}

export function classifyUrl(url: URL, text = ""): Exclude<PageKind, "home"> | null {
  let path: string;
  try {
    path = plain(decodeURIComponent(url.pathname));
  } catch {
    path = plain(url.pathname);
  }
  if (path === "/" || path === "") return null;
  // A whole path part must be the word ("/contact-us", "/en/careers/"), so blog slugs that
  // merely contain it ("/blog/how-we-work-with-clients") do not count.
  const parts = path.split("/").filter(Boolean).slice(0, 3);
  for (const r of KIND_RULES) if (parts.some((part) => r.path.test(part))) return r.kind;
  // Link text: only a short menu label that is just the word ("Contact us", "Careers ›").
  const t = plain(text).replace(/\s+/g, " ").trim();
  if (t && t.length <= 30) {
    for (const r of KIND_RULES) if (new RegExp(`^(?:${r.text.source})\\s*[›»>→]?$`, "i").test(t)) return r.kind;
  }
  return null;
}

export interface FoundLink {
  url: string;
  kind: Exclude<PageKind, "home">;
}

/** Same-site links of a page that look like one of the page kinds (best one per kind: shortest path). */
export function findLinks(html: string, pageUrl: string, domain: string): FoundLink[] {
  const $ = cheerio.load(html);
  const best = new Map<string, URL>();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data|sms|whatsapp):/i.test(href)) return;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (!sameSite(url.hostname, domain) || SKIP_EXT.test(url.pathname)) return;
    url.hash = "";
    const kind = classifyUrl(url, $(el).text());
    if (!kind) return;
    const prev = best.get(kind);
    if (!prev || url.pathname.length < prev.pathname.length) best.set(kind, url);
  });
  return [...best.entries()].map(([kind, url]) => ({ kind: kind as FoundLink["kind"], url: url.toString() }));
}

/** <loc> URLs of a sitemap (or sitemap index). */
export function sitemapLocs(xml: string): { urls: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && urls.length < 1000) urls.push(m[1]!.replace(/&amp;/g, "&"));
  return { urls, isIndex };
}

/** Visible text of a page (no scripts, styles or hidden templates), whitespace collapsed. */
export function pageText($: cheerio.CheerioAPI): string {
  const body = $("body").length ? $("body").clone() : $("html").clone();
  body.find("script, style, noscript, template, svg, iframe").remove();
  // Keep words apart where block elements end.
  body
    .find("br, p, div, li, h1, h2, h3, h4, h5, h6, td, th, section, article, header, footer, address, nav, a, button, label, dt, dd, option")
    .after(" ");
  return body.text().replace(/\s+/g, " ").trim();
}
