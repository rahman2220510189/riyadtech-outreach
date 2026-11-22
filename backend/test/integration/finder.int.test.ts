/**
 * Lead finder end to end on a real PostgreSQL, against Overture-shaped fixture files served
 * over HTTP (STAC catalog + zstd Parquet with range requests) and GeoNames fixture files.
 *
 * Cleans up exactly what it creates: fake release "1999-12-31.0", ".invalid" domains,
 * GeoNames ids >= 990000000, and the jobs it started. Runs only with TEST_DATABASE_URL.
 */
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../src/db/client.js";
import { resolveArea } from "../../src/finder/area.js";
import { createFinderJob } from "../../src/finder/jobs.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearOpenFiles, setFooterCacheDir } from "../../src/finder/overture/parquet.js";
import { clearStacCache } from "../../src/finder/overture/stac.js";
import { clearFinderCaches } from "../../src/finder/tasks.js";
import { JOB_SUMMARIZERS, TASK_HANDLERS } from "../../src/jobs/handlers.js";
import { JobRunner } from "../../src/jobs/runner.js";
import { defaultSettings, type Settings } from "../../src/settings/definitions.js";
import { syncSeeds } from "../../src/seed/sync.js";
import { type FixtureServer, startFixtureServer } from "../helpers/fixture-server.js";
import { testDatabaseUrl } from "../helpers/test-db.js";

const url = testDatabaseUrl();
const RELEASE = "1999-12-31.0";
const FAKE_GEONAME_MIN = 990_000_000;
const MANCHESTER = 990643123;
const AUSTIN = 990671654;
const BRISBANE = 990174003;

