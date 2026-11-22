-- AlterTable
ALTER TABLE "study_programs" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'manual';

-- CreateTable
CREATE TABLE "study_universities" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ror_id" TEXT,
    "wikidata_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "note" TEXT,
    "last_checked_at" TIMESTAMPTZ(3),
    "program_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_universities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_pages" (
    "id" BIGSERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "university_id" BIGINT,
    "program_id" BIGINT,
    "last_status" TEXT,
    "last_error" TEXT,
    "extracted" JSONB,
    "signature" TEXT,
    "last_fetched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_findings" (
    "id" BIGSERIAL NOT NULL,
    "program_id" BIGINT NOT NULL,
    "page_id" BIGINT,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "snippet" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),

    CONSTRAINT "study_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "study_universities_domain_key" ON "study_universities"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "study_universities_program_id_key" ON "study_universities"("program_id");

-- CreateIndex
CREATE INDEX "study_universities_status_country_code_idx" ON "study_universities"("status", "country_code");

-- CreateIndex
CREATE UNIQUE INDEX "study_pages_url_key" ON "study_pages"("url");

-- CreateIndex
CREATE INDEX "study_pages_program_id_idx" ON "study_pages"("program_id");

-- CreateIndex
CREATE INDEX "study_pages_university_id_idx" ON "study_pages"("university_id");

-- CreateIndex
CREATE INDEX "study_findings_status_idx" ON "study_findings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "study_findings_program_id_type_value_key" ON "study_findings"("program_id", "type", "value");

-- AddForeignKey
ALTER TABLE "study_universities" ADD CONSTRAINT "study_universities_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "study_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_pages" ADD CONSTRAINT "study_pages_university_id_fkey" FOREIGN KEY ("university_id") REFERENCES "study_universities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_pages" ADD CONSTRAINT "study_pages_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "study_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_findings" ADD CONSTRAINT "study_findings_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "study_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_findings" ADD CONSTRAINT "study_findings_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "study_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Seeds are marked as such.
UPDATE "study_programs" SET "origin" = 'seed' WHERE "seed_key" IS NOT NULL;

ALTER TABLE "study_programs" ADD CONSTRAINT "study_programs_origin_check" CHECK ("origin" IN ('seed','manual','auto'));
ALTER TABLE "study_universities" ADD CONSTRAINT "study_universities_status_check" CHECK ("status" IN ('new','found','nothing','unreadable','skipped'));
ALTER TABLE "study_universities" ADD CONSTRAINT "study_universities_country_check" CHECK ("country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "study_pages" ADD CONSTRAINT "study_pages_status_check" CHECK ("last_status" IS NULL OR "last_status" IN ('ok','blocked','not_found','error','no_text','pasted'));
ALTER TABLE "study_findings" ADD CONSTRAINT "study_findings_type_check" CHECK ("type" IN ('deadline','ielts','moi','email'));
ALTER TABLE "study_findings" ADD CONSTRAINT "study_findings_status_check" CHECK ("status" IN ('new','accepted','dismissed'));
