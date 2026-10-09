CREATE TABLE simulation_books (
  "accountId" TEXT PRIMARY KEY, "ownerUserId" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
  state JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT simulation_book_mode CHECK (state->>'mode' = 'SIMULATION' AND state->>'accountId' = "accountId")
);
CREATE TABLE simulation_executions (
  "effectId" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "ownerUserId" TEXT NOT NULL,
  "mandateId" TEXT NOT NULL, "actionFingerprint" TEXT NOT NULL,
  "formatVersion" INTEGER NOT NULL DEFAULT 1, outcome JSONB NOT NULL, changes JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX simulation_executions_account_created_idx ON simulation_executions ("accountId", "createdAt");
CREATE TRIGGER preserve_simulation_execution BEFORE UPDATE OR DELETE ON simulation_executions
  FOR EACH ROW EXECUTE FUNCTION preserve_financial_journal();
CREATE FUNCTION preserve_simulation_book() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Simulation accounting cannot be deleted'; END IF;
  IF NEW."accountId" IS DISTINCT FROM OLD."accountId" OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" OR
     NEW."formatVersion" IS DISTINCT FROM OLD."formatVersion" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW.state->'initialEquity' IS DISTINCT FROM OLD.state->'initialEquity' OR
     NEW.state->'currency' IS DISTINCT FROM OLD.state->'currency' OR
     NEW.state->'mode' IS DISTINCT FROM OLD.state->'mode' OR
     NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Simulation book identity is immutable and revision must advance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_simulation_book BEFORE UPDATE OR DELETE ON simulation_books
  FOR EACH ROW EXECUTE FUNCTION preserve_simulation_book();