describe.skipIf(!url)("finder (integration)", () => {
  let db: Db;
  let server: FixtureServer;
  const jobIds: bigint[] = [];

  function runner(settings: Settings = defaultSettings()) {
    return new JobRunner({
      db,
      log: pino({ level: "silent" }),
      env: { OVERTURE_STAC_URL: server.stacUrl, GEONAMES_BASE_URL: server.geonamesUrl },
      handlers: TASK_HANDLERS,
      summarizers: JOB_SUMMARIZERS,
      settings: () => settings,
      concurrency: () => 2,
    });
  }

  async function run(params: object, dryRun: boolean, settings?: Settings) {
    const r = runner(settings);
    const id = await createFinderJob(r.store, params, dryRun);
    jobIds.push(id);
    await r.drain();
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    const events = await db.jobEvent.findMany({ where: { jobId: id }, orderBy: { id: "asc" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON for compact assertions
    return { id, job, summary: (job.summary ?? {}) as Record<string, any>, events: events.map((e) => e.message), r };
  }

  async function cleanup() {
    if (!db) return;
    await db.place.deleteMany({ where: { release: RELEASE } });
    await db.place.deleteMany({ where: { websiteDomain: { endsWith: ".invalid" } } });
    await db.stgOverturePlace.deleteMany({ where: { websiteDomain: { endsWith: ".invalid" } } });
    await db.areaOutline.deleteMany({ where: { release: RELEASE } });
    await db.location.deleteMany({ where: { geonameId: { gte: FAKE_GEONAME_MIN } } });
    if (jobIds.length > 0) await db.job.deleteMany({ where: { id: { in: jobIds } } });
  }

  const onSigint = () => void cleanup().finally(() => process.exit(130));

  beforeAll(async () => {
    process.once("SIGINT", onSigint);
    db = createDb({ DATABASE_URL: url ?? "", DB_POOL_MAX: 5, NODE_ENV: "test" });
    server = await startFixtureServer();
    clearStacCache();
    clearOpenFiles();
    clearFinderCaches();
    await cleanup();
    await syncSeeds(db, { info: () => undefined });

    // GeoNames through the real job path (download zip over HTTP, parse, upsert).
    const r = runner();
    const id = await r.store.createJob({
      kind: "geonames",
      params: { countries: ["GB", "IE", "US", "AU"] },
      tasks: [{ kind: "geonames.import", payload: { countries: ["GB", "IE", "US", "AU"] } }],
    });
    jobIds.push(id);
    await r.drain();
    clearFinderCaches();
  }, 60_000);

  afterAll(async () => {
    process.off("SIGINT", onSigint);
    await cleanup();
    await server?.close();
    await db?.$disconnect();
  }, 60_000);

  it("loaded GeoNames regions and cities (not Germany, not hills)", async () => {
    const fake = { geonameId: { gte: FAKE_GEONAME_MIN } };
    const cities = await db.location.findMany({ where: { ...fake, kind: "city" }, orderBy: { geonameId: "asc" } });
    expect(cities.map((c) => c.name)).not.toContain("Berlin");
    expect(cities.map((c) => c.name)).not.toContain("Some Hill");
    expect(cities.find((c) => c.geonameId === BRISBANE)).toMatchObject({ regionCode: "AU-QLD", timezone: "Australia/Brisbane" });
    const regions = await db.location.findMany({ where: { ...fake, kind: "region" } });
    expect(regions.map((r) => r.regionCode).sort()).toEqual(["AU-NSW", "AU-QLD", "GB-ENG", "GB-SCT", "IE-L", "US-OK", "US-TX"]);
  });

  it("refuses blocked, disabled and too-large areas", async () => {
    await expect(resolveArea(db, { country: "AT", segments: ["A"] })).rejects.toThrow(/blocked/);
    // Germany is in job-search mode (searchable), but still only per city.
    await expect(resolveArea(db, { country: "DE", segments: ["A"] })).rejects.toThrow(/too large/);
    await expect(resolveArea(db, { country: "NL", segments: ["A"] })).rejects.toThrow(/not enabled/);
    await expect(resolveArea(db, { country: "GB", segments: ["A"] })).rejects.toThrow(/too large/);
    await expect(resolveArea(db, { country: "US", segments: ["A"] })).rejects.toThrow(/too large/);
    await expect(resolveArea(db, { country: "IE", segments: ["A"] })).resolves.toMatchObject({ kind: "country" });
    await expect(resolveArea(db, { country: "GB", regionCode: "GB-ENG", segments: ["A"] })).rejects.toThrow(/not available for United Kingdom; choose a city/);
  });

  it("dry run for Manchester: counts by segment and reason, saves nothing, reads only overlapping data", async () => {
    server.requests.clear();
    const { job, summary, events } = await run({ country: "GB", cityGeonameId: MANCHESTER, segments: ["A", "B"] }, true);
    expect(job.status).toBe("done");
    expect(summary).toMatchObject({
      release: RELEASE,
      // 8 businesses; the two Brightsmile locations share one domain (merged when saved).
      // Without outlines (default) "Nowhere Dental" (no address) stays: it is inside the city box.
      kept: 9,
      bySegment: { A: 2, B: 7 },
      byCategory: { dentist: 5, web_design: 1, software_development: 1, law_firm: 1, aesthetic_clinic: 1 },
      skipped: { no_website: 1, low_confidence: 1, closed: 1, unmapped: 2, platform_website: 1 },
      inserted: 0,
    });
    expect(summary).not.toHaveProperty("skipped.outside_outline");
    expect(summary.unmapped).toMatchObject({ casual_eatery: 1, motel: 1 });
    // Only the European place file was touched, London's row groups were pruned, no divisions were read.
    const paths = [...server.requests.keys()];
    expect(paths.some((p) => p.includes("places/part-00001"))).toBe(true);
    expect(paths.some((p) => p.includes("places/part-00000") || p.includes("places/part-00002"))).toBe(false);
    expect(paths.some((p) => p.includes("divisions"))).toBe(false);
    expect(summary.rowGroupsPlanned).toBeLessThan(11);
    expect(summary.bytes).toBeGreaterThan(1000); // footer + the chosen row groups' columns
    expect(summary.bytes).toBeLessThanOrEqual(server.bytesServed());
    expect(events.join("\n")).toMatch(/Area check: inside the box, and the address/);
    expect(await db.place.count({ where: { release: RELEASE } })).toBe(0);
  }, 60_000);

  it("downloads each row group in one request and caches file footers on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "footers-"));
    setFooterCacheDir(dir);
    try {
      clearOpenFiles();
      server.ranges.length = 0;
      const first = await run({ country: "GB", cityGeonameId: MANCHESTER, segments: ["A", "B"] }, true);
      const placeRanges = server.ranges.filter((r) => r.startsWith("/data/places/"));
      // footer (1-2 reads) + one request for the single row group (11 columns coalesced)
      expect(placeRanges.length).toBeLessThanOrEqual(3);
      expect(first.summary.rowGroups).toBe(1);

      clearOpenFiles(); // like a new process: the footer must come from disk
      server.ranges.length = 0;
      const second = await run({ country: "GB", cityGeonameId: MANCHESTER, segments: ["A", "B"] }, true);
      expect(second.summary.kept).toBe(first.summary.kept);
      expect(server.ranges.filter((r) => r.startsWith("/data/places/"))).toHaveLength(1);
      expect(Number(second.summary.bytes)).toBeLessThan(Number(first.summary.bytes));
    } finally {
      setFooterCacheDir(null);
      clearOpenFiles();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("with outlines switched on, the border from Overture divisions removes places outside it", async () => {
    const withOutlines: Settings = { ...defaultSettings(), finder: { ...defaultSettings().finder, useOutlines: true } };
    server.requests.clear();
    const { summary, events } = await run({ country: "GB", cityGeonameId: MANCHESTER, segments: ["A", "B"] }, true, withOutlines);
    expect(summary).toMatchObject({ kept: 8, skipped: { outside_outline: 1 } });
    expect(events.join("\n")).toMatch(/Outline of GB: \d+ points, downloaded/);
    expect([...server.requests.keys()].some((p) => p.includes("divisions"))).toBe(true);
    const again = await run({ country: "GB", cityGeonameId: MANCHESTER, segments: ["A", "B"] }, true, withOutlines);
    expect(again.events.join("\n")).toMatch(/\(cached\)/);
    const tx = await run({ country: "US", regionCode: "US-TX", segments: ["B"] }, true, withOutlines);
    expect(tx.summary).toMatchObject({ kept: 3 });
    expect(tx.events.join("\n")).toMatch(/Outline of US-TX/);
  }, 60_000);

  it("stops (no retries) when the border saved by the plan step is gone", async () => {
    const withOutlines: Settings = { ...defaultSettings(), finder: { ...defaultSettings().finder, useOutlines: true } };
    const r = runner(withOutlines);
    const id = await createFinderJob(r.store, { country: "GB", cityGeonameId: MANCHESTER, segments: ["A"] }, true);
    jobIds.push(id);
    await r.drain(1, id); // plan only: saves the GB border and queues the import step
    await db.areaOutline.deleteMany({ where: { key: "GB", release: RELEASE } });
    clearFinderCaches();
    await r.drain(10_000, id);
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("failed");
    const tasks = await db.jobTask.findMany({ where: { jobId: id, kind: "finder.import" } });
    expect(tasks.every((t) => t.attempts === 1)).toBe(true);
    const events = await db.jobEvent.findMany({ where: { jobId: id } });
    expect(events.map((e) => e.message).join("\n")).toMatch(/saved border of GB .* is gone/);
    clearFinderCaches();
  }, 60_000);

  it("real import for Manchester stores only places with websites, merges locations, and is repeatable", async () => {
    const first = await run({ country: "GB", cityGeonameId: MANCHESTER, segments: ["A", "B"] }, false);
    expect(first.job.status).toBe("done");
    expect(first.summary).toMatchObject({ kept: 9, inserted: 8, updated: 0 });
    expect(first.events.join("\n")).toMatch(/Storage check/); // the dry run gave an estimate

    const places = await db.place.findMany({ where: { release: RELEASE, country: "GB" }, orderBy: { websiteDomain: "asc" } });
    expect(places.map((p) => p.websiteDomain)).toEqual([
      "brightsmile.invalid",
      "edgedental.invalid",
      "glowaesthetics.invalid",
      "harperlaw.invalid",
      "northcode.invalid",
      "nowheredental.invalid",
      "pixelandpine.invalid",
      "smiledental-mcr.invalid",
    ]);
    expect(places.every((p) => p.website.startsWith("https://"))).toBe(true);
    const bright = places.find((p) => p.websiteDomain === "brightsmile.invalid")!;
    expect(bright).toMatchObject({ locationCount: 2, segment: "B", categoryKey: "dentist", name: "Brightsmile Dental Didsbury" });
    expect(bright.sourceIds.sort()).toEqual(["gb-2a", "gb-2b"]);
    const smile = places.find((p) => p.websiteDomain === "smiledental-mcr.invalid")!;
    expect(smile).toMatchObject({ overtureEmails: ["hello@smiledental-mcr.invalid"], timezone: "Europe/London", phone: "+44 161 000 0001" });
    expect(places.find((p) => p.websiteDomain === "pixelandpine.invalid")).toMatchObject({ segment: "A", categoryKey: "web_design" });

    const again = await run({ country: "GB", cityGeonameId: MANCHESTER, segments: ["A", "B"] }, false);
    expect(again.summary).toMatchObject({ kept: 9, inserted: 0, updated: 8 });
    expect(await db.place.count({ where: { release: RELEASE, country: "GB" } })).toBe(8);
    expect((await db.place.findFirstOrThrow({ where: { websiteDomain: "brightsmile.invalid" } })).locationCount).toBe(2);
  }, 60_000);

  it("Austin (US city) reads the US file only and stores Texas and its time zone", async () => {
    server.requests.clear();
    const { job, summary } = await run({ country: "US", cityGeonameId: AUSTIN, segments: ["A", "B"] }, false);
    expect(job.status).toBe("done");
    expect(summary).toMatchObject({ kept: 5, inserted: 5, bySegment: { A: 2, B: 3 } });
    expect([...server.requests.keys()].some((p) => p.includes("places/part-00001"))).toBe(false);
    const us = await db.place.findMany({ where: { release: RELEASE, country: "US" } });
    expect(us.every((p) => p.regionCode === "US-TX" && p.timezone === "America/Chicago")).toBe(true);
  }, 60_000);

  it("region (Texas), whole country (Ireland) and Brisbane dry runs give counts per segment", async () => {
    const tx = await run({ country: "US", regionCode: "US-TX", segments: ["B"] }, true);
    expect(tx.summary).toMatchObject({ kept: 3, bySegment: { B: 3 } });
    const ie = await run({ country: "IE", segments: ["A", "B"] }, true);
    expect(ie.summary).toMatchObject({ kept: 3, bySegment: { A: 1, B: 2 } });
    const bne = await run({ country: "AU", cityGeonameId: BRISBANE, segments: ["A", "B"], categoryKeys: ["dentist", "physiotherapy"] }, true);
    expect(bne.summary).toMatchObject({ kept: 2, byCategory: { dentist: 1, physiotherapy: 1 }, skipped: { other_category: 1 } });
  }, 60_000);

  it("storage guard: refuses up front after a dry run, and pauses a running import (resume continues)", async () => {
    const tiny: Settings = { ...defaultSettings(), storage: { limitMb: 1 } };
    // A dry run exists for this exact import (previous test) -> the plan refuses at once.
    const refused = await run({ country: "US", regionCode: "US-TX", segments: ["B"] }, false, tiny);
    expect(refused.job.status).toBe("failed");
    expect(refused.job.error).toMatch(/Storage limit/);

    // No dry run for this one -> the import step pauses the job when saving would pass the limit.
    const paused = await run({ country: "AU", cityGeonameId: BRISBANE, radiusKm: 12, segments: ["A", "B"] }, false, tiny);
    expect(paused.job.status).toBe("paused");
    expect(paused.job.error).toMatch(/Storage limit reached/);
    expect(await db.place.count({ where: { release: RELEASE, country: "AU" } })).toBe(0);

    const r = runner(); // normal limit again
    await r.store.setStatus(paused.id, "resume");
    await r.drain();
    const done = await db.job.findUniqueOrThrow({ where: { id: paused.id } });
    expect(done.status).toBe("done");
    expect(await db.place.count({ where: { release: RELEASE, country: "AU" } })).toBe(3);
  }, 60_000);

  it("draining one job never runs another job's steps (CLI)", async () => {
    const r = runner();
    const other = await createFinderJob(r.store, { country: "IE", segments: ["A"] }, true);
    const mine = await createFinderJob(r.store, { country: "AU", cityGeonameId: BRISBANE, segments: ["B"] }, true);
    jobIds.push(other, mine);
    await r.drain(10_000, mine);
    expect((await db.job.findUniqueOrThrow({ where: { id: mine } })).status).toBe("done");
    expect(await db.jobTask.count({ where: { jobId: other, status: "queued" } })).toBe(1);
    await r.store.setStatus(other, "cancel");
  }, 60_000);

  it("pause and cancel stop a job before its steps run", async () => {
    const r = runner();
    const id = await createFinderJob(r.store, { country: "IE", segments: ["A"] }, true);
    jobIds.push(id);
    expect(await r.store.setStatus(id, "pause")).toBe("paused");
    expect(await r.drain()).toBe(0);
    expect(await r.store.setStatus(id, "cancel")).toBe("cancelled");
    expect(await db.jobTask.count({ where: { jobId: id, status: "cancelled" } })).toBe(1);
    expect(await r.store.setStatus(id, "resume")).toBe("cancelled");
  });
});
