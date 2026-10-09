-- CreateTable
CREATE TABLE "trading_connections" (
    "id" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerUserId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'metaapi',
    "providerAccountId" TEXT NOT NULL,
    "region" TEXT,
    "ciphertext" TEXT NOT NULL,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "environment" TEXT,
    "capabilities" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_session_leases" (
    "accountId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "holder" TEXT,
    "expiresAt" TIMESTAMP(3),
    "credentialVersion" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "lastEventAt" TIMESTAMP(3),
    "lastHealthyAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_session_leases_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "broker_instruments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "brokerSymbol" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "specification" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "broker_instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_read_requests" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claimedGeneration" INTEGER,
    "result" JSONB,
    "failureCode" TEXT,
    "deadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_read_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trading_connections_ownerUserId_revokedAt_idx" ON "trading_connections"("ownerUserId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "trading_connections_ownerUserId_provider_providerAccountId_key" ON "trading_connections"("ownerUserId", "provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "broker_session_leases_expiresAt_idx" ON "broker_session_leases"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "broker_instruments_accountId_brokerSymbol_key" ON "broker_instruments"("accountId", "brokerSymbol");

-- CreateIndex
CREATE INDEX "broker_read_requests_accountId_status_deadline_idx" ON "broker_read_requests"("accountId", "status", "deadline");

-- CreateIndex
CREATE INDEX "broker_read_requests_createdAt_idx" ON "broker_read_requests"("createdAt");

-- AddForeignKey
ALTER TABLE "broker_session_leases" ADD CONSTRAINT "broker_session_leases_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_instruments" ADD CONSTRAINT "broker_instruments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_read_requests" ADD CONSTRAINT "broker_read_requests_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "trading_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
