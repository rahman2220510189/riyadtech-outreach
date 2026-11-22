/**
 * npm run geonames:import -- [GB IE US AU] [--dir C:\path\to\files]
 *
 * Loads GeoNames regions and cities (population > 5,000) into `locations`.
 * Without country codes: every enabled country. With --dir: reads cities5000.zip
 * (or cities5000.txt) and admin1CodesASCII.txt from that folder instead of downloading.
 * The same import can be started from the Finder page (no command line needed).
 */
import { EnvError, loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { importGeonames } from "../geonames/import.js";
import { syncSeeds } from "../seed/sync.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const args = process.argv.slice(2);
  const dirAt = args.indexOf("--dir");
  const dir = dirAt >= 0 ? args[dirAt + 1] : undefined;
  const codes = args.filter((a, i) => /^[A-Za-z]{2}$/.test(a) && i !== dirAt + 1).map((a) => a.toUpperCase());

  const db = createDb(env);
  try {
    await syncSeeds(db, { info: () => undefined });
    const countries =
      codes.length > 0 ? codes : (await db.country.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code);
    process.stdout.write(`Loading GeoNames for ${countries.join(", ")} ${dir ? `from ${dir}` : `from ${env.GEONAMES_BASE_URL}`}...\n`);
    const started = Date.now();
    const result = await importGeonames(db, countries, dir ? { dir } : { baseUrl: env.GEONAMES_BASE_URL });
    for (const [c, n] of Object.entries(result.countries)) {
      process.stdout.write(`  ${c}: ${n.regions} regions, ${n.cities} cities\n`);
    }
    process.stdout.write(`Done in ${Math.round((Date.now() - started) / 1000)} s.\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvError) console.error(err.message);
  else console.error(`geonames:import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
