/** Small, deterministic random numbers: the same seed always gives the same choices. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fills {variables} first (only names in `vars`), then picks one option of every
 * {a|b|c} group (innermost first). The same seed always gives the same text.
 * An empty option ({ at the moment|}) means "sometimes nothing".
 */
export function renderSpintax(template: string, vars: Record<string, string | null | undefined>, seed: string): string | null {
  const rand = seededRandom(seed);
  const MISSING = "\u0000";
  // Known variables are filled; a variable without a value becomes a marker, so options using it are not chosen.
  let text = template.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const v = vars[name];
    return v === null || v === undefined || v === "" ? MISSING : v;
  });
  for (let guard = 0; guard < 50; guard++) {
    const next = text.replace(/\{([^{}]*\|[^{}]*)\}/, (_, body: string) => {
      const all = body.split("|");
      const options = all.filter((o) => !o.includes(MISSING));
      if (options.length === 0) return MISSING;
      return options[Math.floor(rand() * options.length)] ?? "";
    });
    if (next === text) break;
    text = next;
  }
  // A required variable had no value: this template cannot be used for this lead.
  if (text.includes(MISSING)) return null;
  return text.replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}
