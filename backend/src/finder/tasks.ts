import type { Db } from "../db/client.js";
import { withTxRetry } from "../db/retry.js";
import { FatalTaskError, type JsonObject, type NewTask, type TaskHandler } from "../jobs/types.js";
import { loadSeedData } from "../seed/files.js";
import { citiesBox, resolveArea } from "./area.js";
import { type CategoryRule, compileCategories } from "./categories.js";
import { type BBox, type CityPoint, NearestCity, bboxIntersection, bboxIntersects } from "./geo.js";
import { clearOutlineIndexes, getOutline, outlineIndex } from "./outlines.js";
import { ByteCounter, shortUrl } from "./overture/http.js";
import { groupConsecutive, openParquet, readRows, rowGroupInfos } from "./overture/parquet.js";
import { type Candidate, type FilterContext, PLACE_COLUMNS, type PlaceRow, filterPlace } from "./overture/places.js";
import { latestRelease, releaseFiles } from "./overture/stac.js";
import { areaKey, finderParamsSchema } from "./params.js";
import { checkStorage } from "./storage.js";
import { bump, emptyCounts, topN } from "./summary.js";

export const FINDER_JOB = "finder";

/** Payload of one import task (one run of consecutive row groups in one file). */
interface ImportPayload {
  release: string;
  url: string;
  byteLength?: number;
  groups: { index: number; rowStart: number; rowEnd: number }[];
  box: BBox;
  outlineKey: string | null;
  outlineKind: "country" | "region" | null;
  country: string;
  regionCode: string | null;
  minConfidence: number;
  categoryKeys: string[];
}

let rulesCache: CategoryRule[] | undefined;
const rules = () => (rulesCache ??= compileCategories(loadSeedData().categories));

/** Every category key of the chosen segments, or the chosen keys (checked against the segments). */
export function resolveCategoryKeys(segments: readonly string[], keys?: readonly string[]): string[] {
  const all = loadSeedData().categories.filter((c) => segments.includes(c.segment));
  if (!keys || keys.length === 0) return all.map((c) => c.key);
  const allowed = new Set(all.map((c) => c.key));
  const bad = keys.filter((k) => !allowed.has(k));
  if (bad.length > 0) throw new FatalTaskError(`Categories not in the chosen segments: ${bad.join(", ")}`);
  return [...new Set(keys)];
}

const nearestCache = new Map<string, NearestCity>();
async function nearestFor(db: Db, country: string): Promise<NearestCity> {
  let n = nearestCache.get(country);
  if (!n) {
    const cities = await db.location.findMany({
      where: { country, kind: "city", lat: { not: null }, lng: { not: null } },
      select: { name: true, lat: true, lng: true, timezone: true, regionCode: true },
    });
    n = new NearestCity(cities as CityPoint[]);
    nearestCache.set(country, n);
  }
  return n;
}

/** For tests and after a GeoNames import: rebuild the nearest-city indexes. */
export function clearFinderCaches(): void {
  nearestCache.clear();
  rulesCache = undefined;
  clearOutlineIndexes();
}

/**
 * Step 1 of a finder job: resolve the area, find the latest Overture release, get the
 * area's outline, choose only the files and row groups whose bounding boxes overlap,
 * then queue one import task per run of consecutive row groups.
 */
