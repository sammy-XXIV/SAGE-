CREATE TABLE IF NOT EXISTS rh_wallets (
  id            BIGSERIAL PRIMARY KEY,
  jid           TEXT UNIQUE NOT NULL,
  address       TEXT NOT NULL,
  encrypted_pk  TEXT NOT NULL,
  password_hash TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);