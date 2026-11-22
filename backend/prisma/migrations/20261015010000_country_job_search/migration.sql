-- Job search only: a country's companies can be found and crawled to apply for jobs, never e-mailed for sales.
ALTER TABLE "countries" ADD COLUMN "job_search" BOOLEAN NOT NULL DEFAULT false;

-- Riyad's goal is a developer job in Germany: Germany starts in job-search mode (outreach stays blocked).
UPDATE "countries" SET "job_search" = true WHERE "code" = 'DE';
