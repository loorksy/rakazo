-- Owner-adjustable allowlisted deployment settings. Credentials live in SecretStore-backed
-- integration_provider_configs; bootstrap identity secrets are never stored here.
CREATE TABLE deployment_config (
  id TEXT PRIMARY KEY DEFAULT 'default' CHECK (id = 'default'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  runtime JSONB NOT NULL DEFAULT '{}',
  playbook JSONB NOT NULL DEFAULT '{"disabledGroups":[]}',
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE deployment_config_audit (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  "actorUserId" TEXT NOT NULL,
  changes JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX deployment_config_audit_created ON deployment_config_audit ("createdAt");
CREATE FUNCTION preserve_deployment_config_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Deployment configuration audit is immutable';
END $$;
CREATE TRIGGER preserve_deployment_config_audit BEFORE UPDATE OR DELETE ON deployment_config_audit
  FOR EACH ROW EXECUTE FUNCTION preserve_deployment_config_audit();
-- What each running API/Worker process actually started with; restart-required is derived from it.
CREATE TABLE service_runtime_reports (
  "instanceId" TEXT PRIMARY KEY,
  service TEXT NOT NULL CHECK (service IN ('api', 'worker')),
  "startedAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  revision INTEGER NOT NULL,
  applied JSONB NOT NULL,
  "gitSha" TEXT
);
CREATE INDEX service_runtime_reports_service_heartbeat ON service_runtime_reports (service, "heartbeatAt");
-- Mode the supervisor reports alongside its live containment verification (status only).
ALTER TABLE trading_runtime_health ADD COLUMN "containmentMode" TEXT;
