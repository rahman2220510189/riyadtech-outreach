import { crawlPlanTask, crawlSiteTask, summarizeCrawl } from "../crawler/tasks.js";
import { summarizeFinder } from "../finder/jobs.js";
import { finderImportTask, finderPlanTask } from "../finder/tasks.js";
import { geonamesImportTask } from "../geonames/import.js";
import { jobAdsFetchTask, summarizeJobAds } from "../jobads/tasks.js";
import { studyAiTask, studyCatalogueTask, studyImportTask, studyProgramTask, studySiteTask, summarizeStudy } from "../study/watch.js";
import type { Summarizer } from "./store.js";
import type { TaskHandler } from "./types.js";

/** Every task kind the worker knows. Later phases add send and IMAP tasks. */
export const TASK_HANDLERS: Record<string, TaskHandler> = {
  "finder.plan": finderPlanTask,
  "finder.import": finderImportTask,
  "geonames.import": geonamesImportTask,
  "crawl.plan": crawlPlanTask,
  "crawl.site": crawlSiteTask,
  "jobads.fetch": jobAdsFetchTask,
  "study.import": studyImportTask,
  "study.site": studySiteTask,
  "study.program": studyProgramTask,
  "study.ai": studyAiTask,
  "study.catalogue": studyCatalogueTask,
};

export const JOB_SUMMARIZERS: Record<string, Summarizer> = {
  finder: summarizeFinder,
  crawl: summarizeCrawl,
  jobads: summarizeJobAds,
  studydir: summarizeStudy,
  studycheck: summarizeStudy,
  studyai: summarizeStudy,
};
