import type { CategorySeed } from "../seed/files.js";

export interface Taxonomy {
  primary?: string | null;
  hierarchy?: readonly (string | null)[] | null;
}

export interface CategoryRule {
  key: string;
  segment: "A" | "B";
  label: string;
  value: number;
  nodes: Set<string>;
  exclude: Set<string>;
}

export function compileCategories(seeds: readonly CategorySeed[]): CategoryRule[] {
  return seeds.map((c) => ({
    key: c.key,
    segment: c.segment,
    label: c.label,
    value: c.value,
    nodes: new Set(c.nodes),
    exclude: new Set(c.exclude),
  }));
}

/** Nodes describing a place: its hierarchy (with primary), or the basic category if there is no taxonomy. */
export function placeNodes(taxonomy: Taxonomy | null | undefined, basicCategory?: string | null): string[] {
  const out: string[] = [];
  for (const n of taxonomy?.hierarchy ?? []) if (n) out.push(n);
  if (taxonomy?.primary) out.push(taxonomy.primary);
  if (out.length === 0 && basicCategory) out.push(basicCategory);
  return out;
}

/** First rule (in file order) that matches, limited to the allowed keys. */
export function matchCategory(
  rules: readonly CategoryRule[],
  nodes: readonly string[],
  allowedKeys?: ReadonlySet<string>,
): CategoryRule | null {
  if (nodes.length === 0) return null;
  for (const rule of rules) {
    if (allowedKeys && !allowedKeys.has(rule.key)) continue;
    let hit = false;
    for (const n of nodes) {
      if (rule.exclude.has(n)) {
        hit = false;
        break;
      }
      if (rule.nodes.has(n)) hit = true;
    }
    if (hit) return rule;
  }
  return null;
}
