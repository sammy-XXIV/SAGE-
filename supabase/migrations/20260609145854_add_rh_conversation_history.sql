CREATE TABLE IF NOT EXISTS rh_conversation_history (
  jid        TEXT PRIMARY KEY,
  messages   JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rh_conversation_history DISABLE ROW LEVEL SECURITY;