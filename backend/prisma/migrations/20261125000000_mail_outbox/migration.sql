-- E-mails that wait for the outbox on my PC (hosted on a free plan that blocks SMTP).
ALTER TABLE "mail_log" DROP CONSTRAINT "mail_log_status_check";
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_status_check" CHECK ("status" IN ('queued', 'sent', 'failed'));

CREATE TABLE "mail_outbox" (
    "id" BIGSERIAL NOT NULL,
    "mail_log_id" BIGINT NOT NULL,
    "mailbox_id" BIGINT NOT NULL,
    "message" JSONB NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "ref_kind" TEXT,
    "ref_id" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_outbox_mail_log_id_key" ON "mail_outbox"("mail_log_id");
CREATE INDEX "mail_outbox_status_id_idx" ON "mail_outbox"("status", "id");

ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_mail_log_id_fkey" FOREIGN KEY ("mail_log_id") REFERENCES "mail_log"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_mailbox_id_fkey" FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_status_check" CHECK ("status" IN ('queued', 'sending', 'sent', 'failed'));
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_ref_kind_check" CHECK ("ref_kind" IS NULL OR "ref_kind" IN ('study_email', 'application'));
