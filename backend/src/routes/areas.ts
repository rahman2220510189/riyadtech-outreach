import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { radiusForPopulation } from "../finder/geo.js";
import type { JobStore } from "../jobs/store.js";
import { loadSeedData } from "../seed/files.js";
import { AppError, errors } from "../lib/errors.js";

export interface AreasRoutesOptions {
  db: Db;
  jobs: JobStore;
}

const codeParam = z.object({ code: z.string().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase()) });

/** Countries, regions and cities for the area picker (all need login). */
export const areasRoutes: FastifyPluginCallback<AreasRoutesOptions> = (app, { db, jobs }, done) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/countries", async () => {
    // Market order from seed/countries.json (UK, Ireland, US, Australia, ...), enabled first.
    const order = new Map(loadSeedData().countries.map((c, i) => [c.code, i]));
    const [rows, counts] = await Promise.all([
      db.country.findMany(),
      db.location.groupBy({ by: ["country", "kind"], _count: { _all: true } }),
    ]);
    const countries = rows.sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        Number(b.jobSearch) - Number(a.jobSearch) ||
        (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99),
    );
    const count = (c: string, kind: string) => counts.find((x) => x.country === c && x.kind === kind)?._count._all ?? 0;
    return {
      items: countries.map((c) => ({
        code: c.code,
        name: c.name,
        enabled: c.enabled,
        blocked: c.blocked,
        allowWholeCountry: c.allowWholeCountry,
        regionImports: c.regionImports,
        jobSearch: c.jobSearch,
        timezones: c.timezones,
        outreachRules: c.outreachRules,
        regions: count(c.code, "region"),
        cities: count(c.code, "city"),
      })),
    };
  });

  app.get("/countries/:code/regions", async (request) => {
    const { code } = codeParam.parse(request.params);
    const rows = await db.location.findMany({
      where: { country: code, kind: "region" },
      orderBy: { name: "asc" },
      select: { regionCode: true, name: true },
    });
    return { items: rows.map((r) => ({ regionCode: r.regionCode, name: r.name })) };
  });

  const cityQuery = z.object({
    q: z.string().trim().max(80).optional(),
    region: z.string().max(10).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  });

  app.get("/countries/:code/cities", async (request) => {
    const { code } = codeParam.parse(request.params);
    const { q, region, limit } = cityQuery.parse(request.query);
    const rows = await db.location.findMany({
      where: {
        country: code,
        kind: "city",
        ...(region ? { regionCode: region } : {}),
        ...(q
          ? { OR: [{ asciiName: { startsWith: q, mode: "insensitive" } }, { name: { startsWith: q, mode: "insensitive" } }] }
          : {}),
      },
      orderBy: { population: "desc" },
      take: limit,
    });
    const regionNames = new Map(
      (
        await db.location.findMany({
          where: { country: code, kind: "region" },
          select: { regionCode: true, name: true },
        })
      ).map((r) => [r.regionCode, r.name]),
    );
    return {
      items: rows.map((c) => ({
        geonameId: c.geonameId,
        name: c.name,
        regionCode: c.regionCode,
        regionName: c.regionCode ? (regionNames.get(c.regionCode) ?? null) : null,
        population: c.population,
        lat: c.lat,
        lng: c.lng,
        timezone: c.timezone,
        defaultRadiusKm: radiusForPopulation(c.population),
      })),
    };
  });

  const switchBody = z.object({
    enabled: z.boolean(),
    /** "I have checked this country's cold-email rules." Needed for countries whose rules are not verified. */
    confirmRules: z.boolean().optional(),
    /** Extra confirmation for blocked countries (DE, AT). */
    confirmBlocked: z.boolean().optional(),
  });

  /** Switch a country on or off (Settings). Every change goes to the audit log. */
  app.patch("/countries/:code", async (request) => {
    const { code } = codeParam.parse(request.params);
    const body = switchBody.parse(request.body);
    const country = await db.country.findUnique({ where: { code } });
    if (!country) throw errors.notFound(`Unknown country ${code}`);
    const rules = country.outreachRules as { verified?: boolean };

    if (body.enabled && !country.enabled) {
      if (country.blocked && body.confirmBlocked !== true) {
        throw new AppError(
          400,
          "CONFIRMATION_REQUIRED",
          `${country.name} is blocked by default because cold e-mail there generally needs prior consent. Confirm that you have legal advice to enable it.`,
          { need: "confirmBlocked" },
        );
      }
      if (rules.verified !== true && body.confirmRules !== true) {
        throw new AppError(
          400,
          "CONFIRMATION_REQUIRED",
          `The cold-email rules for ${country.name} are not verified. Confirm that you have checked them.`,
          { need: "confirmRules" },
        );
      }
    }
    if (body.enabled === country.enabled) return { code, enabled: country.enabled };

    await db.$transaction([
      db.country.update({ where: { code }, data: { enabled: body.enabled } }),
      db.auditLog.create({
        data: {
          actor: request.admin?.email ?? null,
          action: body.enabled ? "country.enable" : "country.disable",
          entity: "country",
          entityId: code,
          details: {
            name: country.name,
            blocked: country.blocked,
            rulesVerified: rules.verified === true,
            confirmedRules: body.confirmRules === true,
            confirmedBlocked: body.confirmBlocked === true,
          },
          ip: request.ip,
        },
      }),
    ]);
    return { code, enabled: body.enabled };
  });

  /**
   * Job search only (Settings): the country's companies can be found and crawled to apply for
   * jobs, but nothing is ever sent to them. No legal confirmation needed; audited.
   */
  app.patch("/countries/:code/job-search", async (request) => {
    const { code } = codeParam.parse(request.params);
    const body = z.object({ jobSearch: z.boolean() }).parse(request.body);
    const country = await db.country.findUnique({ where: { code } });
    if (!country) throw errors.notFound(`Unknown country ${code}`);
    if (country.jobSearch === body.jobSearch) return { code, jobSearch: country.jobSearch };
    await db.$transaction([
      db.country.update({ where: { code }, data: { jobSearch: body.jobSearch } }),
      db.auditLog.create({
        data: {
          actor: request.admin?.email ?? null,
          action: body.jobSearch ? "country.job_search_on" : "country.job_search_off",
          entity: "country",
          entityId: code,
          details: { name: country.name },
          ip: request.ip,
        },
      }),
    ]);
    return { code, jobSearch: body.jobSearch };
  });

  const geonamesBody = z.object({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20).optional() });

  /** Loads GeoNames regions and cities (default: every enabled country) as a background job. */
  app.post("/geonames", async (request, reply) => {
    const body = geonamesBody.parse(request.body ?? {});
    const countries =
      body.countries ??
      (await db.country.findMany({ where: { OR: [{ enabled: true }, { jobSearch: true }] }, select: { code: true } })).map((c) => c.code);
    if (countries.length === 0) throw errors.badRequest("No enabled countries");
    const jobId = await jobs.createJob({
      kind: "geonames",
      params: { countries },
      tasks: [{ kind: "geonames.import", payload: { countries }, maxAttempts: 3 }],
      message: `Load regions and cities for ${countries.join(", ")}`,
    });
    void reply.status(202);
    return { jobId: Number(jobId) };
  });

  done();
};
