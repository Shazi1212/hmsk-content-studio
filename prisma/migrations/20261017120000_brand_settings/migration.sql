-- Per-brand rules that used to be hard-coded: category rules, lint terms and compliance switches.
ALTER TABLE "Brand" ADD COLUMN "categoryRules" TEXT NOT NULL DEFAULT '',
ADD COLUMN "forbiddenTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "claimTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "claimSensitive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "complianceReview" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "ReferencePost" ALTER COLUMN "source" SET DEFAULT 'seed';
