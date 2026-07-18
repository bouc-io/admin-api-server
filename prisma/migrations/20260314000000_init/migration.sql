-- CreateTable
CREATE TABLE "llm_instructions" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "llm_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "api_endpoint" TEXT NOT NULL,
    "api_key_enc" TEXT,
    "models" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "llm_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_assignments" (
    "id" TEXT NOT NULL,
    "use_case" TEXT NOT NULL,
    "provider_id" TEXT,
    "model" TEXT,
    "enable_reasoning" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_instructions_priority_idx" ON "llm_instructions"("priority");

-- CreateIndex
CREATE INDEX "llm_instructions_is_active_idx" ON "llm_instructions"("is_active");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "llm_assignments_use_case_key" ON "llm_assignments"("use_case");

-- AddForeignKey
ALTER TABLE "llm_assignments" ADD CONSTRAINT "llm_assignments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "llm_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
