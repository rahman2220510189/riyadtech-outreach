-- Study abroad: my profile, my documents, scholarships/programmes with their dates, and e-mails to universities.
-- CreateTable
CREATE TABLE "study_profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "full_name" TEXT NOT NULL DEFAULT '',
    "nationality" TEXT NOT NULL DEFAULT 'Bangladesh',
    "date_of_birth" DATE,
    "phone" TEXT,
    "target_level" TEXT NOT NULL DEFAULT 'master',
    "target_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bsc_subject" TEXT,
    "bsc_university" TEXT,
    "bsc_cgpa" DECIMAL(4,2),
    "bsc_cgpa_scale" DECIMAL(4,2) NOT NULL DEFAULT 4,
    "bsc_year" INTEGER,
    "hsc_gpa" DECIMAL(4,2),
    "hsc_year" INTEGER,
    "ssc_gpa" DECIMAL(4,2),
    "ssc_year" INTEGER,
    "english_medium" BOOLEAN NOT NULL DEFAULT true,
    "ielts_score" DECIMAL(3,1),
    "duolingo_score" INTEGER,
    "passport_status" TEXT NOT NULL DEFAULT 'none',
    "passport_expiry" DATE,
    "work_experience" TEXT,
    "about_me" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_documents" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_programs" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'scholarship',
    "country" TEXT NOT NULL,
    "university" TEXT,
    "level" TEXT NOT NULL DEFAULT 'both',
    "field" TEXT,
    "english_requirement" TEXT NOT NULL DEFAULT 'varies',
    "min_ielts" DECIMAL(3,1),
    "funding" TEXT,
    "costs" TEXT,
    "apply_url" TEXT,
    "info_url" TEXT,
    "contact_email" TEXT,
    "required_docs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "how_to_apply" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'interested',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "seed_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_deadlines" (
    "id" BIGSERIAL NOT NULL,
    "program_id" BIGINT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'deadline',
    "due_on" DATE NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_emails" (
    "id" BIGSERIAL NOT NULL,
    "program_id" BIGINT,
    "purpose" TEXT NOT NULL DEFAULT 'inquiry',
    "to_email" TEXT,
    "mailbox_id" BIGINT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "document_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "ai_model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sent_at" TIMESTAMPTZ(3),
    "message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "study_documents_kind_idx" ON "study_documents"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "study_programs_seed_key_key" ON "study_programs"("seed_key");

-- CreateIndex
CREATE INDEX "study_programs_status_idx" ON "study_programs"("status");

-- CreateIndex
CREATE INDEX "study_deadlines_done_due_on_idx" ON "study_deadlines"("done", "due_on");

-- CreateIndex
CREATE INDEX "study_emails_status_updated_at_idx" ON "study_emails"("status", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "study_deadlines" ADD CONSTRAINT "study_deadlines_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "study_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_emails" ADD CONSTRAINT "study_emails_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "study_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Allowed values (the database enforces them too).
ALTER TABLE "study_profile" ADD CONSTRAINT "study_profile_one_row" CHECK ("id" = 1);
ALTER TABLE "study_profile" ADD CONSTRAINT "study_profile_level_check" CHECK ("target_level" IN ('bachelor', 'master', 'both'));
ALTER TABLE "study_profile" ADD CONSTRAINT "study_profile_passport_check" CHECK ("passport_status" IN ('none', 'applied', 'ready'));
ALTER TABLE "study_documents" ADD CONSTRAINT "study_documents_kind_check" CHECK ("kind" IN ('passport', 'photo', 'bsc_certificate', 'bsc_transcript', 'hsc_certificate', 'hsc_marksheet', 'ssc_certificate', 'ssc_marksheet', 'moi_letter', 'cv', 'motivation_letter', 'recommendation', 'ielts_result', 'other'));
ALTER TABLE "study_documents" ADD CONSTRAINT "study_documents_size_check" CHECK ("size" BETWEEN 1 AND 8388608);
ALTER TABLE "study_programs" ADD CONSTRAINT "study_programs_kind_check" CHECK ("kind" IN ('scholarship', 'programme'));
ALTER TABLE "study_programs" ADD CONSTRAINT "study_programs_level_check" CHECK ("level" IN ('bachelor', 'master', 'both'));
ALTER TABLE "study_programs" ADD CONSTRAINT "study_programs_english_check" CHECK ("english_requirement" IN ('moi_ok', 'varies', 'test_required', 'not_required'));
ALTER TABLE "study_programs" ADD CONSTRAINT "study_programs_status_check" CHECK ("status" IN ('interested', 'preparing', 'applied', 'interview', 'accepted', 'rejected', 'not_now'));
ALTER TABLE "study_deadlines" ADD CONSTRAINT "study_deadlines_kind_check" CHECK ("kind" IN ('deadline', 'opens', 'reminder'));
ALTER TABLE "study_emails" ADD CONSTRAINT "study_emails_purpose_check" CHECK ("purpose" IN ('inquiry', 'application', 'follow_up'));
ALTER TABLE "study_emails" ADD CONSTRAINT "study_emails_status_check" CHECK ("status" IN ('draft', 'sent', 'failed'));

-- Study e-mails are logged with the other one-by-one e-mails.
ALTER TABLE "mail_log" DROP CONSTRAINT "mail_log_kind_check";
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_kind_check" CHECK ("kind" IN ('test', 'application', 'study'));
