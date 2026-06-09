require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const TOKENS = {
  USDG: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  TSLA: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
  AMZN: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
  PLTR: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
  NFLX: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
  AMD:  "0x71178BAc73cBeb415514eB542a8995b82669778d",
};

// Liquidity amounts: USDG amount, stock amount (at approximate real prices)
const LIQUIDITY = {
  TSLA: { usdg: "1000", stock: "4" },    // ~$250/share
  AMZN: { usdg: "1000", stock: "5" },    // ~$200/share
  PLTR: { usdg: "1000", stock: "100" },  // ~$10/share
  NFLX: { usdg: "1000", stock: "1" },    // ~$1000/share
  AMD:  { usdg: "1000", stock: "8" },    // ~$125/share
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    { chainId: 46630, name: "robinhood-testnet" }
  );
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deployer:", deployer.address);

  const bal = await provider.getBalance(deployer.address);
  console.log("ETH balance:", ethers.formatEther(bal));

  // Load compiled artifacts
  const artifactsDir = path.join(__dirname, "../artifacts/contracts");
  const factoryArtifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, "UniswapV2Factory.sol/UniswapV2Factory.json")));
  const routerArtifact  = JSON.parse(fs.readFileSync(path.join(artifactsDir, "UniswapV2Router.sol/UniswapV2Router.json")));

  // Deploy Factory
  console.log("\nDeploying Factory...");
  const FactoryFactory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, deployer);
  const factory = await FactoryFactory.deploy(deployer.address);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("Factory deployed:", factoryAddress);

  // Deploy Router
  console.log("\nDeploying Router...");
  const RouterFactory = new ethers.ContractFactory(routerArtifact.abi, routerArtifact.bytecode, deployer);
  const router = await RouterFactory.deploy(factoryAddress);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("Router deployed:", routerAddress);

  // Check token balances
  console.log("\nChecking token balances...");
  for (const [sym, addr] of Object.entries(TOKENS)) {
    const token = new ethers.Contract(addr, ERC20_ABI, provider);
    const bal = await token.balanceOf(deployer.address);
    console.log(`${sym}: ${ethers.formatEther(bal)}`);
  }

  // Create pairs and add liquidity
  console.log("\nCreating pairs and adding liquidity...");
  const pairs = {};

  for (const [sym, amounts] of Object.entries(LIQUIDITY)) {
    const stockAddr = TOKENS[sym];
    const usdgAddr  = TOKENS.USDG;

    const usdgContract  = new ethers.Contract(usdgAddr, ERC20_ABI, deployer);
    const stockContract = new ethers.Contract(stockAddr, ERC20_ABI, deployer);

    const usdgBal  = await usdgContract.balanceOf(deployer.address);
    const stockBal = await stockContract.balanceOf(deployer.address);

    const usdgAmount  = ethers.parseEther(amounts.usdg);
    const stockAmount = ethers.parseEther(amounts.stock);

    if (usdgBal < usdgAmount) {
      console.log(`⚠ Insufficient USDG for ${sym} pair (have ${ethers.formatEther(usdgBal)}, need ${amounts.usdg})`);
      continue;
    }
    if (stockBal < stockAmount) {
      console.log(`⚠ Insufficient ${sym} (have ${ethers.formatEther(stockBal)}, need ${amounts.stock})`);
      continue;
    }

    // Approve router
    await usdgContract.approve(routerAddress, usdgAmount);
    await stockContract.approve(routerAddress, stockAmount);

    // Add liquidity
    const routerContract = new ethers.Contract(routerAddress, [
      "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)"
    ], deployer);

    const deadline = Math.floor(Date.now() / 1000) + 600;
    const tx = await routerContract.addLiquidity(
      usdgAddr, stockAddr,
      usdgAmount, stockAmount,
      0, 0,
      deployer.address,
      deadline
    );
    await tx.wait();

    // Get pair address
    const factoryContract = new ethers.Contract(factoryAddress, [
      "function getPair(address,address) view returns (address)"
    ], provider);
    const pairAddr = await factoryContract.getPair(usdgAddr, stockAddr);
    pairs[sym] = pairAddr;
    console.log(`✅ USDG/${sym} pair: ${pairAddr}`);
  }

  // Save deployment info
  const deployment = {
    factory: factoryAddress,
    router:  routerAddress,
    pairs,
    tokens:  TOKENS,
    deployedAt: new Date().toISOString(),
    chainId: 46630,
  };

  fs.writeFileSync(
    path.join(__dirname, "../deployment.json"),
    JSON.stringify(deployment, null, 2)
  );

  console.log("\n✅ Deployment complete!");
  console.log("Factory:", factoryAddress);
  console.log("Router: ", routerAddress);
  console.log("Saved to deployment.json");
}

main().catch(console.error);
