CREATE TABLE trade_proposals (
  id TEXT PRIMARY KEY, "requestKey" TEXT NOT NULL UNIQUE, "formatVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("formatVersion" = 1),
  "ownerUserId" TEXT NOT NULL, "botId" TEXT NOT NULL, "accountId" TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('SIMULATION', 'LIVE')),
  "goalId" TEXT NOT NULL, "mandateId" TEXT NOT NULL, "planId" TEXT NOT NULL, "planVersion" INTEGER NOT NULL,
  action JSONB NOT NULL, "actionFingerprint" TEXT NOT NULL, "rationaleSummary" TEXT NOT NULL,
  "evidenceRefs" JSONB NOT NULL, "chartRefs" JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT', revision INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "trade_proposals_ownerUserId_mandateId_createdAt_idx" ON trade_proposals ("ownerUserId", "mandateId", "createdAt");
CREATE TABLE trade_previews (
  id TEXT PRIMARY KEY, "formatVersion" INTEGER NOT NULL DEFAULT 1 CHECK ("formatVersion" = 1),
  "proposalId" TEXT NOT NULL, version INTEGER NOT NULL,
  "actionFingerprint" TEXT NOT NULL, action JSONB NOT NULL, facts JSONB NOT NULL, risk JSONB NOT NULL, state JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT preview_time CHECK ("expiresAt" > "observedAt")
);
CREATE UNIQUE INDEX "trade_previews_proposalId_version_key" ON trade_previews ("proposalId", version);
CREATE FUNCTION protect_trade_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Financial proposal cannot be deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'revision', 'updatedAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'revision', 'updatedAt']) THEN
    RAISE EXCEPTION 'Financial proposal identity is immutable';
  END IF;
  IF NEW.revision <= OLD.revision THEN RAISE EXCEPTION 'Proposal revision must advance'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_trade_proposal BEFORE UPDATE OR DELETE ON trade_proposals FOR EACH ROW EXECUTE FUNCTION protect_trade_proposal();
CREATE FUNCTION protect_trade_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial preview is immutable'; END $$;
CREATE TRIGGER protect_trade_preview BEFORE UPDATE OR DELETE ON trade_previews FOR EACH ROW EXECUTE FUNCTION protect_trade_preview();
