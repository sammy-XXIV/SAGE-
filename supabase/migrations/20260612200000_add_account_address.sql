-- Smart-account integration: each wallet gets an on-chain SageAccount that
-- custodies USDG + stock tokens and enforces the Risk Guard on-chain.
ALTER TABLE rh_wallets ADD COLUMN IF NOT EXISTS account_address TEXT;
