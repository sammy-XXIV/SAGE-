const { ethers } = require('ethers');
require('dotenv').config();

const RPC      = 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID = 46630;

const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';

const STOCKS = {
  TSLA: { token: '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', pair: '0xABcC98833f9aF473750844Ab687C497C04bF91A0' },
  AMZN: { token: '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', pair: '0x259337566d3F05FB4A29A8C7981bD94e1772BbD6' },
  PLTR: { token: '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0', pair: '0x63De8b4E6770726a1E4dca15fbB5AfB9EDeB76e3' },
  NFLX: { token: '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', pair: '0x9E74F0B6D740174eFeBA450eEBA1C80B8D2c7DC1' },
  AMD:  { token: '0x71178BAc73cBeb415514eB542a8995b82669778d', pair: '0xE8F8b6DCb7a9e677108f4CCD31f65B2A0a71A9f2' },
};

const ORACLE_ABI = [
  'constructor(address _usdg, address _owner)',
  'function registerPair(address stock, address pair, string calldata symbol) external',
  'function spotPrice(address stock) external view returns (uint256)',
  'function allSpotPrices() external view returns (address[] memory, uint256[] memory)',
  'function stockCount() external view returns (uint256)',
  'function owner() external view returns (address)',
];

const ORACLE_BYTECODE = require('../artifacts/contracts/SageOracle.sol/SageOracle.json').bytecode;

async function main() {
  const network  = new ethers.Network('rh', CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC, network, { staticNetwork: network });
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  console.log(`Deployer:  ${wallet.address}`);
  console.log(`Balance:   ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH\n`);

  // ── Deploy SageOracle ───────────────────────────────────────────
  console.log('Deploying SageOracle...');
  const factory  = new ethers.ContractFactory(ORACLE_ABI, ORACLE_BYTECODE, wallet);
  const oracle   = await factory.deploy(USDG, wallet.address);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`✓ SageOracle deployed: ${oracleAddr}\n`);

  // ── Register all 5 stock pairs ──────────────────────────────────
  for (const [symbol, { token, pair }] of Object.entries(STOCKS)) {
    process.stdout.write(`Registering ${symbol}... `);
    const tx = await oracle.registerPair(token, pair, symbol);
    await tx.wait();
    console.log(`✓ (${tx.hash.slice(0, 20)}…)`);
  }

  // ── Verify: read all spot prices ────────────────────────────────
  console.log('\nVerifying spot prices:');
  const [stocks, prices] = await oracle.allSpotPrices();
  const symbols = Object.keys(STOCKS);
  for (let i = 0; i < stocks.length; i++) {
    const usd = (Number(prices[i]) / 1e6).toFixed(2);
    console.log(`  ${symbols[i]}: $${usd}`);
  }

  console.log(`
─────────────────────────────────────────────
SageOracle: ${oracleAddr}
─────────────────────────────────────────────
Add to your .env / Railway:
  SAGE_ORACLE=${oracleAddr}

Add to server.js CONTRACTS block:
  SAGE_ORACLE: '${oracleAddr}',
─────────────────────────────────────────────`);
}

main().catch(e => { console.error(e); process.exit(1); });
