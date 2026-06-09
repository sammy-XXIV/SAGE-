require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const LIQUIDITY = {
  TSLA: { usdg: "35", stock: "0.1" },    // ~$350/share
  AMZN: { usdg: "35", stock: "0.16" },   // ~$218/share
  PLTR: { usdg: "35", stock: "0.28" },   // ~$125/share
  NFLX: { usdg: "35", stock: "0.027" },  // ~$1296/share
  AMD:  { usdg: "35", stock: "0.3" },    // ~$116/share
};

const USDG_DECIMALS = 6;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

const ROUTER_ABI = [
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)"
];

const FACTORY_ABI = [
  "function getPair(address,address) view returns (address)"
];

async function main() {
  const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployment.json")));
  const { factory: factoryAddress, router: routerAddress, tokens: TOKENS } = deployment;

  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    { chainId: 46630, name: "robinhood-testnet" }
  );
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deployer:", deployer.address);

  // Check USDG balance
  const usdgContract = new ethers.Contract(TOKENS.USDG, ERC20_ABI, deployer);
  const usdgBal = await usdgContract.balanceOf(deployer.address);
  console.log("USDG balance:", ethers.formatUnits(usdgBal, USDG_DECIMALS));

  const totalUSDGNeeded = Object.values(LIQUIDITY).reduce(
    (sum, a) => sum + BigInt(ethers.parseUnits(a.usdg, USDG_DECIMALS)), 0n
  );
  if (usdgBal < totalUSDGNeeded) {
    console.error(`Need ${ethers.formatUnits(totalUSDGNeeded, USDG_DECIMALS)} USDG but only have ${ethers.formatUnits(usdgBal, USDG_DECIMALS)}`);
    process.exit(1);
  }

  const routerContract = new ethers.Contract(routerAddress, ROUTER_ABI, deployer);
  const factoryContract = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const pairs = { ...deployment.pairs };

  for (const [sym, amounts] of Object.entries(LIQUIDITY)) {
    const stockAddr = TOKENS[sym];
    const usdgAddr  = TOKENS.USDG;

    const stockContract = new ethers.Contract(stockAddr, ERC20_ABI, deployer);
    const stockBal = await stockContract.balanceOf(deployer.address);
    const stockAmount = ethers.parseEther(amounts.stock);

    if (stockBal < stockAmount) {
      console.log(`⚠ Insufficient ${sym} (have ${ethers.formatEther(stockBal)}, need ${amounts.stock}) — skipping`);
      continue;
    }

    const usdgAmount = ethers.parseUnits(amounts.usdg, USDG_DECIMALS);
    console.log(`\nAdding liquidity: ${amounts.usdg} USDG + ${amounts.stock} ${sym}...`);

    await (await usdgContract.approve(routerAddress, usdgAmount)).wait();
    await (await stockContract.approve(routerAddress, stockAmount)).wait();

    const deadline = Math.floor(Date.now() / 1000) + 600;
    const tx = await routerContract.addLiquidity(
      usdgAddr, stockAddr,
      usdgAmount, stockAmount,
      0, 0,
      deployer.address,
      deadline
    );
    await tx.wait();

    const pairAddr = await factoryContract.getPair(usdgAddr, stockAddr);
    pairs[sym] = pairAddr;
    console.log(`✅ USDG/${sym} pair: ${pairAddr}`);
  }

  deployment.pairs = pairs;
  fs.writeFileSync(
    path.join(__dirname, "../deployment.json"),
    JSON.stringify(deployment, null, 2)
  );

  console.log("\n✅ Liquidity seeded! deployment.json updated.");
}

main().catch(console.error);
