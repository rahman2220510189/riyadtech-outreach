/**
 * npm run study:check [-- https://university.example/admissions]
 *
 * Asks each university directory source once (Hungary only) and prints what it answers.
 * With a web address, also reads that page the way the daily check does and prints what it
 * finds (IELTS, English-medium sentences, dates, addresses). No database, nothing saved.
 */
import { parseHipo, parseRorPage, parseWikidata, rorUrl, wikidataUrl } from "../study/directory.js";
import { ERASMUS_CATALOGUE, matchesSubjects, readErasmusCatalogue, readStudyFinder } from "../study/catalogues.js";
import { readPages } from "../study/reader.js";
import { DIRECTORY_DEFAULTS, directoryGetJson } from "../study/sources.js";

const get = directoryGetJson();
const out = (line: string) => process.stdout.write(`${line}\n`);

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    out(`OK    ${name}: ${await fn()} (${Date.now() - started} ms)`);
  } catch (err) {
    out(`FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  await step("GitHub university list", async () => {
    const list = parseHipo(await get(DIRECTORY_DEFAULTS.hipoUrl));
    return `${list.length} universities in the default countries; e.g. ${list.find((e) => e.countryCode === "HU")?.name ?? "-"}`;
  });
  await step("ROR (Hungary, page 1)", async () => {
    const r = parseRorPage(await get(rorUrl(DIRECTORY_DEFAULTS.rorBase, "HU", 1)));
    return `${r.total} education organisations in Hungary; first: ${r.entries[0] ? `${r.entries[0].name} (${r.entries[0].domain})` : "-"}`;
  });
  await step("Wikidata (Hungary)", async () => {
    const list = parseWikidata(await get(wikidataUrl(DIRECTORY_DEFAULTS.wikidataBase, "HU")), "HU");
    return `${list.length} universities with a website; first: ${list[0] ? `${list[0].name} (${list[0].domain})` : "-"}`;
  });
  await step("Erasmus Mundus catalogue (EACEA)", async () => {
    const r = await readErasmusCatalogue({ minDelayMs: 1500, timeoutMs: 30_000, maxBytes: 5_000_000, maxRedirects: 3, maxCrawlDelaySeconds: 30, maxPages: 1 }, {}, ERASMUS_CATALOGUE);
    if (r.problem) throw new Error(r.problem);
    const cs = r.entries.filter((e) => matchesSubjects(e.name, ["Computer Science"]));
    return `${r.entries.length} programmes on ${r.pages} pages, ${cs.length} close to Computer Science; e.g. ${cs[0] ? `${cs[0].name} (${cs[0].website})` : "-"}`;
  });
  await step("Hungarian Study Finder (Tempus), page 35", async () => {
    const r = await readStudyFinder({ minDelayMs: 1500, timeoutMs: 30_000, maxBytes: 5_000_000, maxRedirects: 3, maxCrawlDelaySeconds: 30, maxPages: 1 }, {}, { from: 35, to: 35, maxMisses: 1 });
    if (r.problem) throw new Error(r.problem);
    const e = r.entries[0];
    if (!e) throw new Error("page 35 could not be read as a programme (the page layout may differ)");
    return `${e.name} — ${e.university ?? "?"}; level ${e.level ?? "?"}; ${e.language ?? "?"}; IELTS ${e.minIelts ?? "?"}; website ${e.website ?? "?"}`;
  });
  const url = process.argv[2];
  if (url) {
    out(`\nReading ${url} …`);
    const [p] = await readPages([url], { minDelayMs: 1500, timeoutMs: 20_000, maxBytes: 5_000_000, maxRedirects: 3, maxCrawlDelaySeconds: 30, maxPages: 1 });
    if (!p) return;
    out(`${p.status === "ok" ? "OK  " : "FAIL"}  ${p.status}${p.error ? `: ${p.error}` : ""} (${p.textLength} characters of text)`);
    for (const i of p.facts.ielts) out(`      IELTS ${i.score}: ${i.snippet}`);
    for (const m of p.facts.moi) out(`      English-medium: ${m}`);
    for (const d of p.facts.deadlines) out(`      Date ${d.date} (${d.label}): ${d.snippet}`);
    for (const e of p.facts.emails) out(`      Address: ${e}`);
    out(`      Taught in English mentioned: ${p.facts.englishTaught ? "yes" : "no"}`);
  }
}

main().catch((err: unknown) => {
  out(`study:check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
