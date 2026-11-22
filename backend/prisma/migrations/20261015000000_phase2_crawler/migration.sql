-- Phase 2: website crawls, e-mail addresses, signals, MX cache, lead scores on places.
-- Generated from schema.prisma, then extended by hand (CHECK constraints at the end).


-- AlterTable
ALTER TABLE "places" ADD COLUMN     "best_offer" TEXT,
ADD COLUMN     "crawl_status" TEXT,
ADD COLUMN     "crawled_at" TIMESTAMPTZ(3),
ADD COLUMN     "first_name" TEXT,
ADD COLUMN     "fit_score" SMALLINT,
ADD COLUMN     "lead_score" SMALLINT,
ADD COLUMN     "need_score" SMALLINT,
ADD COLUMN     "primary_email" TEXT,
ADD COLUMN     "signal_line" TEXT;

-- CreateTable
CREATE TABLE "domain_crawls" (
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "final_url" TEXT,
    "http_status" INTEGER,
    "pages" JSONB NOT NULL,
    "robots" JSONB,
    "tech" TEXT[],
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL,
    "job_id" BIGINT,

    CONSTRAINT "domain_crawls_pkey" PRIMARY KEY ("domain")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" BIGSERIAL NOT NULL,
    "place_id" BIGINT NOT NULL,
    "email" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "domain_match" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "first_name" TEXT,
    "context" TEXT,
    "mx_valid" BOOLEAN,
    "source_url" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'crawl',
    "lawful_basis" TEXT NOT NULL DEFAULT 'legitimate_interest_b2b',
    "found_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" BIGSERIAL NOT NULL,
    "place_id" BIGINT NOT NULL,
    "key" TEXT NOT NULL,
    "score" TEXT NOT NULL,
    "weight" SMALLINT NOT NULL,
    "value" TEXT,
    "evidence_url" TEXT,
    "snippet" TEXT,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mx_checks" (
    "domain" TEXT NOT NULL,
    "has_mx" BOOLEAN,
    "hosts" TEXT[],
    "error" TEXT,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mx_checks_pkey" PRIMARY KEY ("domain")
);

-- CreateIndex
CREATE INDEX "domain_crawls_finished_at_idx" ON "domain_crawls"("finished_at");

-- CreateIndex
CREATE UNIQUE INDEX "emails_email_key" ON "emails"("email");

-- CreateIndex
CREATE INDEX "emails_place_id_idx" ON "emails"("place_id");

-- CreateIndex
CREATE INDEX "emails_domain_idx" ON "emails"("domain");

-- CreateIndex
CREATE INDEX "signals_key_idx" ON "signals"("key");

-- CreateIndex
CREATE UNIQUE INDEX "signals_place_id_key_key" ON "signals"("place_id", "key");

-- CreateIndex
CREATE INDEX "places_crawl_status_idx" ON "places"("crawl_status");

-- CreateIndex
CREATE INDEX "places_lead_score_idx" ON "places"("lead_score" DESC);

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "places"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: the database enforces the allowed values.
ALTER TABLE "emails" ADD CONSTRAINT "emails_email_lower_chk" CHECK ("email" = lower(btrim("email")) AND position('@' in "email") > 1);
ALTER TABLE "emails" ADD CONSTRAINT "emails_kind_chk" CHECK ("kind" IN ('generic', 'named', 'role'));
ALTER TABLE "emails" ADD CONSTRAINT "emails_domain_match_chk" CHECK ("domain_match" IN ('own', 'free', 'other'));
ALTER TABLE "emails" ADD CONSTRAINT "emails_origin_chk" CHECK ("origin" IN ('crawl', 'overture', 'csv'));
ALTER TABLE "signals" ADD CONSTRAINT "signals_score_chk" CHECK ("score" IN ('need', 'fit'));
ALTER TABLE "places" ADD CONSTRAINT "places_scores_chk" CHECK (
  ("fit_score" IS NULL OR "fit_score" BETWEEN 0 AND 100) AND
  ("need_score" IS NULL OR "need_score" BETWEEN 0 AND 100) AND
  ("lead_score" IS NULL OR "lead_score" BETWEEN 0 AND 100));
ALTER TABLE "places" ADD CONSTRAINT "places_best_offer_chk" CHECK ("best_offer" IS NULL OR "best_offer" IN ('chatbot', 'agent'));
