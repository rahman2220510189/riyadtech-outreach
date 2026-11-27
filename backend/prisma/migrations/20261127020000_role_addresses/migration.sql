-- Step 5.2 fix: more department addresses (accessibility@, investors@, franchise@…) are never used
-- for sales, and an address Overture lists on a third domain (a parent brand) is not used either.

-- 1. Saved addresses with the new department words become "role" (never primary).
UPDATE "emails" SET "kind" = 'role', "is_primary" = false, "first_name" = NULL
 WHERE "kind" <> 'role'
   AND split_part("email", '@', 1) ~ '^(accessibility|ada|disability|franchise|franchising|investor|investors|ir|ethics|whistleblow|whistleblowing|whistleblower|fraud|procurement|purchasing|supplier|suppliers|vendor|vendors|donation|donations|sponsorship|sponsorships)([._+-]|$)';

-- 2. Leads whose primary is now a department address, or an Overture-only address on a third
--    domain, lose it and are checked again by the worker (it picks the next usable address).
UPDATE "places" p SET "primary_email" = NULL, "first_name" = NULL, "overture_checked_at" = NULL
  FROM "emails" e
 WHERE e."email" = p."primary_email"
   AND (e."kind" = 'role' OR (e."on_site" = false AND e."origin" = 'overture' AND e."domain_match" = 'other'));
UPDATE "emails" e SET "is_primary" = false
  FROM "places" p
 WHERE e."place_id" = p."id" AND e."is_primary" AND p."primary_email" IS NULL;

-- 3. The worker now goes through every place not checked yet (not only those with Overture
--    addresses); places with nothing to check are marked checked here.
UPDATE "places" SET "overture_checked_at" = now()
 WHERE "overture_checked_at" IS NULL AND cardinality("overture_emails") = 0 AND "primary_email" IS NOT NULL;
UPDATE "places" SET "overture_checked_at" = now()
 WHERE "overture_checked_at" IS NULL AND cardinality("overture_emails") = 0 AND "crawl_status" IS NULL;
DROP INDEX IF EXISTS "places_overture_pending_idx";
CREATE INDEX "places_overture_pending_idx" ON "places" ("id") WHERE "overture_checked_at" IS NULL;
