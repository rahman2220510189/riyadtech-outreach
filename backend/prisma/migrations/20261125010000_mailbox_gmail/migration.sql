-- Gmail API connection per mailbox (OAuth refresh token, encrypted with ENCRYPTION_KEY).
ALTER TABLE "mailboxes" ADD COLUMN "gmail_refresh_token_enc" TEXT;
ALTER TABLE "mailboxes" ADD COLUMN "gmail_connected_at" TIMESTAMPTZ(3);
ALTER TABLE "mailboxes" ADD COLUMN "gmail_error" TEXT;
