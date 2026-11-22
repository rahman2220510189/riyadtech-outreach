import { seededRandom } from "../crawler/spintax.js";

/**
 * Template text -> e-mail text.
 *  - {name} is a variable; {name|fallback} uses the fallback when the value is empty.
 *  - {a|b|c} (not a known variable name first) is spintax: one option is chosen, the same one
 *    every time for the same seed (lead), so a preview equals the e-mail that is sent.
 *  - An option that uses an empty variable is never chosen ({ in {city}|} -> "" without a city).
 *  - A variable without fallback that stays empty is "missing": the e-mail must not be sent.
 * Line breaks are kept; spaces left by empty parts are tidied.
 */

export const STANDARD_VARIABLES = [
  "first_name",
  "company",
  "website",
  "city",
  "country",
  "role",
  "stack_match",
  "signal_line",
  "sender_name",
  "unsubscribe_link",
  "company_address",
  "job_title",
  "job_url",
] as const;

export interface RenderResult {
  text: string;
  /** Variables that were empty without a fallback (or are not known at all). */
  missing: string[];
  unknown: string[];
}

const MISSING = "\u0000";

export function renderText(template: string, vars: Record<string, string | null | undefined>, seed: string): RenderResult {
  const known = new Set<string>([...STANDARD_VARIABLES, ...Object.keys(vars)]);
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const missingAt: string[] = [];

  // 1. Variables (only names that look like variables).
  let text = template.replace(/\{([a-z_][a-z0-9_]*)(?:\|([^{}]*))?\}/g, (whole, name: string, fallback: string | undefined) => {
    if (!known.has(name)) {
      if (fallback !== undefined) return whole; // spintax like {there|you}
      unknown.add(name);
      return `${MISSING}${missingAt.push(name) - 1}${MISSING}`;
    }
    const v = vars[name];
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v);
    if (fallback !== undefined) return fallback;
    return `${MISSING}${missingAt.push(name) - 1}${MISSING}`;
  });

  // 2. Spintax, innermost first; options containing a missing variable are dropped.
  const rand = seededRandom(seed);
  for (let guard = 0; guard < 200; guard++) {
    const next = text.replace(/\{([^{}]*\|[^{}]*)\}/, (_, body: string) => {
      const all = body.split("|");
      const usable = all.filter((o) => !o.includes(MISSING));
      if (usable.length === 0) return all.find((o) => o.includes(MISSING)) ?? "";
      return usable[Math.floor(rand() * usable.length)] ?? "";
    });
    if (next === text) break;
    text = next;
  }

  // 3. What is left of the markers is really missing.
  text = text.replace(new RegExp(`${MISSING}(\\d+)${MISSING}`, "g"), (_, i: string) => {
    const name = missingAt[Number(i)]!;
    if (!unknown.has(name)) missing.add(name);
    return "";
  });

  // 4. Tidy: spaces left by empty parts, keep line breaks.
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?;:])/g, "$1").replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, missing: [...missing], unknown: [...unknown] };
}

/** Variables a template uses (for the editor's warnings). */
export function usedVariables(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([a-z_][a-z0-9_]*)(?:\|[^{}]*)?\}/g)].map((m) => m[1]!))];
}
