import { createCrawlJob } from "../crawler/tasks.js";
import type { Db } from "../db/client.js";
import type { JobStore } from "../jobs/store.js";
import { readyWhere } from "../leads/ready.js";
import type { Settings } from "../settings/definitions.js";

/** How many websites one background crawl takes. */
export const AHEAD_BATCH = 100;

/**
 * Addendum 2 §2.3, "work ahead": while the worker is awake and no crawl is running, the websites of
 * "Ready now" leads that were never crawled are read in the background, a batch at a time, so their
 * opening lines and scores are there before a campaign needs them. The crawler's politeness
 * (robots.txt, delays, concurrency, user agent) is exactly the same as for a crawl I start myself.
 */
export async function crawlAhead(db: Db, jobs: JobStore, settings: Settings): Promise<bigint | null> {
  const busy = await db.job.count({ where: { kind: "crawl", status: { in: ["queued", "running", "paused"] } } });
  if (busy > 0) return null;
  const outreachCountries = (await db.country.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code);
  if (outreachCountries.length === 0) return null;
  const rows = await db.place.findMany({
    where: { AND: [readyWhere({ outreachCountries, minLeadScore: settings.scores.readyMinLeadScore }), { crawlStatus: null }] },
    orderBy: [{ confidence: "desc" }, { id: "asc" }],
    take: AHEAD_BATCH,
    select: { id: true },
  });
  if (rows.length === 0) return null;
  return createCrawlJob(jobs, { placeIds: rows.map((r) => Number(r.id)), onlyNew: true, limit: rows.length }, `Background: ${rows.length} ready websites not read yet`);
}
