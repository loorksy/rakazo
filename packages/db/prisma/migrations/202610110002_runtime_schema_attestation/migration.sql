-- The trusted Worker attests that the database matches the migrations of the build it runs.
ALTER TABLE trading_runtime_health ADD COLUMN "schemaHealthy" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trading_runtime_health ADD COLUMN "schemaFingerprint" TEXT;
