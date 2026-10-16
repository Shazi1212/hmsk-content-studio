-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "cacheReadTokens" INTEGER,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outputTokens" INTEGER;
