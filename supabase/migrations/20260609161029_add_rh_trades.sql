CREATE TABLE IF NOT EXISTS rh_trades (
  id          BIGSERIAL PRIMARY KEY,
  jid         TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,
  amount_in   NUMERIC NOT NULL,
  amount_out  NUMERIC NOT NULL,
  price_usdg  NUMERIC NOT NULL,
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rh_trades DISABLE ROW LEVEL SECURITY;