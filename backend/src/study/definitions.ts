/** Study abroad: document kinds, levels, statuses and which papers a programme needs. */

export const DOC_KINDS = [
  "passport",
  "photo",
  "bsc_certificate",
  "bsc_transcript",
  "hsc_certificate",
  "hsc_marksheet",
  "ssc_certificate",
  "ssc_marksheet",
  "moi_letter",
  "cv",
  "motivation_letter",
  "recommendation",
  "ielts_result",
  "other",
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_LABELS: Record<DocKind, string> = {
  passport: "Passport",
  photo: "Passport photo",
  bsc_certificate: "BSc certificate",
  bsc_transcript: "BSc transcript (marksheet)",
  hsc_certificate: "HSC certificate",
  hsc_marksheet: "HSC marksheet",
  ssc_certificate: "SSC certificate",
  ssc_marksheet: "SSC marksheet",
  moi_letter: "Medium of instruction (MOI) letter",
  cv: "CV",
  motivation_letter: "Motivation letter",
  recommendation: "Recommendation letter",
  ielts_result: "IELTS / English test result",
  other: "Other",
};

export const LEVELS = ["bachelor", "master", "both"] as const;
export type Level = (typeof LEVELS)[number];
export const PROGRAM_STATUSES = ["interested", "preparing", "applied", "interview", "accepted", "rejected", "not_now"] as const;
export const ENGLISH_REQUIREMENTS = ["moi_ok", "varies", "test_required", "not_required"] as const;

/** Degree papers that follow from the level I apply for. */
export function degreeDocs(level: "bachelor" | "master"): DocKind[] {
  return level === "master" ? ["bsc_certificate", "bsc_transcript"] : ["hsc_certificate", "hsc_marksheet", "ssc_certificate", "ssc_marksheet"];
}

/** The level that counts for a programme: its own, or my target level when it offers both. */
export function effectiveLevel(programLevel: string, targetLevel: string): "bachelor" | "master" {
  if (programLevel === "bachelor" || programLevel === "master") return programLevel;
  return targetLevel === "bachelor" ? "bachelor" : "master";
}

/**
 * Papers a programme needs from me: its own list, the degree papers for the level, and proof of English
 * (MOI letter when it accepts one and my degree was in English; otherwise a test result).
 */
export function requiredDocsFor(
  p: { level: string; requiredDocs: string[]; englishRequirement: string },
  profile: { targetLevel: string; englishMedium: boolean; ieltsScore: unknown },
): DocKind[] {
  const docs = new Set<DocKind>(p.requiredDocs.filter((d): d is DocKind => (DOC_KINDS as readonly string[]).includes(d)));
  for (const d of degreeDocs(effectiveLevel(p.level, profile.targetLevel))) docs.add(d);
  if (p.englishRequirement === "test_required") docs.add("ielts_result");
  else if (p.englishRequirement !== "not_required") docs.add(profile.englishMedium && !profile.ieltsScore ? "moi_letter" : "ielts_result");
  return DOC_KINDS.filter((d) => docs.has(d));
}

/** Can I apply with my English proof? yes / maybe / no, with the reason in words. */
export function englishFit(
  p: { englishRequirement: string; minIelts: unknown },
  profile: { englishMedium: boolean; ieltsScore: unknown; duolingoScore: number | null },
): { fit: "yes" | "maybe" | "no"; why: string } {
  const ielts = profile.ieltsScore === null || profile.ieltsScore === undefined ? null : Number(profile.ieltsScore);
  const min = p.minIelts === null || p.minIelts === undefined ? null : Number(p.minIelts);
  if (p.englishRequirement === "not_required") return { fit: "yes", why: "No English test needed" };
  if (ielts !== null && min !== null) return ielts >= min ? { fit: "yes", why: `IELTS ${ielts} ≥ ${min}` } : { fit: "no", why: `IELTS ${ielts} is below ${min}` };
  if (p.englishRequirement === "moi_ok") return profile.englishMedium ? { fit: "yes", why: "Accepts an MOI letter; your BSc was in English" } : { fit: "no", why: "Needs an English-medium degree or a test" };
  if (p.englishRequirement === "test_required") return ielts !== null ? { fit: "yes", why: `IELTS ${ielts}` } : { fit: "no", why: "Needs IELTS or another English test" };
  if (ielts !== null) return { fit: "maybe", why: `You have IELTS ${ielts}: check the university's minimum score` };
  return profile.englishMedium ? { fit: "maybe", why: "Depends on the university: ask whether they accept an MOI letter" } : { fit: "no", why: "Needs an English test" };
}
