require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployment.json")));

const TOKENS = {
  USDG: { address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6  },
  TSLA: { address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", decimals: 18 },
  AMZN: { address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02", decimals: 18 },
  PLTR: { address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0", decimals: 18 },
  NFLX: { address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93", decimals: 18 },
  AMD:  { address: "0x71178BAc73cBeb415514eB542a8995b82669778d", decimals: 18 },
};

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL,
    { chainId: 46630, name: "robinhood-testnet" }
  );
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const router   = new ethers.Contract(dep.router, ROUTER_ABI, deployer);

  console.log("Wallet:", deployer.address);
  console.log("Router:", dep.router);

  // ── Step 1: Get quotes for all pairs ─────────────────────────
  console.log("\n── Quotes: 10 USDG → each stock ──");
  const amtIn = ethers.parseUnits("10", 6); // 10 USDG

  for (const sym of ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"]) {
    try {
      const path = [TOKENS.USDG.address, TOKENS[sym].address];
      const amounts = await router.getAmountsOut(amtIn, path);
      const out = ethers.formatUnits(amounts[1], TOKENS[sym].decimals);
      console.log(`10 USDG → ${parseFloat(out).toFixed(6)} ${sym}`);
    } catch (e) {
      console.log(`${sym}: quote failed — ${e.message}`);
    }
  }

  // ── Step 2: Execute a real swap — 5 USDG → TSLA ──────────────
  console.log("\n── Executing swap: 5 USDG → TSLA ──");
  const swapAmtIn = ethers.parseUnits("5", 6);
  const path      = [TOKENS.USDG.address, TOKENS.TSLA.address];

  // Get quote first
  const amounts   = await router.getAmountsOut(swapAmtIn, path);
  const expectedOut = amounts[1];
  const minOut    = expectedOut * 99n / 100n; // 1% slippage
  console.log("Expected TSLA out:", ethers.formatUnits(expectedOut, 18));
  console.log("Min TSLA out (1% slip):", ethers.formatUnits(minOut, 18));

  // Approve USDG
  const usdgContract = new ethers.Contract(TOKENS.USDG.address, ERC20_ABI, deployer);
  const allowance    = await usdgContract.allowance(deployer.address, dep.router);
  if (allowance < swapAmtIn) {
    console.log("Approving USDG...");
    await (await usdgContract.approve(dep.router, swapAmtIn)).wait();
    console.log("Approved.");
  }

  // Check TSLA balance before
  const tslaContract = new ethers.Contract(TOKENS.TSLA.address, ERC20_ABI, deployer);
  const tslaBefore   = await tslaContract.balanceOf(deployer.address);
  console.log("TSLA before:", ethers.formatUnits(tslaBefore, 18));

  // Swap
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const tx = await router.swapExactTokensForTokens(swapAmtIn, minOut, path, deployer.address, deadline);
  console.log("Tx sent:", tx.hash);
  const receipt = await tx.wait();
  console.log("Confirmed in block:", receipt.blockNumber);

  // Check TSLA balance after
  const tslaAfter = await tslaContract.balanceOf(deployer.address);
  const received  = tslaAfter - tslaBefore;
  console.log("TSLA after:", ethers.formatUnits(tslaAfter, 18));
  console.log("TSLA received:", ethers.formatUnits(received, 18));
  console.log("Explorer:", `https://explorer.testnet.chain.robinhood.com/tx/${tx.hash}`);

  // ── Step 3: Check USDG balance remaining ─────────────────────
  const usdgBal = await usdgContract.balanceOf(deployer.address);
  console.log("\nUSDG remaining:", ethers.formatUnits(usdgBal, 6));

  console.log("\n✅ Swap works!");
}

main().catch(console.error);
