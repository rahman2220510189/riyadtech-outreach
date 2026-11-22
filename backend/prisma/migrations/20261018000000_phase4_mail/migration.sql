-- Phase 4: mailboxes (encrypted passwords), templates, a log of tests and applications, CV files, job applications.
-- CreateTable
CREATE TABLE "mailboxes" (
    "id" BIGSERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "from_name" TEXT NOT NULL,
    "from_email" TEXT NOT NULL,
    "reply_to" TEXT,
    "smtp_host" TEXT NOT NULL,
    "smtp_port" INTEGER NOT NULL,
    "smtp_security" TEXT NOT NULL,
    "smtp_user" TEXT NOT NULL,
    "smtp_password_enc" TEXT,
    "imap_host" TEXT NOT NULL,
    "imap_port" INTEGER NOT NULL,
    "imap_user" TEXT NOT NULL,
    "imap_password_enc" TEXT,
    "imap_same_as_smtp" BOOLEAN NOT NULL DEFAULT true,
    "daily_cap" INTEGER NOT NULL DEFAULT 50,
    "warmup_started_on" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dkim_selector" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_test_at" TIMESTAMPTZ(3),
    "last_test" JSONB,
    "last_dns_at" TIMESTAMPTZ(3),
    "last_dns" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segment" CHAR(1),
    "offer" TEXT,
    "step" INTEGER NOT NULL DEFAULT 1,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "seed_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mail_log" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "mailbox_id" BIGINT,
    "to_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message_id" TEXT,
    "status" TEXT NOT NULL,
    "smtp_response" TEXT,
    "error" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cv_files" (
    "id" BIGSERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cv_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" BIGSERIAL NOT NULL,
    "job_ad_id" BIGINT,
    "place_id" BIGINT,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "to_email" TEXT,
    "mailbox_id" BIGINT,
    "template_id" BIGINT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cv_file_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sent_at" TIMESTAMPTZ(3),
    "message_id" TEXT,
    "smtp_response" TEXT,
    "error" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mailboxes_from_email_key" ON "mailboxes"("from_email");

-- CreateIndex
CREATE UNIQUE INDEX "templates_seed_key_key" ON "templates"("seed_key");

-- CreateIndex
CREATE INDEX "templates_kind_segment_idx" ON "templates"("kind", "segment");

-- CreateIndex
CREATE INDEX "mail_log_kind_created_at_idx" ON "mail_log"("kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "applications_status_updated_at_idx" ON "applications"("status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "applications_job_ad_id_idx" ON "applications"("job_ad_id");

-- AddForeignKey
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_ad_id_fkey" FOREIGN KEY ("job_ad_id") REFERENCES "job_ads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Allowed values and lower-case addresses (the database enforces them too).
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_security_check" CHECK ("smtp_security" IN ('ssl', 'starttls'));
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_from_email_check" CHECK ("from_email" = lower("from_email"));
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_ports_check" CHECK ("smtp_port" BETWEEN 1 AND 65535 AND "imap_port" BETWEEN 1 AND 65535);
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_daily_cap_check" CHECK ("daily_cap" BETWEEN 1 AND 500);
ALTER TABLE "templates" ADD CONSTRAINT "templates_kind_check" CHECK ("kind" IN ('outreach', 'job'));
ALTER TABLE "templates" ADD CONSTRAINT "templates_segment_check" CHECK ("segment" IS NULL OR "segment" IN ('A', 'B'));
ALTER TABLE "templates" ADD CONSTRAINT "templates_offer_check" CHECK ("offer" IS NULL OR "offer" IN ('chatbot', 'agent'));
ALTER TABLE "templates" ADD CONSTRAINT "templates_step_check" CHECK ("step" BETWEEN 1 AND 3);
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_kind_check" CHECK ("kind" IN ('test', 'application'));
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_status_check" CHECK ("status" IN ('sent', 'failed'));
ALTER TABLE "cv_files" ADD CONSTRAINT "cv_files_size_check" CHECK ("size" BETWEEN 1 AND 5242880);
ALTER TABLE "applications" ADD CONSTRAINT "applications_status_check"
  CHECK ("status" IN ('draft', 'sent', 'failed', 'applied_elsewhere', 'interview', 'rejected', 'offer', 'no_answer'));
