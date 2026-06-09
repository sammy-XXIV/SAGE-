CREATE TABLE IF NOT EXISTS wa_sessions (
  key_id     TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);