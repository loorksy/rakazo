ALTER TABLE financial_journal ALTER COLUMN "effectId" DROP NOT NULL;
ALTER TABLE financial_journal ADD COLUMN "goalId" TEXT, ADD COLUMN "mandateId" TEXT, ADD COLUMN "planVersion" INTEGER;
