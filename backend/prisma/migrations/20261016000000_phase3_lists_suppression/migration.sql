-- Phase 3: suppression list, imported CSV lists, places.suppressed.
-- Generated from schema.prisma, then extended by hand (CHECK constraints at the end).


-- AlterTable
ALTER TABLE "places" ADD COLUMN     "suppressed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "suppression" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_lists" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "file_name" TEXT,
    "mapping" JSONB NOT NULL,
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "counts" JSONB NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "list_leads" (
    "id" BIGSERIAL NOT NULL,
    "list_id" BIGINT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "first_name" TEXT,
    "company" TEXT,
    "website" TEXT,
    "country" CHAR(2),
    "city" TEXT,
    "custom" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "place_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppression_created_at_idx" ON "suppression"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "suppression_kind_value_key" ON "suppression"("kind", "value");

-- CreateIndex
CREATE INDEX "list_leads_email_idx" ON "list_leads"("email");

-- CreateIndex
CREATE INDEX "list_leads_domain_idx" ON "list_leads"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "list_leads_list_id_email_key" ON "list_leads"("list_id", "email");

-- CreateIndex
CREATE INDEX "places_suppressed_idx" ON "places"("suppressed");

-- AddForeignKey
ALTER TABLE "list_leads" ADD CONSTRAINT "list_leads_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lead_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: allowed values, lower-case keys.
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_kind_chk" CHECK ("kind" IN ('email', 'domain'));
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_value_lower_chk" CHECK ("value" = lower(btrim("value")) AND length("value") >= 3);
ALTER TABLE "suppression" ADD CONSTRAINT "suppression_reason_chk" CHECK ("reason" IN ('unsubscribed', 'bounced', 'replied_no', 'manual', 'client'));
ALTER TABLE "list_leads" ADD CONSTRAINT "list_leads_email_lower_chk" CHECK ("email" = lower(btrim("email")) AND position('@' in "email") > 1);
ALTER TABLE "list_leads" ADD CONSTRAINT "list_leads_status_chk" CHECK ("status" IN ('ok', 'suppressed', 'duplicate', 'invalid'));
