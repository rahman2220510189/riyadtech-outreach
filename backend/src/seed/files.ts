import { readFileSync } from "node:fs";
import { z } from "zod";

/** backend/seed, from src/seed (tsx) or dist/seed (compiled). */
const SEED_DIR = new URL("../../seed/", import.meta.url);

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, SEED_DIR), "utf8"));
}

const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const countrySeedSchema = z.object({
  code: z.string().regex(/^[A-Z]{2}$/),
  name: z.string().min(1),
  enabled: z.boolean(),
  blocked: z.boolean(),
  allowWholeCountry: z.boolean(),
  regionImports: z.boolean().default(false),
  /** Starting value of "job search only" for a new database (Settings changes it later). */
  jobSearch: z.boolean().default(false),
  timezones: z.array(z.string().min(1)).min(1),
  bbox,
  outreachRules: z
    .object({ law: z.string(), genericOnly: z.boolean(), verified: z.boolean().default(false), notes: z.string() })
    .loose(),
});
export type CountrySeed = z.infer<typeof countrySeedSchema>;

const countriesFileSchema = z.object({
  countries: z.array(countrySeedSchema).min(1),
  geonamesAdmin1ToIso: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});

export const categorySeedSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  segment: z.enum(["A", "B"]),
  label: z.string().min(1),
  nodes: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string()).default([]),
  value: z.number().int().min(1).max(5),
});
export type CategorySeed = z.infer<typeof categorySeedSchema>;

const categoriesFileSchema = z.object({
  taxonomyRelease: z.string(),
  categories: z.array(categorySeedSchema).min(1),
});

const platformFileSchema = z.object({ domains: z.array(z.string().min(3)).min(1) });

export interface SeedData {
  countries: CountrySeed[];
  geonamesAdmin1ToIso: Record<string, Record<string, string>>;
  categories: CategorySeed[];
  taxonomyRelease: string;
  platformDomains: string[];
}

let cached: SeedData | undefined;

/** Reads and validates the seed files once. Throws with a clear message if a file is broken. */
export function loadSeedData(): SeedData {
  if (cached) return cached;
  const countries = countriesFileSchema.parse(readJson("countries.json"));
  const categories = categoriesFileSchema.parse(readJson("categories.json"));
  const platform = platformFileSchema.parse(readJson("platform-domains.json"));

  const codes = new Set<string>();
  for (const c of countries.countries) {
    if (codes.has(c.code)) throw new Error(`seed/countries.json: duplicate country ${c.code}`);
    codes.add(c.code);
  }
  const keys = new Set<string>();
  for (const c of categories.categories) {
    if (keys.has(c.key)) throw new Error(`seed/categories.json: duplicate key ${c.key}`);
    keys.add(c.key);
  }
  cached = {
    countries: countries.countries,
    geonamesAdmin1ToIso: countries.geonamesAdmin1ToIso,
    categories: categories.categories,
    taxonomyRelease: categories.taxonomyRelease,
    platformDomains: platform.domains.map((d) => d.toLowerCase()),
  };
  return cached;
}
