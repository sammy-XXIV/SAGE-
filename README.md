# SAGE-RH

**Trade tokenized stocks from WhatsApp — with on-chain self-custody, zero gas, and no app.**

SAGE is a Claude-powered AI agent you talk to over WhatsApp. It gives every user an on-chain smart-account wallet and lets them trade tokenized stocks (TSLA, AMZN, PLTR, NFLX, AMD) against USDG on a custom AMM deployed on Robinhood Chain (Arbitrum Orbit L2) — no browser, no seed phrase, no gas, just chat.

Built for the **Arbitrum Open House London** hackathon.

---

## Why it's different

Most "DeFi on chat" demos are thin wrappers over a custodial hot wallet — one server breach drains everyone. SAGE pushes the trust on-chain:

- 🛡️ **On-chain Risk Guard** — each user's funds live in a `SageAccount` smart contract. SAGE's server key can only *trade* (swap on the SAGE DEX, capped per 24h) — it has no code path to move funds out. A fully compromised server can't drain a single wallet.
- 🔑 **Real self-custody, no wallet required** — set a password on a one-time secure web page; a key is generated **in your browser** (SAGE never sees it or the password) and becomes the on-chain owner. After that SAGE keeps trading for you but can never withdraw — only you can. No MetaMask needed, no secret ever typed in chat.
- ⚡ **Gasless, single address** — SAGE sponsors every transaction. Users never touch a faucet or hold ETH, and deal with one wallet address.
- 🤖 **AI analytics + copilot** — the DEX analytics page has SAGE generate a live market read and answer free-form questions, grounded in real on-chain pool data.
- 📈 **Original on-chain price oracle** — `SageOracle` publishes spot + TWAP prices for every pair, kept fresh by an in-process keeper.
- 💬 **WhatsApp-native, zero-step onboarding** — no app to install. One message creates your wallet (no password, no choices); then trade, set limit orders, and go self-custodial entirely in chat.

---

## Architecture

```
WhatsApp (Baileys)
      │
      ▼
  server.js ───► Claude (haiku-4-5, tool use) ───► on-chain tx
      │
      ├── SageAccount / SageAccountFactory  (per-user smart wallets + on-chain Risk Guard)
      ├── SageDEX  (SageFactory + SagePair + SageRouter — Uniswap V2-style AMM)
      ├── SageOracle  (on-chain spot + TWAP prices)
      ├── Gas sponsor  (deployer wallet tops up each user's session key)
      ├── Price keeper  (Finnhub → DEX rebalance every 60s, pushes TWAP to oracle)
      └── Supabase  (wallets, sessions, history, trades, alerts)

  Web (GitHub Pages)
      ├── SAGE DEX (index.html)        — swap UI
      ├── Analytics (analytics.html)   — live TVL + AI market read + "Ask SAGE" copilot
      └── Secure page (secure.html)    — set password, claim self-custody, export key (all client-side)
```

### Custody model

| Role | Who holds it | Can do | Cannot do |
|---|---|---|---|
| `sessionKey` | SAGE server (per-user EOA) | Swap on the DEX, capped per 24h | Withdraw funds out |
| `owner` (pre-claim) | SAGE server (same EOA) | Withdraw on user's behalf, set limits | — |
| `owner` (post-claim) | **The user's own key** (browser-generated + password-encrypted, or their own MetaMask) | Withdraw, rotate keys, change caps | — |

Funds (USDG + stocks) live in the `SageAccount`. The session key signs trades and SAGE pays the gas. Once a user claims ownership, the withdrawal path requires *their* key — not even SAGE can move funds out.

---

## Chain

| Property | Value |
|---|---|
| Network | Robinhood Chain Testnet |
| Chain ID | 46630 |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |

### Deployed contracts

