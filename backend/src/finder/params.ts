import { z } from "zod";

/** What the user picks on the Finder page. */
export const finderParamsSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/),
    regionCode: z.string().regex(/^[A-Z]{2}-[A-Z0-9]{1,4}$/).optional(),
    cityGeonameId: z.number().int().positive().optional(),
    /** City search radius; default depends on the city's population. */
    radiusKm: z.number().min(1).max(50).optional(),
    segments: z.array(z.enum(["A", "B"])).min(1).max(2),
    /** Category keys; default: every category of the chosen segments. */
    categoryKeys: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(50).optional(),
  })
  .refine((p) => !(p.regionCode && p.cityGeonameId), { message: "Choose a region or a city, not both" });

export type FinderParams = z.infer<typeof finderParamsSchema>;

/** Same area + same filters = same key (used to find a previous dry run of the same import). */
export function areaKey(p: FinderParams, categoryKeys: string[]): string {
  return [
    p.country,
    p.regionCode ?? "",
    p.cityGeonameId ?? "",
    p.radiusKm ?? "",
    [...p.segments].sort().join(""),
    [...categoryKeys].sort().join(","),
  ].join("|");
}
