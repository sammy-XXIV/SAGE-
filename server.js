import express from 'express';
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
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const RPC_URL        = process.env.RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID       = 46630;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'sage-rh-default-key-32-chars!!!!!';

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

// ── Encryption ─────────────────────────────────────────────────
function encrypt(text) {
  const iv  = crypto.randomBytes(16);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
}

function decrypt(enc) {
  const [ivHex, data] = enc.split(':');
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
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
  const value  = ethers.parseEther(String(amount));
  const tx = await signer.sendTransaction({ to: toAddress, value });
  await tx.wait();
  return tx.hash;
}

async function sendToken(jid, symbol, toAddress, amount) {
  const tokenInfo = TOKENS[symbol.toUpperCase()];
  if (!tokenInfo) throw new Error(`Unknown token: ${symbol}`);
  if (tokenInfo.address === 'native') return sendEth(jid, toAddress, amount);

  const signer   = await getSignerForJid(jid);
  const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
  const units    = ethers.parseUnits(String(amount), tokenInfo.decimals);
  const tx = await contract.transfer(toAddress, units);
  await tx.wait();
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
  const erc20   = new ethers.Contract(fromToken.address, ERC20_ABI, signer);
  const router  = new ethers.Contract(DEX.router, ROUTER_ABI, signer);

  const amtIn     = ethers.parseUnits(String(amountIn), fromToken.decimals);
  const amtOutMin = ethers.parseUnits(String(minAmountOut), toToken.decimals);
  const path      = [fromToken.address, toToken.address];
  const deadline  = Math.floor(Date.now() / 1000) + 300;

  // Check allowance and approve if needed
  const allowance = await erc20.allowance(signer.address, DEX.router);
  if (allowance < amtIn) {
    const approveTx = await erc20.approve(DEX.router, amtIn);
    await approveTx.wait();
  }

  const tx = await router.swapExactTokensForTokens(amtIn, amtOutMin, path, signer.address, deadline);
  const receipt = await tx.wait();

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

// ── Per-user spending limits (in-memory, set via set_spending_limit tool) ──
const spendingLimits = new Map(); // jid → max USDG per trade

// ── Pending limit order setup confirmations (confirm at order placement, not execution) ──
const pendingLimitOrders = new Map(); // jid → order details (waiting for yes/no before saving to DB)
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
        condition:    { type: 'string', enum: ['above', 'below'], description: 'Trigger when price goes above or below target' },
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
        condition:    { type: 'string', enum: ['above', 'below'], description: 'Execute when price goes above or below target' },
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
];

