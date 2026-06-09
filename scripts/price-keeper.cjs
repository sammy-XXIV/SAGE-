/**
 * Price Keeper — keeps SAGE DEX pool prices pegged to real market prices.
 * Fetches Yahoo Finance prices every 60s, calculates deviation from pool
 * reserves, and executes a correcting swap when deviation > THRESHOLD.
 */
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const THRESHOLD = 0.015; // 1.5% deviation triggers rebalance
const INTERVAL  = 60_000; // check every 60 seconds

const dep    = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployment.json")));
const ROUTER = dep.router;
const PAIRS  = dep.pairs;

const TOKENS = {
  USDG: { address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6  },
  TSLA: { address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", decimals: 18 },
  AMZN: { address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02", decimals: 18 },
  PLTR: { address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0", decimals: 18 },
  NFLX: { address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93", decimals: 18 },
  AMD:  { address: "0x71178BAc73cBeb415514eB542a8995b82669778d", decimals: 18 },
};

const PAIR_ABI = [
  "function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)",
  "function token0() view returns (address)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

const provider = new ethers.JsonRpcProvider(
  process.env.RPC_URL,
  { chainId: 46630, name: "robinhood-testnet" }
);
const keeper = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
const router = new ethers.Contract(ROUTER, ROUTER_ABI, keeper);

// ── Fetch real price from Finnhub ─────────────────────────────
async function getMarketPrice(sym) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY not set');
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`);
  const q   = await res.json();
  if (!q?.c || q.c === 0) throw new Error(`No price for ${sym}`);
  return q.c;
}

// ── Get current DEX price from reserves ────────────────────────
async function getDexPrice(sym) {
  const pair    = new ethers.Contract(PAIRS[sym], PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  const token0  = await pair.token0();
  const isUsdg0 = token0.toLowerCase() === TOKENS.USDG.address.toLowerCase();

  const rUSDG  = parseFloat(ethers.formatUnits(isUsdg0 ? r0 : r1, 6));
  const rSTOCK = parseFloat(ethers.formatUnits(isUsdg0 ? r1 : r0, 18));
  return { price: rUSDG / rSTOCK, rUSDG, rSTOCK, isUsdg0 };
}

// ── Calculate correcting swap amount ──────────────────────────
// Uniswap V2 constant product: k = rUSDG * rSTOCK
// Target: rUSDG_new / rSTOCK_new = targetPrice
// New reserves: rUSDG_new = sqrt(k * targetPrice), rSTOCK_new = sqrt(k / targetPrice)
function calcCorrection(rUSDG, rSTOCK, targetPrice) {
  const k          = rUSDG * rSTOCK;
  const rUSDG_new  = Math.sqrt(k * targetPrice);
  const rSTOCK_new = Math.sqrt(k / targetPrice);
  const deltaUSDG  = rUSDG_new - rUSDG;
  const deltaSTOCK = rSTOCK_new - rSTOCK;
  return { deltaUSDG, deltaSTOCK };
}

// ── Execute correcting swap ────────────────────────────────────
async function rebalance(sym, targetPrice, dex) {
  const { deltaUSDG, deltaSTOCK, rUSDG, rSTOCK } = {
    ...calcCorrection(dex.rUSDG, dex.rSTOCK, targetPrice),
    rUSDG: dex.rUSDG,
    rSTOCK: dex.rSTOCK,
  };

  let tokenIn, tokenOut, amountIn, decimalsIn;

  if (deltaUSDG > 0) {
    // Pool needs more USDG → we swap USDG → STOCK (buy stock, price too high in pool)
    tokenIn    = TOKENS.USDG;
    tokenOut   = TOKENS[sym];
    amountIn   = deltaUSDG / 0.997; // account for 0.3% fee
    decimalsIn = 6;
  } else {
    // Pool needs more STOCK → we swap STOCK → USDG (sell stock, price too low in pool)
    tokenIn    = TOKENS[sym];
    tokenOut   = TOKENS.USDG;
    amountIn   = Math.abs(deltaSTOCK) / 0.997;
    decimalsIn = 18;
  }

  // Cap swap to avoid draining keeper wallet
  const maxSwap = decimalsIn === 6 ? 15 : 0.5; // max 15 USDG or 0.5 stock per correction
  amountIn = Math.min(amountIn, maxSwap);
  if (amountIn < 0.000001) return;

  // Check keeper balance
  const erc20   = new ethers.Contract(tokenIn.address, ERC20_ABI, keeper);
  const bal     = await erc20.balanceOf(keeper.address);
  const parsed  = ethers.parseUnits(amountIn.toFixed(decimalsIn), decimalsIn);
  if (bal < parsed) {
    console.log(`  ⚠ Insufficient ${tokenIn === TOKENS.USDG ? "USDG" : sym} to rebalance (have ${ethers.formatUnits(bal, decimalsIn)})`);
    return;
  }

  // Approve
  const allowance = await erc20.allowance(keeper.address, ROUTER);
  if (allowance < parsed) await (await erc20.approve(ROUTER, parsed)).wait();

  // Swap
  const deadline = Math.floor(Date.now() / 1000) + 120;
  const tx = await router.swapExactTokensForTokens(
    parsed, 0,
    [tokenIn.address, tokenOut.address],
    keeper.address,
    deadline
  );
  await tx.wait();
  console.log(`  ✅ Rebalanced ${sym}: tx ${tx.hash.slice(0, 18)}…`);
}

// ── Main loop ─────────────────────────────────────────────────
async function check() {
  const ts = new Date().toLocaleTimeString();
  console.log(`\n[${ts}] Checking prices…`);

  for (const sym of ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"]) {
    try {
      const [marketPrice, dex] = await Promise.all([
        getMarketPrice(sym),
        getDexPrice(sym),
      ]);

      const deviation = Math.abs(dex.price - marketPrice) / marketPrice;
      const sign      = dex.price > marketPrice ? "↑" : "↓";
      console.log(
        `  ${sym.padEnd(4)} market=$${marketPrice.toFixed(2)}  dex=$${dex.price.toFixed(2)}  ` +
        `dev=${(deviation * 100).toFixed(2)}% ${sign}`
      );

      if (deviation > THRESHOLD) {
        console.log(`  → Rebalancing ${sym}…`);
        await rebalance(sym, marketPrice, dex);
      }
    } catch (e) {
      console.log(`  ${sym}: error — ${e.message}`);
    }
  }
}

// ── Start ──────────────────────────────────────────────────────
console.log("🔁 SAGE Price Keeper started");
console.log(`Keeper: ${keeper.address}`);
console.log(`Threshold: ${THRESHOLD * 100}% | Interval: ${INTERVAL / 1000}s\n`);

check();
setInterval(check, INTERVAL);
