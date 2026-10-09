CREATE TABLE trading_mission_wakes (
  id TEXT PRIMARY KEY,
  "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "mandateId" TEXT NOT NULL,
  "wakeKey" TEXT NOT NULL,
  kind TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'WAITING',
  "runId" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "trading_mission_wakes_wakeKey_key" ON trading_mission_wakes ("wakeKey");
CREATE INDEX "trading_mission_wakes_status_dueAt_idx" ON trading_mission_wakes (status, "dueAt");
CREATE INDEX "trading_mission_wakes_runId_idx" ON trading_mission_wakes ("runId");
CREATE INDEX "trading_mission_wakes_mandateId_status_idx" ON trading_mission_wakes ("mandateId", status);
ALTER TABLE trading_mandates DROP CONSTRAINT mandate_approval_bound;
ALTER TABLE trading_mandates ADD CONSTRAINT mandate_approval_bound CHECK (
  status NOT IN ('APPROVED_WAITING', 'ACTIVE', 'PAUSED', 'TARGET_REACHED', 'RISK_STOPPED', 'EXPIRED', 'COMPLETED', 'NEEDS_ATTENTION', 'NEEDS_RECONCILIATION') OR
  ("approvedFingerprint" IS NOT NULL AND "approvedByUserId" IS NOT NULL AND "approvedFingerprint" = fingerprint AND "approvedByUserId" = "ownerUserId" AND "approvedAt" IS NOT NULL)
);
CREATE FUNCTION receipt_trading_mission_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'failed', 'cancelled') THEN
    UPDATE trading_mission_wakes SET
      status = CASE WHEN NEW.status = 'completed' THEN 'COMPLETED' ELSE 'NEEDS_ATTENTION' END,
      "completedAt" = COALESCE(NEW."completedAt", CURRENT_TIMESTAMP), "updatedAt" = CURRENT_TIMESTAMP
      WHERE "runId" = NEW.id AND "completedAt" IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_trading_mission_wake AFTER UPDATE OF status ON runs
  FOR EACH ROW EXECUTE FUNCTION receipt_trading_mission_wake();
CREATE FUNCTION detach_trading_mission_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE trading_mission_wakes SET status = 'DELIVERY_NEEDED', "runId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "runId" = OLD.id AND "completedAt" IS NULL;
  RETURN OLD;
END $$;
CREATE TRIGGER detach_trading_mission_wake BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION detach_trading_mission_wake();
