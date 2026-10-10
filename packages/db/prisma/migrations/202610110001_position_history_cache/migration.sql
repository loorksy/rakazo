-- Rebuildable current provider deal history per attributed position. Immutable audit stays in
-- financial_journal; this cache lets accounting and correction checks avoid rereading everything.
CREATE TABLE trading_position_histories (
  "accountId" TEXT NOT NULL,
  "positionId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  deals JSONB NOT NULL,
  synchronized BOOLEAN NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  "realizedPnl" DECIMAL(38,12),
  "dealCount" INTEGER NOT NULL,
  "dealsHash" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("accountId", "positionId"),
  CHECK (NOT complete OR (synchronized AND "realizedPnl" IS NOT NULL)),
  CHECK ("dealCount" >= 0 AND "dealCount" <= 1000)
);
CREATE INDEX trading_position_histories_verification
  ON trading_position_histories ("accountId", complete, "verifiedAt");
CREATE INDEX trading_risk_reservations_provider_reference
  ON trading_risk_reservations ("accountId", "providerReference");
