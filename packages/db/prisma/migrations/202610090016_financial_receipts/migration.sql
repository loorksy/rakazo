-- Financial receipts cannot be rewritten by a later model review or stale execution.
CREATE FUNCTION preserve_financial_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."financialContext" IS NULL THEN RETURN NEW; END IF;
  IF NEW."financialGeneration" < OLD."financialGeneration" THEN
    RAISE EXCEPTION 'Financial generation cannot decrease';
  END IF;
  IF OLD."reviewDecision" IS NOT NULL AND
    (NEW."reviewDecision" IS DISTINCT FROM OLD."reviewDecision" OR
     NEW."reviewReason" IS DISTINCT FROM OLD."reviewReason" OR
     NEW."reviewModel" IS DISTINCT FROM OLD."reviewModel") THEN
    RAISE EXCEPTION 'Financial review receipt is immutable';
  END IF;
  IF OLD."financialStartedAt" IS NOT NULL AND
     NEW."financialStartedAt" IS DISTINCT FROM OLD."financialStartedAt" THEN
    RAISE EXCEPTION 'Financial STARTED receipt is immutable';
  END IF;
  IF OLD."financialExpiresAt" IS NOT NULL AND
     NEW."financialExpiresAt" IS DISTINCT FROM OLD."financialExpiresAt" THEN
    RAISE EXCEPTION 'Financial expiry is immutable';
  END IF;
  IF OLD."financialApprovedAt" IS NOT NULL AND
    (NEW."financialApprovedAt" IS DISTINCT FROM OLD."financialApprovedAt" OR
     NEW."financialApprovedByUserId" IS DISTINCT FROM OLD."financialApprovedByUserId") THEN
    RAISE EXCEPTION 'Financial approval receipt is immutable';
  END IF;
  IF OLD."financialContext"->>'version' = '2' AND OLD.status IN ('completed', 'failed', 'denied') AND
    (NEW.status IS DISTINCT FROM OLD.status OR NEW.result IS DISTINCT FROM OLD.result OR
     NEW."financialProviderReference" IS DISTINCT FROM OLD."financialProviderReference" OR
     NEW."financialFailureCode" IS DISTINCT FROM OLD."financialFailureCode") THEN
    RAISE EXCEPTION 'Financial terminal receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_financial_receipt BEFORE UPDATE ON external_effects
  FOR EACH ROW EXECUTE FUNCTION preserve_financial_receipt();
