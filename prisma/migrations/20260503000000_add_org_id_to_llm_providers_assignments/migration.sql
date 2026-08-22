-- Migration: Add org_id to llm_providers and llm_assignments
-- GAP 6 Phase 1 — LLM Provider Org-Scoping Foundation

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Ensure default organizations exist BEFORE adding any FK constraints.
--    The deployment pipeline runs migrations before the seed script, so these
--    rows may not exist yet. ON CONFLICT DO NOTHING makes this idempotent if
--    they were already seeded.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "organizations" ("id", "name", "slug", "tier", "status", "updated_at")
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Bouc.io', 'bouc-io', 'internal', 'active', now()),
  ('a0000000-0000-4000-8000-000000000002', 'Public',  'public',  'free',     'active', now())
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. llm_providers: add nullable org_id FK
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "llm_providers" ADD COLUMN IF NOT EXISTS "org_id" TEXT;

ALTER TABLE "llm_providers"
  DROP CONSTRAINT IF EXISTS "llm_providers_org_id_fkey";

ALTER TABLE "llm_providers"
  ADD CONSTRAINT "llm_providers_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "llm_providers_org_id_idx" ON "llm_providers"("org_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. llm_assignments: replace UNIQUE(use_case) with two partial unique indexes
--    that enforce (use_case) uniqueness for global rows and (use_case, org_id)
--    uniqueness for org-specific rows.
--
--    Why not UNIQUE(use_case, org_id)?
--    PostgreSQL treats NULL != NULL in UNIQUE constraints, so a naïve composite
--    unique would allow duplicate global rows. The two partial indexes below
--    handle both cases correctly.
-- ─────────────────────────────────────────────────────────────────────────────
-- Prisma created this as a CREATE UNIQUE INDEX (not ADD CONSTRAINT), so drop it as an index.
DROP INDEX IF EXISTS "llm_assignments_use_case_key";

ALTER TABLE "llm_assignments" ADD COLUMN IF NOT EXISTS "org_id" TEXT;

ALTER TABLE "llm_assignments"
  DROP CONSTRAINT IF EXISTS "llm_assignments_org_id_fkey";

ALTER TABLE "llm_assignments"
  ADD CONSTRAINT "llm_assignments_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One global assignment per use_case (org_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS "llm_assignments_use_case_global_key"
  ON "llm_assignments"("use_case")
  WHERE "org_id" IS NULL;

-- One org-specific assignment per (use_case, org_id)
CREATE UNIQUE INDEX IF NOT EXISTS "llm_assignments_use_case_org_key"
  ON "llm_assignments"("use_case", "org_id")
  WHERE "org_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "llm_assignments_org_id_idx" ON "llm_assignments"("org_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Data conversion: assign all existing records to the two default orgs.
--    bouc.io org UUID : a0000000-0000-4000-8000-000000000001
--    public  org UUID : a0000000-0000-4000-8000-000000000002
-- ─────────────────────────────────────────────────────────────────────────────

-- Tag all existing providers as belonging to the bouc.io org
-- (they are bouc.io's internal Ollama infrastructure)
UPDATE "llm_providers"
SET "org_id" = 'a0000000-0000-4000-8000-000000000001'
WHERE "org_id" IS NULL;

-- Tag all existing assignments as belonging to the bouc.io org
UPDATE "llm_assignments"
SET "org_id" = 'a0000000-0000-4000-8000-000000000001'
WHERE "org_id" IS NULL;

-- Clone each bouc.io assignment for the public org
-- (both default orgs route to the same internal Ollama provider)
-- ON CONFLICT DO NOTHING guards against re-runs if the partial index already exists.
INSERT INTO "llm_assignments" ("id", "org_id", "use_case", "provider_id", "model", "enable_reasoning", "updated_at")
SELECT
  gen_random_uuid(),
  'a0000000-0000-4000-8000-000000000002',
  "use_case",
  "provider_id",
  "model",
  "enable_reasoning",
  now()
FROM "llm_assignments"
WHERE "org_id" = 'a0000000-0000-4000-8000-000000000001'
ON CONFLICT DO NOTHING;
