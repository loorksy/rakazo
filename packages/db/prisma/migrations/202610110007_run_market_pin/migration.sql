-- One primary broker instrument per run. Not a credential and not execution authority.
CREATE TABLE "trading_run_markets" (
  "runId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "brokerSymbol" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "accountRead" BOOLEAN NOT NULL DEFAULT false,
  "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trading_run_markets_pkey" PRIMARY KEY ("runId")
);
