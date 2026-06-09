require("dotenv").config();
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

// Load compiled artifacts
function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, `../artifacts/contracts/${name}.sol/${name}.json`))
  );
}

const TOKENS = {
  USDG: { address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6  },
  TSLA: { address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E", decimals: 18 },
  AMZN: { address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02", decimals: 18 },
  PLTR: { address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0", decimals: 18 },
  NFLX: { address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93", decimals: 18 },
  AMD:  { address: "0x71178BAc73cBeb415514eB542a8995b82669778d", decimals: 18 },
};

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, { chainId: 46630, name: "rh" });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  console.log("Deployer:", deployer.address);

  const factoryArt = artifact("SageFactory");
  const routerArt  = artifact("SageRouter");

  // 1. Deploy SageFactory
  console.log("\nDeploying SageFactory...");
  const Factory = new ethers.ContractFactory(factoryArt.abi, factoryArt.bytecode, deployer);
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("SageFactory:", factoryAddr);

  // 2. Deploy SageRouter
  console.log("Deploying SageRouter...");
  const Router = new ethers.ContractFactory(routerArt.abi, routerArt.bytecode, deployer);
  const router = await Router.deploy(factoryAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("SageRouter:", routerAddr);

  // 3. Create pairs
  console.log("\nCreating pairs...");
  const pairs = {};
  const stockSymbols = ["TSLA", "AMZN", "PLTR", "NFLX", "AMD"];

  for (const sym of stockSymbols) {
    const tx = await factory.createPair(TOKENS.USDG.address, TOKENS[sym].address);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => {
      try { return factory.interface.parseLog(l)?.name === "PairCreated"; } catch { return false; }
    });
    const parsed = factory.interface.parseLog(event);
    pairs[sym] = parsed.args[2]; // pair address is 3rd arg
    console.log(`✅ ${sym}/USDG pair: ${pairs[sym]}`);
  }

  // 4. Write deployment.json
  const deployment = {
    factory:   factoryAddr,
    router:    routerAddr,
    pairs,
    tokens: {
      USDG: TOKENS.USDG.address,
      TSLA: TOKENS.TSLA.address,
      AMZN: TOKENS.AMZN.address,
      PLTR: TOKENS.PLTR.address,
      NFLX: TOKENS.NFLX.address,
      AMD:  TOKENS.AMD.address,
    },
    chainId: 46630,
  };

  fs.writeFileSync(
    path.join(__dirname, "../deployment.json"),
    JSON.stringify(deployment, null, 2)
  );
  console.log("\n✅ deployment.json updated");
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
