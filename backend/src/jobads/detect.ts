import { stackWords } from "../crawler/analyze.js";
import { isDeveloperRole, loadSignalRules } from "../crawler/signals.js";

/**
 * Reading job adverts from job APIs: is it a developer job, which flags apply
 * (remote, visa, English), does it match our stack, which company is it.
 */

/** Developer titles the hiring_dev rule may miss (Java, .NET, C#, Go… and German compounds). */
const EXTRA_DEV = [
  /\b(?:software|web|front[- ]?end|back[- ]?end|full[- ]?stack|java|\.net|c#|c\+\+|golang|go|rust|scala|kotlin|swift|python|php|ruby|node(?:\.js)?|react(?:\.js)?|angular|vue(?:\.js)?|javascript|typescript|mobile|ios|android|cloud|platform|devops|app|frontend|backend|ki|ai|ml|data)[- ]?(?:developer|engineer|entwickler(?:in)?|programmierer(?:in)?)\b/i,
  /(?:software|web|anwendungs|applikations|frontend|backend|fullstack|app)entwickler/i,
  /\bfachinformatiker(?:in)?\b.{0,30}anwendungsentwicklung/i,
  /\b(?:developer|entwickler(?:in)?|programmierer(?:in)?)\b/i,
];

/** Titles that contain "developer"/"Entwickler" but are not software jobs. */
const NOT_DEV = /\b(?:business developer|business development|sales developer|developer relations manager|property developer|immobilien|projektentwickler|produktentwickler|personalentwickler|organisationsentwickler|verpackungsentwickl|lebensmittel|chemie|elektronikentwickler|hardwareentwickler|hardware[- ]entwickler|konstrukteur|maschinenbau|fahrzeug|mechanik|textil|rezeptur|pharma)/i;

export function isDevTitle(title: string): boolean {
  if (NOT_DEV.test(title)) return false;
  return isDeveloperRole(title) || EXTRA_DEV.some((re) => re.test(title));
}

/** The title without gender tags and noise, used as the role ("Senior React Developer"). */
export function roleOf(title: string): string {
  return title
    .replace(/\((?:m|w|d|f|x|h|v|k|div|all genders?|alle|gn\*?|w\/m\/d|m\/w\/d|m\/f\/d|f\/m\/d|m\/f\/x)[^)]{0,15}\)/gi, "")
    .replace(/\s*[|–—-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const FLAG_RULES: Record<string, string> = {
  remote: "job_remote",
  visa: "job_visa",
  english_team: "job_english",
  local_lang: "job_local_lang",
};

const GERMAN_WORDS = /\b(und|wir|die|der|das|mit|für|fuer|sie|dich|deine|ihre|bei|eine?n?|auf|von|zu|ist|oder|unser|unsere)\b/gi;
const ENGLISH_WORDS = /\b(and|the|with|you|your|our|we|for|are|will|to|of|is|or|in|as|this)\b/gi;

/** True when the advert itself is written in English (a good sign for a non-German speaker). */
export function writtenInEnglish(text: string): boolean {
  const sample = text.slice(0, 4000);
  const en = sample.match(ENGLISH_WORDS)?.length ?? 0;
  const de = sample.match(GERMAN_WORDS)?.length ?? 0;
  return en >= 15 && en > de * 2;
}

/** remote, visa, english_team, ad_english, local_lang (same patterns as on websites). */
export function flagsOf(text: string, apiRemote = false): string[] {
  const rules = loadSignalRules();
  const flags = new Set<string>();
  if (apiRemote) flags.add("remote");
  for (const [flag, key] of Object.entries(FLAG_RULES)) {
    const r = rules.rules.find((x) => x.key === key);
    if (r && r.type === "match" && r.patterns.some((p) => rules.regex.get(p)!.test(text))) flags.add(flag);
  }
  if (writtenInEnglish(text)) flags.add("ad_english");
  return [...flags].sort();
}

/** The advert mentions our stack (React, Node.js, TypeScript, Next.js…). */
export function stackMatch(text: string): boolean {
  const t = ` ${text.toLowerCase()} `;
  return stackWords().some((w) => {
    const word = w.trim();
    if (word.length < 3) return false;
    const i = t.indexOf(word);
    if (i < 0) return false;
    const before = t[i - 1] ?? " ";
    const after = t[i + word.length] ?? " ";
    return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
  });
}

const LEGAL_FORMS =
  /\b(gmbh\s*&\s*co\.?\s*kgaa|gmbh\s*&\s*co\.?\s*kg|gmbh\s*&\s*co|ug\s*\(haftungsbeschr(?:ä|a)nkt\)|gmbh|mbh|ag|se|kgaa|kg|ohg|gbr|e\.\s?k\.|e\.\s?v\.|ug|ltd\.?|limited|llc|inc\.?|plc|corp\.?|b\.v\.|bv|n\.v\.|nv|s\.a\.r\.l\.|sarl|sas|s\.a\.|sa|sp\.\s?z\s?o\.\s?o\.|co\.?)(?=\s|$|,)/gi;

/** "ACME Software GmbH & Co. KG" -> "acme software". */
export function companyKey(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ß/g, "ss")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(LEGAL_FORMS, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || name.toLowerCase().trim()
  );
}

/** HTML from an API description -> plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
