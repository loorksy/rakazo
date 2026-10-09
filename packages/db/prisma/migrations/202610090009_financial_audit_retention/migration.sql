-- Ordinary Run/Space deletion removes delivery linkage, never financial evidence.
ALTER TABLE external_effects DROP CONSTRAINT "external_effects_spaceId_fkey";
ALTER TABLE external_effects DROP CONSTRAINT "external_effects_runId_fkey";
ALTER TABLE external_effects ALTER COLUMN "spaceId" DROP NOT NULL;
ALTER TABLE external_effects ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE external_effects ADD CONSTRAINT "external_effects_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES spaces(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE external_effects ADD CONSTRAINT "external_effects_runId_fkey" FOREIGN KEY ("runId") REFERENCES runs(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE external_effects
  ADD COLUMN "financialContext" JSONB,
  ADD COLUMN "financialGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "financialHolder" TEXT,
  ADD COLUMN "financialStartedAt" TIMESTAMP(3),
  ADD COLUMN "financialProviderReference" TEXT,
  ADD COLUMN "financialExpiresAt" TIMESTAMP(3),
  ADD COLUMN "financialApprovedByUserId" TEXT,
  ADD COLUMN "financialApprovedAt" TIMESTAMP(3),
  ADD COLUMN "financialFailureCode" TEXT;
CREATE TABLE financial_journal (
  id TEXT PRIMARY KEY, "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "ownerUserId" TEXT NOT NULL, "accountId" TEXT NOT NULL, mode TEXT NOT NULL,
  "effectId" TEXT NOT NULL, event TEXT NOT NULL, entry JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT financial_journal_mode CHECK (mode IN ('SIMULATION', 'LIVE'))
);
CREATE INDEX "financial_journal_ownerUserId_accountId_mode_createdAt_idx" ON financial_journal ("ownerUserId", "accountId", mode, "createdAt");
CREATE INDEX "financial_journal_effectId_createdAt_idx" ON financial_journal ("effectId", "createdAt");
CREATE FUNCTION preserve_financial_effect_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."financialContext" IS NOT NULL THEN RAISE EXCEPTION 'Financial effects cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."financialContext" IS NOT NULL AND
    (NEW."financialContext" IS DISTINCT FROM OLD."financialContext" OR NEW.request IS DISTINCT FROM OLD.request OR
     NEW.kind IS DISTINCT FROM OLD.kind OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey") THEN
    RAISE EXCEPTION 'Financial effect identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_financial_effect_identity BEFORE UPDATE OR DELETE ON external_effects
  FOR EACH ROW EXECUTE FUNCTION preserve_financial_effect_identity();
CREATE FUNCTION preserve_financial_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial journal entries are immutable'; END $$;
CREATE TRIGGER preserve_financial_journal BEFORE UPDATE OR DELETE ON financial_journal
  FOR EACH ROW EXECUTE FUNCTION preserve_financial_journal();
