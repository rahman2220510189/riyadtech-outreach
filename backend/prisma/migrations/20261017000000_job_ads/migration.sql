-- Job adverts from public job APIs (Bundesagentur für Arbeit Jobsuche, Arbeitnow) for Riyad's own job search.

-- CreateTable
CREATE TABLE "job_ads" (
    "id" BIGSERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "company_key" TEXT NOT NULL,
    "location" TEXT,
    "city" TEXT,
    "postcode" TEXT,
    "country" CHAR(2),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "url" TEXT NOT NULL,
    "external_url" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "job_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "role" TEXT,
    "is_dev" BOOLEAN NOT NULL DEFAULT false,
    "stack_match" BOOLEAN NOT NULL DEFAULT false,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "posted_at" TIMESTAMPTZ(3),
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "place_id" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_ads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_ads_is_dev_posted_at_idx" ON "job_ads"("is_dev", "posted_at" DESC);

-- CreateIndex
CREATE INDEX "job_ads_status_idx" ON "job_ads"("status");

-- CreateIndex
CREATE INDEX "job_ads_company_key_idx" ON "job_ads"("company_key");

-- CreateIndex
CREATE INDEX "job_ads_place_id_idx" ON "job_ads"("place_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_ads_source_external_id_key" ON "job_ads"("source", "external_id");

-- AddForeignKey
ALTER TABLE "job_ads" ADD CONSTRAINT "job_ads_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Allowed values (the database enforces them too).
ALTER TABLE "job_ads" ADD CONSTRAINT "job_ads_source_check" CHECK ("source" IN ('ba', 'arbeitnow'));
ALTER TABLE "job_ads" ADD CONSTRAINT "job_ads_status_check" CHECK ("status" IN ('new', 'saved', 'hidden', 'applied'));
ALTER TABLE "job_ads" ADD CONSTRAINT "job_ads_company_key_check" CHECK ("company_key" = lower("company_key"));