| Contract | Address |
|---|---|
| SageAccountFactory | `0xcBe2F33bBB9824f29d253C14a812Ac4B6faE86a5` |
| SageOracle | `0x47543D0d0eE57F08f5FBe213795d4078b4900C7D` |
| SageFactory | `0x681c44F678b10bE02f5c8a14B22D1B672E967aaD` |
| SageRouter | `0x275D5A1f0c5036B048Fa9BbB46373c885a4EF0A8` |
| USDG | `0x7E955252E15c84f5768B83c41a71F9eba181802F` |
| TSLA | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` |
| AMZN | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` |
| PLTR | `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` |
| NFLX | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` |
| AMD | `0x71178BAc73cBeb415514eB542a8995b82669778d` |

---

## Features

| Feature | Say to SAGE |
|---|---|
| Wallet address | "what's my wallet?" |
| Portfolio + PNL | "show my portfolio" |
| Live prices | "TSLA price" |
| Buy stock | "buy $50 of TSLA" |
| Sell stock | "sell 0.1 TSLA" |
| Send to any address | "send 10 USDG to 0x…" |
| Price alert | "alert me when TSLA hits $450" |
| Limit order | "buy $100 of AMZN if it drops below $200" |
| List / cancel orders | "show my orders" / "cancel order 3" |
| Spending limit | "limit my trades to $100" |
| Trade history | "show my trades" |
| **Set password / self-custody** | "secure my wallet" → one-time secure link |
| **Export private key** | "export my key" → secure link (enter your password) |

Self-custody, password and key export happen on a **one-time secure web page** — never in chat. The key is generated and decrypted in the user's browser; SAGE only ever stores the password-encrypted keystore (ciphertext) and never sees the password. Power users with an existing wallet can instead claim straight to their own address.

### SAGE Risk Guard

Before any swap, SAGE checks (and blocks unless the user overrides):

- **Price impact** > 8% — pool too thin for the trade size
- **Concentration** > 25% of portfolio in one trade
- **Spending limit** — optional per-user max USDG per trade

The 24h trading cap is additionally enforced **on-chain** by the `SageAccount` contract, independent of the server.

---

## Price architecture

Display price is read directly from DEX pair reserves — no external API in the hot path:

```
price = rUSDG / rSTOCK   (from SagePair.getReserves())
```

A background **price keeper** runs every 60s, fetches Finnhub market prices, and swaps through the DEX to rebalance any pool that drifts more than **0.1%** from the real price (tight enough for limit-order triggers). After each run it calls `SageOracle.updateAll()` to refresh on-chain TWAP snapshots.

---

## Security

Hardened across two audits (see commit history):

- Server-held session keys encrypted with **AES-256-GCM**, random per-secret scrypt salt
- **No secrets in chat** — passwords and private keys are never typed in WhatsApp. Self-custody/export happen on a secure page; the user's key is generated and decrypted **client-side** and the server stores only the password-encrypted keystore (ciphertext) — never the password
- Secure-page links are **one-time, jid-bound, and expire in 1 hour**
- WhatsApp session keys encrypted at rest with a boot-derived key (fast path)
- **Rate limiting** (per-IP behind Railway's proxy), timing-safe admin auth, separate `ADMIN_KEY`
- Risk-guard `force` override can't be self-granted by the model (server-side gating)
- Server-side **slippage floor** on every swap; transaction timeouts; generic error responses

---

## Stack

- **WhatsApp**: [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — linked-device protocol, auth persisted (encrypted) in Supabase
- **AI**: Claude `claude-haiku-4-5` with tool use (`get_portfolio`, `execute_swap`, `get_secure_link`, `claim_ownership`, `set_limit_order`, …) — also powers the analytics market read and the "Ask SAGE" copilot
- **Chain**: ethers.js v6
- **Smart accounts**: `SageAccount` + `SageAccountFactory` — per-user on-chain wallets with the Risk Guard enforced in Solidity
- **DEX**: SageDEX — custom Uniswap V2 fork (`SageFactory`, `SagePair` with TWAP, `SageRouter`)
- **Oracle**: `SageOracle` — on-chain spot + TWAP price feed
- **Backend**: Express on Railway
- **Frontend**: static DEX UI, AI analytics page, and client-side secure self-custody page on GitHub Pages
- **DB**: Supabase (PostgreSQL)

### Key HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `GET /analytics` | Live pool stats — TVL, reserves, prices |
| `GET /analytics/ai` | SAGE's AI market read (server-cached 3 min) |
| `POST /analytics/ask` | "Ask SAGE" copilot — Q&A on live data (rate-limited) |
| `GET /claim/info` · `POST /claim/complete` | Secure-page self-custody claim (token-gated) |
| `POST /vault/get` | Return the encrypted keystore for in-browser export |
| `GET /admin/*` | Status, keeper, user reset (admin-key gated) |

---

## Running locally

1. Add env vars to `.env` (see below)
2. `npm install`
3. `npm start` — starts the WhatsApp bot + Express API + in-process price keeper
4. Open `/qr?key=<ADMIN_KEY>` and scan with WhatsApp linked devices

### Required env vars

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
ENCRYPTION_KEY=          # wallet encryption — required, no fallback
ADMIN_KEY=               # admin endpoint auth (separate from ENCRYPTION_KEY)
RPC_URL=
DEPLOYER_PRIVATE_KEY=    # gas sponsor + price keeper
FINNHUB_API_KEY=
SAGE_ACCOUNT_FACTORY=    # defaults to the deployed factory
SAGE_ORACLE=             # defaults to the deployed oracle
FRONTEND_BASE=           # base URL for the secure page (defaults to the GitHub Pages site)
PORT=
```

---

## Supabase tables

| Table | Purpose |
|---|---|
| `rh_wallets` | User EOA + encrypted key + `account_address` (smart account) |
| `wa_sessions` | Baileys auth state (encrypted, survives deploys) |
| `rh_conversation_history` | Per-user Claude message history |
| `rh_trades` | Every swap logged for PNL |
| `rh_alerts` | Price alerts, limit orders, and per-user config |

Migrations in `supabase/migrations/`.

---

## Contracts

Compiled with Hardhat. Source in `contracts/`:

- `SageAccount.sol` — per-user smart wallet; session key trades (capped on-chain), owner withdraws
- `SageAccountFactory.sol` — deploys + indexes accounts, keyed by `keccak256(jid)` (no phone numbers on-chain)
- `SageFactory.sol` — CREATE2 pair deployment
- `SagePair.sol` — x·y=k AMM + TWAP oracle
- `SageRouter.sol` — swap + liquidity routing
- `SageOracle.sol` — on-chain spot + TWAP price aggregation

On-chain proofs of the custody model are in `scripts/` (`deploy-account`, `test-account-integration`, `test-gas-sponsor`, `test-claim-flow`).
