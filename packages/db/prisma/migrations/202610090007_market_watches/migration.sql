-- CreateTable
CREATE TABLE "market_watches" (
    "creationKey" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerUserId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "condition" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "wakeGeneration" INTEGER NOT NULL DEFAULT 0,
    "lastValue" TEXT,
    "lastSourceTime" TIMESTAMP(3),
    "pendingEvidence" JSONB,
    "triggeredRunId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_watches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_watches_creationKey_key" ON "market_watches"("creationKey");

-- CreateIndex
CREATE INDEX "market_watches_accountId_status_expiresAt_idx" ON "market_watches"("accountId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "market_watches_ownerUserId_botId_idx" ON "market_watches"("ownerUserId", "botId");
