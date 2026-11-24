/**
 * npm run seed:demo
 *
 * Fills a fresh local database with a demo student and a few made-up programmes and website
 * findings, so a reviewer can click through the study-abroad pages without real data.
 * Safe by design: refuses in production and refuses when a real (non-demo) profile exists.
 * Run it again any time: it only adds what is missing. All addresses are on .invalid / example
 * domains, so nothing points at a real person or university.
 */
import { loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { describePgUrl } from "../db/url.js";

const DEMO_NAME = "Demo Student";

const PROGRAMMES = [
  {
    name: "Erasmus Mundus Joint Master in Artificial Intelligence (demo)",
    country: "Europe (several countries)",
    url: "https://example.org/demo-emai",
    findings: [{ type: "deadline", value: "2027-01-15", label: "Application deadline", snippet: "Scholarship applications must be submitted by 15 January 2027." }],
  },
  {
    name: "Joint Master in Language and Communication Technologies (demo)",
    country: "Europe (several countries)",
    url: "https://example.org/demo-lct",
    findings: [],
  },
  {
    name: "MSc Computer Science — Example University of Technology (demo)",
    country: "Austria",
    url: "https://example-tu.invalid/msc-cs",
    findings: [
      { type: "moi", value: "moi", label: "English-medium degree", snippet: "Applicants whose bachelor's degree was taught entirely in English may submit a confirmation from their university instead of a language test." },
      { type: "ielts", value: "6.5", label: null, snippet: "IELTS Academic: overall band 6.5, no section below 6.0." },
      { type: "deadline", value: "2027-01-31", label: "Application deadline", snippet: "The application period for the winter semester closes on 31 January 2027." },
      { type: "email", value: "admissions@example-tu.invalid", label: null, snippet: "Questions about admission: admissions@example-tu.invalid" },
    ],
  },
] as const;

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === "production") throw new Error("seed:demo is for local demo databases only (NODE_ENV=production).");
  const target = describePgUrl(env.DATABASE_URL);
  process.stdout.write(`Database: ${target.host} / ${target.database}\n`);
  const db = createDb(env);
  try {
    const profile = await db.studyProfile.findUnique({ where: { id: 1 } });
    if (profile && profile.fullName && profile.fullName !== DEMO_NAME) {
      throw new Error(`This database has a real profile ("${profile.fullName}"). Use an empty database for the demo; nothing changed.`);
    }
    await db.studyProfile.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        fullName: DEMO_NAME,
        targetLevel: "master",
        targetFields: ["Computer Science", "Artificial Intelligence"],
        bscSubject: "Computer Science and Engineering",
        bscCgpa: 3.3,
        englishMedium: true,
        workExperience: "Full-stack developer (Next.js, Node.js) integrating LLM APIs for a software company.",
        aboutMe: "Bachelor's research on fake news detection in a low-resource language with transformer models (BERT) and classic machine learning.",
      },
    });
    let added = 0;
    for (const p of PROGRAMMES) {
      const existing = await db.studyProgram.findFirst({ where: { name: p.name } });
      const prog =
        existing ??
        (await db.studyProgram.create({
          data: { name: p.name, kind: "programme", country: p.country, level: "master", englishRequirement: "varies", applyUrl: p.url, infoUrl: p.url, origin: "auto" },
        }));
      if (!existing) added++;
      for (const f of p.findings) {
        await db.studyFinding.upsert({
          where: { programId_type_value: { programId: prog.id, type: f.type, value: f.value } },
          update: {},
          create: { programId: prog.id, type: f.type, value: f.value, label: f.label, snippet: f.snippet, url: p.url },
        });
      }
    }
    process.stdout.write(`Demo ready: profile "${DEMO_NAME}", ${added} new programmes, findings under Study abroad → Updates.\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`seed:demo failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
