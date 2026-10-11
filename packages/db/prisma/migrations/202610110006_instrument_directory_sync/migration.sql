-- When the persisted broker directory was last synchronized. Not a credential.
ALTER TABLE trading_connections ADD COLUMN "instrumentDirectorySyncedAt" TIMESTAMP(3);
