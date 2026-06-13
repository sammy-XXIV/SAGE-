import express from 'express';
import rateLimit from 'express-rate-limit';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import Pino from 'pino';
import Anthropic from '@anthropic-ai/sdk';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import fs from 'fs';
import qrcode from 'qrcode';
import yahooFinance from 'yahoo-finance2';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
app.set('trust proxy', 1); // behind Railway's proxy — needed so rate limiting keys on real client IPs
app.use(express.json());

// ── Rate limiting ─────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const adminLimiter   = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
app.use('/admin', adminLimiter);
app.use(generalLimiter);

// ── Config ────────────────────────────────────────────────────
const RPC_URL        = process.env.RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID       = 46630;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY env var is required — refusing to start without it');

// Admin endpoint auth — separate from the wallet encryption key so a leaked
// admin token can't decrypt wallet private keys. Falls back to ENCRYPTION_KEY
// until ADMIN_KEY is set in Railway env vars.
const ADMIN_KEY = process.env.ADMIN_KEY || ENCRYPTION_KEY;
if (!process.env.ADMIN_KEY) console.warn('[Security] ADMIN_KEY not set — admin auth falls back to ENCRYPTION_KEY. Add a separate ADMIN_KEY env var.');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Accepts x-admin-key header (preferred — query strings end up in access logs) or ?key= for backward compat
function isAdmin(req) {
  return safeEqual(req.get('x-admin-key') || req.query.key, ADMIN_KEY);
}

