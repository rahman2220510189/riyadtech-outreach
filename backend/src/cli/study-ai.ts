/**
 * npm run study:ai -- KR
 *
 * Asks Groq (with its web search) for scholarships in one country, then opens every proposed
 * official page the way the tool does and prints which ones pass. Uses GROQ_API_KEY from
 * backend/.env. Nothing is saved.
 */
import { loadEnv } from "../config/env.js";
import { countryName } from "../study/directory.js";
import { checkCandidates, searchModel, searchScholarships } from "../study/discover.js";

const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const env = loadEnv();
  const code = (process.argv[2] ?? "KR").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error("Give a two-letter country code, e.g. npm run study:ai -- KR");
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set in backend/.env");
  out(`Searching with ${searchModel(env.GROQ_MODEL)} for ${countryName(code)} … (up to 3 minutes)`);
  const started = Date.now();
  const { candidates, raw } = await searchScholarships(env, countryName(code), "Computer Science", "master's degree");
  out(`Groq answered in ${Math.round((Date.now() - started) / 1000)} s with ${candidates.length} proposal(s).`);
  if (candidates.length === 0) out(`Answer: ${raw.slice(0, 500)}`);
  const checked = await checkCandidates(candidates, { minDelayMs: 1500, timeoutMs: 20_000, maxBytes: 5_000_000, maxRedirects: 3, maxCrawlDelaySeconds: 30, maxPages: 1 });
  for (const c of checked) {
    out(`${c.ok ? "OK  " : "SKIP"}  ${c.name}`);
    out(`      ${c.url}`);
    out(`      ${c.reason}; deadline ${c.deadline ?? "unknown"}${c.deadlineOnPage ? " (on the page)" : ""}; English: ${c.english}`);
  }
}

main().catch((err: unknown) => {
  out(`study:ai failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
