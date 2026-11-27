-- Addendum 2, step 5.1: contact data from Overture is used at import time.

-- Was the address seen on the business's website? Crawled addresses: yes. Addresses only listed
-- by Overture (or imported from my CSV files): no, until a crawl finds them on the site.
ALTER TABLE "emails" ADD COLUMN "on_site" BOOLEAN NOT NULL DEFAULT true;
UPDATE "emails" SET "on_site" = false WHERE "origin" = 'csv';
-- Where an Overture address came from: the Overture place id and the release.
ALTER TABLE "emails" ADD COLUMN "source_id" TEXT;
ALTER TABLE "emails" ADD COLUMN "source_release" TEXT;

-- Social profile links listed by Overture (at most 5 per place).
ALTER TABLE "places" ADD COLUMN "socials" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "stg_overture_places" ADD COLUMN "socials" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