export const finderPlanTask: TaskHandler = async (ctx) => {
  const params = finderParamsSchema.parse(ctx.job.params);
  const categoryKeys = resolveCategoryKeys(params.segments, params.categoryKeys);
  const area = await resolveArea(ctx.db, params);
  const stac = ctx.env.OVERTURE_STAC_URL;
  const counter = new ByteCounter();

  await ctx.event("info", "Looking up the latest Overture release…");
  const release = ctx.settings.finder.release || (await latestRelease(stac));
  await ctx.event("info", `Area: ${area.label}. Overture release ${release}.`);

  // The area: a city box, or a box around the region's / country's GeoNames cities.
  let box: BBox | null;
  let outline: Awaited<ReturnType<typeof getOutline>>["outline"] = null;
  if (ctx.settings.finder.useOutlines) {
    await ctx.event("info", `Downloading the border of ${area.outlineKey} from Overture divisions (this can be large)…`);
    const got = await getOutline(
      ctx.db,
      stac,
      release,
      { key: area.outlineKey, kind: area.outlineKind, country: area.country, searchBox: area.countryBox },
      counter,
    );
    outline = got.outline;
    if (!outline) {
      if (area.kind !== "city") throw new FatalTaskError(`Overture has no outline for ${area.outlineKey} in release ${release}`);
      await ctx.event("warn", `No outline found for ${area.outlineKey}; using the city box only.`);
    } else {
      await ctx.event(
        "info",
        `Outline of ${area.outlineKey}: ${outline.pointCount} points${got.fromCache ? " (cached)" : ", downloaded from Overture divisions"}.`,
      );
    }
    box = area.cityBox ? (outline ? bboxIntersection(area.cityBox, outline.bbox) : area.cityBox) : (outline?.bbox ?? null);
  } else {
    box = area.cityBox ?? (await citiesBox(ctx.db, area.country, area.regionCode));
    if (!box) throw new FatalTaskError(`Regions and cities for ${area.countryName} are not loaded yet. Load them on the Finder page first.`);
    await ctx.event("info", "Area check: inside the box, and the address (when it has one) names the right country and state.");
  }
  if (!box) throw new FatalTaskError("The city box does not overlap the country or region outline");

  await ctx.event("info", "Reading the list of Overture place files…");
  const files = (await releaseFiles(stac, release, "places", "place")).filter((f) => bboxIntersects(f.bbox, box));
  await ctx.event("info", `${files.length} file(s) overlap the area; reading their row-group index…`);
  const tasks: NewTask[] = [];
  let rowGroups = 0;
  let unprunable = 0;
  for (const f of files) {
    const opened = await openParquet(f.url, f.byteLength, counter);
    const infos = rowGroupInfos(opened.metadata);
    const hits = infos.filter((g) => !g.bbox || bboxIntersects(g.bbox, box));
    unprunable += hits.filter((g) => !g.bbox).length;
    rowGroups += hits.length;
    for (const unit of groupConsecutive(hits, ctx.settings.finder.rowGroupsPerTask)) {
      const payload: ImportPayload = {
        release,
        url: f.url,
        ...(f.byteLength !== undefined ? { byteLength: f.byteLength } : {}),
        groups: unit.map((g) => ({ index: g.index, rowStart: g.rowStart, rowEnd: g.rowEnd })),
        box,
        outlineKey: outline ? outline.key : null,
        outlineKind: outline ? outline.kind : null,
        country: area.country,
        regionCode: area.regionCode,
        minConfidence: ctx.settings.finder.minConfidence,
        categoryKeys,
      };
      tasks.push({ kind: "finder.import", payload: payload as unknown as JsonObject });
    }
    await ctx.touch();
  }
  if (unprunable > 0) {
    await ctx.event("warn", `${unprunable} row groups have no bounding-box statistics and are read in full.`);
  }

  // Storage guard before any real import: use a finished dry run of the same import, if there is one.
  if (!ctx.job.dryRun) {
    const key = areaKey(params, categoryKeys);
    const dry = await ctx.db.job.findFirst({
      where: { kind: FINDER_JOB, dryRun: true, status: "done", params: { path: ["areaKey"], equals: key } },
      orderBy: { id: "desc" },
      select: { summary: true },
    });
    const expected = Number((dry?.summary as { kept?: number } | null)?.kept ?? 0);
    if (expected > 0) {
      const check = await checkStorage(ctx.db, expected, ctx.settings.storage.limitMb);
      if (!check.ok) {
        throw new FatalTaskError(
          `Storage limit: ${expected} places would bring the database to about ${check.projectedMb} MB (limit ${check.limitMb} MB).`,
        );
      }
      await ctx.event("info", `Storage check: about ${check.addedMb} MB for ${expected} places; database ${check.databaseMb} MB of ${check.limitMb} MB.`);
    }
  }

  await ctx.event(
    "info",
    `Reading ${rowGroups} of the release's row groups from ${files.length} file(s) in ${tasks.length} step(s).`,
  );
  return {
    result: { release, area: area.label, box, files: files.length, rowGroups, tasks: tasks.length, bytes: counter.bytes },
    newTasks: tasks,
  };
};

