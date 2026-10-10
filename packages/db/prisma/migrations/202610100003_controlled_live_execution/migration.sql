ALTER TABLE deployment_settings ADD COLUMN "tradingLiveEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE trading_provider_executions (
  "effectId" TEXT PRIMARY KEY REFERENCES external_effects(id) ON DELETE RESTRICT,
  "ownerUserId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL UNIQUE, "actionFingerprint" TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','UNCERTAIN','RESOLVED')),
  "claimedGeneration" INTEGER, "sentAt" TIMESTAMP(3), admission JSONB, outcome JSONB,
  "reconciledAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK (status NOT IN ('SENT','UNCERTAIN') OR "sentAt" IS NOT NULL)
);
CREATE INDEX trading_provider_executions_account_status ON trading_provider_executions ("accountId",status);
CREATE TABLE trading_broker_snapshots (
  "accountId" TEXT PRIMARY KEY, generation INTEGER NOT NULL,
  account JSONB NOT NULL, positions JSONB NOT NULL, orders JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE trading_position_supervisions (
  id TEXT PRIMARY KEY, "ownerUserId" TEXT NOT NULL, "botId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL, "positionId" TEXT NOT NULL, "mandateId" TEXT NOT NULL UNIQUE,
  baseline JSONB NOT NULL, expected JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX trading_position_supervisions_account_status ON trading_position_supervisions ("accountId",status);
CREATE TABLE trading_drift_events (
  id TEXT PRIMARY KEY, "ownerUserId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
  "supervisionId" TEXT, reason TEXT NOT NULL, evidence JSONB NOT NULL,
  "resolvedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX trading_drift_events_account_unresolved ON trading_drift_events ("accountId","resolvedAt");
CREATE TABLE trading_runtime_health (
  id TEXT PRIMARY KEY DEFAULT 'default', "containmentRevision" TEXT,
  "containmentActive" BOOLEAN NOT NULL DEFAULT FALSE, "riskHealthy" BOOLEAN NOT NULL DEFAULT FALSE,
  "effectsHealthy" BOOLEAN NOT NULL DEFAULT FALSE, "emergencyStopHealthy" BOOLEAN NOT NULL DEFAULT FALSE,
  "observabilityHealthy" BOOLEAN NOT NULL DEFAULT FALSE, "jobLagMs" INTEGER, "observedAt" TIMESTAMP(3) NOT NULL
);
CREATE FUNCTION preserve_live_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Provider execution evidence cannot be deleted'; END IF;
  IF ROW(NEW."effectId",NEW."ownerUserId",NEW."accountId",NEW."clientId",NEW."actionFingerprint",NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."effectId",OLD."ownerUserId",OLD."accountId",OLD."clientId",OLD."actionFingerprint",OLD."createdAt") THEN
    RAISE EXCEPTION 'Provider execution identity is immutable';
  END IF;
  IF OLD."sentAt" IS NOT NULL AND (NEW."sentAt" IS DISTINCT FROM OLD."sentAt" OR NEW.status = 'PENDING') THEN
    RAISE EXCEPTION 'A sent provider execution can never be resent';
  END IF;
  IF OLD."sentAt" IS NOT NULL AND NEW.admission IS DISTINCT FROM OLD.admission THEN
    RAISE EXCEPTION 'Provider admission evidence is immutable';
  END IF;
  IF OLD.status = 'RESOLVED' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'Provider terminal receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_live_execution BEFORE UPDATE OR DELETE ON trading_provider_executions
  FOR EACH ROW EXECUTE FUNCTION preserve_live_execution();
CREATE FUNCTION preserve_supervision_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Supervision evidence cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW."ownerUserId",NEW."botId",NEW."accountId",NEW."positionId",NEW."mandateId",NEW.baseline,NEW."createdAt")
    IS DISTINCT FROM ROW(OLD.id,OLD."ownerUserId",OLD."botId",OLD."accountId",OLD."positionId",OLD."mandateId",OLD.baseline,OLD."createdAt") THEN
    RAISE EXCEPTION 'Supervision baseline is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_supervision_evidence BEFORE UPDATE OR DELETE ON trading_position_supervisions
  FOR EACH ROW EXECUTE FUNCTION preserve_supervision_evidence();
CREATE FUNCTION preserve_drift_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Drift evidence cannot be deleted'; END IF;
  IF ROW(NEW.id,NEW."ownerUserId",NEW."accountId",NEW."supervisionId",NEW.reason,NEW.evidence,NEW."createdAt")
    IS DISTINCT FROM ROW(OLD.id,OLD."ownerUserId",OLD."accountId",OLD."supervisionId",OLD.reason,OLD.evidence,OLD."createdAt") THEN
    RAISE EXCEPTION 'Drift evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_drift_evidence BEFORE UPDATE OR DELETE ON trading_drift_events
  FOR EACH ROW EXECUTE FUNCTION preserve_drift_evidence();

ALTER TABLE trading_risk_reservations ADD COLUMN "providerState" JSONB;
