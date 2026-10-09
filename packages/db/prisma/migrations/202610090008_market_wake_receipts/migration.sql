-- A turn receipt must survive chat reset/deletion. This extends existing Runs, not a second task engine.
ALTER TABLE market_watches ADD COLUMN "wakeCompletedAt" TIMESTAMP(3);
CREATE INDEX "market_watches_triggeredRunId_idx" ON market_watches ("triggeredRunId");

CREATE FUNCTION record_market_wake_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed','failed','cancelled') THEN
    UPDATE market_watches SET "wakeCompletedAt" = COALESCE(NEW."completedAt", CURRENT_TIMESTAMP),
      status = CASE WHEN NEW.status = 'completed' THEN 'FIRED' ELSE 'NEEDS_ATTENTION' END,
      revision = revision + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "triggeredRunId" = NEW.id AND "wakeCompletedAt" IS NULL AND status = 'FIRED';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER market_wake_completion AFTER UPDATE OF status ON runs
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION record_market_wake_completion();

CREATE FUNCTION retain_interrupted_market_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE market_watches SET status = 'DELIVERY_NEEDED', "triggeredRunId" = NULL,
    revision = revision + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "triggeredRunId" = OLD.id AND "wakeCompletedAt" IS NULL AND status = 'FIRED';
  RETURN OLD;
END;
$$;
CREATE TRIGGER market_wake_turn_deleted BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION retain_interrupted_market_wake();
