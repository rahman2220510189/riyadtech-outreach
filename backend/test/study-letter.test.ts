import { describe, expect, it } from "vitest";
import { letterChecks, letterGaps, parseLetter } from "../src/study/ai.js";
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

describe("letter checks", () => {
  const facts = '{"bscCgpa":"3.16 out of 4","about":"benchmarked 11 models from 60,000+ articles; best 92.0% macro F1; p = 0.68"}';

  it("flags numbers that are not in my facts, but not years or numbers that are", () => {
    const c = letterChecks("CGPA 3.16, eleven models, 92.0% macro-F1, p = 0.68, 60,000 articles, finished in 2026. My HSC GPA was 4.83.", facts);
    expect(c.join(" ")).toMatch(/Numbers not found in your profile: 4\.83\./);
    expect(c.join(" ")).not.toMatch(/3\.16|92\.0|2026|60000|60,000/);
  });

  it("flags boastful words, order words and length", () => {
    const c = letterChecks(`A remarkable result with state-of-the-art models. Earlier, I founded a studio. ${"word ".repeat(700)}`, facts);
    expect(c.join(" ")).toMatch(/remarkable, state-of-the-art/);
    expect(c.join(" ")).toMatch(/earlier/);
    expect(c.join(" ")).toMatch(/longer than 650/);
    expect(letterChecks("A short, plain letter about my thesis.", facts)).toEqual([]);
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
