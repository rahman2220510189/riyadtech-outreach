import { describe, expect, it } from "vitest";
import { type FitProfile, minCgpa, subjectFit, suggestedSubjects, workYears } from "../src/study/fit.js";

const me: FitProfile = {
  bscSubject: "Computer Science and Engineering",
  targetFields: ["Computer Science", "Artificial Intelligence"],
  workExperience: "Full-stack developer (Next.js, Node.js) integrating LLM APIs for a Cyprus company since April 2026.",
  aboutMe: "Research on Bengali fake news detection with BanglaBERT and machine learning (92% Macro F1). Built a telemedicine platform.",
  bscCgpa: 3.15,
  bscCgpaScale: 4,
};
const prog = (name: string, extra: Partial<{ field: string; howToApply: string; notes: string }> = {}) => ({
  name,
  field: extra.field ?? null,
  kind: "scholarship",
  notes: extra.notes ?? null,
  howToApply: extra.howToApply ?? null,
  funding: null,
  university: null,
});

describe("study: does the subject suit me", () => {
  it("strong for my own work, related for my degree, weak for physics, any for open scholarships", () => {
    expect(subjectFit(prog("Erasmus Mundus Joint Master in Artificial Intelligence"), me).level).toBe("strong");
    expect(subjectFit(prog("Joint Master in Language and Communication Technologies (LCT)"), me).level).toBe("strong");
    expect(subjectFit(prog("Erasmus Mundus Master in Cybersecurity"), me)).toMatchObject({ level: "related" });
    expect(subjectFit(prog("Quantum Technologies and Engineering Erasmus Mundus Master Plus"), me)).toMatchObject({ level: "weak" });
    expect(subjectFit(prog("Master in Advanced Microscopy with Artificial Intelligence"), me).level).toBe("strong");
    expect(subjectFit(prog("Master in Marine Biological Resources"), me).level).toBe("weak");
    const gks = subjectFit(prog("Global Korea Scholarship (GKS) – Embassy track"), me);
    expect(gks.level).toBe("any");
    expect(gks.reasons[0]).toMatch(/Artificial Intelligence/);
  });

  it("warns about CGPA and work-experience requirements written in the text", () => {
    expect(minCgpa("CGPA must be at least 2.64/4.0; age under 40.")).toBe(2.64);
    expect(minCgpa("CGPA at least 3.00 (or second class upper)")).toBe(3);
    expect(minCgpa("asks for at least 3.0/4 from a 4-year Bangladeshi bachelor's")).toBe(3);
    expect(workYears("Needs at least four years of full-time relevant work experience")).toBe(4);
    const aa = subjectFit(prog("Australia Awards Scholarships", { howToApply: "Needs at least four years of full-time relevant work experience, IELTS 6.5." }), me);
    expect(aa.warnings).toEqual(["Needs at least 4 years of full-time work experience."]);
    const high = subjectFit(prog("Top Data Science Scholarship", { howToApply: "CGPA at least 3.50/4." }), me);
    expect(high.warnings[0]).toMatch(/3\.50\/4 — yours is 3\.15/);
    expect(subjectFit(prog("GKS", { howToApply: "CGPA must be at least 2.64/4.0" }), me).warnings).toEqual([]);
  });

  it("suggested subjects quote my own profile", () => {
    const s = suggestedSubjects(me);
    expect(s.map((x) => x.topic)).toEqual(["ai", "nlp", "software", "health", "cs"]);
    expect(s[1]!.why).toMatch(/BanglaBERT|fake news/);
    expect(s.at(-1)!.why).toBe("Your bachelor's: Computer Science and Engineering.");
    expect(suggestedSubjects({ ...me, targetFields: [], workExperience: null, aboutMe: null }).map((x) => x.topic)).toEqual(["cs"]);
  });
});
