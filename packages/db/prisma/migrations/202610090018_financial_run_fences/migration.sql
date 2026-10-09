-- Run fences are scoped to one Run. Financial ownership remains monotonic across recovery Runs.
ALTER TABLE external_effects ADD COLUMN "financialRunFence" INTEGER NOT NULL DEFAULT 0;
UPDATE external_effects SET "financialRunFence" = "financialGeneration"
  WHERE "financialContext" IS NOT NULL;
ALTER TABLE external_effects ADD CONSTRAINT financial_ownership_nonnegative
  CHECK ("financialGeneration" >= 0 AND "financialRunFence" >= 0);
