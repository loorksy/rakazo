ALTER TABLE simulation_books ADD COLUMN "nextExpiryAt" TIMESTAMP(3);
UPDATE simulation_books SET revision = revision + 1, "nextExpiryAt" = (
  SELECT MIN((entry->>'expiresAt')::timestamptz AT TIME ZONE 'UTC')
  FROM jsonb_array_elements(state->'orders') entry
) WHERE jsonb_array_length(state->'orders') > 0;
CREATE INDEX simulation_books_expiry_idx ON simulation_books ("nextExpiryAt");
CREATE TABLE simulation_market_cursors (
  "accountId" TEXT NOT NULL, "instrumentId" TEXT NOT NULL, "ownerUserId" TEXT NOT NULL,
  "sourceTime" TIMESTAMP(3) NOT NULL, quote JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("accountId", "instrumentId"),
  CONSTRAINT simulation_cursor_identity CHECK (
    quote->>'accountId' = "accountId" AND quote->>'instrumentId' = "instrumentId"
  )
);
CREATE TABLE simulation_market_receipts (
  id TEXT PRIMARY KEY, "accountId" TEXT NOT NULL, "ownerUserId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL, type TEXT NOT NULL, "originEffectId" TEXT NOT NULL,
  "mandateId" TEXT NOT NULL, "formatVersion" INTEGER NOT NULL DEFAULT 1,
  "bookRevision" INTEGER NOT NULL, event JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT simulation_receipt_format CHECK ("formatVersion" = 1 AND "bookRevision" > 0),
  CONSTRAINT simulation_receipt_type CHECK (type IN ('ORDER_FILLED','ORDER_EXPIRED','STOP_LOSS','TAKE_PROFIT'))
);
CREATE UNIQUE INDEX simulation_receipt_identity ON simulation_market_receipts ("accountId", "targetId", type);
CREATE INDEX simulation_receipt_account_created ON simulation_market_receipts ("accountId", "createdAt");
CREATE TRIGGER preserve_simulation_market_receipt BEFORE UPDATE OR DELETE ON simulation_market_receipts
  FOR EACH ROW EXECUTE FUNCTION preserve_financial_journal();
ALTER TABLE trading_mission_wakes DROP CONSTRAINT mission_wake_kind;
ALTER TABLE trading_mission_wakes ADD CONSTRAINT mission_wake_kind CHECK (
  kind IN ('START','REEVALUATE','EXPIRE','ACCOUNT_EVENT')
);
