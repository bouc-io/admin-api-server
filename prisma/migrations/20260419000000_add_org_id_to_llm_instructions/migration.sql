-- Add org_id to llm_instructions: null = global, non-null = org-level
-- Drop any partial column from failed previous attempts (UUID or wrong type)
ALTER TABLE "llm_instructions" DROP COLUMN IF EXISTS "org_id";

ALTER TABLE "llm_instructions" ADD COLUMN "org_id" TEXT;

ALTER TABLE "llm_instructions"
  ADD CONSTRAINT "llm_instructions_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "llm_instructions_org_id_idx" ON "llm_instructions"("org_id");
