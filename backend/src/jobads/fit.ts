/**
 * Does a job advert suit me? Rule-based and explainable, like the study subject fit:
 * - seniority from the title (senior / lead / principal … vs junior / entry level / graduate),
 *   student jobs (Werkstudent, internship, Ausbildung) kept apart: they need a German enrolment or German;
 * - years of experience asked for in the text ("at least 5 years", "mind. 3 Jahre Berufserfahrung");
 * - German required (the advert is in German or asks for fluent German) against my level;
 * - the technologies the advert names, against my skills (matched and missing).
 * Only the title and the stored description (first 3,000 characters) are read.
 */

export const TECH: { name: string; re: RegExp }[] = [
  { name: "JavaScript", re: /\bjavascript\b|\bjs\b|\becmascript\b/i },
  { name: "TypeScript", re: /\btypescript\b/i },
  { name: "React", re: /\breact(?:\.?js)?\b(?!\s*native)/i },
  { name: "React Native", re: /\breact\s*native\b/i },
  { name: "Next.js", re: /\bnext\.?js\b/i },
  { name: "Vue", re: /\bvue(?:\.?js)?\b|\bnuxt/i },
  { name: "Angular", re: /\bangular(?:js)?\b/i },
  { name: "Svelte", re: /\bsvelte(?:kit)?\b/i },
  { name: "Node.js", re: /\bnode(?:\.?js)?\b/i },
  { name: "Express", re: /\bexpress(?:\.?js)?\b/i },
  { name: "NestJS", re: /\bnest\.?js\b/i },
  { name: "Fastify", re: /\bfastify\b/i },
  { name: "Python", re: /\bpython\b/i },
  { name: "Django", re: /\bdjango\b/i },
  { name: "FastAPI", re: /\bfastapi\b/i },
  { name: "Flask", re: /\bflask\b/i },
  { name: "Java", re: /\bjava\b(?!\s*script)/i },
  { name: "Spring", re: /\bspring(?:\s*boot)?\b/i },
  { name: "Kotlin", re: /\bkotlin\b/i },
  { name: "C#/.NET", re: /\bc#|\.net\b|\basp\.net\b|\bdotnet\b/i },
  { name: "C++", re: /\bc\+\+/i },
  { name: "Go", re: /\bgolang\b|\bgo\s+(?:developer|entwickler|engineer)\b|\b(?:in|mit|with)\s+go\b/i },
  { name: "Rust", re: /\brust\b/i },
  { name: "PHP", re: /\bphp\b/i },
  { name: "Laravel", re: /\blaravel\b/i },
  { name: "Symfony", re: /\bsymfony\b/i },
  { name: "Ruby", re: /\bruby\b|\brails\b/i },
  { name: "Swift", re: /\bswift\b/i },
  { name: "Flutter", re: /\bflutter\b|\bdart\b/i },
  { name: "SAP/ABAP", re: /\babap\b|\bsap\b/i },
  { name: "HTML/CSS", re: /\bhtml5?\b|\bcss3?\b|\bscss\b|\bsass\b/i },
  { name: "Tailwind", re: /\btailwind/i },
  { name: "REST APIs", re: /\brest(?:ful)?\b|\bapis?\b/i },
  { name: "GraphQL", re: /\bgraphql\b/i },
  { name: "PostgreSQL", re: /\bpostgres(?:ql)?\b/i },
  { name: "MySQL", re: /\bmysql\b|\bmariadb\b/i },
  { name: "MongoDB", re: /\bmongo(?:db)?\b/i },
  { name: "SQL", re: /\bsql\b/i },
  { name: "Redis", re: /\bredis\b/i },
  { name: "Prisma", re: /\bprisma\b/i },
  { name: "Docker", re: /\bdocker\b|\bcontainer/i },
  { name: "Kubernetes", re: /\bkubernetes\b|\bk8s\b/i },
  { name: "AWS", re: /\baws\b|\bamazon web services\b/i },
  { name: "Azure", re: /\bazure\b/i },
  { name: "GCP", re: /\bgcp\b|\bgoogle cloud\b/i },
  { name: "Terraform", re: /\bterraform\b/i },
  { name: "CI/CD", re: /\bci\/cd\b|\bgithub actions\b|\bgitlab ci\b|\bjenkins\b/i },
  { name: "Git", re: /\bgit\b(?!lab ci)/i },
  { name: "Linux", re: /\blinux\b/i },
  { name: "Testing", re: /\bjest\b|\bvitest\b|\bplaywright\b|\bcypress\b|\bunit tests?\b|\btdd\b/i },
  { name: "Machine learning", re: /\bmachine learning\b|\bdeep learning\b|\bpytorch\b|\btensorflow\b|\bscikit/i },
  { name: "LLMs / AI", re: /\bllms?\b|\bgenai\b|\bgenerative ai\b|\bopenai\b|\blangchain\b|\brag\b|\bchatgpt\b|\bkünstliche intelligenz\b/i },
  { name: "NLP", re: /\bnlp\b|\bnatural language\b|\btransformers?\b|\bbert\b/i },
];

export function techIn(text: string): string[] {
  return TECH.filter((t) => t.re.test(text)).map((t) => t.name);
}

export type Seniority = "student" | "junior" | "senior" | "open";

const SENIOR = /\b(senior|sr\.?|lead|leading|principal|staff|head of|architect|architekt(?:in)?|teamlead|team lead|tech lead|leiter(?:in)?|leitung|director|manager|expert(?:e|in)?|cto)\b/i;
const STUDENT = /\b(werkstudent(?:in)?|working student|praktikum|praktikant(?:in)?|pflichtpraktikum|intern|internship|ausbildung|auszubildende|azubi|duales? studium|dual(?:es)? student|abschlussarbeit|masterarbeit|bachelorarbeit|thesis|minijob|aushilfe)\b/i;
const JUNIOR = /\b(junior|jr\.?|entry[- ]level|graduate|berufseinsteiger(?:in)?|einsteiger(?:in)?|absolvent(?:in)?|young professional|trainee|associate|nachwuchs)\b/i;
/** Junior-friendly words in the text even when the title says nothing. */
const JUNIOR_TEXT = /\b(berufseinsteiger(?:innen)?|erste berufserfahrung|first (?:professional|work) experience|entry[- ]level|recent graduates?|junior|career starters?|no experience required|keine berufserfahrung)\b/i;

export function seniorityOf(title: string, text: string): Seniority {
  if (STUDENT.test(title)) return "student";
  if (JUNIOR.test(title)) return "junior";
  if (SENIOR.test(title)) return "senior";
  if (JUNIOR_TEXT.test(text)) return "junior";
  return "open";
}

const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10, ein: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, zehn: 10, mehrjährige: 3, mehrjaehrige: 3, several: 3, mehreren: 3 };

