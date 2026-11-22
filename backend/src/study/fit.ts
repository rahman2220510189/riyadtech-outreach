/**
 * Does a programme's subject suit me? Rule-based and explainable: topics are read from my
 * profile (BSc subject, target subjects, work experience, "about me") and from the programme
 * (name, subject, notes); the overlap decides. Also checks hard requirements written in the
 * programme's text (minimum CGPA, years of work experience).
 */

export const TOPICS = {
  ai: { label: "Artificial Intelligence / Machine Learning", re: /artificial intelligence|\bai\b|machine learning|deep learning|neural|intelligent systems?|llm|large language|computer vision|generative/i },
  nlp: { label: "Natural Language Processing / Language Technology", re: /natural language|\bnlp\b|language (and \w+ )?technolog|linguistic|text mining|speech|bangla ?bert|fake news/i },
  data: { label: "Data Science / Big Data", re: /data science|big data|data engineering|data analytics|\banalytics\b|data mining|data-driven/i },
  software: { label: "Software Engineering / Web", re: /software|full[- ]?stack|web (development|applications?)|programming|devops|cloud|distributed systems?|next\.?js|react|node\.?js/i },
  cs: { label: "Computer Science", re: /computer science|computing|informatics|computer engineering|\bcse\b|\bict\b|information technology/i },
  cyber: { label: "Cybersecurity", re: /cyber|security|cryptograph|privacy/i },
  networks: { label: "Networks / IoT", re: /network|telecommunic|\biot\b|internet of things|5g|wireless/i },
  robotics: { label: "Robotics / Autonomous systems", re: /robot|autonomous|mechatronic|control systems?/i },
  hci: { label: "Human–Computer Interaction / Games", re: /human[- ]computer|interaction design|\bhci\b|games?|multimedia|virtual reality|\bvr\b/i },
  health: { label: "Health / Bio informatics", re: /health|medical|telemedicine|bioinformatic|biomedical/i },
  quantum: { label: "Quantum technologies", re: /quantum/i },
  physics: { label: "Physics / Photonics / Imaging", re: /photonic|optics|laser|microscop|physics|nanotech/i },
  math: { label: "Mathematics / Statistics", re: /mathemat|statistic|actuarial/i },
} as const;
export type Topic = keyof typeof TOPICS;

/** Topics close to a Computer Science / Engineering bachelor's. */
const CS_FAMILY: Topic[] = ["ai", "nlp", "data", "software", "cs", "cyber", "networks", "robotics", "hci"];
/** Topics that usually ask for a physics or mathematics bachelor's. */
const FAR: Topic[] = ["quantum", "physics", "math"];

export function topicsIn(text: string): Topic[] {
  return (Object.keys(TOPICS) as Topic[]).filter((t) => TOPICS[t].re.test(text));
}

export interface FitProfile {
  bscSubject: string | null;
  targetFields: string[];
  workExperience: string | null;
  aboutMe: string | null;
  bscCgpa: number | null;
  bscCgpaScale: number;
}

export interface FitProgram {
  name: string;
  field: string | null;
  kind: string;
  notes: string | null;
  howToApply: string | null;
  funding: string | null;
  university: string | null;
}

export interface SubjectFit {
  /** strong: your specialty; related: your degree fits; weak: needs another background; any: a scholarship for many subjects. */
  level: "strong" | "related" | "weak" | "any";
  reasons: string[];
  warnings: string[];
}

/** What I am strongest in, from my profile (specialties first). */
export function myTopics(p: FitProfile): { all: Topic[]; specialties: Topic[] } {
  const degree = topicsIn(`${p.bscSubject ?? ""}`);
  const rest = topicsIn(`${p.targetFields.join(" ")} ${p.workExperience ?? ""} ${p.aboutMe ?? ""}`);
  const all = [...new Set([...degree, ...rest, ...(degree.length === 0 && /engineer/i.test(p.bscSubject ?? "") ? (["cs"] as Topic[]) : [])])];
  return { all, specialties: rest.filter((t) => !["cs"].includes(t)) };
}

/** Minimum CGPA written in the text ("CGPA at least 3.00", "2.64/4.0", "at least 3.0/4"), on a 4-point scale. */
export function minCgpa(text: string): number | null {
  const m = /(?:cgpa|gpa|grade point average)[^.]{0,40}?(?:at least|minimum(?: of)?|≥|>=)\s*(\d(?:\.\d{1,2})?)\s*(?:\/\s*4(?:\.0+)?|out of 4)?/i.exec(text) ?? /(?:at least|minimum(?: of)?)\s*(\d\.\d{1,2})\s*\/\s*4(?:\.0+)?/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  return v > 0 && v <= 4 ? v : null;
}

/** Years of work experience required ("at least four years of full-time … work experience"). */
export function workYears(text: string): number | null {
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const m = /at least (\d|one|two|three|four|five) years? of[^.]{0,40}work experience/i.exec(text);
  if (!m) return null;
  return /\d/.test(m[1]!) ? Number(m[1]) : (words[m[1]!.toLowerCase()] ?? null);
}

