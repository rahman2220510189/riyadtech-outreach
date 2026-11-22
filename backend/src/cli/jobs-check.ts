/**
 * npm run jobs:check
 *
 * Asks each job API once (a tiny search) and prints what it answers: HTTP status, the start of
 * an error answer, how many adverts, how the first advert is read, and whether advert texts can
 * be read. No database, nothing saved. Use it when a job search fails.
 */
import { ARBEITNOW_BASE, BA_BASE, BA_DETAIL_PATHS, BA_SEARCH_PATHS, baAdvert, findAdArray, netGetJson } from "../jobads/sources.js";

const get = netGetJson();
const KEY = { "X-API-Key": "jobboerse-jobsuche" };
const pause = () => new Promise((r) => setTimeout(r, 1000));
const out = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  let firstRef: string | null = null;
  for (const p of BA_SEARCH_PATHS) {
    const started = Date.now();
    try {
      const body = (await get(`${BA_BASE}${p}?was=Softwareentwickler&angebotsart=1&page=1&size=5`, KEY)) as Record<string, unknown>;
      const found = findAdArray(body);
      out(`OK    Bundesagentur ${p}: ${found.items.length} advert(s) of ${JSON.stringify(body.maxErgebnisse)} in ${Date.now() - started} ms`);
      out(`      answer keys: ${Object.keys(body).join(", ")}; adverts in: ${found.key ?? "(not found)"}`);
      const raw = found.items[0];
      if (raw) {
        const ad = baAdvert(raw);
        out(`      read as: ${ad ? `"${ad.title}" · ${ad.company} · ${ad.location ?? "no place"} · ${ad.postedAt?.toISOString().slice(0, 10) ?? "no date"} · dev=${ad.isDev} · flags=${ad.flags.join("/") || "-"}` : "(could not be read)"}`);
        out(`      raw place: ${JSON.stringify(raw.stellenlokationen ?? raw.arbeitsort ?? null).slice(0, 300)}`);
        out(`      raw employer: ${JSON.stringify(raw.firma ?? raw.arbeitgeber ?? null).slice(0, 150)} · dates: ${JSON.stringify(raw.veroeffentlichungszeitraum ?? null)} ${JSON.stringify(raw.datumErsteVeroeffentlichung ?? null)}`);
        firstRef ??= ad?.externalId ?? null;
      }
    } catch (err) {
      out(`FAIL  Bundesagentur ${p}: ${(err as Error).message}`);
    }
    await pause();
  }
  if (firstRef) {
    const code = Buffer.from(firstRef, "utf8").toString("base64");
    for (const p of BA_DETAIL_PATHS) {
      try {
        const d = (await get(`${BA_BASE}${p}/${code}`, KEY)) as Record<string, unknown>;
        const text = d.stellenangebotsBeschreibung ?? d.stellenbeschreibung ?? d.beschreibung;
        out(`OK    Bundesagentur text ${p}: keys ${Object.keys(d).slice(0, 15).join(", ")}; text ${typeof text === "string" ? `${text.length} characters` : "not found"}`);
      } catch (err) {
        out(`FAIL  Bundesagentur text ${p}: ${(err as Error).message}`);
      }
      await pause();
    }
  }
  try {
    const body = (await get(`${ARBEITNOW_BASE}?page=1`)) as { data?: { title?: string }[] };
    out(`OK    Arbeitnow: ${body.data?.length ?? 0} advert(s); first: ${body.data?.[0]?.title ?? "-"}`);
  } catch (err) {
    out(`FAIL  Arbeitnow: ${(err as Error).message}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
