-- CreateTable
CREATE TABLE "account_risk_guardrails" (
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerUserId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "limits" JSONB NOT NULL,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_risk_guardrails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_goals" (
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerUserId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_plans" (
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "goalId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trading_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_mandates" (
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerUserId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "envelope" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "approvedFingerprint" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "missionPnl" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "dailyPnl" DECIMAL(38,12) NOT NULL DEFAULT 0,
    "observedAt" TIMESTAMP(3),
    "observedState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_risk_reservations" (
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerUserId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "effectId" TEXT NOT NULL,
    "actionFingerprint" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "risk" DECIMAL(38,12) NOT NULL,
    "exposure" DECIMAL(38,12) NOT NULL,
    "margin" DECIMAL(38,12) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "executionGeneration" INTEGER NOT NULL,
    "providerReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_risk_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_risk_guardrails_accountId_mode_key" ON "account_risk_guardrails"("accountId", "mode");

-- CreateIndex
CREATE INDEX "trading_goals_ownerUserId_accountId_mode_status_idx" ON "trading_goals"("ownerUserId", "accountId", "mode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trading_plans_goalId_version_key" ON "trading_plans"("goalId", "version");

-- CreateIndex
CREATE INDEX "trading_mandates_ownerUserId_accountId_mode_status_idx" ON "trading_mandates"("ownerUserId", "accountId", "mode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "trading_risk_reservations_effectId_key" ON "trading_risk_reservations"("effectId");

-- CreateIndex
CREATE INDEX "trading_risk_reservations_accountId_mode_status_idx" ON "trading_risk_reservations"("accountId", "mode", "status");

-- CreateIndex
CREATE INDEX "trading_risk_reservations_mandateId_status_idx" ON "trading_risk_reservations"("mandateId", "status");

ALTER TABLE account_risk_guardrails ADD CONSTRAINT account_guardrail_mode CHECK (mode IN ('SIMULATION', 'LIVE'));
ALTER TABLE trading_goals ADD CONSTRAINT trading_goal_mode CHECK (mode IN ('SIMULATION', 'LIVE'));
ALTER TABLE trading_mandates ADD CONSTRAINT trading_mandate_mode CHECK (mode IN ('SIMULATION', 'LIVE'));
ALTER TABLE trading_risk_reservations ADD CONSTRAINT trading_reservation_mode CHECK (mode IN ('SIMULATION', 'LIVE'));
ALTER TABLE trading_risk_reservations ADD CONSTRAINT nonnegative_reservation CHECK (risk >= 0 AND exposure >= 0 AND margin >= 0);
ALTER TABLE trading_mandates ADD CONSTRAINT mandate_approval_bound CHECK (
  status NOT IN ('ACTIVE', 'PAUSED', 'TARGET_REACHED', 'RISK_STOPPED', 'EXPIRED', 'COMPLETED', 'NEEDS_ATTENTION') OR
  ("approvedFingerprint" IS NOT NULL AND "approvedByUserId" IS NOT NULL AND "approvedFingerprint" = fingerprint AND "approvedByUserId" = "ownerUserId" AND "approvedAt" IS NOT NULL)
);
CREATE FUNCTION preserve_trading_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Trading plan versions are immutable'; END $$;
CREATE TRIGGER preserve_trading_plan BEFORE UPDATE OR DELETE ON trading_plans
  FOR EACH ROW EXECUTE FUNCTION preserve_trading_plan();
CREATE FUNCTION preserve_trading_mandate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Trading mandates cannot be deleted'; END IF;
  IF NEW.envelope IS DISTINCT FROM OLD.envelope OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint OR
    NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" OR NEW."botId" IS DISTINCT FROM OLD."botId" OR
    NEW."accountId" IS DISTINCT FROM OLD."accountId" OR NEW.mode IS DISTINCT FROM OLD.mode OR
    NEW."goalId" IS DISTINCT FROM OLD."goalId" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'Trading mandate envelope is immutable';
  END IF;
  IF OLD."approvedAt" IS NOT NULL AND
    (NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" OR NEW."approvedByUserId" IS DISTINCT FROM OLD."approvedByUserId" OR
     NEW."approvedFingerprint" IS DISTINCT FROM OLD."approvedFingerprint") THEN
    RAISE EXCEPTION 'Trading mandate approval is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_trading_mandate BEFORE UPDATE OR DELETE ON trading_mandates
  FOR EACH ROW EXECUTE FUNCTION preserve_trading_mandate();
