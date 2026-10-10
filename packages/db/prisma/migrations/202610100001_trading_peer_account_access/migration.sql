CREATE TABLE trading_agent_account_access (
  "botId" TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "accountId" TEXT NOT NULL REFERENCES trading_connections(id) ON DELETE CASCADE,
  "ownerUserId" TEXT NOT NULL,
  "accountRead" BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("botId", "accountId")
);
