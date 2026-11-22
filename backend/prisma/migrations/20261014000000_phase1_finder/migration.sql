-- Phase 1: countries, locations, outlines, category map, places, job queue.
-- Generated from schema.prisma, then extended by hand (see the end of the file).

-- CreateTable
CREATE TABLE "countries" (
    "code" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "allow_whole_country" BOOLEAN NOT NULL DEFAULT false,
    "timezones" TEXT[],
    "bbox" DOUBLE PRECISION[],
    "outreach_rules" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" BIGSERIAL NOT NULL,
    "geoname_id" INTEGER NOT NULL,
    "country" CHAR(2) NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ascii_name" TEXT NOT NULL,
    "admin1_code" TEXT,
    "region_code" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "population" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "area_outlines" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "release" TEXT NOT NULL,
    "geometry" JSONB NOT NULL,
    "bbox" DOUBLE PRECISION[],
    "point_count" INTEGER NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "area_outlines_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "categories_map" (
    "key" TEXT NOT NULL,
    "segment" CHAR(1) NOT NULL,
    "label" TEXT NOT NULL,
    "nodes" TEXT[],
    "exclude_nodes" TEXT[],
    "value" SMALLINT NOT NULL,
    "sort" INTEGER NOT NULL,

    CONSTRAINT "categories_map_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "stg_overture_places" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT NOT NULL,
    "overture_id" TEXT NOT NULL,
    "segment" CHAR(1) NOT NULL,
    "category_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "website_domain" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "region_code" TEXT,
    "city" TEXT,
    "postcode" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "timezone" TEXT,
    "phone" TEXT,
    "emails" TEXT[],
    "confidence" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stg_overture_places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "places" (
    "id" BIGSERIAL NOT NULL,
    "segment" CHAR(1) NOT NULL,
    "category_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "website_domain" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "region_code" TEXT,
    "city" TEXT,
    "postcode" TEXT,
    "address" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "timezone" TEXT,
    "phone" TEXT,
    "overture_emails" TEXT[],
    "source_ids" TEXT[],
    "location_count" INTEGER NOT NULL DEFAULT 1,
    "confidence" REAL NOT NULL,
    "release" TEXT NOT NULL,
    "first_job_id" BIGINT,
    "last_job_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "params" JSONB NOT NULL,
    "summary" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_tasks" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" BIGSERIAL NOT NULL,
    "job_id" BIGINT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "locations_geoname_id_key" ON "locations"("geoname_id");

-- CreateIndex
CREATE INDEX "locations_country_kind_population_idx" ON "locations"("country", "kind", "population" DESC);

-- CreateIndex
CREATE INDEX "stg_overture_places_task_id_idx" ON "stg_overture_places"("task_id");

-- CreateIndex
CREATE INDEX "places_country_region_code_idx" ON "places"("country", "region_code");

-- CreateIndex
CREATE INDEX "places_category_key_idx" ON "places"("category_key");

-- CreateIndex
CREATE UNIQUE INDEX "places_segment_website_domain_key" ON "places"("segment", "website_domain");

-- CreateIndex
CREATE INDEX "jobs_kind_created_at_idx" ON "jobs"("kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_tasks_status_run_after_idx" ON "job_tasks"("status", "run_after");

-- CreateIndex
CREATE INDEX "job_tasks_job_id_status_idx" ON "job_tasks"("job_id", "status");

-- CreateIndex
CREATE INDEX "job_events_job_id_id_idx" ON "job_events"("job_id", "id");

-- AddForeignKey
ALTER TABLE "job_tasks" ADD CONSTRAINT "job_tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written additions (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------

-- Staging is throw-away: skip the write-ahead log.
ALTER TABLE "stg_overture_places" SET UNLOGGED;

ALTER TABLE "places" ADD CONSTRAINT "places_segment_check" CHECK ("segment" IN ('A', 'B'));
ALTER TABLE "stg_overture_places" ADD CONSTRAINT "stg_overture_places_segment_check" CHECK ("segment" IN ('A', 'B'));
ALTER TABLE "categories_map" ADD CONSTRAINT "categories_map_segment_check" CHECK ("segment" IN ('A', 'B'));
ALTER TABLE "categories_map" ADD CONSTRAINT "categories_map_value_check" CHECK ("value" BETWEEN 1 AND 5);
ALTER TABLE "locations" ADD CONSTRAINT "locations_kind_check" CHECK ("kind" IN ('region', 'city'));
ALTER TABLE "places" ADD CONSTRAINT "places_domain_lowercase" CHECK ("website_domain" = lower("website_domain"));
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_check"
  CHECK ("status" IN ('queued', 'running', 'paused', 'done', 'failed', 'cancelled'));
ALTER TABLE "job_tasks" ADD CONSTRAINT "job_tasks_status_check"
  CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'cancelled'));
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_level_check" CHECK ("level" IN ('info', 'warn', 'error'));
