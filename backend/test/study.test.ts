import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDraft } from "../src/study/ai.js";
import { DOC_KINDS, ENGLISH_REQUIREMENTS, LEVELS, effectiveLevel, englishFit, requiredDocsFor } from "../src/study/definitions.js";

const me = { targetLevel: "master", englishMedium: true, ieltsScore: null as number | null, duolingoScore: null };

describe("study: papers and English", () => {
  it("needs the BSc papers for a master's, the school papers for a bachelor's, and the MOI letter while I have no IELTS", () => {
    const p = { level: "both", requiredDocs: ["passport", "motivation_letter"], englishRequirement: "varies" };
    expect(requiredDocsFor(p, me)).toEqual(["passport", "bsc_certificate", "bsc_transcript", "moi_letter", "motivation_letter"]);
    expect(requiredDocsFor({ ...p, level: "bachelor" }, me)).toEqual(["passport", "hsc_certificate", "hsc_marksheet", "ssc_certificate", "ssc_marksheet", "moi_letter", "motivation_letter"]);
    expect(requiredDocsFor(p, { ...me, ieltsScore: 6.5 })).toContain("ielts_result");
    expect(requiredDocsFor({ ...p, englishRequirement: "not_required" }, me)).not.toContain("moi_letter");
    expect(effectiveLevel("both", "bachelor")).toBe("bachelor");
  });

  it("explains whether my English proof fits", () => {
    expect(englishFit({ englishRequirement: "moi_ok", minIelts: null }, me).fit).toBe("yes");
    expect(englishFit({ englishRequirement: "varies", minIelts: null }, me)).toMatchObject({ fit: "maybe" });
    expect(englishFit({ englishRequirement: "test_required", minIelts: 6.5 }, me).fit).toBe("no");
    expect(englishFit({ englishRequirement: "test_required", minIelts: 6.5 }, { ...me, ieltsScore: 7 })).toMatchObject({ fit: "yes", why: "IELTS 7 ≥ 6.5" });
    expect(englishFit({ englishRequirement: "varies", minIelts: 6 }, { ...me, ieltsScore: 5.5 }).fit).toBe("no");
  });

  it("reads the AI answer: subject and body; refuses an answer that is not an e-mail", () => {
    const d = parseDraft("<think>plan</think>SUBJECT: **Question about MOI for MSc Computer Science**\nBODY:\nDear Admissions Team,\n\nI hold a BSc in Computer Science taught in English and would like to ask whether you accept an MOI letter.\n\nKind regards,\nRiyad");
    expect(d.subject).toBe("Question about MOI for MSc Computer Science");
    expect(d.body.startsWith("Dear Admissions Team,")).toBe(true);
    expect(() => parseDraft("Sorry, I cannot help")).toThrow(/could not be read/);
  });
});

describe("study: seed file", () => {
  const seed = JSON.parse(readFileSync(new URL("../seed/study-programs.json", import.meta.url), "utf8")) as {
    programs: { seedKey: string; name: string; kind: string; country: string; level: string; englishRequirement: string; requiredDocs: string[]; deadlines: { kind: string; dueOn: string; confirmed: boolean }[] }[];
  };

  it("is valid: unique keys, known values, real dates, nothing marked confirmed", () => {
    const keys = seed.programs.map((p) => p.seedKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of seed.programs) {
      expect(["scholarship", "programme"]).toContain(p.kind);
      expect(LEVELS).toContain(p.level);
      expect(ENGLISH_REQUIREMENTS).toContain(p.englishRequirement);
      for (const k of p.requiredDocs) expect(DOC_KINDS).toContain(k);
      for (const d of p.deadlines) {
        expect(["deadline", "opens", "reminder"]).toContain(d.kind);
        expect(d.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(`${d.dueOn}T00:00:00Z`).toISOString().slice(0, 10)).toBe(d.dueOn);
        expect(d.confirmed).toBe(false);
      }
    }
  });

  it("covers Europe: a guide for many countries plus scholarships", () => {
    const countries = new Set(seed.programs.map((p) => p.country));
    expect(countries.size).toBeGreaterThanOrEqual(25);
    expect(seed.programs.filter((p) => p.kind === "scholarship").length).toBeGreaterThanOrEqual(10);
  });
});