export function subjectFit(program: FitProgram, profile: FitProfile): SubjectFit {
  const text = `${program.name} ${program.field ?? ""}`;
  const progTopics = topicsIn(text);
  const mine = myTopics(profile);
  const warnings: string[] = [];
  const all = `${program.howToApply ?? ""} ${program.notes ?? ""}`;
  const need = minCgpa(all);
  const myCgpa = profile.bscCgpa === null ? null : (profile.bscCgpa / profile.bscCgpaScale) * 4;
  if (need !== null && myCgpa !== null) {
    if (myCgpa < need) warnings.push(`Needs a CGPA of at least ${need.toFixed(2)}/4 — yours is ${myCgpa.toFixed(2)}.`);
  }
  const years = workYears(all);
  if (years !== null) warnings.push(`Needs at least ${years} year${years === 1 ? "" : "s"} of full-time work experience.`);

  // A degree programme with a subject outside my areas (e.g. "Master in Marine Biology").
  if (progTopics.length === 0 && /\b(master|msc|m\.sc|joint degree|degree in|programme in|program in)\b/i.test(program.name)) {
    return { level: "weak", reasons: ["The subject is far from Computer Science; check the entry requirements before applying."], warnings };
  }
  // Scholarships without a subject of their own (GKS, CGS, MEXT, guides): any subject — choose yours.
  if (progTopics.length === 0) {
    const best = mine.specialties.length ? mine.specialties : mine.all;
    return {
      level: "any",
      reasons: [best.length ? `Open to many subjects: choose a programme in ${best.slice(0, 3).map((t) => TOPICS[t].label).join(", ")}.` : "Open to many subjects: choose one close to your bachelor's."],
      warnings,
    };
  }
  const labels = (ts: Topic[]) => ts.map((t) => TOPICS[t].label).join(", ");
  const shared = progTopics.filter((t) => mine.specialties.includes(t));
  if (shared.length) return { level: "strong", reasons: [`Matches your own work and research: ${labels(shared)}.`], warnings };
  const sharedAny = progTopics.filter((t) => mine.all.includes(t) || (CS_FAMILY.includes(t) && mine.all.some((m) => CS_FAMILY.includes(m))));
  const far = progTopics.filter((t) => FAR.includes(t));
  if (sharedAny.length && far.length === 0) {
    return { level: "related", reasons: [`Your degree fits (${labels(sharedAny)}); in your letter, show why this area interests you.`], warnings };
  }
  if (far.length) {
    return {
      level: sharedAny.length ? "related" : "weak",
      reasons: [`Usually asks for a ${far.includes("math") ? "mathematics" : "physics"} background (${labels(far)}).${sharedAny.length ? ` The ${labels(sharedAny)} part suits your degree.` : ""}`],
      warnings,
    };
  }
  return { level: "weak", reasons: [`Different from your background (${labels(progTopics)}).`], warnings };
}

/** The words in my profile that show a topic (a short quote), or null. */
function evidence(text: string, t: Topic): string | null {
  const m = TOPICS[t].re.exec(text);
  if (!m) return null;
  const from = Math.max(0, text.lastIndexOf(" ", Math.max(0, m.index - 50)));
  const to = text.indexOf(" ", Math.min(text.length, m.index + m[0].length + 50));
  const piece = text.slice(from, to === -1 ? undefined : to).trim();
  return `“${from > 0 ? "…" : ""}${piece}${to !== -1 ? "…" : ""}”`;
}

/** Subjects to apply for, best first, each with the words from my profile that support it. */
export function suggestedSubjects(profile: FitProfile): { topic: Topic; label: string; why: string }[] {
  // Evidence from what I did (work, research) first; the subjects I typed only say what I want.
  const text = `${profile.workExperience ?? ""} ${profile.aboutMe ?? ""}`.replace(/\s+/g, " ").trim();
  const wanted = profile.targetFields.join(", ");
  const mine = myTopics(profile);
  const order: Topic[] = ["ai", "nlp", "data", "software", "health", "cyber", "networks", "robotics", "hci", "cs"];
  const out: { topic: Topic; label: string; why: string }[] = [];
  for (const t of order) {
    if (t === "cs") {
      if (profile.bscSubject) out.push({ topic: t, label: TOPICS[t].label, why: `Your bachelor's: ${profile.bscSubject}.` });
      continue;
    }
    if (!mine.all.includes(t)) continue;
    const quote = evidence(text, t);
    out.push({
      topic: t,
      label: TOPICS[t].label,
      why: quote ? `Your experience: ${quote}` : TOPICS[t].re.test(wanted) ? "One of the subjects you listed in My profile." : "From your bachelor's subject.",
    });
  }
  return out.slice(0, 5);
}
