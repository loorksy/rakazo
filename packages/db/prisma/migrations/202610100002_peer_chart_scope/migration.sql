-- Preserve creator ownership while removing the legacy Main chart terminology.
UPDATE cloud_charts SET scope = 'PRIVATE' WHERE scope = 'MAIN';
ALTER TABLE cloud_charts ALTER COLUMN scope SET DEFAULT 'WORKER';
