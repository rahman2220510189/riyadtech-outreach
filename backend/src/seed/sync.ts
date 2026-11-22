/** Any pino-style logger (pino itself or Fastify's app.log). */
type Logger = { info: (obj: object, msg: string) => void };
import type { Db } from "../db/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import { xactLock } from "../db/locks.js";
import { readFileSync } from "node:fs";
import { loadSeedData } from "./files.js";

/**
 * Brings the reviewed seed files into the database at server start (no shell needed on Render).
 * - countries: new ones are inserted (blocked ones always start disabled); existing ones keep
 *   `enabled` (switched in Settings), everything else follows the file.
 * - categories_map: replaced to match the file exactly (read-only in the app).
 */
export async function syncSeeds(db: Db, log: Logger): Promise<void> {
  const seed = loadSeedData();
  await db.$transaction(async (tx) => {
    await xactLock(tx, "seed-sync");
    for (const c of [...seed.countries].sort((a, b) => a.code.localeCompare(b.code))) {
      await tx.country.upsert({
        where: { code: c.code },
        create: {
          code: c.code,
          name: c.name,
          enabled: c.enabled && !c.blocked,
          blocked: c.blocked,
          allowWholeCountry: c.allowWholeCountry,
          regionImports: c.regionImports,
          jobSearch: c.jobSearch,
          timezones: c.timezones,
          bbox: c.bbox,
          outreachRules: c.outreachRules as Prisma.InputJsonObject,
        },
        update: {
          name: c.name,
          blocked: c.blocked,
          allowWholeCountry: c.allowWholeCountry,
          regionImports: c.regionImports,
          timezones: c.timezones,
          bbox: c.bbox,
          outreachRules: c.outreachRules as Prisma.InputJsonObject,
        },
      });
    }
    await tx.categoryMap.deleteMany({});
    await tx.categoryMap.createMany({
      data: seed.categories.map((c, i) => ({
        key: c.key,
        segment: c.segment,
        label: c.label,
        nodes: c.nodes,
        excludeNodes: c.exclude,
        value: c.value,
        sort: i,
      })),
    });
  });
  const templates = await syncSeedTemplates(db);
  await syncStudySeeds(db);
  log.info({ countries: seed.countries.length, categories: seed.categories.length, newTemplates: templates }, "Seed data synced");
}

interface SeedTemplate {
  seedKey: string;
  kind: "outreach" | "job";
  name: string;
  segment: "A" | "B" | null;
  offer: "chatbot" | "agent" | null;
  step: number;
  subject: string;
  body: string;
}

/** Seed templates (§15) are inserted once; a template edited or deleted in the app is left alone. */
export async function syncSeedTemplates(db: Db): Promise<number> {
  const file = JSON.parse(readFileSync(new URL("../../seed/templates.json", import.meta.url), "utf8")) as { templates: SeedTemplate[] };
  const deleted = await db.setting.findUnique({ where: { key: "templates.deletedSeeds" } });
  const skip = new Set(Array.isArray(deleted?.value) ? (deleted.value as string[]) : []);
  const res = await db.template.createMany({
    data: file.templates.filter((t) => !skip.has(t.seedKey)),
    skipDuplicates: true,
  });
  return res.count;
}

interface SeedProgram {
  seedKey: string;
  name: string;
  kind: string;
  country: string;
  university: string | null;
  level: string;
  field: string | null;
  englishRequirement: string;
  minIelts: number | null;
  funding: string | null;
  costs: string | null;
  workWhileStudying?: string | null;
  applyUrl: string | null;
  infoUrl: string | null;
  contactEmail: string | null;
  requiredDocs: string[];
  howToApply: string | null;
  notes: string | null;
  deadlines: { label: string; kind: string; dueOn: string; confirmed: boolean }[];
}

/** Researched study options and their dates: inserted once; edits and deletions in the app are kept. */
export async function syncStudySeeds(db: Db): Promise<number> {
  const file = JSON.parse(readFileSync(new URL("../../seed/study-programs.json", import.meta.url), "utf8")) as { programs: SeedProgram[] };
  const deleted = await db.setting.findUnique({ where: { key: "study.deletedSeeds" } });
  const skip = new Set(Array.isArray(deleted?.value) ? (deleted.value as string[]) : []);
  const have = new Set((await db.studyProgram.findMany({ where: { seedKey: { not: null } }, select: { seedKey: true } })).map((p) => p.seedKey));
  let added = 0;
  for (const { deadlines, ...p } of file.programs) {
    // Facts added to the seed later fill empty fields of rows already saved (never overwrite my edits).
    if (have.has(p.seedKey)) {
      if (p.workWhileStudying) await db.studyProgram.updateMany({ where: { seedKey: p.seedKey, workWhileStudying: null }, data: { workWhileStudying: p.workWhileStudying } });
      if (p.applyUrl) await db.studyProgram.updateMany({ where: { seedKey: p.seedKey, applyUrl: null }, data: { applyUrl: p.applyUrl } });
    }
    if (have.has(p.seedKey) || skip.has(p.seedKey)) continue;
    await db.studyProgram.create({
      data: { ...p, origin: "seed", deadlines: { create: deadlines.map((d) => ({ ...d, dueOn: new Date(`${d.dueOn}T00:00:00Z`) })) } },
    });
    added++;
  }
  await db.studyProfile.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return added;
}