/** The smallest number of years of experience the advert asks for, or null. */
export function minYears(text: string): number | null {
  const found: number[] = [];
  const word = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|ten|ein|einem|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|zehn|several|mehreren)";
  const res = [
    new RegExp(`${word}\\s*(?:\\+|-\\s*\\d+|bis\\s*\\d+|to\\s*\\d+|or more)?\\s*(?:years?|yrs?|jahre?n?)\\b[^.\\n]{0,50}?(?:experience|erfahrung|berufserfahrung)`, "gi"),
    new RegExp(`(?:experience|erfahrung)[^.\\n]{0,20}?(?:of|von)?\\s*(?:at least|min(?:imum|destens|\\.)?)?\\s*${word}\\s*\\+?\\s*(?:years?|jahre?n?)`, "gi"),
    /\b(mehrjährige|mehrjaehrige)\s+(?:berufs)?erfahrung/gi,
  ];
  for (const re of res) {
    for (const m of text.matchAll(re)) {
      const raw = m[1]!.toLowerCase();
      const n = /^\d+$/.test(raw) ? Number(raw) : (NUM[raw] ?? null);
      if (n !== null && n >= 1 && n <= 15) found.push(n);
    }
  }
  return found.length ? Math.min(...found) : null;
}

export const GERMAN_LEVELS = ["none", "a1", "a2", "b1", "b2", "c1", "c2"] as const;
export type GermanLevel = (typeof GERMAN_LEVELS)[number];

