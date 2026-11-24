-- A completion letter ("degree completed, certificate to follow") stands in for the BSc certificate.
ALTER TABLE "study_documents" DROP CONSTRAINT "study_documents_kind_check";
ALTER TABLE "study_documents" ADD CONSTRAINT "study_documents_kind_check" CHECK ("kind" IN ('passport', 'photo', 'bsc_certificate', 'bsc_completion_letter', 'bsc_transcript', 'hsc_certificate', 'hsc_marksheet', 'ssc_certificate', 'ssc_marksheet', 'moi_letter', 'cv', 'motivation_letter', 'recommendation', 'ielts_result', 'other'));

-- One motivation letter / statement of purpose per programme, written with the AI and edited by hand.
CREATE TABLE "study_letters" (
    "id" BIGSERIAL NOT NULL,
    "program_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "notes" TEXT,
    "ai_model" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "study_letters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "study_letters_program_id_key" ON "study_letters"("program_id");

ALTER TABLE "study_letters" ADD CONSTRAINT "study_letters_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "study_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "study_letters" ADD CONSTRAINT "study_letters_title_check" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "study_letters" ADD CONSTRAINT "study_letters_body_check" CHECK (char_length("body") <= 20000);