const provider  = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'robinhood-testnet' });
const supabase  = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// ── Token registry ─────────────────────────────────────────────
const TOKENS = {
  ETH:  { address: 'native',                                        decimals: 18, name: 'Ethereum' },
  WETH: { address: '0x7943e237c7F95DA44E0301572D358911207852Fa',    decimals: 18, name: 'Wrapped ETH' },
  USDG: { address: '0x7E955252E15c84f5768B83c41a71F9eba181802F',    decimals: 6,  name: 'USD (Robinhood)' },
  TSLA: { address: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E',    decimals: 18, name: 'Tesla' },
  AMZN: { address: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02',    decimals: 18, name: 'Amazon' },
  PLTR: { address: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0',    decimals: 18, name: 'Palantir' },
  NFLX: { address: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93',    decimals: 18, name: 'Netflix' },
  AMD:  { address: '0x71178BAc73cBeb415514eB542a8995b82669778d',    decimals: 18, name: 'AMD' },
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  'function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

// ── DEX config ─────────────────────────────────────────────────
let DEX = null;
try {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployment.json'), 'utf8'));
  DEX = { factory: dep.factory, router: dep.router };
  console.log('DEX loaded — Router:', DEX.router);
} catch {
  console.log('No deployment.json found — swap features disabled until deploy');
}

// ── SageAccount (smart wallet) config ──────────────────────────
// Per-user on-chain account that custodies USDG + stock tokens and enforces
// the Risk Guard on-chain. The user's EOA is the session+owner key (server
// holds it, pays gas, signs swaps); funds live in the account, so a leaked
// session key can only trade within the daily cap, never withdraw.
const SAGE_ACCOUNT_FACTORY = process.env.SAGE_ACCOUNT_FACTORY || '0xcBe2F33bBB9824f29d253C14a812Ac4B6faE86a5';
const ACCOUNT_FACTORY_ABI = [
  'function createAccount(bytes32 userId, address owner, address sessionKey) external returns (address account)',
  'function accountOf(bytes32 userId) external view returns (address)',
];
const SAGE_ACCOUNT_ABI = [
  'function swap(uint256 amountIn, uint256 amountOutMin, address[] path, uint256 deadline) external returns (uint256)',
  'function withdraw(address token, address to, uint256 amount) external',
  'function transferOwnership(address newOwner) external',
  'function owner() view returns (address)',
  'function sessionKey() view returns (address)',
  'function remainingToday() view returns (uint256)',
];
function userIdFor(jid) { return ethers.keccak256(ethers.toUtf8Bytes(jid)); }

// ── Secure web link (self-custody / password / export, off-chat) ──────
// The user sets a password and a key is generated in their BROWSER on this
// page — nothing secret ever travels through chat or reaches the server.
// The page sends back only the public address, which becomes the account owner.
const FRONTEND_BASE = process.env.FRONTEND_BASE || 'https://sammy-xxiv.github.io/sage';
const SECURE_TOKEN_TTL = 60 * 60 * 1000; // 1 hour
const secureTokens = new Map(); // token -> { jid, expires }

function makeSecureToken(jid) {
  const token = crypto.randomBytes(24).toString('hex');
  secureTokens.set(token, { jid, expires: Date.now() + SECURE_TOKEN_TTL });
  return token;
}
function peekSecureToken(token) {
  const t = secureTokens.get(token);
  if (!t || Date.now() > t.expires) { secureTokens.delete(token); return null; }
  return t;
}

// Password-encrypted owner keystore (ciphertext only — the password never reaches
// the server). Stored in the now-unused password_hash column. The user sets it
// once on the secure page; later they re-enter the password to decrypt locally.
async function getKeystore(jid) {
  const { data } = await supabase.from('rh_wallets').select('password_hash').eq('jid', jid).single();
  const v = data?.password_hash;
  return (v && v.trim().startsWith('{')) ? v : null; // keystore JSON only; ignore legacy hashes
}
async function setKeystore(jid, keystore) {
  await supabase.from('rh_wallets').update({ password_hash: keystore }).eq('jid', jid);
}

// ── Encryption ─────────────────────────────────────────────────
// v2 format:           v2:salt:iv:tag:ct   — AES-256-GCM, random per-secret salt (authenticated)
// legacy CBC random:   salt:iv:ct          (3 parts)
// legacy CBC static:   iv:ct               (2 parts, static 'salt')
function encrypt(text) {
  const salt   = crypto.randomBytes(16);
  const iv     = crypto.randomBytes(12);
  const key    = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct     = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v2', salt.toString('hex'), iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}

function decrypt(enc) {
  const parts = enc.split(':');
  if (parts[0] === 'v2') {
    const [, saltHex, ivHex, tagHex, ctHex] = parts;
    const key = crypto.scryptSync(ENCRYPTION_KEY, Buffer.from(saltHex, 'hex'), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  }
  let key, iv, data;
  if (parts.length === 3) {
    const [saltHex, ivHex, ciphertext] = parts;
    key  = crypto.scryptSync(ENCRYPTION_KEY, Buffer.from(saltHex, 'hex'), 32);
    iv   = Buffer.from(ivHex, 'hex');
    data = ciphertext;
  } else {
    // Legacy: static salt
    const [ivHex, ciphertext] = parts;
    key  = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    iv   = Buffer.from(ivHex, 'hex');
    data = ciphertext;
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

// ── Session encryption (fast path) ─────────────────────────────
// Baileys writes session keys dozens of times per message — per-write scrypt
// would peg the CPU. Derive the session key ONCE at boot, random IV per write.
// Wallet PKs keep the per-secret scrypt salt above (rare writes, higher stakes).
const SESSION_KEY = crypto.scryptSync(ENCRYPTION_KEY, 'sage-wa-sessions-v1', 32);

function encryptSession(text) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SESSION_KEY, iv);
  const ct     = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['s1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}

function decryptSession(enc) {
  const [v, ivHex, tagHex, ctHex] = enc.split(':');
  if (v !== 's1') throw new Error('not session format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SESSION_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

// ── Wallet helpers ─────────────────────────────────────────────
async function getOrCreateWallet(jid) {
  const { data } = await supabase
    .from('rh_wallets')
    .select('*')
    .eq('jid', jid)
    .single();

  if (data) {
    activeWalletRegistry.set(jid, data.address);
    // Backfill a smart account for pre-existing users (background, non-blocking)
    if (!data.account_address && !accountProvisioning.has(jid)) {
      ensureAccount(jid, data.address).catch(() => {});
    }
    return data;
  }

  const wallet = ethers.Wallet.createRandom();
  const encrypted = encrypt(wallet.privateKey);

  const { data: inserted, error } = await supabase
    .from('rh_wallets')
    .insert({ jid, address: wallet.address, encrypted_pk: encrypted })
    .select()
    .single();

  if (error) throw new Error('Failed to create wallet: ' + error.message);
  activeWalletRegistry.set(jid, inserted.address);
  return inserted;
}

async function getSignerForJid(jid) {
  const row = await getOrCreateWallet(jid);
  const pk  = decrypt(row.encrypted_pk);
  return new ethers.Wallet(pk, provider);
}

// ── Smart-account helpers ──────────────────────────────────────
// Read the user's SageAccount address from the DB (no on-chain tx). Returns
// null if not provisioned yet — callers fall back to the legacy EOA path.
async function getAccountAddress(jid) {
  try {
    const { data } = await supabase.from('rh_wallets').select('account_address').eq('jid', jid).single();
    return data?.account_address || null;
  } catch { return null; }
}

const accountProvisioning = new Set(); // jid guard against concurrent creation

// Provision a SageAccount for a user if missing. Gas is paid by the deployer
// wallet (not the user), so this works at onboarding before the user has ETH.
// Returns the account address, or null if provisioning is unavailable/failed.
async function ensureAccount(jid, eoaAddress) {
  if (!SAGE_ACCOUNT_FACTORY || !DEX || !KEEPER_PK) return null;

  const existing = await getAccountAddress(jid);
  if (existing) return existing;
  if (accountProvisioning.has(jid)) return null; // already in flight
  accountProvisioning.add(jid);
  try {
    const deployer = new ethers.Wallet(KEEPER_PK, provider);
    const factory  = new ethers.Contract(SAGE_ACCOUNT_FACTORY, ACCOUNT_FACTORY_ABI, deployer);
    const userId   = userIdFor(jid);

    // May already exist on-chain (e.g. DB column added after creation)
    let acct = await factory.accountOf(userId);
    if (!acct || acct === ethers.ZeroAddress) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = await factory.createAccount(userId, eoaAddress, eoaAddress);
          await waitTx(tx);
          break;
        } catch (e) {
          if (!/nonce|replacement|already known/i.test(e.message) || attempt === 2) throw e;
          await new Promise(r => setTimeout(r, 1500)); // nonce race with keeper — retry
        }
      }
      acct = await factory.accountOf(userId);
    }
    if (!acct || acct === ethers.ZeroAddress) return null;

    await supabase.from('rh_wallets').update({ account_address: acct }).eq('jid', jid);
    await sponsorGas(eoaAddress); // pre-fund gas so the user never needs ETH
    return acct;
  } catch (e) {
    console.error('[Account] ensure failed:', e.message);
    return null;
  } finally {
    accountProvisioning.delete(jid);
  }
}

// ── Gas sponsorship ────────────────────────────────────────────
// SAGE covers gas for every user so they only deal with ONE address (the
// smart account). Each user's EOA still signs its own swaps (own nonce, no
// shared key), we just keep it topped up from the deployer wallet.
// Gas is ~0.000002 ETH/swap on Robinhood Chain (0.01 gwei), so tiny top-ups go
// a long way. Refill an EOA to ~150 swaps' worth when it drops below ~15.
const GAS_TOPUP_THRESHOLD = ethers.parseEther('0.00003'); // ~15 swaps left → refill
const GAS_TOPUP_AMOUNT    = ethers.parseEther('0.0003');  // ~150 swaps
const GAS_RESERVE         = ethers.parseEther('0.0003');  // keep this much in deployer for the keeper
const gasSponsoring = new Set(); // eoa guard against concurrent top-ups

async function sponsorGas(eoaAddress) {
  if (!KEEPER_PK || !eoaAddress) return;
  try {
    if ((await provider.getBalance(eoaAddress)) >= GAS_TOPUP_THRESHOLD) return;
    if (gasSponsoring.has(eoaAddress)) return;
    gasSponsoring.add(eoaAddress);
    try {
      const deployer = new ethers.Wallet(KEEPER_PK, provider);
      const dbal = await provider.getBalance(deployer.address);
      if (dbal < GAS_TOPUP_AMOUNT + GAS_RESERVE) {
        console.error(`[Gas] deployer too low (${ethers.formatEther(dbal)} ETH) to sponsor ${eoaAddress}`);
        return;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = await deployer.sendTransaction({ to: eoaAddress, value: GAS_TOPUP_AMOUNT });
          await waitTx(tx);
          console.log(`[Gas] topped up ${eoaAddress} +${ethers.formatEther(GAS_TOPUP_AMOUNT)} ETH`);
          break;
        } catch (e) {
          if (!/nonce|replacement|already known/i.test(e.message) || attempt === 2) throw e;
          await new Promise(r => setTimeout(r, 1500)); // nonce race with keeper — retry
        }
      }
    } finally {
      gasSponsoring.delete(eoaAddress);
    }
  } catch (e) {
    console.error('[Gas] sponsor failed:', e.message);
  }
}

// On-chain ERC-20 balance (raw bigint) for any address.
async function tokenBalanceOf(tokenAddress, owner) {
  const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return c.balanceOf(owner);
}

// Combined holdings across the smart account + the gas EOA, merged by symbol.
// Used during the migration window so legacy EOA funds still show and trade.
async function getCombinedPortfolio(jid) {
  const row = await getOrCreateWallet(jid);
  const accountAddr = await getAccountAddress(jid);
  const addresses = accountAddr ? [accountAddr, row.address] : [row.address];

  const merged = {};
  for (const addr of addresses) {
    const holdings = await getPortfolio(addr);
    for (const h of holdings) {
      if (merged[h.symbol]) merged[h.symbol].amount += h.amount;
      else merged[h.symbol] = { ...h };
    }
  }
  return { address: row.address, accountAddress: accountAddr, holdings: Object.values(merged) };
}

async function getPortfolio(address) {
  const holdings = [];

  // ETH balance
  const ethBal = await provider.getBalance(address);
  const ethAmt = parseFloat(ethers.formatEther(ethBal));
  if (ethAmt > 0) holdings.push({ symbol: 'ETH', amount: ethAmt, address: 'native' });

  // ERC-20 balances — fetch all in parallel, retry once on failure
  await Promise.all(Object.entries(TOKENS).map(async ([symbol, info]) => {
    if (info.address === 'native') return;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const contract = new ethers.Contract(info.address, ERC20_ABI, provider);
        const bal = await contract.balanceOf(address);
        const amt = parseFloat(ethers.formatUnits(bal, info.decimals));
        if (amt > 0) holdings.push({ symbol, amount: amt, address: info.address, name: info.name });
        return;
      } catch (e) {
        if (attempt === 1) console.error(`[Portfolio] ${symbol} balanceOf failed:`, e.message);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }));

  return holdings;
}

async function sendEth(jid, toAddress, amount) {
  const signer = await getSignerForJid(jid);
  await sponsorGas(signer.address);
  const value  = ethers.parseEther(String(amount));
  const tx = await signer.sendTransaction({ to: toAddress, value });
  await waitTx(tx);
  return tx.hash;
}

async function sendToken(jid, symbol, toAddress, amount) {
  const tokenInfo = TOKENS[symbol.toUpperCase()];
  if (!tokenInfo) throw new Error(`Unknown token: ${symbol}`);
  if (tokenInfo.address === 'native') return sendEth(jid, toAddress, amount);

  const signer = await getSignerForJid(jid);
  await sponsorGas(signer.address);
  const units  = ethers.parseUnits(String(amount), tokenInfo.decimals);

  // If the smart account holds the tokens, withdraw via the account (owner=EOA
  // signs). Otherwise transfer directly from the EOA (legacy/un-migrated funds).
  const accountAddr = await getAccountAddress(jid);
  if (accountAddr) {
    try {
      if ((await tokenBalanceOf(tokenInfo.address, accountAddr)) >= units) {
        const account = new ethers.Contract(accountAddr, SAGE_ACCOUNT_ABI, signer);
        // If self-custodied, SAGE is no longer owner and can't withdraw — say so clearly.
        const owner = await account.owner();
        if (owner.toLowerCase() !== signer.address.toLowerCase()) {
          throw new Error(`SELF_CUSTODIED: Your wallet is self-custodied — SAGE can no longer move your funds out. Withdraw ${symbol} yourself using your own wallet (e.g. MetaMask) that owns the account.`);
        }
        const tx = await account.withdraw(tokenInfo.address, toAddress, units);
        await waitTx(tx);
        return tx.hash;
      }
    } catch (e) {
      if (/^SELF_CUSTODIED:/.test(e.message)) throw new Error(e.message.replace('SELF_CUSTODIED: ', ''));
      console.error('[Send] account withdraw failed, trying EOA:', e.message);
    }
  }

  const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
  const tx = await contract.transfer(toAddress, units);
  await waitTx(tx);
  return tx.hash;
}

// ── DEX swap helpers ──────────────────────────────────────────
async function getSwapQuote(fromSymbol, toSymbol, amountIn) {
  if (!DEX) throw new Error('DEX not deployed yet');

  const fromToken = TOKENS[fromSymbol.toUpperCase()];
  const toToken   = TOKENS[toSymbol.toUpperCase()];
  if (!fromToken || fromToken.address === 'native') throw new Error(`Unsupported input token: ${fromSymbol}`);
  if (!toToken   || toToken.address === 'native')   throw new Error(`Unsupported output token: ${toSymbol}`);

  const router   = new ethers.Contract(DEX.router, ROUTER_ABI, provider);
  const amtIn    = ethers.parseUnits(String(amountIn), fromToken.decimals);
  const path     = [fromToken.address, toToken.address];
  const amounts  = await router.getAmountsOut(amtIn, path);
  const amtOut   = ethers.formatUnits(amounts[1], toToken.decimals);
  const priceImpact = ((parseFloat(amountIn) / (parseFloat(amtOut) + parseFloat(amountIn))) * 0.3).toFixed(3);

  return {
    fromSymbol: fromSymbol.toUpperCase(),
    toSymbol:   toSymbol.toUpperCase(),
    amountIn:   parseFloat(amountIn),
    amountOut:  parseFloat(amtOut),
    rate:       (parseFloat(amtOut) / parseFloat(amountIn)).toFixed(6),
    priceImpact,
    minAmountOut: (parseFloat(amtOut) * 0.99).toFixed(6), // 1% slippage
  };
}

async function executeSwap(jid, fromSymbol, toSymbol, amountIn, minAmountOut) {
  if (!DEX) throw new Error('DEX not deployed yet');

  const fromToken = TOKENS[fromSymbol.toUpperCase()];
  const toToken   = TOKENS[toSymbol.toUpperCase()];
  if (!fromToken || fromToken.address === 'native') throw new Error(`Unsupported input token: ${fromSymbol}`);
  if (!toToken   || toToken.address === 'native')   throw new Error(`Unsupported output token: ${toSymbol}`);

  const signer  = await getSignerForJid(jid);
  await sponsorGas(signer.address); // SAGE covers gas — keep the EOA funded

  const amtIn     = ethers.parseUnits(String(amountIn), fromToken.decimals);
  const amtOutMin = ethers.parseUnits(String(minAmountOut), toToken.decimals);
  const path      = [fromToken.address, toToken.address];
  const deadline  = Math.floor(Date.now() / 1000) + 300;

  // Route through the smart account when it holds the input token; otherwise
  // fall back to the legacy EOA path (existing/un-migrated funds).
  const accountAddr = await getAccountAddress(jid);
  let useAccount = false;
  if (accountAddr) {
    try { useAccount = (await tokenBalanceOf(fromToken.address, accountAddr)) >= amtIn; } catch {}
  }

  let tx, receipt;
  if (useAccount) {
    // account.swap() approves the router internally and forces output back to
    // the account — funds can never leave via this path.
    const account = new ethers.Contract(accountAddr, SAGE_ACCOUNT_ABI, signer);
    tx = await account.swap(amtIn, amtOutMin, path, deadline);
    receipt = await waitTx(tx);
  } else {
    const erc20  = new ethers.Contract(fromToken.address, ERC20_ABI, signer);
    const router = new ethers.Contract(DEX.router, ROUTER_ABI, signer);
    const allowance = await erc20.allowance(signer.address, DEX.router);
    if (allowance < amtIn) {
      const approveTx = await erc20.approve(DEX.router, amtIn);
      await waitTx(approveTx);
    }
    tx = await router.swapExactTokensForTokens(amtIn, amtOutMin, path, signer.address, deadline);
    receipt = await waitTx(tx);
  }

  // Parse actual amountOut from the last Transfer log
  const actualAmountOut = (() => {
    try {
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      const last = [...receipt.logs].reverse().find(l => l.topics[0] === transferTopic);
      return last ? parseFloat(ethers.formatUnits(last.data, toToken.decimals)) : parseFloat(minAmountOut);
    } catch { return parseFloat(minAmountOut); }
  })();

  // Log trade for PNL tracking
  const from = fromSymbol.toUpperCase();
  const to   = toSymbol.toUpperCase();
  const isSwapFromUsdg = from === 'USDG';
  const stockSym  = isSwapFromUsdg ? to : from;
  const priceData = await getStockPrice(stockSym);
  const priceUsdg = priceData?.price || 0;
  await supabase.from('rh_trades').insert({
    jid,
    symbol:     stockSym,
    side:       isSwapFromUsdg ? 'buy' : 'sell',
    amount_in:  parseFloat(amountIn),
    amount_out: actualAmountOut,
    price_usdg: priceUsdg,
    tx_hash:    tx.hash,
  });

  return {
    success: true,
    hash: tx.hash,
    explorer: `https://explorer.testnet.chain.robinhood.com/tx/${tx.hash}`,
    fromSymbol: from,
    toSymbol:   to,
    amountIn:   parseFloat(amountIn),
    amountOut:  actualAmountOut,
  };
}

// ── Stock price lookup (Yahoo Finance unofficial) ──────────────
const STOCK_SYMBOLS = { TSLA: 'TSLA', AMZN: 'AMZN', PLTR: 'PLTR', NFLX: 'NFLX', AMD: 'AMD' };

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';

const DEP_PAIRS = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployment.json'), 'utf8')).pairs;

// ── Per-user spending limits (cached in-memory, persisted to Supabase) ──
// Stored as a config row in rh_alerts (type='config', triggered=true so the
// alert monitor and get_orders never pick it up) — survives Railway redeploys.
const spendingLimits = new Map(); // jid → max USDG per trade (cache)

async function getSpendingLimit(jid) {
  if (spendingLimits.has(jid)) return spendingLimits.get(jid);
  let limit = 0;
  try {
    const { data } = await supabase.from('rh_alerts').select('target_price')
      .eq('jid', jid).eq('type', 'config').eq('symbol', 'SPENDING_LIMIT').maybeSingle();
    limit = data?.target_price || 0;
  } catch (e) {
    console.error('[SpendingLimit] load failed:', e.message);
  }
  spendingLimits.set(jid, limit);
  return limit;
}

async function setSpendingLimit(jid, limit) {
  spendingLimits.set(jid, limit);
  try {
    await supabase.from('rh_alerts').delete().eq('jid', jid).eq('type', 'config').eq('symbol', 'SPENDING_LIMIT');
    if (limit > 0) {
      const { error } = await supabase.from('rh_alerts').insert({
        jid, type: 'config', symbol: 'SPENDING_LIMIT', condition: 'above', target_price: limit, triggered: true,
      });
      if (error) console.error('[SpendingLimit] persist failed:', error.message);
    }
  } catch (e) {
    console.error('[SpendingLimit] persist failed:', e.message);
  }
}

// ── Pending limit order setup confirmations (confirm at order placement, not execution) ──
const pendingLimitOrders = new Map(); // jid → order details (waiting for yes/no before saving to DB)

// ── Server-side risk-guard override tracking ──────────────────
// Only allow force=true on execute_swap if a risk guard actually blocked for this jid recently.
// Prevents Claude from self-granting force bypass via prompt injection.
const riskOverrides = new Map(); // jid → expires (ms timestamp)

// ── Export intent tracking ────────────────────────────────────
// Prevents __TRIGGER_EXPORT__ from firing unless user explicitly asked for it
const exportIntentJids = new Set();

// ── tx.wait() timeout wrapper ─────────────────────────────────
function waitTx(tx, ms = 60_000) {
  return Promise.race([
    tx.wait(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Transaction timed out after 60s')), ms)),
  ]);
}

const PAIR_ABI_PRICE = ['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)'];

async function getStockPrice(symbol) {
  const s = symbol.toUpperCase();
  try {
    const pairAddr = DEP_PAIRS[s];
    if (!pairAddr) throw new Error(`No pair for ${s}`);
    const pair     = new ethers.Contract(pairAddr, PAIR_ABI_PRICE, provider);
    const [r0, r1] = await pair.getReserves();
    const token0   = await pair.token0();
    const isUsdg0  = token0.toLowerCase() === TOKENS.USDG.address.toLowerCase();
    const rUSDG    = parseFloat(ethers.formatUnits(isUsdg0 ? r0 : r1, 6));
    const rSTOCK   = parseFloat(ethers.formatUnits(isUsdg0 ? r1 : r0, 18));
    if (!rSTOCK) throw new Error('zero reserves');
    const price = rUSDG / rSTOCK;

    // Get prev close from Finnhub for change %
    let change = '0.00';
    if (FINNHUB_KEY) {
      try {
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${FINNHUB_KEY}`);
        const q   = await res.json();
        if (q?.pc) change = ((price - q.pc) / q.pc * 100).toFixed(2);
      } catch {}
    }

    return { price, change, symbol: s };
  } catch (e) {
    console.error(`[Price] ${s} error:`, e.message);
    return null;
  }
}

// ── Incoming transfer monitor ─────────────────────────────────
const activeWalletRegistry = new Map(); // jid -> address
const lastSeenBlock = new Map();        // address -> blockNumber

async function monitorIncomingTransfers() {
  if (!activeWalletRegistry.size || !waConnected) return;

  for (const [jid, address] of activeWalletRegistry) {
    try {
      const currentBlock = await provider.getBlockNumber();
      const fromBlock    = lastSeenBlock.get(address) || currentBlock - 5;
      lastSeenBlock.set(address, currentBlock);

      if (fromBlock >= currentBlock) continue;

      // Check ETH transfers via block logs — simpler: check balance change
      // For ERC-20s, scan Transfer events to this address
      for (const [symbol, info] of Object.entries(TOKENS)) {
        if (info.address === 'native') continue;
        try {
          const contract = new ethers.Contract(info.address, [
            'event Transfer(address indexed from, address indexed to, uint256 value)',
          ], provider);
          const events = await contract.queryFilter(
            contract.filters.Transfer(null, address),
            fromBlock,
            currentBlock
          );
          for (const ev of events) {
            const amt = parseFloat(ethers.formatUnits(ev.args.value, TOKENS[symbol].decimals));
            if (amt <= 0) continue;
            const from = ev.args.from.slice(0, 6) + '...' + ev.args.from.slice(-4);
            await sendWAMessage(jid,
              `💰 *Incoming Transfer*\n\n` +
              `+${amt.toFixed(4)} ${symbol}\n` +
              `From: ${from}\n` +
              `Tx: ${ev.transactionHash.slice(0, 10)}...\n` +
              `https://explorer.testnet.chain.robinhood.com/tx/${ev.transactionHash}`
            );
          }
        } catch {}
      }
    } catch {}
  }
}

// ── Conversation history (Supabase-backed) ────────────────────
const historyCache  = new Map(); // jid -> messages[]
const onboardingState    = new Map();
const pendingExportJid   = new Map();

async function getHistory(jid) {
  if (historyCache.has(jid)) return historyCache.get(jid);
  const { data } = await supabase.from('rh_conversation_history').select('messages').eq('jid', jid).single();
  const msgs = data?.messages || [];
  historyCache.set(jid, msgs);
  return msgs;
}

async function addToHistory(jid, role, content) {
  const h = await getHistory(jid);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
  await supabase.from('rh_conversation_history').upsert(
    { jid, messages: h, updated_at: new Date().toISOString() },
    { onConflict: 'jid' }
  );
}

// ── SAGE Tools ────────────────────────────────────────────────
const sageTools = [
  {
    name: 'get_wallet',
    description: 'Get the user\'s Robinhood Chain wallet address',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_portfolio',
    description: 'Get the user\'s full portfolio — ETH balance and all stock token balances (TSLA, AMZN, PLTR, NFLX, AMD)',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_stock_price',
    description: 'Get live price and 24h change for a stock token',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock symbol e.g. TSLA, AMZN, NFLX, AMD, PLTR' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'send_token',
    description: 'Send ETH or a stock token to an address',
    input_schema: {
      type: 'object',
      properties: {
        symbol:  { type: 'string', description: 'Token symbol: ETH, USDG, TSLA, AMZN, PLTR, NFLX, AMD' },
        to:      { type: 'string', description: 'Recipient wallet address' },
        amount:  { type: 'number', description: 'Amount to send' },
      },
      required: ['symbol', 'to', 'amount'],
    },
  },
  {
    name: 'get_tx_explorer_link',
    description: 'Get the Robinhood Chain explorer link for a transaction hash',
    input_schema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'Transaction hash' },
      },
      required: ['hash'],
    },
  },
  {
    name: 'get_swap_quote',
    description: 'Get a quote for swapping one token for another on the SAGE DEX (Uniswap V2 AMM on Robinhood Chain). Use this before executing a swap to show the user what they\'ll receive.',
    input_schema: {
      type: 'object',
      properties: {
        from_symbol: { type: 'string', description: 'Token to sell: USDG, TSLA, AMZN, PLTR, NFLX, AMD' },
        to_symbol:   { type: 'string', description: 'Token to buy: USDG, TSLA, AMZN, PLTR, NFLX, AMD' },
        amount_in:   { type: 'number', description: 'Amount of from_symbol to swap' },
      },
      required: ['from_symbol', 'to_symbol', 'amount_in'],
    },
  },
  {
    name: 'execute_swap',
    description: 'Execute a token swap on the SAGE DEX. ONLY call this after showing the user a quote and receiving explicit confirmation. If the risk guard returns a warning, show it to the user and only set force=true if they explicitly say to proceed anyway.',
    input_schema: {
      type: 'object',
      properties: {
        from_symbol:    { type: 'string', description: 'Token to sell' },
        to_symbol:      { type: 'string', description: 'Token to buy' },
        amount_in:      { type: 'number', description: 'Exact amount to sell' },
        min_amount_out: { type: 'number', description: 'Minimum amount to receive (from quote, apply 1% slippage)' },
        force:          { type: 'boolean', description: 'Set true only if user explicitly confirmed after seeing a risk guard warning.' },
      },
      required: ['from_symbol', 'to_symbol', 'amount_in', 'min_amount_out'],
    },
  },
  {
    name: 'set_price_alert',
    description: 'Set a price alert for a stock. SAGE will notify the user on WhatsApp when the price crosses the target.',
    input_schema: {
      type: 'object',
      properties: {
        symbol:       { type: 'string', description: 'Stock symbol: TSLA, AMZN, PLTR, NFLX, AMD' },
        condition:    { type: 'string', enum: ['above', 'below', 'at'], description: 'Trigger when price goes above, below, or reaches (at) target' },
        target_price: { type: 'number', description: 'Price threshold in USDG' },
      },
      required: ['symbol', 'condition', 'target_price'],
    },
  },
  {
    name: 'set_limit_order',
    description: 'Place a limit order — automatically buy or sell when price hits target. User must have enough USDG (buy) or stock (sell) in their SAGE wallet.',
    input_schema: {
      type: 'object',
      properties: {
        symbol:       { type: 'string', description: 'Stock symbol: TSLA, AMZN, PLTR, NFLX, AMD' },
        action:       { type: 'string', enum: ['buy', 'sell'], description: 'Buy or sell' },
        condition:    { type: 'string', enum: ['above', 'below', 'at'], description: 'Execute when price rises above, drops below, or reaches (at) target' },
        target_price: { type: 'number', description: 'Trigger price in USDG' },
        amount:       { type: 'number', description: 'Amount of USDG to spend (buy) or stock amount to sell' },
      },
      required: ['symbol', 'action', 'condition', 'target_price', 'amount'],
    },
  },
  {
    name: 'get_trade_history',
    description: 'Get the user\'s recent trade history on the SAGE DEX.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of recent trades to fetch (default 10, max 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_orders',
    description: 'Fetch all active (untriggered) limit orders and price alerts for the user.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cancel_order',
    description: 'Cancel an active limit order or price alert by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The order/alert ID to cancel' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_faucet',
    description: 'Get faucet link for testnet ETH on Robinhood Chain, plus the user\'s wallet address for easy copy-paste.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_spending_limit',
    description: 'Set a maximum USDG-equivalent trade size per swap. SAGE will block any swap that exceeds this value and ask the user to confirm before proceeding. Set limit_usdg to 0 to disable.',
    input_schema: {
      type: 'object',
      properties: {
        limit_usdg: { type: 'number', description: 'Max USDG value per trade. 0 = disabled.' },
      },
      required: ['limit_usdg'],
    },
  },
  {
    name: 'claim_ownership',
    description: 'Transfer on-chain ownership of the user\'s smart account to their OWN wallet address (e.g. their MetaMask), making it fully self-custodial. After this, SAGE can still trade on their behalf but can NEVER withdraw their funds — only the new owner can. This is IRREVERSIBLE by SAGE: once transferred, SAGE cannot reclaim ownership. ONLY call this after the user has provided their own external wallet address AND explicitly confirmed they understand SAGE will no longer be able to move funds out.',
    input_schema: {
      type: 'object',
      properties: {
        new_owner: { type: 'string', description: 'The user\'s own external wallet address (e.g. MetaMask) to become the account owner.' },
      },
      required: ['new_owner'],
    },
  },
  {
    name: 'get_secure_link',
    description: 'Generate a one-time secure web link where the user sets a password and takes full self-custody of their wallet — a key is generated in their own browser, never seen by SAGE and never typed in chat. Use this whenever the user wants to: set a password, secure their wallet, take full control/ownership, go self-custodial, export their key, or withdraw to their own control. No wallet/MetaMask required.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tool executor ─────────────────────────────────────────────
async function executeTool(name, input, jid) {
  try {
    if (name === 'get_wallet') {
      const row = await getOrCreateWallet(jid);
      let accountAddr = await getAccountAddress(jid);
      if (!accountAddr) accountAddr = await ensureAccount(jid, row.address); // provision on demand
      if (accountAddr) {
        // Self-custodied = owner is no longer the SAGE-held EOA
        let selfCustodied = false, owner = null;
        try {
          owner = await new ethers.Contract(accountAddr, SAGE_ACCOUNT_ABI, provider).owner();
          selfCustodied = owner.toLowerCase() !== row.address.toLowerCase();
        } catch {}
        return {
          address: accountAddr,        // the user's single wallet address
          smartAccount: accountAddr,   // on-chain Risk Guard; SAGE covers gas
          selfCustodied,               // true once the user has claimed ownership
          owner,
          chain: 'Robinhood Chain Testnet', chainId: CHAIN_ID,
          note: selfCustodied
            ? 'This wallet is self-custodied — only the user\'s own key can withdraw. SAGE can still trade for them.'
            : 'This is the user\'s wallet — deposit USDG and stocks here. SAGE covers all gas automatically. The user can say "claim my wallet" to make it fully self-custodial.',
        };
      }
      return { address: row.address, chain: 'Robinhood Chain Testnet', chainId: CHAIN_ID };
    }

    if (name === 'get_portfolio') {
      const combined = await getCombinedPortfolio(jid); // smart account + gas EOA
      const row      = { address: combined.address };
      const holdings = combined.holdings;
      if (!holdings.length) return { holdings: [], message: 'Wallet is empty. Get testnet ETH from https://faucet.testnet.chain.robinhood.com/' };

      // Enrich with PNL for stock holdings
      const { data: trades } = await supabase.from('rh_trades').select('*').eq('jid', jid);
      const enriched = await Promise.all(holdings.map(async h => {
        if (!STOCK_SYMBOLS[h.symbol]) return h;
        const currentPrice = (await getStockPrice(h.symbol))?.price || 0;

        // Calculate average cost basis from trades
        let totalCost = 0, totalBought = 0, totalSold = 0;
        (trades || []).filter(t => t.symbol === h.symbol).forEach(t => {
          if (t.side === 'buy')  { totalCost += t.amount_in; totalBought += t.amount_out; }
          if (t.side === 'sell') { totalSold += t.amount_in; }
        });
        const netHeld = totalBought - totalSold;
        const avgCost = netHeld > 0 ? totalCost / netHeld : 0;
        const pnlPct  = avgCost > 0 ? ((currentPrice - avgCost) / avgCost * 100).toFixed(2) : null;
        const pnlUsdg = avgCost > 0 ? ((currentPrice - avgCost) * h.amount).toFixed(2) : null;

        return { ...h, currentPrice, avgCost: avgCost.toFixed(2), pnlPct, pnlUsdg };
      }));

      return { address: row.address, holdings: enriched };
    }

    if (name === 'get_stock_price') {
      const data = await getStockPrice(input.symbol);
      if (!data) return { error: `Could not fetch price for ${input.symbol}` };
      return data;
    }

    if (name === 'send_token') {
      const { symbol, to, amount } = input;
      if (!ethers.isAddress(to)) return { error: 'Invalid destination address' };
      const hash = await sendToken(jid, symbol, to, amount);
      return {
        success: true,
        hash,
        explorer: `https://explorer.testnet.chain.robinhood.com/tx/${hash}`,
        amount,
        symbol,
        to,
      };
    }

    if (name === 'get_tx_explorer_link') {
      return { url: `https://explorer.testnet.chain.robinhood.com/tx/${input.hash}` };
    }

    if (name === 'get_swap_quote') {
      const quote = await getSwapQuote(input.from_symbol, input.to_symbol, input.amount_in);
      return quote;
    }

    if (name === 'execute_swap') {
      const fromSym = input.from_symbol.toUpperCase();
      const toSym   = input.to_symbol.toUpperCase();
      const amtIn   = parseFloat(input.amount_in);

      // force=true is only honored if a risk guard blocked for this user recently (server-side).
      // This prevents Claude from self-granting force bypass via prompt injection.
      const requestedForce = !!input.force;
      const override = riskOverrides.get(jid);
      const force = requestedForce && !!override && Date.now() < override;
      if (force) riskOverrides.delete(jid);

      if (!force) {
        // ── 1. Spending limit ───────────────────────────────────────
        const limit = await getSpendingLimit(jid);
        if (limit && limit > 0) {
          let tradeValueUsdg = amtIn;
          if (fromSym !== 'USDG') {
            const p = await getStockPrice(fromSym);
            if (!p) return { blocked: true, reason: 'spending_limit', message: '🛡️ *SAGE Risk Guard*: could not verify trade value — price fetch failed. Please try again.' };
            tradeValueUsdg = p.price * amtIn;
          }
          if (tradeValueUsdg > limit) {
            riskOverrides.set(jid, Date.now() + 5 * 60_000);
            return {
              blocked: true,
              reason: 'spending_limit',
              message: `🛡️ *SAGE Risk Guard*: trade blocked — ~$${tradeValueUsdg.toFixed(2)} exceeds your spending limit of $${limit} USDG per trade. Say "update my spending limit" to change it, or "proceed anyway" to override.`,
            };
          }
        }

        // ── 2. Price impact (reserves-based) ───────────────────────
        const isSimplePair = fromSym === 'USDG' || toSym === 'USDG';
        if (DEX && isSimplePair) {
          try {
            const stockSym = fromSym === 'USDG' ? toSym : fromSym;
            const pair     = new ethers.Contract(DEP_PAIRS[stockSym], PAIR_ABI_PRICE, provider);
            const [r0, r1] = await pair.getReserves();
            const token0   = await pair.token0();
            const isUsdg0  = token0.toLowerCase() === TOKENS.USDG.address.toLowerCase();
            const rUSDG    = parseFloat(ethers.formatUnits(isUsdg0 ? r0 : r1, 6));
            const rSTOCK   = parseFloat(ethers.formatUnits(isUsdg0 ? r1 : r0, 18));
            const spot     = rUSDG / rSTOCK;

            let impact = 0;
            if (fromSym === 'USDG') {
              const out      = (amtIn * 997 * rSTOCK) / (rUSDG * 1000 + amtIn * 997);
              const effective = amtIn / out;
              impact = Math.abs((effective - spot) / spot * 100);
            } else {
              const out      = (amtIn * 997 * rUSDG) / (rSTOCK * 1000 + amtIn * 997);
              const effective = out / amtIn;
              impact = Math.abs((spot - effective) / spot * 100);
            }

            if (impact > 8) {
              riskOverrides.set(jid, Date.now() + 5 * 60_000);
              return {
                blocked: true,
                reason: 'price_impact',
                impact: impact.toFixed(1),
                message: `🛡️ *SAGE Risk Guard*: price impact is ${impact.toFixed(1)}% — above the 8% safety threshold. The pool is thin for this trade size. Try a smaller amount, or say "proceed anyway" to override.`,
              };
            }
          } catch (e) {
            console.error('[RiskGuard] impact check failed:', e.message);
          }
        }

        // ── 3. Portfolio concentration ──────────────────────────────
        try {
          const holdings = (await getCombinedPortfolio(jid)).holdings;
          let portfolioUsdg = 0;
          for (const h of holdings) {
            if (h.symbol === 'USDG') { portfolioUsdg += h.amount; continue; }
            const p = await getStockPrice(h.symbol);
            if (p) portfolioUsdg += h.amount * p.price;
          }
          let tradeUsdg = amtIn;
          if (fromSym !== 'USDG') {
            const p = await getStockPrice(fromSym);
            tradeUsdg = p ? p.price * amtIn : amtIn;
          }
          const pct = portfolioUsdg > 0 ? (tradeUsdg / portfolioUsdg * 100) : 0;
          if (pct > 25) {
            riskOverrides.set(jid, Date.now() + 5 * 60_000);
            return {
              blocked: true,
              reason: 'concentration',
              pct: pct.toFixed(0),
              message: `🛡️ *SAGE Risk Guard*: this trade is ${pct.toFixed(0)}% of your portfolio (~$${tradeUsdg.toFixed(2)} of $${portfolioUsdg.toFixed(2)} total). Say "proceed anyway" to execute, or reduce the amount.`,
            };
          }
        } catch (e) {
          console.error('[RiskGuard] concentration check failed:', e.message);
        }
      }

      // Server-side slippage floor — don't trust the AI-supplied min_amount_out alone.
      // A fresh quote sets the floor at 3% below expected output; the AI value can only tighten it.
      let minOut;
      try {
        const q = await getSwapQuote(fromSym, toSym, amtIn);
        minOut = Math.max(parseFloat(input.min_amount_out) || 0, q.amountOut * 0.97);
      } catch (e) {
        return { error: `Could not verify swap price: ${e.message}` };
      }

      const result = await executeSwap(jid, fromSym, toSym, amtIn, minOut);
      return result;
    }

    if (name === 'set_price_alert') {
      const { symbol, condition, target_price } = input;
      const { error } = await supabase.from('rh_alerts').insert({
        jid, type: 'alert', symbol: symbol.toUpperCase(), condition, target_price,
      });
      if (error) return { error: error.message };
      return { success: true, message: `Alert set: notify when ${symbol.toUpperCase()} goes ${condition} $${target_price}` };
    }

    if (name === 'set_limit_order') {
      const { symbol, action, target_price, amount } = input;
      const sym = symbol.toUpperCase();

      const priceData = await getStockPrice(sym);
      const currentPrice = priceData ? priceData.price : null;

      // Resolve 'at' into above/below based on current price
      let condition = input.condition;
      if (condition === 'at') {
        condition = currentPrice !== null && currentPrice < target_price ? 'above' : 'below';
      }

      // Warn if condition already satisfied — would fire immediately
      if (currentPrice !== null) {
        const alreadyMet =
          (condition === 'above' && currentPrice >= target_price) ||
          (condition === 'below' && currentPrice <= target_price);
        if (alreadyMet) {
          return {
            success: false,
            message: `⚠️ ${sym} is already $${currentPrice.toFixed(2)} — that's already ${condition} your target of $${target_price}. The order would fire immediately. Did you mean a different price?`,
          };
        }
      }

      const dir = condition === 'above' ? 'rises above' : 'drops below';
      const fromSym = action === 'buy' ? 'USDG' : sym;
      const toSym   = action === 'buy' ? sym : 'USDG';

      // Verify funds exist now — the order auto-executes later with no further checks.
      // Count both the smart account and the gas EOA (migration window).
      try {
        const row = await getOrCreateWallet(jid);
        const checkSym = fromSym;
        const accountAddr = await getAccountAddress(jid);
        let raw = await tokenBalanceOf(TOKENS[checkSym].address, row.address);
        if (accountAddr) raw += await tokenBalanceOf(TOKENS[checkSym].address, accountAddr);
        const bal = parseFloat(ethers.formatUnits(raw, TOKENS[checkSym].decimals));
        if (bal < amount) {
          return {
            success: false,
            message: `⚠️ You have ${bal.toFixed(4)} ${checkSym} but this order needs ${amount}. Top up first or reduce the amount.`,
          };
        }
      } catch (e) {
        console.error('[LimitOrder] balance check failed:', e.message);
      }

      // Store pending — don't save to DB until user confirms
      pendingLimitOrders.set(jid, { sym, action, condition, target_price, amount, fromSym, toSym });

      return {
        success: true,
        needs_confirmation: true,
        message: `Limit order ready — I'll auto-${action} ${amount} ${fromSym} → ${toSym} when ${sym} ${dir} $${target_price}${currentPrice ? ` (now $${currentPrice.toFixed(2)})` : ''}. Confirm?`,
      };
    }

    if (name === 'get_orders') {
      const { data, error } = await supabase
        .from('rh_alerts')
        .select('*')
        .eq('jid', jid)
        .eq('triggered', false)
        .neq('type', 'config')
        .order('created_at', { ascending: false });
      if (error) return { error: error.message };
      if (!data || data.length === 0) return { orders: [], message: 'No active orders or alerts.' };
      return {
        orders: data.map(o => ({
          id: o.id,
          type: o.type,
          symbol: o.symbol,
          condition: o.condition,
          target_price: o.target_price,
          ...(o.type === 'limit' ? { action: o.action, amount: o.amount } : {}),
          created_at: o.created_at,
        })),
      };
    }

    if (name === 'cancel_order') {
      const { data, error: fetchErr } = await supabase
        .from('rh_alerts')
        .select('id, jid, type')
        .eq('id', input.id)
        .single();
      if (fetchErr || !data || data.type === 'config') return { error: 'Order not found.' };
      if (data.jid !== jid) return { error: 'That order does not belong to you.' };
      const { error } = await supabase.from('rh_alerts').delete().eq('id', input.id);
      if (error) return { error: error.message };
      return { success: true, message: `Order #${input.id} cancelled.` };
    }

    if (name === 'get_trade_history') {
      const limit = Math.min(input.limit || 10, 50);
      const { data, error } = await supabase
        .from('rh_trades')
        .select('*')
        .eq('jid', jid)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return { error: error.message };
      if (!data || data.length === 0) return { trades: [], message: 'No trades yet.' };
      return { trades: data.map(t => ({
        date:      new Date(t.created_at).toLocaleDateString(),
        side:      t.side,
        symbol:    t.symbol,
        amountIn:  t.amount_in,
        amountOut: t.amount_out,
        price:     t.price_usdg,
        tx:        t.tx_hash ? `https://explorer.testnet.chain.robinhood.com/tx/${t.tx_hash}` : null,
      })) };
    }

    if (name === 'set_spending_limit') {
      const limit = parseFloat(input.limit_usdg);
      if (!limit || limit <= 0) {
        await setSpendingLimit(jid, 0);
        return { success: true, message: 'Spending limit removed. All trade sizes allowed.' };
      }
      await setSpendingLimit(jid, limit);
      return { success: true, message: `Spending limit set to $${limit} USDG per trade. SAGE will warn you before any larger swap.` };
    }

    if (name === 'get_faucet') {
      const row = await getOrCreateWallet(jid);
      const accountAddr = await getAccountAddress(jid);
      if (accountAddr) {
        return {
          address: accountAddr,
          message: `Good news — SAGE covers all gas fees, so you don't need any testnet ETH. To trade, just deposit USDG to your wallet: ${accountAddr}`,
        };
      }
      return {
        faucetUrl: 'https://faucet.testnet.chain.robinhood.com/',
        address: row.address,
        message: `Paste this address at the faucet to get testnet ETH for transaction fees.`,
      };
    }

    if (name === 'claim_ownership') {
      const newOwner = input.new_owner;
      if (!ethers.isAddress(newOwner)) return { error: 'That doesn\'t look like a valid wallet address. Send your own wallet address (starts with 0x).' };

      const row = await getOrCreateWallet(jid);
      const accountAddr = await getAccountAddress(jid);
      if (!accountAddr) return { error: 'You don\'t have a smart account yet — say "what\'s my wallet" to set one up first.' };

      const signer  = await getSignerForJid(jid);
      await sponsorGas(signer.address);
      const account = new ethers.Contract(accountAddr, SAGE_ACCOUNT_ABI, signer);

      // Must currently be SAGE-owned to transfer
      const currentOwner = await account.owner();
      if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
        return { error: 'already_claimed', message: `This wallet is already self-custodied (owner: ${currentOwner}). SAGE cannot change its ownership.` };
      }
      if (newOwner.toLowerCase() === signer.address.toLowerCase()) {
        return { error: 'That\'s SAGE\'s own key — send YOUR wallet address so you get full control.' };
      }

      const tx = await account.transferOwnership(newOwner);
      await waitTx(tx);
      return {
        success: true,
        account: accountAddr,
        new_owner: newOwner,
        hash: tx.hash,
        explorer: `https://explorer.testnet.chain.robinhood.com/tx/${tx.hash}`,
        message: `✅ Done. Your wallet is now self-custodied. SAGE can still trade for you, but only ${newOwner.slice(0,6)}…${newOwner.slice(-4)} can withdraw your funds — not even SAGE can. To withdraw, use your own wallet (e.g. MetaMask) on Robinhood Chain.`,
      };
    }

    if (name === 'get_secure_link') {
      const row = await getOrCreateWallet(jid);
      let accountAddr = await getAccountAddress(jid);
      if (!accountAddr) accountAddr = await ensureAccount(jid, row.address);
      if (!accountAddr) return { error: 'Your smart account isn\'t ready yet — try again in a moment.' };
      const token = makeSecureToken(jid);
      const url = `${FRONTEND_BASE}/secure.html?t=${token}`;
      return {
        url,
        message: `🔐 Open this private link to set a password and take full control of your wallet:\n${url}\n\nYour password and key are created in your browser — I never see them. The link works once and expires in 1 hour.`,
      };
    }

    return { error: 'Unknown tool' };
  } catch (e) {
    console.error(`Tool error [${name}]:`, e.message);
    return { error: e.message };
  }
}

// ── SAGE system prompt ────────────────────────────────────────
const SYSTEM_PROMPT = `You are SAGE — a sharp, direct DeFi agent running inside WhatsApp. You help users manage tokenized stock assets on Robinhood Chain, an Arbitrum L2.

Available assets on Robinhood Chain Testnet:
- ETH (native gas token)
- USDG (stablecoin)
- TSLA (tokenized Tesla stock)
- AMZN (tokenized Amazon stock)
- PLTR (tokenized Palantir stock)
- NFLX (tokenized Netflix stock)
- AMD (tokenized AMD stock)

Your capabilities:
- Show wallet address and portfolio balances
- Fetch live stock prices and 24h changes
- Send ETH and stock tokens to any address
- **Trade tokenized stocks** — buy/sell TSLA, AMZN, PLTR, NFLX, AMD against USDG on the SAGE DEX
- **Price alerts** — notify user when a stock crosses a price threshold
- **Limit orders** — auto-execute a buy or sell when price hits target
- **Trade history** — show recent swaps with dates and tx links
- **Faucet** — give user the testnet ETH faucet link + their address
- Explain what Robinhood Chain is and how tokenized stocks work

Personality:
- Direct and concise — no fluff, no filler
- Give opinions when asked about stocks
- Never make stuff up — if you don't know, say so

Formatting rules (WhatsApp):
- Use *bold* only on the single most important value per message
- No markdown headers (#, ##) — use plain text structure
- Keep responses short — 3-5 lines max unless analysis is requested

NEVER GO SILENT:
- Always respond, even if a tool fails
- If a tool errors, tell the user what went wrong
- Never return an empty response
- If the user cancels, declines, or says anything like "no", "don't", "stop", "cancel", "never mind", "don't proceed", "don't swap" — always acknowledge it. Reply with something like "Got it, cancelled." or "Okay, no swap. Let me know if you change your mind." Never stay silent after a cancellation.
- If the user says something you don't understand, ask them to clarify — never ignore the message

SMART ACCOUNT (important):
- Every user has an on-chain smart account that holds their USDG and stocks and enforces SAGE's Risk Guard on-chain.
- Users have ONE wallet address (the smart account). get_wallet returns it as 'address'. Tell them to deposit USDG and stocks there.
- SAGE covers ALL gas fees automatically — users never need testnet ETH. If a user asks about gas or faucet, tell them SAGE handles gas and they just need USDG to trade.
- Custody: by default SAGE holds the account's owner key (so it can help them fully), but trading is capped on-chain. A user can become FULLY self-custodial by claiming ownership (see below). Be accurate: pre-claim, SAGE can move funds; post-claim, only the user can. Don't overstate safety.

SELF-CUSTODY / CLAIM OWNERSHIP:
- If the user says "claim my wallet", "make it self-custodial", "I want full control", "transfer ownership to me", "secure my wallet to my own key", or similar: use claim_ownership.
- First ask for THEIR OWN external wallet address (e.g. their MetaMask address on Robinhood Chain).
- Then clearly explain, and get explicit confirmation: "After this, you'll have full control — SAGE can still trade for you, but only YOU can withdraw. This can't be undone by SAGE. Send your wallet address and confirm."
- Only call claim_ownership after they provide their address AND confirm.
- After claiming: if they ask SAGE to send/withdraw their funds out, explain they must do it themselves with their own wallet now — SAGE can no longer move funds out (this is the whole point of claiming).
- Never invent an address — the user must provide their own.

BALANCE / PORTFOLIO:
- ALWAYS call get_portfolio when the user asks about their balance, holdings, or portfolio — no exceptions
- NEVER answer from memory or conversation history — balances change on-chain between messages
- After getting the result, report it plainly. Do not editorialize about missing balances or "disappeared" tokens — just state what's there
- Then call get_stock_price for each stock holding and give a direct recommendation (hold / sell / consolidate)

SENDING TOKENS:
- Always confirm before sending: "Send X TOKEN to 0xabc...xyz. Confirm?"
- Only call send_token after user says yes/confirm/yep
- Show the tx hash and explorer link after sending

TRADING STOCKS:
- When user says "buy $X of TSLA" or "sell TSLA": call get_swap_quote first
- Present the quote clearly: "You'll swap 10 USDG → ~0.04 TSLA. Confirm?"
- Only call execute_swap after explicit confirmation
- After swap: show tx hash + explorer link + what they received
- Swaps go through the SAGE DEX — a Uniswap V2 AMM deployed on Robinhood Chain
- Supported pairs: USDG/TSLA, USDG/AMZN, USDG/PLTR, USDG/NFLX, USDG/AMD

PRICE ALERTS:
- When user says "alert me when TSLA hits $X" or similar: call set_price_alert
- Confirm: "Alert set — I'll message you when TSLA goes above/below $X."
- Alerts trigger automatically in the background

LIMIT ORDERS:
- When user says "buy X if it drops below $Y": condition=below
- When user says "buy X if it rises above $Y": condition=above
- When user says "buy X when it gets to $Y" or "when the price is at $Y" or "when it reaches $Y": condition=at (system auto-detects direction)
- Same logic applies to sell orders
- Confirm the order details and note it will auto-execute

ORDERS & ALERTS:
- When user asks "what are my orders?", "show my alerts", "bring up existing orders", "list my limit orders" etc: call get_orders
- Format each order: "#ID · LIMIT · BUY 10 USDG → NFLX when price drops below $400"
- When user asks to cancel an order: call cancel_order with the ID. Confirm cancellation.
- NEVER make up or recall orders from memory — always call get_orders

TRADE HISTORY:
- When user asks for trade history or "what have I traded?": call get_trade_history
- Format each trade as: "BUY 0.04 TSLA @ $394 on 6/9"
- Show tx link for each trade

FAUCET:
- When user asks for testnet ETH, gas, or faucet: call get_faucet
- Display their address and the faucet URL clearly

FULL CONTROL / PASSWORD / PRIVATE KEY / WITHDRAW TO SELF:
- SAGE never handles passwords or private keys in chat — they'd sit in chat history.
- Whenever the user wants to: set a password, secure their wallet, take full control/ownership, go self-custodial, export their key, or withdraw to their own control — call get_secure_link and send them the one-time link.
- The page auto-detects: first time it lets them SET a password (a key is generated in their browser, SAGE never sees it); after that it lets them ENTER that same password to export their key or withdraw. No MetaMask needed. Tell them: the link works once, expires in 1 hour, and the password can't be reset — forgetting it means losing access (same as any self-custodial wallet).
- (Power users who already have a wallet can instead just provide their own address and you can use claim_ownership directly.)

UNSUPPORTED REQUESTS:
- Never make up features, apps, or systems that don't exist
- If you can't do something, say so directly in one line`;

// ── Claude message handler ────────────────────────────────────
async function handleMessage(jid, text) {
  const state = onboardingState.get(jid);

  // ── Onboarding: first ever message — auto-create wallet + smart account, no password ──
  if (!state) {
    const { data } = await supabase.from('rh_wallets').select('address').eq('jid', jid).single();
    if (data) {
      onboardingState.set(jid, 'done'); // returning user — skip onboarding
    } else {
      // One message, zero decisions, no chat-typed secrets: create the wallet,
      // provision the on-chain smart account (SAGE pays the gas), hand back the address.
      const wallet = ethers.Wallet.createRandom();
      const encrypted_pk = encrypt(wallet.privateKey);
      await supabase.from('rh_wallets').upsert({ jid, address: wallet.address, encrypted_pk });
      activeWalletRegistry.set(jid, wallet.address);
      onboardingState.set(jid, 'done');
      const account = await ensureAccount(jid, wallet.address);
      const addr = account || wallet.address;
      const setupLink = `${FRONTEND_BASE}/secure.html?t=${makeSecureToken(jid)}`;
      return `👋 Welcome to *SAGE* — trade tokenized stocks (TSLA, AMZN, PLTR, NFLX, AMD) right from WhatsApp.\n\nNo app, no gas, no crypto experience needed. I've set up your on-chain wallet and I cover all the gas. ⚡\n\n📥 *Your wallet — deposit USDG here to start:*\n\`${addr}\`\n\n🔐 *Secure it:* set a password to take full self-custody — do it now or anytime (you'll use this password later to export your key or withdraw):\n${setupLink}\n\nThen say *"buy $10 of TSLA"* or *"show my portfolio"* to begin 🚀`;
    }
  }

  // ── Normal AI flow (onboarding done) ─────────────────────────
  const { data: walletRow } = await supabase.from('rh_wallets').select('address').eq('jid', jid).single();
  const dynamicSystem = SYSTEM_PROMPT + (walletRow ? `\n\nThis user's wallet address is: ${walletRow.address}` : '');

  await addToHistory(jid, 'user', text);
  const history = await getHistory(jid);

  let response = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system:     dynamicSystem,
    tools:      sageTools,
    messages:   history,
  });

  while (response.stop_reason === 'tool_use') {
    const toolUses    = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];

    for (const tu of toolUses) {
      const result = await executeTool(tu.name, tu.input, jid);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }

    await addToHistory(jid, 'assistant', response.content);
    await addToHistory(jid, 'user', toolResults);

    response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     dynamicSystem,
      tools:      sageTools,
      messages:   await getHistory(jid),
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  const reply     = textBlock?.text || 'Something went wrong — try again.';
  await addToHistory(jid, 'assistant', reply);
  return reply;
}

// ── Supabase-backed Baileys auth state ────────────────────────
async function useSupabaseAuthState() {
  async function read(keyId) {
    const { data, error } = await supabase.from('wa_sessions').select('data').eq('key_id', keyId).single();
    if (error && error.code !== 'PGRST116') console.error('[WA-AUTH] read error:', error.message);
    if (!data) return null;
    // Try fast session format, then v2/CBC formats, then plain JSON (legacy)
    try {
      return JSON.parse(decryptSession(data.data), BufferJSON.reviver);
    } catch {
      try {
        return JSON.parse(decrypt(data.data), BufferJSON.reviver);
      } catch {
        try { return JSON.parse(data.data, BufferJSON.reviver); } catch { return null; }
      }
    }
  }

  async function write(keyId, value) {
    const encrypted = encryptSession(JSON.stringify(value, BufferJSON.replacer));
    const { error } = await supabase.from('wa_sessions').upsert(
      { key_id: keyId, data: encrypted, updated_at: new Date().toISOString() },
      { onConflict: 'key_id' }
    );
    if (error) console.error('[WA-AUTH] write error:', error.message);
  }

  async function remove(keyId) {
    const { error } = await supabase.from('wa_sessions').delete().eq('key_id', keyId);
    if (error) console.error('[WA-AUTH] remove error:', error.message);
  }

  const creds = (await read('creds')) || initAuthCreds();
  console.log('[WA-AUTH] Loaded creds from Supabase:', creds ? 'existing session' : 'fresh start');

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          await Promise.all(ids.map(async id => {
            const val = await read(`${type}-${id}`);
            if (val) result[id] = val;
          }));
          return result;
        },
        set: async (data) => {
          await Promise.all(
            Object.entries(data).flatMap(([category, items]) =>
              Object.entries(items).map(([id, value]) =>
                value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`)
              )
            )
          );
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}

// ── WhatsApp connection ────────────────────────────────────────
let waSocket    = null;
let waConnected = false;
let currentQr    = null;
const pendingImages = new Map();

async function sendWAMessage(jid, text) {
  if (!waSocket || !waConnected) return;
  await waSocket.sendMessage(jid, { text });
}

async function connectWhatsApp() {
  const { state, saveCreds } = await useSupabaseAuthState();
  const { version }          = await fetchLatestBaileysVersion();

  waSocket = makeWASocket({
    version,
    auth:   state,
    logger: Pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['SAGE-RH', 'Chrome', '120.0.0'],
    defaultQueryTimeoutMs: 30000,
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQr = qr;
      console.log('📱 QR code ready — visit /qr to scan');
    }
    if (connection === 'open') {
      waConnected = true;
      currentQr = null;
      console.log('✅ SAGE connected to WhatsApp');
      setInterval(monitorIncomingTransfers, 30000);
    }
    if (connection === 'close') {
      waConnected = false;
      const code  = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('❌ Disconnected, code:', code, '| reconnect:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectWhatsApp, 5000);
    }
  });

  waSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;

      const jid  = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;

      try {
        // ── Limit order placement confirmation intercept ──────
        if (pendingLimitOrders.has(jid)) {
          const pending = pendingLimitOrders.get(jid);
          const t = text.trim().toLowerCase();
          const isYes = /^(yes|y|confirm|yep|yh|yeah|sure|ok|okay|do it|go|proceed)$/i.test(t);
          const isNo  = /^(no|n|nope|cancel|stop|nah|don't|dont|never mind|nevermind|skip)$/i.test(t);

          if (isYes || isNo) {
            pendingLimitOrders.delete(jid);
            await waSocket.sendPresenceUpdate('composing', jid);
            if (isNo) {
              await sendWAMessage(jid, `Got it — limit order cancelled.`);
            } else {
              // Save to DB — will auto-execute when price hits, no further confirmation needed
              const { error } = await supabase.from('rh_alerts').insert({
                jid,
                type: 'limit',
                symbol: pending.sym,
                condition: pending.condition,
                target_price: pending.target_price,
                action: pending.action,
                amount: pending.amount,
              });
              if (error) {
                await sendWAMessage(jid, `⚠️ Failed to save limit order: ${error.message}`);
              } else {
                const dir = pending.condition === 'above' ? 'rises above' : 'drops below';
                await sendWAMessage(jid,
                  `✅ Limit order set — I'll automatically ${pending.action} ${pending.amount} ${pending.fromSym} → ${pending.toSym} when ${pending.sym} ${dir} $${pending.target_price}. I'll notify you when it executes.`
                );
              }
            }
            await waSocket.sendPresenceUpdate('paused', jid);
            continue;
          }
          // User said something else — clear pending and fall through to Claude
          pendingLimitOrders.delete(jid);
        }

        const currentState = onboardingState.get(jid);
        const isPkMessage     = currentState === 'awaiting_pk';
        const isPasswordMsg   = currentState === 'awaiting_export_password';

        await waSocket.sendPresenceUpdate('composing', jid);
        const reply = await handleMessage(jid, text.trim());
        await waSocket.sendPresenceUpdate('paused', jid);

        // Delete user's private key from bot's side only (can't delete user's own messages)
        if (isPkMessage) {
          await waSocket.chatModify({ clear: { messages: [{ id: msg.key.id, fromMe: false }] } }, jid);
        }

        // Delete user's export-password from bot's side only
        if (isPasswordMsg) {
          await waSocket.chatModify({ clear: { messages: [{ id: msg.key.id, fromMe: false }] } }, jid);
        }

        // Handle private key export — send PK then delete after 2 minutes
        if (reply.startsWith('__EXPORT_PK__')) {
          const pk = reply.replace('__EXPORT_PK__', '');
          const sent = await waSocket.sendMessage(jid, { text: `🔑 *Your Private Key*\n\n\`${pk}\`\n\n⚠️ Copy it now. This message will self-destruct in 2 minutes.` });
          setTimeout(async () => {
            try { await waSocket.sendMessage(jid, { delete: sent.key }); } catch {}
          }, 2 * 60 * 1000);
          continue;
        }

        // Check if there's a pending image to send first
        if (pendingImages.has(jid)) {
          const { buffer, caption } = pendingImages.get(jid);
          pendingImages.delete(jid);
          await waSocket.sendMessage(jid, { image: buffer, caption });
        }

        // Claude triggered export flow — only honor if user genuinely requested it server-side
        if (reply.trim() === '__TRIGGER_EXPORT__' && exportIntentJids.has(jid)) {
          exportIntentJids.delete(jid);
          onboardingState.set(jid, 'awaiting_export_password');
          await waSocket.sendMessage(jid, { text: `🔒 Enter your *password* to export your private key:` });
          continue;
        }

        await waSocket.sendMessage(jid, { text: reply });
      } catch (e) {
        console.error('Message handler error:', e.message);
        await waSocket.sendMessage(jid, { text: 'Something went wrong. Try again.' });
      }
    }
  });
}

