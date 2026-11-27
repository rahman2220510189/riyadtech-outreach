-- Phase 6: replies and bounces read from the mailbox (IMAP, read-only).

ALTER TABLE "mailboxes" ADD COLUMN "imap_uid_validity" TEXT;
ALTER TABLE "mailboxes" ADD COLUMN "imap_last_uid" INTEGER;
ALTER TABLE "mailboxes" ADD COLUMN "imap_checked_at" TIMESTAMPTZ(3);
ALTER TABLE "mailboxes" ADD COLUMN "imap_error" TEXT;

-- Only messages that belong to a campaign are saved (nothing else from the inbox).
CREATE TABLE "replies" (
  "id"               BIGSERIAL PRIMARY KEY,
  "mailbox_id"       BIGINT NOT NULL REFERENCES "mailboxes"("id") ON DELETE CASCADE,
  "campaign_lead_id" BIGINT REFERENCES "campaign_leads"("id") ON DELETE SET NULL,
  -- The message's Message-ID (or "<uidvalidity>:<uid>" without one): the same message is never handled twice.
  "imap_key"         TEXT NOT NULL,
  "from_email"       TEXT NOT NULL,
  "subject"          TEXT NOT NULL,
  -- The new text of the reply (quoted history removed), at most 2000 characters.
  "snippet"          TEXT NOT NULL,
  -- reply | auto_reply | unsubscribe | bounce
  "kind"             TEXT NOT NULL CHECK ("kind" IN ('reply', 'auto_reply', 'unsubscribe', 'bounce')),
  "received_at"      TIMESTAMPTZ(3) NOT NULL,
  "done"             BOOLEAN NOT NULL DEFAULT false,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "replies_imap_key" UNIQUE ("mailbox_id", "imap_key")
);
CREATE INDEX "replies_received_idx" ON "replies" ("received_at" DESC);
CREATE INDEX "campaign_sends_message_idx" ON "campaign_sends" ("message_id");