/** How much German the advert needs: fluent (C1+), good (B2), some, or none said. */
export function germanNeeded(text: string, flags: string[]): "fluent" | "good" | "some" | "none" {
  if (/\b(verhandlungssicher|fließend|fliessend|muttersprach|c1|c2|fluent (?:in )?german|german (?:at )?(?:native|c1|c2)|native german|business[- ]fluent german)\b/i.test(text) && /deutsch|german/i.test(text)) return "fluent";
  if (/\b(sehr gute|gute) deutschkenntnisse|\bb2\b[^.\n]{0,20}(deutsch|german)|(deutsch|german)[^.\n]{0,20}\bb2\b|good german|very good german/i.test(text)) return "good";
  if (flags.includes("local_lang")) return flags.includes("ad_english") || flags.includes("english_team") ? "some" : "good";
  if (!flags.includes("ad_english") && !flags.includes("english_team")) return "good";
  return /\bdeutsch|german\b/i.test(text) ? "some" : "none";
}

export interface JobProfile {
  skills: string[];
  yearsExperience: number;
  germanLevel: GermanLevel;
}

export interface JobFit {
  /** good: apply; possible: worth a look; unlikely: needs much more than I have. */
  level: "good" | "possible" | "unlikely";
  score: number;
  seniority: Seniority;
  years: number | null;
  german: "fluent" | "good" | "some" | "none";
  matched: string[];
  missing: string[];
  reasons: string[];
  warnings: string[];
}

const GERMAN_RANK: Record<GermanLevel, number> = { none: 0, a1: 1, a2: 2, b1: 3, b2: 4, c1: 5, c2: 6 };

export function jobFit(ad: { title: string; description: string | null; tags: string[]; flags: string[] }, me: JobProfile): JobFit {
  const text = `${ad.title}\n${ad.tags.join(", ")}\n${ad.description ?? ""}`;
  const seniority = seniorityOf(ad.title, ad.description ?? "");
  const years = minYears(text);
  const german = germanNeeded(text, ad.flags);
  const mine = new Set(me.skills.map((s) => s.toLowerCase()));
  // REST/Git/HTML are named in almost every advert; they count when I have them, but are not "missing".
  const common = new Set(["REST APIs", "Git", "HTML/CSS", "SQL", "Linux", "Testing"]);
  const named = techIn(text);
  const matched = named.filter((t) => mine.has(t.toLowerCase()));
  const missing = named.filter((t) => !mine.has(t.toLowerCase()) && !common.has(t));
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  if (seniority === "junior") {
    score += 3;
    reasons.push("Junior / entry-level role.");
  } else if (seniority === "senior") {
    score -= 4;
    warnings.push("Senior or lead role.");
  } else if (seniority === "student") {
    score -= 4;
    warnings.push("Student job, internship or apprenticeship (usually needs enrolment in Germany or German).");
  }

  if (years !== null) {
    if (years <= me.yearsExperience + 1) {
      score += 1;
      reasons.push(`Asks for ${years} year${years === 1 ? "" : "s"} of experience.`);
    } else {
      score -= years - me.yearsExperience >= 3 ? 3 : 2;
      warnings.push(`Asks for at least ${years} years of experience.`);
    }
  } else if (seniority === "open") score += 1;

  const myGerman = GERMAN_RANK[me.germanLevel];
  if (german === "fluent" && myGerman < 5) {
    score -= 3;
    warnings.push("Needs fluent German (C1 or better).");
  } else if (german === "good" && myGerman < 4) {
    score -= 2;
    warnings.push("Advert in German or asks for good German.");
  } else if (german === "none" || german === "some") {
    score += 1;
    reasons.push("English is enough to apply.");
  }

  if (named.length > 0) {
    const ratio = matched.length / Math.max(1, matched.length + missing.length);
    score += Math.round(ratio * 4);
    if (matched.length) reasons.push(`Your skills: ${matched.join(", ")}.`);
    if (missing.length >= 3 && ratio < 0.5) {
      score -= 1;
      warnings.push(`Mostly other technologies: ${missing.slice(0, 5).join(", ")}.`);
    }
  }

  let level: JobFit["level"] = score >= 5 ? "good" : score >= 2 ? "possible" : "unlikely";
  // A hard requirement I do not meet keeps it from being a "good" match, however well the skills fit.
  if (level === "good" && warnings.length > 0) level = "possible";
  if (seniority === "senior" || seniority === "student") level = level === "good" ? "possible" : level;
  return { level, score, seniority, years, german, matched, missing, reasons, warnings };
}
