-- CreateTable
CREATE TABLE "IdeaBatch" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "params" JSONB NOT NULL,
    "ideas" JSONB NOT NULL,
    "model" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeaBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConnection" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ok',
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncCount" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledRun" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "detail" JSONB,
    "error" TEXT,

    CONSTRAINT "ScheduledRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdeaBatch_brandId_createdAt_idx" ON "IdeaBatch"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformConnection_platform_status_idx" ON "PlatformConnection"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformConnection_brandId_platform_externalId_key" ON "PlatformConnection"("brandId", "platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledRun_task_period_key" ON "ScheduledRun"("task", "period");

-- AddForeignKey
ALTER TABLE "IdeaBatch" ADD CONSTRAINT "IdeaBatch_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformConnection" ADD CONSTRAINT "PlatformConnection_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