// ── Static UI ─────────────────────────────────────────────────
import { createRequire } from 'module';
const require2 = createRequire(import.meta.url);
app.use(express.static(path.join(__dirname, 'ui')));

// ── HTTP endpoints ────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true, connected: waConnected }));

app.get('/qr', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).send('<html><body style="background:#000;color:#ff4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>401 Unauthorized</h2></body></html>');
  if (waConnected) return res.send('<html><body style="background:#000;color:#C8F135;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✅ SAGE is already connected to WhatsApp</h2></body></html>');
  if (!currentQr)  return res.send('<html><body style="background:#000;color:#C8F135;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h2>⏳ Waiting for QR code...</h2><p>Refresh in a few seconds</p><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  const dataUrl = await qrcode.toDataURL(currentQr, { width: 300, margin: 2 });
  res.send(`<html><body style="background:#000;color:#C8F135;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0"><h2>Scan with WhatsApp</h2><img src="${dataUrl}" style="border-radius:12px"/><p style="opacity:0.6;font-size:13px">Auto-refreshes every 30s</p><script>setTimeout(()=>location.reload(),30000)</script></body></html>`);
});

app.get('/wallet/:jid', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    const row = await getOrCreateWallet(req.params.jid);
    res.json({ ok: true, address: row.address });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/portfolio/:address', async (req, res) => {
  try {
    if (!ethers.isAddress(req.params.address)) return res.status(400).json({ ok: false, error: 'invalid address' });
    const holdings = await getPortfolio(req.params.address);
    res.json({ ok: true, holdings });
  } catch (e) {
    console.error('[API] /portfolio error:', e.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

app.get('/price/:symbol', async (req, res) => {
  try {
    const data = await getStockPrice(req.params.symbol);
    res.json({ ok: !!data, ...data });
  } catch (e) {
    console.error('[API] /price error:', e.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

app.get('/admin/status', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const keeper = new ethers.Wallet(KEEPER_PK, provider);
    const usdgContract = new ethers.Contract(TOKENS.USDG.address, ['function balanceOf(address) view returns (uint256)'], provider);
    const ethBal  = await provider.getBalance(keeper.address);
    const usdgBal = await usdgContract.balanceOf(keeper.address);
    const prices  = {};
    for (const sym of ['TSLA','AMZN','NFLX','AMD','PLTR']) {
      const d = await getStockPrice(sym);
      prices[sym] = d ? `$${d.price.toFixed(2)}` : 'error';
    }
    res.json({
      keeper: keeper.address,
      eth: ethers.formatEther(ethBal),
      usdg: ethers.formatUnits(usdgBal, 6),
      dex_prices: prices,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/keeper', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    await runPriceKeeper();
    res.json({ ok: true, message: 'Keeper run triggered' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Fully reset a user (demo helper) — clears in-memory state + all DB rows so the
// next message restarts onboarding from scratch. DESTRUCTIVE: deletes the wallet
// (and its encrypted key) — any funds in that wallet become unrecoverable.
app.get('/admin/reset-user', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid query param required' });
  try {
    onboardingState.delete(jid);
    historyCache.delete(jid);
    activeWalletRegistry.delete(jid);
    spendingLimits.delete(jid);
    pendingLimitOrders.delete(jid);
    exportIntentJids.delete(jid);
    await supabase.from('rh_wallets').delete().eq('jid', jid);
    await supabase.from('rh_conversation_history').delete().eq('jid', jid);
    await supabase.from('rh_trades').delete().eq('jid', jid);
    await supabase.from('rh_alerts').delete().eq('jid', jid);
    res.json({ ok: true, jid, message: 'User reset — next message restarts onboarding.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Secure self-custody page endpoints (token-gated, CORS to the frontend) ──
function claimCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://sammy-xxiv.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
app.options('/claim/info', (req, res) => { claimCors(res); res.status(204).end(); });
app.options('/claim/complete', (req, res) => { claimCors(res); res.status(204).end(); });
app.options('/vault/get', (req, res) => { claimCors(res); res.status(204).end(); });

// Validate a token; tell the page whether to SET a password (first time) or
// UNLOCK with an existing one. No jid exposed.
app.get('/claim/info', async (req, res) => {
  claimCors(res);
  const t = peekSecureToken(req.query.token);
  if (!t) return res.status(404).json({ ok: false, error: 'This link is invalid or has expired. Ask SAGE for a new one.' });
  try {
    const row = await getOrCreateWallet(t.jid);
    const account = await getAccountAddress(t.jid);
    if (!account) return res.status(409).json({ ok: false, error: 'No smart account found.' });
    const owner = await new ethers.Contract(account, SAGE_ACCOUNT_ABI, provider).owner();
    const hasKeystore = !!(await getKeystore(t.jid));
    res.json({ ok: true, account, hasKeystore, claimed: owner.toLowerCase() !== row.address.toLowerCase() });
  } catch (e) {
    console.error('[Claim] info error:', e.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// SETUP: page submits the browser-generated owner address + its password-encrypted
// keystore. Server transfers ownership (session-key signed, gas sponsored) and
// stores the keystore ciphertext (never the password).
app.post('/claim/complete', async (req, res) => {
  claimCors(res);
  const { token, owner, keystore } = req.body || {};
  const t = peekSecureToken(token);
  if (!t) return res.status(404).json({ ok: false, error: 'Link invalid or expired.' });
  if (!ethers.isAddress(owner)) return res.status(400).json({ ok: false, error: 'Bad owner address.' });
  try {
    const accountAddr = await getAccountAddress(t.jid);
    if (!accountAddr) return res.status(409).json({ ok: false, error: 'No smart account.' });
    const signer = await getSignerForJid(t.jid);
    await sponsorGas(signer.address);
    const account = new ethers.Contract(accountAddr, SAGE_ACCOUNT_ABI, signer);
    const currentOwner = await account.owner();
    if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
      secureTokens.delete(token);
      return res.status(409).json({ ok: false, error: 'This wallet is already self-custodied.' });
    }
    const tx = await account.transferOwnership(owner);
    await waitTx(tx);
    if (keystore && String(keystore).trim().startsWith('{')) await setKeystore(t.jid, keystore);
    secureTokens.delete(token); // one-time use
    sendWAMessage(t.jid, `✅ *Self-custody activated.*\nYour wallet is now yours — secured by your password. I can still trade for you, but only you can withdraw or export your key. Keep your password safe; it can't be reset.`).catch(() => {});
    res.json({ ok: true, account: accountAddr, owner, hash: tx.hash, explorer: `https://explorer.testnet.chain.robinhood.com/tx/${tx.hash}` });
  } catch (e) {
    console.error('[Claim] complete error:', e.message);
    res.status(500).json({ ok: false, error: 'Transfer failed — try the link again.' });
  }
});

// UNLOCK: return the stored encrypted keystore so the page can decrypt it locally
// with the user's password (to export the key or sign a withdrawal). Ciphertext
// only — useless without the password. Token not consumed so password can be retried.
app.post('/vault/get', async (req, res) => {
  claimCors(res);
  const t = peekSecureToken(req.body?.token);
  if (!t) return res.status(404).json({ ok: false, error: 'Link invalid or expired.' });
  try {
    const keystore = await getKeystore(t.jid);
    if (!keystore) return res.status(404).json({ ok: false, error: 'No saved key — set a password first.' });
    const account = await getAccountAddress(t.jid);
    res.json({ ok: true, keystore, account });
  } catch (e) {
    console.error('[Vault] get error:', e.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

app.get('/prices', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://sammy-xxiv.github.io');
  const syms = ['TSLA', 'AMZN', 'NFLX', 'PLTR', 'AMD'];
  const result = {};
  await Promise.all(syms.map(async sym => {
    const data = await getStockPrice(sym);
    result[sym] = data ? { price: data.price, prev: data.price, change: data.change } : null;
  }));
  res.json(result);
});

// ── DEX analytics (public, for the frontend analytics page) ───────────
async function gatherAnalytics() {
  const syms = ['TSLA', 'AMZN', 'NFLX', 'PLTR', 'AMD'];
  let totalTvl = 0;
  const pairs = [];
  await Promise.all(syms.map(async sym => {
    try {
      const pairAddr = DEP_PAIRS[sym];
      const pair = new ethers.Contract(pairAddr, PAIR_ABI_PRICE, provider);
      const [r0, r1] = await pair.getReserves();
      const token0  = await pair.token0();
      const isUsdg0 = token0.toLowerCase() === TOKENS.USDG.address.toLowerCase();
      const rUSDG  = parseFloat(ethers.formatUnits(isUsdg0 ? r0 : r1, 6));
      const rSTOCK = parseFloat(ethers.formatUnits(isUsdg0 ? r1 : r0, 18));
      const price  = rSTOCK > 0 ? rUSDG / rSTOCK : 0;
      const pd     = await getStockPrice(sym);
      const poolTvl = rUSDG * 2;
      totalTvl += poolTvl;
      pairs.push({ symbol: sym, price, change: pd?.change ?? '0.00', usdgReserve: rUSDG, stockReserve: rSTOCK, tvl: poolTvl, pair: pairAddr });
    } catch (e) {
      pairs.push({ symbol: sym, error: true });
    }
  }));
  pairs.sort((a, b) => syms.indexOf(a.symbol) - syms.indexOf(b.symbol));
  return { totalTvl, pairCount: pairs.filter(p => !p.error).length, pairs };
}

app.get('/analytics', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://sammy-xxiv.github.io');
  const a = await gatherAnalytics();
  res.json({ ok: true, ...a, router: DEX?.router || null, oracle: SAGE_ORACLE_ADDRESS, updatedAt: new Date().toISOString() });
});

// AI market read — SAGE analyzes the live pool data. Cached so page loads don't spam the model.
let aiAnalysisCache = { text: null, at: 0 };
const AI_ANALYSIS_TTL = 3 * 60_000;
app.get('/analytics/ai', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://sammy-xxiv.github.io');
  try {
    if (aiAnalysisCache.text && Date.now() - aiAnalysisCache.at < AI_ANALYSIS_TTL) {
      return res.json({ ok: true, analysis: aiAnalysisCache.text, generatedAt: new Date(aiAnalysisCache.at).toISOString(), cached: true });
    }
    const a = await gatherAnalytics();
    const data = a.pairs.filter(p => !p.error).map(p => ({ sym: p.symbol, price: +p.price.toFixed(2), change24h: p.change + '%', usdgLiquidity: Math.round(p.usdgReserve), tvl: Math.round(p.tvl) }));
    let analysis;
    try {
      const r = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 320,
        system: 'You are SAGE, a sharp DeFi market analyst for a tokenized-stock DEX (TSLA, AMZN, NFLX, PLTR, AMD vs USDG) on Robinhood Chain. Given live pool data, write a concise market read of 3-5 short sentences: the biggest mover(s), overall liquidity/TVL health, anything that stands out, and ONE actionable insight for a trader. Direct and confident, no fluff, no disclaimers. PLAIN TEXT ONLY — no markdown, no asterisks, no bold, no bullet points, no headers.',
        messages: [{ role: 'user', content: `Total TVL: $${Math.round(a.totalTvl)}. Pools: ${JSON.stringify(data)}` }],
      });
      analysis = r.content.find(b => b.type === 'text')?.text?.trim();
    } catch (e) {
      console.error('[AI Analytics] model error:', e.message);
    }
    // Strip markdown so it renders clean as plain text on the page
    if (analysis) {
      analysis = analysis
        .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
        .replace(/\*(.+?)\*/g, '$1')       // italics
        .replace(/`(.+?)`/g, '$1')         // code
        .replace(/^#+\s*/gm, '')           // headers
        .replace(/^\s*[-*]\s+/gm, '')      // bullet markers
        .trim();
    }
    if (!analysis) {
      const top = [...data].sort((x, y) => parseFloat(y.change24h) - parseFloat(x.change24h))[0];
      analysis = `Total value locked sits at $${Math.round(a.totalTvl)} across ${a.pairCount} pools. ${top?.sym || 'Markets'} leads at ${top?.change24h || '—'}. Liquidity is healthy and balanced across pairs.`;
    }
    aiAnalysisCache = { text: analysis, at: Date.now() };
    res.json({ ok: true, analysis, generatedAt: new Date(aiAnalysisCache.at).toISOString(), cached: false });
  } catch (e) {
    console.error('[AI Analytics] error:', e.message);
    res.status(500).json({ ok: false, error: 'internal error' });
  }
});

// ── Price keeper (runs in-process every 60s) ──────────────────
const KEEPER_THRESHOLD = 0.001; // 0.1% — keep DEX tight enough for limit order triggers
const KEEPER_PK = process.env.DEPLOYER_PRIVATE_KEY;

const KEEPER_ROUTER_ABI = [
  'function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)',
];
const KEEPER_ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];
const PAIR_ABI_KEEPER = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
];

const SAGE_ORACLE_ADDRESS = process.env.SAGE_ORACLE || '0x47543D0d0eE57F08f5FBe213795d4078b4900C7D';
const SAGE_ORACLE_ABI = [
  'function updateAll() external',
  'function spotPrice(address stock) external view returns (uint256)',
  'function allSpotPrices() external view returns (address[] memory, uint256[] memory)',
];

async function keeperGetDexPrice(sym) {
  if (!DEX) return null;
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployment.json'), 'utf8'));
  const pair = new ethers.Contract(dep.pairs[sym], PAIR_ABI_KEEPER, provider);
  const [r0, r1] = await pair.getReserves();
  const token0   = await pair.token0();
  const isUsdg0  = token0.toLowerCase() === TOKENS.USDG.address.toLowerCase();
  const rUSDG    = parseFloat(ethers.formatUnits(isUsdg0 ? r0 : r1, 6));
  const rSTOCK   = parseFloat(ethers.formatUnits(isUsdg0 ? r1 : r0, 18));
  return { price: rUSDG / rSTOCK, rUSDG, rSTOCK };
}

let keeperRunning = false;
async function runPriceKeeper() {
  if (!KEEPER_PK || !DEX || keeperRunning) return;
  keeperRunning = true;
  try { await _runPriceKeeper(); } finally { keeperRunning = false; }
}
async function _runPriceKeeper() {
  const keeper = new ethers.Wallet(KEEPER_PK, provider);
  const dep    = JSON.parse(fs.readFileSync(path.join(__dirname, 'deployment.json'), 'utf8'));
  const router = new ethers.Contract(DEX.router, KEEPER_ROUTER_ABI, keeper);

  for (const sym of ['TSLA', 'AMZN', 'PLTR', 'NFLX', 'AMD']) {
    try {
      const finnRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
      const finnQ   = await finnRes.json();
      console.log(`[Keeper] ${sym} raw:`, JSON.stringify(finnQ));
      const marketPrice = finnQ?.c;
      if (!marketPrice || marketPrice === 0) { console.log(`[Keeper] ${sym}: no Finnhub price`); continue; }

      const dex = await keeperGetDexPrice(sym);
      if (!dex) continue;

      const deviation = Math.abs(dex.price - marketPrice) / marketPrice;
      console.log(`[Keeper] ${sym} market=$${marketPrice.toFixed(2)} dex=$${dex.price.toFixed(2)} dev=${(deviation*100).toFixed(2)}%`);
      if (deviation <= KEEPER_THRESHOLD) continue;

      const k          = dex.rUSDG * dex.rSTOCK;
      const rUSDG_new  = Math.sqrt(k * marketPrice);
      const rSTOCK_new = Math.sqrt(k / marketPrice);
      const deltaUSDG  = rUSDG_new - dex.rUSDG;

      let tokenIn, tokenOut, amountIn, decimalsIn;
      if (deltaUSDG > 0) {
        tokenIn = TOKENS.USDG; tokenOut = TOKENS[sym]; amountIn = Math.min(deltaUSDG / 0.997, 500); decimalsIn = 6;
      } else {
        tokenIn = TOKENS[sym]; tokenOut = TOKENS.USDG; amountIn = Math.min(Math.abs(rSTOCK_new - dex.rSTOCK) / 0.997, 10); decimalsIn = 18;
      }
      if (amountIn < 0.000001) continue;

      const erc20   = new ethers.Contract(tokenIn.address, KEEPER_ERC20_ABI, keeper);
      const parsed  = ethers.parseUnits(amountIn.toFixed(decimalsIn), decimalsIn);
      const bal     = await erc20.balanceOf(keeper.address);
      if (bal < parsed) { console.log(`[Keeper] ${sym}: insufficient balance`); continue; }

      const allowance = await erc20.allowance(keeper.address, DEX.router);
      if (allowance < parsed) await waitTx(await erc20.approve(DEX.router, parsed));

      const tx = await router.swapExactTokensForTokens(parsed, 0, [tokenIn.address, tokenOut.address], keeper.address, Math.floor(Date.now()/1000)+120);
      await waitTx(tx);
      console.log(`[Keeper] ${sym} rebalanced — ${tx.hash.slice(0,18)}…`);
    } catch (e) {
      console.error(`[Keeper] ${sym} error:`, e.message);
    }
  }

  // Push fresh TWAP snapshots to SageOracle after every keeper run
  try {
    const oracle = new ethers.Contract(SAGE_ORACLE_ADDRESS, SAGE_ORACLE_ABI, keeper);
    const tx = await oracle.updateAll();
    await waitTx(tx);
    console.log(`[Keeper] SageOracle updated — ${tx.hash.slice(0,18)}…`);
  } catch (e) {
    console.error('[Keeper] SageOracle updateAll error:', e.message);
  }
}

// ── Alert / limit-order monitor ───────────────────────────────
let alertRunning = false;
const limitOrderFails = new Map(); // alert.id → consecutive execution failures
async function runAlertMonitor() {
  if (alertRunning) return;
  alertRunning = true;
  try {
    const { data: alerts } = await supabase
      .from('rh_alerts')
      .select('*')
      .eq('triggered', false)
      .neq('type', 'config');

    if (!alerts || alerts.length === 0) return;

    // Group by symbol to avoid redundant price fetches
    const bySymbol = {};
    for (const a of alerts) {
      if (!bySymbol[a.symbol]) bySymbol[a.symbol] = [];
      bySymbol[a.symbol].push(a);
    }

    for (const [sym, rows] of Object.entries(bySymbol)) {
      const priceData = await getStockPrice(sym);
      if (!priceData) continue;
      const { price } = priceData;

      for (const alert of rows) {
        const triggered =
          (alert.condition === 'above' && price >= alert.target_price) ||
          (alert.condition === 'below' && price <= alert.target_price) ||
          (alert.condition === 'at' && Math.abs(price - alert.target_price) / alert.target_price <= 0.01);
        if (!triggered) continue;

        if (alert.type === 'alert') {
          await sendWAMessage(alert.jid,
            `🔔 *Price Alert Triggered*\n${sym} is now $${price.toFixed(2)} — ${alert.condition} your target of $${alert.target_price}`
          );
        } else if (alert.type === 'limit') {
          // Auto-execute — user already confirmed when placing the order
          try {
            const fromSym = alert.action === 'buy' ? 'USDG' : sym;
            const toSym   = alert.action === 'buy' ? sym : 'USDG';
            const quote   = await getSwapQuote(fromSym, toSym, Number(alert.amount));
            if (quote.error) throw new Error(quote.error);
            const minOut  = quote.amountOut * 0.99;
            const result  = await executeSwap(alert.jid, fromSym, toSym, Number(alert.amount), minOut);
            if (result.error) throw new Error(result.error);
            limitOrderFails.delete(alert.id);
            await sendWAMessage(alert.jid,
              `✅ *Limit Order Executed*\n${alert.action.toUpperCase()} ${alert.amount} ${fromSym} → ${result.amountOut?.toFixed(4) || '?'} ${toSym}\nPrice: $${price.toFixed(2)}\nTx: https://explorer.testnet.chain.robinhood.com/tx/${result.hash}`
            );
          } catch (e) {
            // Don't consume the order on a transient failure — retry on the next
            // monitor pass (60s), give up after 3 strikes.
            const fails = (limitOrderFails.get(alert.id) || 0) + 1;
            limitOrderFails.set(alert.id, fails);
            if (fails < 3) {
              await sendWAMessage(alert.jid,
                `⚠️ *Limit Order Hiccup*\n${sym} hit $${price.toFixed(2)} but execution failed (attempt ${fails}/3): ${e.message}\nRetrying in ~60s.`
              );
              continue; // keep untriggered
            }
            limitOrderFails.delete(alert.id);
            await sendWAMessage(alert.jid,
              `❌ *Limit Order Cancelled*\n${sym} hit $${price.toFixed(2)} but execution failed 3 times: ${e.message}\nThe order has been removed — place it again when ready.`
            );
          }
        }

        // Mark triggered
        await supabase.from('rh_alerts').update({ triggered: true }).eq('id', alert.id);
      }
    }
  } catch (e) {
    console.error('[AlertMonitor] error:', e.message);
  } finally {
    alertRunning = false;
  }
}

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SAGE-RH running on port ${PORT}`));
connectWhatsApp();

// Start price keeper + alert monitor after 10s delay, then every 60s
setTimeout(() => {
  runPriceKeeper();
  runAlertMonitor();
  setInterval(runPriceKeeper, 60_000);
  setInterval(runAlertMonitor, 60_000);
}, 10_000);
