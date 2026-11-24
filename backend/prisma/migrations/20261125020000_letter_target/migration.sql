-- For a scholarship: the university programme the letter applies to; and the length asked for.
ALTER TABLE "study_letters" ADD COLUMN "target" TEXT;
ALTER TABLE "study_letters" ADD COLUMN "length" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "study_letters" ADD CONSTRAINT "study_letters_length_check" CHECK ("length" IN ('standard', 'short'));
