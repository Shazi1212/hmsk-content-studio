-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "description" TEXT NOT NULL,
    "websiteUrl" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pillars" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audience" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "visual" TEXT NOT NULL,
    "offers" TEXT NOT NULL,
    "guardrails" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferencePost" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "postUrl" TEXT NOT NULL,
    "date" TEXT,
    "format" TEXT,
    "pillar" TEXT,
    "topic" TEXT,
    "product" TEXT,
    "hook" TEXT,
    "hookType" TEXT,
    "mainMessage" TEXT,
    "visualConcept" TEXT,
    "visualStyle" TEXT,
    "colors" TEXT,
    "typography" TEXT,
    "people" TEXT,
    "productPlacement" TEXT,
    "captionStyle" TEXT,
    "captionStructure" TEXT,
    "cta" TEXT,
    "ctaType" TEXT,
    "views" TEXT,
    "likes" TEXT,
    "comments" TEXT,
    "shares" TEXT,
    "saves" TEXT,
    "engagementIndicators" TEXT,
    "performanceLevel" TEXT,
    "performanceEvidence" TEXT,
    "audienceReaction" TEXT,
    "trendReference" TEXT,
    "storytelling" TEXT,
    "emotionalDriver" TEXT,
    "contentMechanism" TEXT,
    "replicability" TEXT,
    "observations" TEXT,
    "confidence" TEXT,
    "sourceEvidence" TEXT,
    "source" TEXT NOT NULL DEFAULT 'research-2026-09-20',
    "searchText" TEXT NOT NULL,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferencePost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Generation" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "postType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "brief" JSONB NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "userPrompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "output" JSONB NOT NULL,
    "outputText" TEXT NOT NULL,
    "referenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priorGenIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "audioUrl" TEXT,
    "audioProvider" TEXT,
    "videoUrl" TEXT,
    "videoProvider" TEXT,
    "imageUrl" TEXT,
    "imageProvider" TEXT,
    "score" INTEGER,
    "notes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Generation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

-- CreateIndex
CREATE INDEX "ReferencePost_brandId_platform_idx" ON "ReferencePost"("brandId", "platform");

-- CreateIndex
CREATE INDEX "ReferencePost_brandId_pillar_idx" ON "ReferencePost"("brandId", "pillar");

-- CreateIndex
CREATE INDEX "ReferencePost_performanceLevel_idx" ON "ReferencePost"("performanceLevel");

-- CreateIndex
CREATE UNIQUE INDEX "ReferencePost_postUrl_platform_hook_key" ON "ReferencePost"("postUrl", "platform", "hook");

-- CreateIndex
CREATE INDEX "Generation_brandId_status_idx" ON "Generation"("brandId", "status");

-- CreateIndex
CREATE INDEX "Generation_brandId_platform_postType_idx" ON "Generation"("brandId", "platform", "postType");

-- AddForeignKey
ALTER TABLE "ReferencePost" ADD CONSTRAINT "ReferencePost_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
