# SAGE-RH

WhatsApp DeFi agent + DEX for tokenized stocks on Robinhood Chain (Arbitrum Orbit L2).

Built for the **Arbitrum Open House London** hackathon.

---

## What it is

SAGE is a Claude-powered AI agent you talk to over WhatsApp. It manages a non-custodial wallet for each user and lets them trade tokenized stocks (TSLA, AMZN, PLTR, NFLX, AMD) against USDG on a Uniswap V2-style AMM deployed on Robinhood Chain Testnet — no app, no browser, just chat.

---

## Architecture

```
WhatsApp (Baileys) ──► server.js ──► Claude (tool use) ──► on-chain tx
                           │
                           ├── SageAMM (SageFactory + SagePair + SageRouter)
                           ├── Supabase (wallets, sessions, history, trades, alerts)
                           └── Price keeper (Finnhub → DEX rebalance every 60s)
```

### Chain

| Property | Value |
|---|---|
| Network | Robinhood Chain Testnet |
| Chain ID | 46630 |
| RPC | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://explorer.testnet.chain.robinhood.com` |
| Faucet | `https://faucet.testnet.chain.robinhood.com` |

### Deployed contracts

| Contract | Address |
|---|---|
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

| Feature | How to use |
|---|---|
| Wallet | "what's my wallet?" |
| Portfolio | "show my portfolio" |
| Live prices | "TSLA price" |
| Buy stock | "buy $50 of TSLA" |
| Sell stock | "sell 0.1 TSLA" |
| Send tokens | "send 10 USDG to 0x..." |
| Price alert | "alert me when TSLA hits $450" |
| Limit order | "buy $100 USDG of AMZN if it drops to $200" |
| Trade history | "show my trades" |
| Faucet | "I need gas" |

---

## Stack

- **WhatsApp**: [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — linked device protocol, auth persisted in Supabase
- **AI**: Claude claude-sonnet-4-6 with tool use (get_portfolio, execute_swap, set_price_alert, etc.)
- **Chain**: ethers.js v6 — wallet per user, private keys encrypted in Supabase
- **DEX**: SageAMM — custom Uniswap V2 fork (SageFactory, SagePair with TWAP, SageRouter)
- **Prices**: on-chain reserves (`rUSDG / rSTOCK`) for display; Finnhub for price keeper reference
- **Backend**: Express on Railway
- **Frontend**: Static HTML/JS DEX UI on GitHub Pages
- **DB**: Supabase (PostgreSQL) — `rh_wallets`, `wa_sessions`, `rh_conversation_history`, `rh_trades`, `rh_alerts`

---

## Price architecture

Display price is read directly from DEX pair reserves — no external API needed:

```
price = rUSDG / rSTOCK   (from SagePair.getReserves())
```

A background price keeper runs every 60s, fetches Finnhub market prices, and swaps via the DEX to rebalance any pool that drifts >1.5% from the real price.

---

## Running locally

1. Add env vars to a `.env` file
2. `npm install`
3. `npm start` — starts the WhatsApp bot + Express API
4. Scan the QR code with WhatsApp linked devices

```bash
# Separate terminal — local price keeper (optional, Railway runs it in-process)
npm run price-keeper
```

---

## Supabase tables

| Table | Purpose |
|---|---|
| `rh_wallets` | User wallet address + encrypted private key |
| `wa_sessions` | Baileys auth state (persists WhatsApp session across deploys) |
| `rh_conversation_history` | Per-user Claude message history |
| `rh_trades` | Every swap logged for PNL tracking |
| `rh_alerts` | Price alerts and limit orders |

Migrations are in `supabase/migrations/`.

---

## Contracts

Compiled with Hardhat. Source in `contracts/`:

- `SageFactory.sol` — CREATE2 pair deployment
- `SagePair.sol` — x\*y=k AMM + TWAP oracle
- `SageRouter.sol` — swap + liquidity routing
