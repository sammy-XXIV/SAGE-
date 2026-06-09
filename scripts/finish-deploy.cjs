require("dotenv").config();
const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const FACTORY_ADDR = "0x681c44F678b10bE02f5c8a14B22D1B672E967aaD";
const ROUTER_ADDR  = "0x275D5A1f0c5036B048Fa9BbB46373c885a4EF0A8";

const TOKENS = {
  USDG: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  TSLA: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
  AMZN: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
  PLTR: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
  NFLX: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
  AMD:  "0x71178BAc73cBeb415514eB542a8995b82669778d",
};

const FACTORY_ABI = [
  "function createPair(address,address) returns (address)",
  "function getPair(address,address) view returns (address)",
  "event PairCreated(address indexed,address indexed,address,uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, { chainId: 46630, name: "rh" });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const factory  = new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, deployer);

  // Check if AMD pair already exists
  let amdPair = await factory.getPair(TOKENS.USDG, TOKENS.AMD);
  if (amdPair === ethers.ZeroAddress) {
    console.log("Creating AMD/USDG pair...");
    const tx = await factory.createPair(TOKENS.USDG, TOKENS.AMD);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => {
      try { return factory.interface.parseLog(l)?.name === "PairCreated"; } catch { return false; }
    });
    amdPair = factory.interface.parseLog(event).args[2];
    console.log("AMD pair:", amdPair);
  } else {
    console.log("AMD pair already exists:", amdPair);
  }

  const deployment = {
    factory:  FACTORY_ADDR,
    router:   ROUTER_ADDR,
    pairs: {
      TSLA: "0xABcC98833f9aF473750844Ab687C497C04bF91A0",
      AMZN: "0x259337566d3F05FB4A29A8C7981bD94e1772BbD6",
      PLTR: "0x63De8b4E6770726a1E4dca15fbB5AfB9EDeB76e3",
      NFLX: "0x9E74F0B6D740174eFeBA450eEBA1C80B8D2c7DC1",
      AMD:  amdPair,
    },
    tokens: {
      USDG: TOKENS.USDG,
      TSLA: TOKENS.TSLA,
      AMZN: TOKENS.AMZN,
      PLTR: TOKENS.PLTR,
      NFLX: TOKENS.NFLX,
      AMD:  TOKENS.AMD,
    },
    chainId: 46630,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(__dirname, "../deployment.json"),
    JSON.stringify(deployment, null, 2)
  );

  console.log("\n✅ deployment.json written:");
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
