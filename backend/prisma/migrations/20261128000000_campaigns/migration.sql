-- Phase 5: campaigns. A campaign takes "Ready now" leads, crawls the ones not crawled yet, then
-- sends step 1 and two follow-ups in the same thread, inside the recipient's office hours.

CREATE TABLE "campaigns" (
  "id"            BIGSERIAL PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "segment"       CHAR(1) NOT NULL,
  "country"       CHAR(2) NOT NULL,
  "category_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "mailbox_id"    BIGINT NOT NULL REFERENCES "mailboxes"("id") ON DELETE RESTRICT,
  -- draft | running | paused | stopped | done
  "status"        TEXT NOT NULL DEFAULT 'draft',
  -- At most this many e-mails in total (the first real campaign: 5), then the campaign pauses.
  "send_limit"    INTEGER,
  "note"          TEXT,
  "crawl_job_id"  BIGINT,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "started_at"    TIMESTAMPTZ(3),
  "updated_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE "campaign_leads" (
  "id"               BIGSERIAL PRIMARY KEY,
  "campaign_id"      BIGINT NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "place_id"         BIGINT NOT NULL REFERENCES "places"("id") ON DELETE CASCADE,
  "email"            TEXT NOT NULL,
  "domain"           TEXT NOT NULL,
  -- chatbot | agent (Segment B) | null
  "offer"            TEXT,
  -- How many steps were sent (0-3).
  "step"             INTEGER NOT NULL DEFAULT 0,
  -- waiting_crawl | queued | done | stopped | replied | skipped | failed | bounced
  "status"           TEXT NOT NULL DEFAULT 'queued',
  "next_at"          TIMESTAMPTZ(3),
  "first_subject"    TEXT,
  "first_message_id" TEXT,
  "last_message_id"  TEXT,
  "reason"           TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_leads_place_key" UNIQUE ("campaign_id", "place_id"),
  -- One company, one conversation.
  CONSTRAINT "campaign_leads_domain_key" UNIQUE ("campaign_id", "domain")
);
CREATE INDEX "campaign_leads_due_idx" ON "campaign_leads" ("status", "next_at");
CREATE INDEX "campaign_leads_place_idx" ON "campaign_leads" ("place_id");
CREATE INDEX "campaign_leads_domain_idx" ON "campaign_leads" ("domain");

CREATE TABLE "campaign_sends" (
  "id"               BIGSERIAL PRIMARY KEY,
  "campaign_lead_id" BIGINT NOT NULL REFERENCES "campaign_leads"("id") ON DELETE CASCADE,
  "step"             INTEGER NOT NULL,
  "mailbox_id"       BIGINT NOT NULL,
  "to_email"         TEXT NOT NULL,
  "subject"          TEXT NOT NULL,
  "body"             TEXT NOT NULL,
  "message_id"       TEXT NOT NULL,
  -- sending | sent | preview (SENDING_ENABLED=false: written, not sent) | failed
  "status"           TEXT NOT NULL,
  "response"         TEXT,
  "error"            TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- No lead gets two copies of a step, even after a crash.
  CONSTRAINT "campaign_sends_step_key" UNIQUE ("campaign_lead_id", "step")
);
CREATE INDEX "campaign_sends_mailbox_idx" ON "campaign_sends" ("mailbox_id", "created_at");
