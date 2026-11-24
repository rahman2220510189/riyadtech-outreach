import { describe, expect, it } from "vitest";
import { germanNeeded, jobFit, type JobProfile, minYears, residenceRule, seniorityOf, techIn } from "../src/jobads/fit.js";

const me: JobProfile = { skills: ["JavaScript", "TypeScript", "React", "Next.js", "Node.js", "PostgreSQL", "REST APIs", "Git"], yearsExperience: 1, germanLevel: "a1" };

describe("job advert: level, years, German, technologies", () => {
  it("reads the seniority from the title, and junior hints from the text", () => {
    expect(seniorityOf("Senior Full Stack Developer (m/w/d)", "")).toBe("senior");
    expect(seniorityOf("Lead Frontend Engineer", "")).toBe("senior");
    expect(seniorityOf("Software Architekt (m/w/d)", "")).toBe("senior");
    expect(seniorityOf("Junior React Developer", "")).toBe("junior");
    expect(seniorityOf("Softwareentwickler (m/w/d) – Berufseinsteiger", "")).toBe("junior");
    expect(seniorityOf("Werkstudent Softwareentwicklung (m/w/d)", "")).toBe("student");
    expect(seniorityOf("Ausbildung Fachinformatiker Anwendungsentwicklung", "")).toBe("student");
    expect(seniorityOf("Full Stack Developer (m/w/d)", "Wir freuen uns auch über Berufseinsteiger.")).toBe("junior");
    expect(seniorityOf("Full Stack Developer (m/w/d)", "You build features end to end.")).toBe("open");
  });

  it("finds the smallest number of years asked for, in English and German", () => {
    expect(minYears("You have 5+ years of experience with React.")).toBe(5);
    expect(minYears("At least three years of professional experience in backend work")).toBe(3);
    expect(minYears("Mindestens 3 Jahre Berufserfahrung in der Softwareentwicklung")).toBe(3);
    expect(minYears("2-4 years experience; ideally 5 years in total")).toBe(2);
    expect(minYears("Mehrjährige Berufserfahrung mit Java")).toBe(3);
    expect(minYears("You enjoy clean code.")).toBeNull();
    expect(minYears("Founded 25 years ago, we have experience with clients")).toBeNull();
  });

  it("tells how much German is needed", () => {
    expect(germanNeeded("Fließende Deutschkenntnisse (C1) und gute Englischkenntnisse", ["local_lang"])).toBe("fluent");
    expect(germanNeeded("Sehr gute Deutschkenntnisse in Wort und Schrift", [])).toBe("good");
    expect(germanNeeded("Our team speaks English; German is a plus.", ["ad_english", "english_team"])).toBe("some");
    expect(germanNeeded("We build web apps in English.", ["ad_english"])).toBe("none");
    expect(germanNeeded("Wir entwickeln Webanwendungen mit React.", [])).toBe("good");
  });

  it("names the technologies, without Java in JavaScript", () => {
    const t = techIn("JavaScript, TypeScript, React, Node.js, PostgreSQL, Docker and AWS; no Java.");
    expect(t).toEqual(expect.arrayContaining(["JavaScript", "TypeScript", "React", "Node.js", "PostgreSQL", "Docker", "AWS", "Java"]));
    expect(techIn("Modern JavaScript and React")).not.toContain("Java");
  });
});

describe("job fit against my profile", () => {
  it("a junior React/Node role in English is a good match", () => {
    const f = jobFit(
      { title: "Junior Full Stack Developer (m/f/d)", description: "We are an English-speaking team in Berlin. You work with React, Next.js, Node.js and PostgreSQL. 1-2 years of experience.", tags: [], flags: ["ad_english", "english_team"] },
      me,
    );
    expect(f.level).toBe("good");
    expect(f.matched).toEqual(expect.arrayContaining(["React", "Next.js", "Node.js", "PostgreSQL"]));
    expect(f.warnings).toEqual([]);
  });

  it("a senior Java role in German with 5 years is unlikely, with the reasons", () => {
    const f = jobFit(
      { title: "Senior Java Entwickler (m/w/d)", description: "Mindestens 5 Jahre Berufserfahrung mit Java, Spring Boot und Kubernetes. Verhandlungssicheres Deutsch (C1).", tags: [], flags: ["local_lang"] },
      me,
    );
    expect(f.level).toBe("unlikely");
    expect(f.warnings.join(" ")).toMatch(/Senior/);
    expect(f.warnings.join(" ")).toMatch(/5 years/);
    expect(f.warnings.join(" ")).toMatch(/fluent German/);
    expect(f.missing).toEqual(expect.arrayContaining(["Java", "Spring", "Kubernetes"]));
  });

  it("German counts once I have it", () => {
    const ad = { title: "Webentwickler React (m/w/d)", description: "Wir suchen Unterstützung für React und TypeScript. Gute Deutschkenntnisse.", tags: [], flags: ["local_lang"] };
    expect(jobFit(ad, me).warnings.join(" ")).toMatch(/German/);
    expect(jobFit(ad, me).level).not.toBe("good"); // a requirement I do not meet: never a "good" match
    expect(jobFit(ad, { ...me, germanLevel: "b2" }).warnings.join(" ")).not.toMatch(/German/);
  });

  it("uses the job board's own level field (Arbeitnow job types)", () => {
    expect(seniorityOf("Machine Learning Engineer", "", ["Experienced", "Permanent"])).toBe("experienced");
    expect(seniorityOf("Software Engineer", "", ["Mid-Level"])).toBe("experienced");
    expect(seniorityOf("Software Engineer", "", ["Senior"])).toBe("senior");
    expect(seniorityOf("Developer", "", ["Entry Level", "Full Time"])).toBe("junior");
    expect(seniorityOf("Developer", "", ["Internship"])).toBe("student");
    const f = jobFit({ title: "Machine Learning Engineer", description: "Python, Docker, Linux and machine learning in English.", tags: [], flags: ["ad_english"], jobTypes: ["Experienced"] }, { ...me, skills: [...me.skills, "Python", "Docker", "Linux", "Machine learning"] });
    expect(f.level).not.toBe("good");
    expect(f.warnings.join(" ")).toMatch(/experienced/);
  });

  it("one familiar word is not a good match", () => {
    const f = jobFit({ title: "FullStack Engineer", description: "You have a knack for solving problems with JavaScript.", tags: [], flags: ["ad_english"] }, me);
    expect(f.matched).toEqual(["JavaScript"]);
    expect(f.level).toBe("possible");
  });

  it("where I must already live, or no visa sponsorship", () => {
    expect(residenceRule("Candidates must live in the United Kingdom. Full-time.")).toBe("Must already live in the United Kingdom.");
    expect(residenceRule("We are unable to offer visa sponsorship for this role.")).toBe("No visa sponsorship.");
    expect(residenceRule("A valid EU work permit is required.")).toBe("Needs a work permit already.");
    expect(residenceRule("We help with relocation and visas.")).toBeNull();
    const f = jobFit({ title: "Junior React Developer", description: "React, Next.js, Node.js, TypeScript. Candidates must live in Germany.", tags: [], flags: ["ad_english"] }, me);
    expect(f.level).not.toBe("good");
    expect(f.warnings).toContain("Must already live in Germany.");
  });
});
