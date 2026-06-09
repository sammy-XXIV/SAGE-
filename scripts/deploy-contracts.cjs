require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

async function main() {
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com",
    { chainId: 46630, name: "robinhood-testnet" }
  );
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deployer:", deployer.address);

  const ethBal = await provider.getBalance(deployer.address);
  console.log("ETH balance:", ethers.formatEther(ethBal));

  const artifactsDir = path.join(__dirname, "../artifacts/contracts");
  const factoryArtifact = JSON.parse(fs.readFileSync(path.join(artifactsDir, "UniswapV2Factory.sol/UniswapV2Factory.json")));
  const routerArtifact  = JSON.parse(fs.readFileSync(path.join(artifactsDir, "UniswapV2Router.sol/UniswapV2Router.json")));

  console.log("\nDeploying Factory...");
  const FactoryFactory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, deployer);
  const factory = await FactoryFactory.deploy(deployer.address);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("Factory deployed:", factoryAddress);

  console.log("\nDeploying Router...");
  const RouterFactory = new ethers.ContractFactory(routerArtifact.abi, routerArtifact.bytecode, deployer);
  const router = await RouterFactory.deploy(factoryAddress);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("Router deployed:", routerAddress);

  const deployment = {
    factory: factoryAddress,
    router:  routerAddress,
    pairs:   {},
    tokens: {
      USDG: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
      TSLA: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
      AMZN: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
      PLTR: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
      NFLX: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
      AMD:  "0x71178BAc73cBeb415514eB542a8995b82669778d",
    },
    deployedAt: new Date().toISOString(),
    chainId: 46630,
  };

  fs.writeFileSync(
    path.join(__dirname, "../deployment.json"),
    JSON.stringify(deployment, null, 2)
  );

  console.log("\n✅ Contracts deployed!");
  console.log("Factory:", factoryAddress);
  console.log("Router: ", routerAddress);
  console.log("Run seed-liquidity.cjs once USDG arrives.");
}

main().catch(console.error);
