import { describe, expect, it } from "vitest";
import { letterGaps, parseLetter } from "../src/study/ai.js";
import { docLabel, heldDocs, requiredDocsFor } from "../src/study/definitions.js";

const para = "My bachelor's research looked at fake news detection with transformer models and classic machine learning. ";

describe("motivation letter parsing", () => {
  it("splits title and letter, strips markdown and blank runs", () => {
    const r = parseLetter(`<think>plan</think>TITLE: **Statement of Purpose – MSc AI**\nLETTER:\n## ${para.repeat(10)}\n\n\n\n${para.repeat(5)}\n\nDemo Student`);
    expect(r.title).toBe("Statement of Purpose – MSc AI");
    expect(r.body.startsWith("My bachelor's")).toBe(true);
    expect(r.body).not.toMatch(/\n{3}|\*\*|#/);
  });

  it("refuses an answer that is not a letter", () => {
    expect(() => parseLetter("Sorry, I cannot help with that.")).toThrow(/could not be read/);
    expect(() => parseLetter("TITLE: x\nLETTER:\nToo short.")).toThrow(/could not be read/);
  });

  it("lists the [[…]] places to fill in", () => {
    expect(letterGaps("I want to join [[name of the research group]] and later [[your career goal]].")).toEqual(["name of the research group", "your career goal"]);
    expect(letterGaps("Nothing to add.")).toEqual([]);
  });
});

describe("completion letter instead of the certificate", () => {
  const prog = { level: "master", requiredDocs: [], englishRequirement: "moi_ok" };
  const profile = { targetLevel: "master", englishMedium: true, ieltsScore: null };

  it("counts as the BSc certificate until the certificate arrives", () => {
    expect(requiredDocsFor(prog, profile)).toContain("bsc_certificate");
    const have = heldDocs(["bsc_transcript", "bsc_completion_letter", "not_a_kind"]);
    expect(have.has("bsc_certificate")).toBe(true);
    expect(have.has("not_a_kind" as never)).toBe(false);
    expect(docLabel("bsc_certificate", have)).toMatch(/completion letter/);
    expect(docLabel("bsc_transcript", have)).toBe("BSc transcript (marksheet)");
    expect(heldDocs(["bsc_transcript"]).has("bsc_certificate")).toBe(false);
  });
});
