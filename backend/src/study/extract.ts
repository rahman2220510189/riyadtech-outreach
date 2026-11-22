import { createHash } from "node:crypto";

/**
 * What a university page says about English proof and dates, read from its plain text.
 * Every value keeps the sentence it came from, so a person can check it in one look.
 */
export interface Extracted {
  /** IELTS overall scores mentioned (4.0-9.0). */
  ielts: { score: number; snippet: string }[];
  /** Sentences about the medium of instruction / English-medium degrees / exemptions. */
  moi: string[];
  /** Future dates next to an application word. */
  deadlines: { date: string; label: string; snippet: string }[];
  /** Admission-looking e-mail addresses. */
  emails: string[];
  /** The page mentions programmes taught in English. */
  englishTaught: boolean;
}

export const EMPTY: Extracted = { ielts: [], moi: [], deadlines: [], emails: [], englishTaught: false };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/** Collapses whitespace. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The sentence around position `at` (at most ~260 characters). */
function sentenceAround(text: string, at: number, len: number): string {
  let start = Math.max(0, at - 160);
  let end = Math.min(text.length, at + len + 160);
  const before = text.slice(start, at);
  const breaks = [...before.matchAll(/[.!?](?=\s)\s*|\n|•/g)];
  const last = breaks.at(-1);
  if (last?.index !== undefined) start += last.index + last[0].length;
  const after = text.slice(at + len, end);
  const stop = after.search(/[.!?](\s|$)|\n/);
  if (stop >= 0) end = at + len + stop + 1;
  return clean(text.slice(start, end)).slice(0, 300);
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/** Every date written in a common form, with its position. */
export function findDates(text: string): { date: string; index: number; length: number }[] {
  const out: { date: string; index: number; length: number }[] = [];
  const add = (date: string | null, m: RegExpExecArray) => {
    if (date) out.push({ date, index: m.index, length: m[0].length });
  };
  const patterns: [RegExp, (m: RegExpExecArray) => string | null][] = [
    // 15 January 2027, 15th of Jan. 2027
    [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\.?,?\\s+(20\\d{2})\\b`, "gi"), (m) => iso(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!)],
    // January 15, 2027
    [new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, "gi"), (m) => iso(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!)],
    // 2027-01-15
    [/\b(20\d{2})-(\d{2})-(\d{2})\b/g, (m) => iso(+m[1]!, +m[2]!, +m[3]!)],
    // 15.01.2027 and 15/01/2027 (day first, as in Europe)
    [/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/g, (m) => iso(+m[3]!, +m[2]!, +m[1]!)],
  ];
  for (const [re, toDate] of patterns) {
    for (let m = re.exec(text); m; m = re.exec(text)) add(toDate(m), m);
  }
  return out.sort((a, b) => a.index - b.index);
}

const DEADLINE_WORDS = /deadline|apply|application|closing date|closes|submission|submit|no later than|last date|admission round|enrol(l)?ment period|bewerbung|frist/i;
const OPEN_WORDS = /\bopens?\b|opening|starts?|from\b|begins?/i;

export function extractFacts(rawText: string, today: Date = new Date()): Extracted {
  const text = rawText.replace(/\u00a0/g, " ");
  const out: Extracted = { ielts: [], moi: [], deadlines: [], emails: [], englishTaught: false };

  // IELTS: the first score within 80 characters after the word.
  const ieltsRe = /\bIELTS\b/gi;
  const seenScores = new Set<number>();
  for (let m = ieltsRe.exec(text); m; m = ieltsRe.exec(text)) {
    const tail = text.slice(m.index + 5, m.index + 90);
    const s = /(?:^|[^\d.,])([4-9](?:[.,][05])?)(?![\d.,]*\d)/.exec(tail.replace(/\b(19|20)\d{2}\b/g, " "));
    if (!s) continue;
    const score = Number(s[1]!.replace(",", "."));
    if (score < 4 || score > 9 || seenScores.has(score)) continue;
    seenScores.add(score);
    out.ielts.push({ score, snippet: sentenceAround(text, m.index, 5) });
    if (out.ielts.length >= 6) break;
  }

  // Medium of instruction / English-medium degree / exemption from a test.
  const moiRe =
    /medium of (?:instruction|teaching)|language of instruction (?:was|is|has been) english|english[- ]medium|(?:previous|prior|bachelor'?s?|first|undergraduate) degree[^.\n]{0,80}(?:taught|completed|conducted|delivered) (?:entirely |fully |wholly )?in english|(?:taught|completed|conducted|delivered) (?:entirely |fully |wholly )?in english[^.\n]{0,60}(?:previous|prior|bachelor|degree)|exempt(?:ed|ion)?[^.\n]{0,80}(?:english|ielts|language test)/gi;
  const seenMoi = new Set<string>();
  for (let m = moiRe.exec(text); m; m = moiRe.exec(text)) {
    const s = sentenceAround(text, m.index, m[0].length);
    if (seenMoi.has(s)) continue;
    seenMoi.add(s);
    out.moi.push(s);
    if (out.moi.length >= 4) break;
  }

  out.englishTaught = /taught (?:entirely |fully )?in english|english[- ]taught|programmes? (?:taught )?in english|programs? (?:taught )?in english|study in english|language of instruction:? english/i.test(text);

  // Dates: future (up to 18 months) and next to an application word.
  const min = new Date(today.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
  const max = new Date(today.getTime() + 540 * 86_400_000).toISOString().slice(0, 10);
  const seenDates = new Set<string>();
  for (const d of findDates(text)) {
    if (d.date < min || d.date > max || seenDates.has(d.date)) continue;
    const sentence = sentenceAround(text, d.index, d.length);
    // The application word must be in the same sentence; course start dates are not deadlines.
    if (!DEADLINE_WORDS.test(sentence) && !/round|intake/i.test(sentence)) continue;
    if (/\b(classes|lectures|semester|programme|program|course|studies|teaching)\b[^.]{0,30}\b(start|starts|begin|begins|commence)/i.test(sentence) && !/apply|application|deadline/i.test(sentence)) continue;
    seenDates.add(d.date);
    const before = text.slice(Math.max(0, d.index - 120), d.index);
    const piece = clean(before.split(/[.!?]\s|\n|•/).at(-1) ?? "").replace(/[\s,:\-–(]+$/, "").replace(/\b(is|are|on|by|until|before)$/i, "").trim();
    const label = (piece.length >= 4 ? piece : OPEN_WORDS.test(sentence) ? "Application period" : "Application deadline").slice(0, 120);
    out.deadlines.push({ date: d.date, label, snippet: sentence });
    if (out.deadlines.length >= 8) break;
  }

  // Admission-looking addresses.
  const emailRe = /\b[a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
  const emails = new Set<string>();
  for (let m = emailRe.exec(text); m; m = emailRe.exec(text)) {
    const e = m[0].toLowerCase();
    if (/admission|international|apply|application|study|studies|enrol|master|graduate|recruit|incoming|degree/.test(e.split("@")[0]!) && !/\.(png|jpe?g|gif|svg|webp)$/.test(e)) emails.add(e);
  }
  out.emails = [...emails].slice(0, 3);
  return out;
}

/** True when there is anything worth showing. */
export function hasFacts(e: Extracted): boolean {
  return e.ielts.length > 0 || e.moi.length > 0 || e.deadlines.length > 0;
}

/** Stable signature of the facts (not the whole page): pages with rotating news do not count as changed. */
export function factSignature(e: Extracted): string {
  const key = JSON.stringify({
    i: e.ielts.map((x) => x.score).sort(),
    m: e.moi.map((x) => x.toLowerCase()).sort(),
    d: e.deadlines.map((x) => x.date).sort(),
    e: [...e.emails].sort(),
  });
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/** Merges the facts of several pages of one site. */
export function mergeFacts(list: Extracted[]): Extracted {
  const out: Extracted = { ielts: [], moi: [], deadlines: [], emails: [], englishTaught: false };
  for (const e of list) {
    for (const i of e.ielts) if (!out.ielts.some((x) => x.score === i.score)) out.ielts.push(i);
    for (const m of e.moi) if (!out.moi.includes(m)) out.moi.push(m);
    for (const d of e.deadlines) if (!out.deadlines.some((x) => x.date === d.date)) out.deadlines.push(d);
    for (const a of e.emails) if (!out.emails.includes(a)) out.emails.push(a);
    out.englishTaught ||= e.englishTaught;
  }
  out.deadlines.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}
