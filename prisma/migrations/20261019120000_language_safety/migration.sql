-- Per-brand settings of the language safety check (lib/language-safety.ts).
ALTER TABLE "Brand" ADD COLUMN "bannedPhrases" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "aiPhraseCheck" BOOLEAN NOT NULL DEFAULT true;
