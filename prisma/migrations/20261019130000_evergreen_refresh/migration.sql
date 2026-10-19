-- Evergreen refresh window per brand (lib/similarity.ts): published pieces this many days old count as refresh candidates.
ALTER TABLE "Brand" ADD COLUMN "refreshAfterDays" INTEGER NOT NULL DEFAULT 180;
