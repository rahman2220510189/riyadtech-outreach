-- Campaign e-mails are logged in mail_log too (kind "outreach").
ALTER TABLE "mail_log" DROP CONSTRAINT "mail_log_kind_check";
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_kind_check" CHECK ("kind" IN ('test', 'application', 'study', 'outreach'));
