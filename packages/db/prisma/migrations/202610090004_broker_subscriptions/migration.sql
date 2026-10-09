-- CreateTable
CREATE TABLE "broker_market_subscriptions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_market_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broker_market_subscriptions_accountId_expiresAt_idx" ON "broker_market_subscriptions"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "broker_market_subscriptions_expiresAt_idx" ON "broker_market_subscriptions"("expiresAt");

-- AddForeignKey
ALTER TABLE "broker_market_subscriptions" ADD CONSTRAINT "broker_market_subscriptions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
