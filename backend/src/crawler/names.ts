import { readFileSync } from "node:fs";

let names: Set<string> | undefined;

/** Common first names (seed/first-names.txt), read once. */
function load(): Set<string> {
  if (!names) {
    const text = readFileSync(new URL("../../seed/first-names.txt", import.meta.url), "utf8");
    names = new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase())
        .filter((l) => l && !l.startsWith("#")),
    );
  }
  return names;
}

export function isFirstName(word: string): boolean {
  return load().has(word.toLowerCase());
}

export function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
