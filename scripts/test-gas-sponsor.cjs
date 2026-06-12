// Proves the gasless UX: a user EOA that starts with ZERO ETH gets sponsored
// by the deployer and can swap — no faucet, one address.
const { ethers } = require('ethers');
require('dotenv').config();

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID = 46630;
const FACTORY = process.env.SAGE_ACCOUNT_FACTORY || '0xcBe2F33bBB9824f29d253C14a812Ac4B6faE86a5';
const USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';

const FACTORY_ABI = [
  'function createAccount(bytes32 userId, address owner, address sessionKey) external returns (address)',
  'function accountOf(bytes32 userId) external view returns (address)',
];
const ACCOUNT_ABI = ['function swap(uint256,uint256,address[],uint256) external returns (uint256)'];
const ERC20 = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

const TOPUP = ethers.parseEther('0.0003');

async function main() {
  const net = new ethers.Network('rh', CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const userEOA = ethers.Wallet.createRandom().connect(provider);
  const jid = `gastest-${Date.now()}@s.whatsapp.net`;
  const userId = ethers.keccak256(ethers.toUtf8Bytes(jid));
  console.log(`User EOA: ${userEOA.address}`);
  console.log(`Starting EOA ETH: ${ethers.formatEther(await provider.getBalance(userEOA.address))} (zero — no faucet)\n`);

  console.log('1. Deployer creates account + sponsors gas (the ensureAccount path)...');
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer);
  await (await factory.createAccount(userId, userEOA.address, userEOA.address)).wait();
  const accountAddr = await factory.accountOf(userId);
  await (await deployer.sendTransaction({ to: userEOA.address, value: TOPUP })).wait(); // sponsorGas
  console.log(`   ✓ Account: ${accountAddr}`);
  console.log(`   ✓ EOA sponsored to: ${ethers.formatEther(await provider.getBalance(userEOA.address))} ETH\n`);

  console.log('2. Fund account 10 USDG (simulates user deposit)...');
  const usdg = new ethers.Contract(USDG, ERC20, deployer);
  await (await usdg.transfer(accountAddr, 10n * 10n ** 6n)).wait();
  console.log(`   ✓ Account USDG: ${ethers.formatUnits(await usdg.balanceOf(accountAddr), 6)}\n`);

  console.log('3. User EOA swaps 5 USDG → TSLA using ONLY sponsored gas...');
  const before = await provider.getBalance(userEOA.address);
  const account = new ethers.Contract(accountAddr, ACCOUNT_ABI, userEOA);
  const tx = await account.swap(5n * 10n ** 6n, 0, [USDG, TSLA], Math.floor(Date.now()/1000)+300);
  await tx.wait();
  const after = await provider.getBalance(userEOA.address);
  const tsla = new ethers.Contract(TSLA, ERC20, provider);
  console.log(`   ✓ ${tx.hash}`);
  console.log(`   ✓ Account TSLA: ${ethers.formatEther(await tsla.balanceOf(accountAddr))}`);
  console.log(`   ✓ Gas spent this swap: ${ethers.formatEther(before - after)} ETH`);
  console.log(`   ✓ EOA ETH remaining: ${ethers.formatEther(after)} (good for ~${(Number(after) / Number(before - after || 1n)).toFixed(0)} more swaps)\n`);

  console.log('GASLESS FLOW PASS ✓ — user funded zero ETH, SAGE sponsored, swap succeeded.');
}

main().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
