-- Phase 1b: per-country flag for state-level imports (was hard-coded for US and AU).

-- AlterTable
ALTER TABLE "countries" ADD COLUMN     "region_imports" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows: same behaviour as before.
UPDATE "countries" SET "region_imports" = true WHERE "code" IN ('US', 'AU');
