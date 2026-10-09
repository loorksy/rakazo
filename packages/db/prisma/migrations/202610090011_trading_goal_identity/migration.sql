-- Existing goal identity remains stable. Application-created requests use a scoped SHA-256 key.
ALTER TABLE trading_goals ADD COLUMN "requestKey" TEXT;
UPDATE trading_goals SET "requestKey" = 'legacy:' || id;
ALTER TABLE trading_goals ALTER COLUMN "requestKey" SET NOT NULL;
CREATE UNIQUE INDEX "trading_goals_requestKey_key" ON trading_goals ("requestKey");

CREATE FUNCTION preserve_trading_goal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Trading goal audit identity cannot be deleted'; END IF;
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey" OR
    NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" OR NEW."botId" IS DISTINCT FROM OLD."botId" OR
    NEW."accountId" IS DISTINCT FROM OLD."accountId" OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'Trading goal identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_trading_goal_identity BEFORE UPDATE OR DELETE ON trading_goals
  FOR EACH ROW EXECUTE FUNCTION preserve_trading_goal_identity();

CREATE FUNCTION preserve_mandate_plan_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."planId" IS DISTINCT FROM OLD."planId" THEN RAISE EXCEPTION 'Approved mandate plan reference is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_mandate_plan_identity BEFORE UPDATE ON trading_mandates
  FOR EACH ROW EXECUTE FUNCTION preserve_mandate_plan_identity();
