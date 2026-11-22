import type { JobStore, Summarizer } from "../jobs/store.js";
import type { JsonObject } from "../jobs/types.js";
import { areaKey, type FinderParams, finderParamsSchema } from "./params.js";
import { addCounts, emptyCounts, topN } from "./summary.js";
import { FINDER_JOB, resolveCategoryKeys } from "./tasks.js";

/** Creates a finder job (import or dry run): one plan task, which then queues the import steps. */
export async function createFinderJob(store: JobStore, input: unknown, dryRun: boolean, label?: string): Promise<bigint> {
  const params: FinderParams = finderParamsSchema.parse(input);
  const categoryKeys = resolveCategoryKeys(params.segments, params.categoryKeys);
  const stored = {
    ...params,
    categoryKeys,
    areaKey: areaKey(params, categoryKeys),
    ...(label ? { label } : {}),
  } satisfies JsonObject;
  return store.createJob({
    kind: FINDER_JOB,
    params: stored,
    dryRun,
    tasks: [{ kind: "finder.plan", payload: {}, maxAttempts: 3 }],
    message: dryRun ? "Dry run created (counts only, nothing is saved)" : "Import created",
  });
}

export const summarizeFinder: Summarizer = (tasks) => {
  const plan = tasks.find((t) => t.kind === "finder.plan")?.result ?? {};
  const imports = tasks.filter((t) => t.kind === "finder.import");
  const total = emptyCounts();
  for (const t of imports) if (t.status === "done") addCounts(total, t.result);
  return {
    release: (plan.release as string | undefined) ?? null,
    area: (plan.area as string | undefined) ?? null,
    files: (plan.files as number | undefined) ?? 0,
    rowGroupsPlanned: (plan.rowGroups as number | undefined) ?? 0,
    steps: imports.length,
    stepsDone: imports.filter((t) => t.status === "done").length,
    stepsFailed: imports.filter((t) => t.status === "failed").length,
    ...total,
    bytes: total.bytes + ((plan.bytes as number | undefined) ?? 0),
    unmapped: topN(total.unmapped, 20),
  };
};