// ── Tool executor ─────────────────────────────────────────────
async function executeTool(name, input, jid) {
  try {
    if (name === 'get_wallet') {
      const row = await getOrCreateWallet(jid);
      return { address: row.address, chain: 'Robinhood Chain Testnet', chainId: CHAIN_ID };
    }

    if (name === 'get_portfolio') {
      const row      = await getOrCreateWallet(jid);
      const holdings = await getPortfolio(row.address);
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
      const force   = !!input.force;

      if (!force) {
        // ── 1. Spending limit ───────────────────────────────────────
        const limit = spendingLimits.get(jid);
        if (limit && limit > 0) {
          let tradeValueUsdg = amtIn;
          if (fromSym !== 'USDG') {
            const p = await getStockPrice(fromSym);
            tradeValueUsdg = p ? p.price * amtIn : amtIn;
          }
          if (tradeValueUsdg > limit) {
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
          const row      = await getOrCreateWallet(jid);
          const holdings = await getPortfolio(row.address);
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

      const result = await executeSwap(jid, fromSym, toSym, amtIn, input.min_amount_out);
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

      // Auto-detect condition from current price vs target
      const priceData = await getStockPrice(sym);
      const currentPrice = priceData ? priceData.price : null;
      const condition = currentPrice !== null
        ? (target_price > currentPrice ? 'above' : 'below')
        : input.condition;

      const dir = condition === 'above' ? 'rises to' : 'drops to';
      const fromSym = action === 'buy' ? 'USDG' : sym;
      const toSym   = action === 'buy' ? sym : 'USDG';

      // Store pending — don't save to DB until user confirms
      pendingLimitOrders.set(jid, { sym, action, condition, target_price, amount, fromSym, toSym });

      return {
        success: true,
        needs_confirmation: true,
        message: `Limit order ready — I'll auto-${action} ${amount} ${fromSym} → ${toSym} when ${sym} ${dir} $${target_price}${currentPrice ? ` (now $${currentPrice.toFixed(2)})` : ''}. Confirm?`,
      };
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
        spendingLimits.delete(jid);
        return { success: true, message: 'Spending limit removed. All trade sizes allowed.' };
      }
      spendingLimits.set(jid, limit);
      return { success: true, message: `Spending limit set to $${limit} USDG per trade. SAGE will warn you before any larger swap.` };
    }

    if (name === 'get_faucet') {
      const row = await getOrCreateWallet(jid);
      return {
        faucetUrl: 'https://faucet.testnet.chain.robinhood.com/',
        address: row.address,
        message: `Paste your address at the faucet to get testnet ETH.`,
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
- When user says "buy $X USDG of TSLA if it drops to $Y": call set_limit_order with action=buy, condition=below
- When user says "sell N TSLA if it hits $Y": call set_limit_order with action=sell, condition=above
- Confirm the order details and note it will auto-execute

TRADE HISTORY:
- When user asks for trade history or "what have I traded?": call get_trade_history
- Format each trade as: "BUY 0.04 TSLA @ $394 on 6/9"
- Show tx link for each trade

FAUCET:
- When user asks for testnet ETH, gas, or faucet: call get_faucet
- Display their address and the faucet URL clearly

EXPORTING PRIVATE KEY:
- If the user asks to export or see their private key, reply EXACTLY with: __TRIGGER_EXPORT__
- Do not say anything else, do not explain — just that token

UNSUPPORTED REQUESTS:
- If the user asks to change their password, say: "Password change isn't supported yet. If you need to reset it, export your private key and reimport your wallet."
- Never make up features, apps, or systems that don't exist
- If you can't do something, say so directly in one line`;

// ── Claude message handler ────────────────────────────────────
async function handleMessage(jid, text) {
  const state = onboardingState.get(jid);

  // ── Onboarding: first ever message ───────────────────────────
  if (!state) {
    // Check if wallet already exists in DB
    const { data } = await supabase.from('rh_wallets').select('address').eq('jid', jid).single();
    if (data) {
      // Returning user — skip onboarding
      onboardingState.set(jid, 'done');
    } else {
      onboardingState.set(jid, 'awaiting_choice');
      return `👋 Welcome to *SAGE* — your DeFi agent on Robinhood Chain.\n\nTrade tokenized stocks (TSLA, AMZN, PLTR, NFLX, AMD) right from WhatsApp.\n\nTo get started, would you like to:\n\n*1️⃣ Generate a new wallet*\n*2️⃣ Import an existing wallet*\n\nReply *1* or *2*`;
    }
  }

  // ── Onboarding: waiting for 1 or 2 ───────────────────────────
  if (state === 'awaiting_choice') {
    const choice = text.trim();
    if (choice === '1') {
      const wallet = ethers.Wallet.createRandom();
      const encrypted_pk = encrypt(wallet.privateKey);
      await supabase.from('rh_wallets').upsert({ jid, address: wallet.address, encrypted_pk });
      activeWalletRegistry.set(jid, wallet.address);
      onboardingState.set(jid, 'awaiting_password_set');
      return `✅ *Wallet created!*\n\n📬 Address:\n\`${wallet.address}\`\n\nNow set a *password* to protect your wallet.\nYou'll need it to export your private key.\n\nReply with your chosen password:`;
    } else if (choice === '2') {
      onboardingState.set(jid, 'awaiting_pk');
      return `🔑 Send your *private key* and I'll import your wallet.\n\n⚠️ It will be encrypted and stored securely. This message will be deleted immediately.`;
    } else {
      return `Please reply *1* to generate a new wallet or *2* to import an existing one.`;
    }
  }

  // ── Onboarding: waiting for private key ──────────────────────
  if (state === 'awaiting_pk') {
    try {
      const pk = text.trim().startsWith('0x') ? text.trim() : `0x${text.trim()}`;
      const wallet = new ethers.Wallet(pk);
      const encrypted_pk = encrypt(wallet.privateKey);
      await supabase.from('rh_wallets').upsert({ jid, address: wallet.address, encrypted_pk });
      activeWalletRegistry.set(jid, wallet.address);
      onboardingState.set(jid, 'awaiting_password_set');
      return `✅ *Wallet imported!*\n\n📬 Address:\n\`${wallet.address}\`\n\nNow set a *password* to protect your wallet.\nYou'll need it to export your private key.\n\nReply with your chosen password:`;
    } catch {
      return `❌ Invalid private key. Please try again or reply *1* to generate a new wallet instead.`;
    }
  }

  // ── Onboarding: set password ──────────────────────────────────
  if (state === 'awaiting_password_set') {
    const password = text.trim();
    if (password.length < 6) return `❌ Password too short. Use at least 6 characters.`;
    const password_hash = crypto.createHash('sha256').update(password).digest('hex');
    await supabase.from('rh_wallets').update({ password_hash }).eq('jid', jid);
    onboardingState.set(jid, 'done');
    return `🔒 *Password set!*\n\nYour wallet is ready. Fund it with testnet ETH:\nhttps://faucet.testnet.chain.robinhood.com/\n\nSay *"buy $10 of TSLA"* or *"show my portfolio"* to get started 🚀`;
  }

  // ── Export private key: waiting for password ──────────────────
  if (state === 'awaiting_export_password') {
    const { data: row } = await supabase.from('rh_wallets').select('encrypted_pk, password_hash').eq('jid', jid).single();
    const entered_hash = crypto.createHash('sha256').update(text.trim()).digest('hex');
    if (entered_hash !== row.password_hash) {
      onboardingState.set(jid, 'done');
      return `❌ Wrong password. Export cancelled.`;
    }
    const pk = decrypt(row.encrypted_pk);
    onboardingState.set(jid, 'done');
    // Return special marker — message handler will send + schedule deletion
    return `__EXPORT_PK__${pk}`;
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
    return JSON.parse(data.data, BufferJSON.reviver);
  }

  async function write(keyId, value) {
    const { error } = await supabase.from('wa_sessions').upsert(
      { key_id: keyId, data: JSON.stringify(value, BufferJSON.replacer), updated_at: new Date().toISOString() },
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
                const dir = pending.condition === 'above' ? 'rises to' : 'drops to';
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

        // Claude triggered export flow
        if (reply.trim() === '__TRIGGER_EXPORT__') {
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
  if (req.query.key !== ENCRYPTION_KEY) return res.status(401).send('<html><body style="background:#000;color:#ff4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>401 Unauthorized</h2></body></html>');
  if (waConnected) return res.send('<html><body style="background:#000;color:#C8F135;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>✅ SAGE is already connected to WhatsApp</h2></body></html>');
  if (!currentQr)  return res.send('<html><body style="background:#000;color:#C8F135;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column"><h2>⏳ Waiting for QR code...</h2><p>Refresh in a few seconds</p><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  const dataUrl = await qrcode.toDataURL(currentQr, { width: 300, margin: 2 });
  res.send(`<html><body style="background:#000;color:#C8F135;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0"><h2>Scan with WhatsApp</h2><img src="${dataUrl}" style="border-radius:12px"/><p style="opacity:0.6;font-size:13px">Auto-refreshes every 30s</p><script>setTimeout(()=>location.reload(),30000)</script></body></html>`);
});

app.get('/wallet/:jid', async (req, res) => {
  try {
    const row = await getOrCreateWallet(req.params.jid);
    res.json({ ok: true, address: row.address });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/portfolio/:address', async (req, res) => {
  try {
    const holdings = await getPortfolio(req.params.address);
    res.json({ ok: true, holdings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/price/:symbol', async (req, res) => {
  try {
    const data = await getStockPrice(req.params.symbol);
    res.json({ ok: !!data, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/prices', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const syms = ['TSLA', 'AMZN', 'NFLX', 'PLTR', 'AMD'];
  const result = {};
  await Promise.all(syms.map(async sym => {
    const data = await getStockPrice(sym);
    result[sym] = data ? { price: data.price, prev: data.price, change: data.change } : null;
  }));
  res.json(result);
});

// ── Price keeper (runs in-process every 60s) ──────────────────
const KEEPER_THRESHOLD = 0.015;
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
        tokenIn = TOKENS.USDG; tokenOut = TOKENS[sym]; amountIn = Math.min(deltaUSDG / 0.997, 20); decimalsIn = 6;
      } else {
        tokenIn = TOKENS[sym]; tokenOut = TOKENS.USDG; amountIn = Math.min(Math.abs(rSTOCK_new - dex.rSTOCK) / 0.997, 0.5); decimalsIn = 18;
      }
      if (amountIn < 0.000001) continue;

      const erc20   = new ethers.Contract(tokenIn.address, KEEPER_ERC20_ABI, keeper);
      const parsed  = ethers.parseUnits(amountIn.toFixed(decimalsIn), decimalsIn);
      const bal     = await erc20.balanceOf(keeper.address);
      if (bal < parsed) { console.log(`[Keeper] ${sym}: insufficient balance`); continue; }

      const allowance = await erc20.allowance(keeper.address, DEX.router);
      if (allowance < parsed) await (await erc20.approve(DEX.router, parsed)).wait();

      const tx = await router.swapExactTokensForTokens(parsed, 0, [tokenIn.address, tokenOut.address], keeper.address, Math.floor(Date.now()/1000)+120);
      await tx.wait();
      console.log(`[Keeper] ${sym} rebalanced — ${tx.hash.slice(0,18)}…`);
    } catch (e) {
      console.error(`[Keeper] ${sym} error:`, e.message);
    }
  }

  // Push fresh TWAP snapshots to SageOracle after every keeper run
  try {
    const oracle = new ethers.Contract(SAGE_ORACLE_ADDRESS, SAGE_ORACLE_ABI, keeper);
    const tx = await oracle.updateAll();
    await tx.wait();
    console.log(`[Keeper] SageOracle updated — ${tx.hash.slice(0,18)}…`);
  } catch (e) {
    console.error('[Keeper] SageOracle updateAll error:', e.message);
  }
}

// ── Alert / limit-order monitor ───────────────────────────────
let alertRunning = false;
async function runAlertMonitor() {
  if (alertRunning) return;
  alertRunning = true;
  try {
    const { data: alerts } = await supabase
      .from('rh_alerts')
      .select('*')
      .eq('triggered', false);

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
          (alert.condition === 'below' && price <= alert.target_price);
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
            await sendWAMessage(alert.jid,
              `✅ *Limit Order Executed*\n${alert.action.toUpperCase()} ${alert.amount} ${fromSym} → ${result.amountOut?.toFixed(4) || '?'} ${toSym}\nPrice: $${price.toFixed(2)}\nTx: https://explorer.testnet.chain.robinhood.com/tx/${result.hash}`
            );
          } catch (e) {
            await sendWAMessage(alert.jid,
              `⚠️ *Limit Order Failed*\n${sym} hit $${price.toFixed(2)} but execution failed: ${e.message}`
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
