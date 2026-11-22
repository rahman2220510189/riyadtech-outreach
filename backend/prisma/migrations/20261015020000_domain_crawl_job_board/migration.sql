-- The job platform a website links to (Personio, Greenhouse, Lever, Recruitee, Workable, SmartRecruiters).
ALTER TABLE "domain_crawls" ADD COLUMN "job_board" JSONB;
