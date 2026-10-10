-- Rebuildable calendar cache. Absence of rows means the feed is unknown, never that nothing is scheduled.
CREATE TABLE economic_calendar_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  title TEXT NOT NULL,
  currency TEXT NOT NULL,
  country TEXT,
  impact TEXT NOT NULL,
  "occursAt" TIMESTAMP(3) NOT NULL,
  actual TEXT,
  forecast TEXT,
  previous TEXT,
  revision TEXT,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  CHECK (impact IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')),
  CHECK (char_length(currency) BETWEEN 2 AND 8),
  UNIQUE (provider, "eventKey")
);
CREATE INDEX economic_calendar_events_time ON economic_calendar_events ("occursAt");
