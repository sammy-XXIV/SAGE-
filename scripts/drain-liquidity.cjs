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
  "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
];
const PAIR_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, { chainId: 46630, name: "rh" });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const router   = new ethers.Contract(dep.router, ROUTER_ABI, deployer);

  console.log("Draining liquidity from all pairs...\n");

  for (const [sym, pairAddr] of Object.entries(dep.pairs)) {
    try {
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, deployer);
      const lpBal = await pair.balanceOf(deployer.address);

      if (lpBal === 0n) { console.log(`${sym}: no LP tokens, skipping`); continue; }

      console.log(`${sym}: LP balance = ${ethers.formatEther(lpBal)}`);

      // Approve router to spend LP tokens
      await (await pair.approve(dep.router, lpBal)).wait();

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await router.removeLiquidity(
        TOKENS.USDG.address,
        TOKENS[sym].address,
        lpBal,
        0, 0, // accept any amount back
        deployer.address,
        deadline
      );
      await tx.wait();
      console.log(`✅ ${sym} liquidity drained — tx ${tx.hash.slice(0,18)}…`);
    } catch(e) {
      console.log(`❌ ${sym}: ${e.message}`);
    }
  }

  // Show final balances
  console.log("\n── Final balances ──");
  const usdg = new ethers.Contract(TOKENS.USDG.address, ERC20_ABI, provider);
  const usdgBal = await usdg.balanceOf(deployer.address);
  console.log("USDG:", ethers.formatUnits(usdgBal, 6));

  for (const [sym, t] of Object.entries(TOKENS)) {
    if (sym === "USDG") continue;
    const c = new ethers.Contract(t.address, ERC20_ABI, provider);
    const b = await c.balanceOf(deployer.address);
    console.log(`${sym}: ${ethers.formatEther(b)}`);
  }
}

main().catch(console.error);