const STAGE_CHUNK = 500;

/** Writes candidates to staging and merges them into places in one statement (fixed order, retried on deadlock). */
async function stageAndMerge(
  db: Db,
  taskId: bigint,
  jobId: bigint,
  release: string,
  candidates: Candidate[],
): Promise<{ inserted: number; updated: number }> {
  const sorted = [...candidates].sort(
    (a, b) => a.segment.localeCompare(b.segment) || a.websiteDomain.localeCompare(b.websiteDomain) || a.overtureId.localeCompare(b.overtureId),
  );
  return withTxRetry(() =>
    db.$transaction(
      async (tx) => {
        await tx.stgOverturePlace.deleteMany({ where: { taskId } });
        for (let i = 0; i < sorted.length; i += STAGE_CHUNK) {
          await tx.stgOverturePlace.createMany({ data: sorted.slice(i, i + STAGE_CHUNK).map((c) => ({ taskId, ...c })) });
        }
        const rows = await tx.$queryRaw<{ inserted: boolean }[]>`
          WITH batch AS (
            SELECT s.segment, s.website_domain,
                   (array_agg(s.category_key ORDER BY s.confidence DESC, s.overture_id))[1] AS category_key,
                   (array_agg(s.name        ORDER BY s.confidence DESC, s.overture_id))[1] AS name,
                   (array_agg(s.website     ORDER BY s.confidence DESC, s.overture_id))[1] AS website,
                   (array_agg(s.country     ORDER BY s.confidence DESC, s.overture_id))[1] AS country,
                   (array_agg(s.region_code ORDER BY s.confidence DESC, s.overture_id))[1] AS region_code,
                   (array_agg(s.city        ORDER BY s.confidence DESC, s.overture_id))[1] AS city,
                   (array_agg(s.postcode    ORDER BY s.confidence DESC, s.overture_id))[1] AS postcode,
                   (array_agg(s.address     ORDER BY s.confidence DESC, s.overture_id))[1] AS address,
                   (array_agg(s.lat         ORDER BY s.confidence DESC, s.overture_id))[1] AS lat,
                   (array_agg(s.lng         ORDER BY s.confidence DESC, s.overture_id))[1] AS lng,
                   (array_agg(s.timezone    ORDER BY s.confidence DESC, s.overture_id))[1] AS timezone,
                   (array_agg(s.phone       ORDER BY s.confidence DESC, s.overture_id))[1] AS phone,
                   ARRAY(SELECT DISTINCT e FROM stg_overture_places s2, unnest(s2.emails) e
                          WHERE s2.task_id = ${taskId} AND s2.segment = s.segment
                            AND s2.website_domain = s.website_domain ORDER BY e) AS emails,
                   array_agg(DISTINCT s.overture_id ORDER BY s.overture_id) AS source_ids,
                   max(s.confidence) AS confidence
              FROM stg_overture_places s
             WHERE s.task_id = ${taskId}
             GROUP BY s.segment, s.website_domain
          )
          INSERT INTO places (segment, category_key, name, website, website_domain, country, region_code, city, postcode,
                              address, lat, lng, timezone, phone, overture_emails, source_ids, location_count, confidence,
                              release, first_job_id, last_job_id, created_at, updated_at)
          SELECT segment, category_key, name, website, website_domain, country, region_code, city, postcode,
                 address, lat, lng, timezone, phone, emails, source_ids, cardinality(source_ids), confidence,
                 ${release}, ${jobId}, ${jobId}, now(), now()
            FROM batch
           ORDER BY segment, website_domain
          ON CONFLICT (segment, website_domain) DO UPDATE SET
            source_ids      = ARRAY(SELECT DISTINCT x FROM unnest(places.source_ids || EXCLUDED.source_ids) x ORDER BY x),
            location_count  = cardinality(ARRAY(SELECT DISTINCT x FROM unnest(places.source_ids || EXCLUDED.source_ids) x)),
            overture_emails = ARRAY(SELECT DISTINCT x FROM unnest(places.overture_emails || EXCLUDED.overture_emails) x ORDER BY x),
            name        = CASE WHEN EXCLUDED.confidence > places.confidence THEN EXCLUDED.name ELSE places.name END,
            category_key = CASE WHEN EXCLUDED.confidence > places.confidence THEN EXCLUDED.category_key ELSE places.category_key END,
            address     = COALESCE(places.address, EXCLUDED.address),
            postcode    = COALESCE(places.postcode, EXCLUDED.postcode),
            city        = COALESCE(places.city, EXCLUDED.city),
            region_code = COALESCE(places.region_code, EXCLUDED.region_code),
            timezone    = COALESCE(places.timezone, EXCLUDED.timezone),
            phone       = COALESCE(places.phone, EXCLUDED.phone),
            confidence  = GREATEST(places.confidence, EXCLUDED.confidence),
            release     = EXCLUDED.release,
            last_job_id = EXCLUDED.last_job_id,
            updated_at  = now()
          RETURNING (xmax = 0) AS inserted`;
        await tx.stgOverturePlace.deleteMany({ where: { taskId } });
        const inserted = rows.filter((r) => r.inserted).length;
        return { inserted, updated: rows.length - inserted };
      },
      { timeout: 120_000 },
    ),
  );
}

