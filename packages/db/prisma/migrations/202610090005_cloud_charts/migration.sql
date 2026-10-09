-- CreateTable
CREATE TABLE "cloud_charts" (
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerUserId" TEXT NOT NULL,
    "ownerBotId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'MAIN',
    "accountId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "brokerSymbol" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_charts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cloud_charts_ownerUserId_scope_idx" ON "cloud_charts"("ownerUserId", "scope");

-- CreateIndex
CREATE INDEX "cloud_charts_accountId_instrumentId_idx" ON "cloud_charts"("accountId", "instrumentId");
