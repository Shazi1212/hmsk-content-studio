-- CreateTable
CREATE TABLE "BrandAsset" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "sourceUrl" TEXT,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrandAsset_brandId_idx" ON "BrandAsset"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandAsset_brandId_sourceUrl_key" ON "BrandAsset"("brandId", "sourceUrl");

-- AddForeignKey
ALTER TABLE "BrandAsset" ADD CONSTRAINT "BrandAsset_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