/** Step 2: read a few row groups, keep the places that become leads, and (unless dry run) save them. */
export const finderImportTask: TaskHandler = async (ctx) => {
  const p = ctx.task.payload as unknown as ImportPayload;
  const counter = new ByteCounter();
  const counts = emptyCounts();
  const filter: FilterContext = {
    box: p.box,
    outline: p.outlineKey ? await outlineIndex(ctx.db, p.outlineKey, p.release) : null,
    outlineKind: p.outlineKind,
    country: p.country,
    regionCode: p.regionCode,
    minConfidence: p.minConfidence,
    rules: rules(),
    allowedKeys: new Set(p.categoryKeys),
    platforms: loadSeedData().platformDomains,
    nearest: await nearestFor(ctx.db, p.country),
    addressCheck: !p.outlineKey,
  };
  if (p.outlineKey && !filter.outline) {
    // Retrying cannot bring it back (the plan step saved it, and it has been replaced or removed since).
    throw new FatalTaskError(
      `The saved border of ${p.outlineKey} (Overture ${p.release}) is gone, so this job cannot continue. Start the search again.`,
    );
  }

  const opened = await openParquet(p.url, p.byteLength, counter);
  const kept: Candidate[] = [];
  for (const g of p.groups) {
    const rows = (await readRows(opened, g.rowStart, g.rowEnd, PLACE_COLUMNS, counter)) as PlaceRow[];
    counts.rowGroups++;
    counts.scanned += rows.length;
    for (const row of rows) {
      const r = filterPlace(row, filter);
      if ("kept" in r) {
        kept.push(r.kept);
        bump(counts.bySegment, r.kept.segment);
        bump(counts.byCategory, r.kept.categoryKey);
      } else {
        // Places far outside the box are expected (row groups are wider than the area): not interesting.
        if (r.skipped !== "outside_area") bump(counts.skipped, r.skipped);
        if (r.skipped === "unmapped" && r.category) bump(counts.unmapped, r.category);
      }
    }
    await ctx.touch();
  }
  counts.kept = kept.length;
  counts.unmapped = topN(counts.unmapped, 30);

  if (!ctx.job.dryRun && kept.length > 0) {
    const check = await checkStorage(ctx.db, kept.length, ctx.settings.storage.limitMb);
    if (!check.ok) {
      throw new FatalTaskError(
        `Storage limit reached: saving ${kept.length} places would bring the database to about ${check.projectedMb} MB (limit ${check.limitMb} MB). Free space or raise the limit, then resume.`,
        true,
      );
    }
    const merged = await stageAndMerge(ctx.db, ctx.task.id, ctx.job.id, p.release, kept);
    counts.inserted = merged.inserted;
    counts.updated = merged.updated;
  }
  counts.bytes = counter.bytes;
  ctx.log.debug({ file: shortUrl(p.url), ...counts }, "Import step done");
  return { result: counts as unknown as JsonObject };
};
