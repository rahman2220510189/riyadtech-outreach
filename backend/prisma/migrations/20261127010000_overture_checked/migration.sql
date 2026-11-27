-- Step 5.2: when Overture's addresses of a place were last checked (null = never). Leads imported
-- before step 5.1 are picked up once by the worker, so old areas need no new import.
ALTER TABLE "places" ADD COLUMN "overture_checked_at" TIMESTAMPTZ(3);
CREATE INDEX "places_overture_pending_idx" ON "places" ("id") WHERE "overture_checked_at" IS NULL AND cardinality("overture_emails") > 0;
