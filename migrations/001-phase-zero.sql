CREATE TABLE cookies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  cookie_id TEXT REFERENCES cookies(id) ON DELETE RESTRICT,
  quality TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  stop_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'recording', 'recorded', 'cancelled', 'failed', 'missed')),
  unit_name TEXT NOT NULL,
  ts_path TEXT NOT NULL,
  last_started_boot_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (start_at < stop_at)
);

CREATE INDEX recordings_due_scheduled_idx ON recordings(status, start_at);
CREATE INDEX recordings_elapsed_idx ON recordings(status, stop_at);
CREATE INDEX recordings_status_created_idx ON recordings(status, created_at DESC);
CREATE INDEX recordings_cookie_id_idx ON recordings(cookie_id);
