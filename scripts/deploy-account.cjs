// Deploys SageAccountFactory + one demo SageAccount on Robinhood Chain,
// then proves the security model live:
//   1. Fund the account with USDG
//   2. Session key swaps USDG → TSLA through the account  (allowed)
//   3. A random attacker key tries to withdraw            (reverts: Forbidden)
//   4. Session key tries to withdraw                      (reverts: Forbidden)
const { ethers } = require('ethers');
require('dotenv').config();

const RPC      = 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID = 46630;

const ROUTER = '0x275D5A1f0c5036B048Fa9BbB46373c885a4EF0A8';
const USDG   = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const TSLA   = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';

const STOCK_TOKENS = [
  '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E', // TSLA
  '0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02', // AMZN
  '0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0', // PLTR
  '0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93', // NFLX
  '0x71178BAc73cBeb415514eB542a8995b82669778d', // AMD
];

const DEFAULT_DAILY_CAP = 10_000n * 10n ** 6n; // 10,000 USDG per 24h

const FACTORY_ARTIFACT = require('../artifacts/contracts/SageAccountFactory.sol/SageAccountFactory.json');
const ACCOUNT_ARTIFACT = require('../artifacts/contracts/SageAccount.sol/SageAccount.json');

const ERC20_ABI = [
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  const network  = new ethers.Network('rh', CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC, network, { staticNetwork: network });
  const wallet   = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  console.log(`Deployer:  ${wallet.address}`);
  console.log(`Balance:   ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH\n`);

  // ── 1. Deploy SageAccountFactory ────────────────────────────────
  console.log('Deploying SageAccountFactory...');
  const Factory = new ethers.ContractFactory(FACTORY_ARTIFACT.abi, FACTORY_ARTIFACT.bytecode, wallet);
  const factory = await Factory.deploy(ROUTER, USDG, STOCK_TOKENS, DEFAULT_DAILY_CAP);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`✓ SageAccountFactory deployed: ${factoryAddr}\n`);

  // ── 2. Create a demo account ────────────────────────────────────
  // userId = keccak256 of the WhatsApp jid — phone number never goes on-chain
  const userId = ethers.keccak256(ethers.toUtf8Bytes('demo-user@s.whatsapp.net'));
  console.log('Creating demo SageAccount...');
  const tx = await factory.createAccount(userId, wallet.address, wallet.address);
  await tx.wait();
  const accountAddr = await factory.accountOf(userId);
  console.log(`✓ Demo SageAccount: ${accountAddr}\n`);

  const account = new ethers.Contract(accountAddr, ACCOUNT_ARTIFACT.abi, wallet);
  const usdg    = new ethers.Contract(USDG, ERC20_ABI, wallet);
  const tsla    = new ethers.Contract(TSLA, ERC20_ABI, provider);

  // ── 3. Fund it with 20 USDG ─────────────────────────────────────
  console.log('Funding account with 20 USDG...');
  await (await usdg.transfer(accountAddr, 20n * 10n ** 6n)).wait();
  console.log(`✓ Account USDG: ${ethers.formatUnits(await usdg.balanceOf(accountAddr), 6)}\n`);

  // ── 4. Session key swaps 5 USDG → TSLA through the account ─────
  console.log('Session key swapping 5 USDG → TSLA via account.swap()...');
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const swapTx   = await account.swap(5n * 10n ** 6n, 0, [USDG, TSLA], deadline);
  await swapTx.wait();
  console.log(`✓ Swap executed: ${swapTx.hash}`);
  console.log(`  Account TSLA: ${ethers.formatEther(await tsla.balanceOf(accountAddr))}`);
  console.log(`  Account USDG: ${ethers.formatUnits(await usdg.balanceOf(accountAddr), 6)}`);
  console.log(`  Cap remaining today: ${ethers.formatUnits(await account.remainingToday(), 6)} USDG\n`);

  // ── 5. Prove the guard: attacker key cannot withdraw ────────────
  console.log('Attacker (random key) attempting withdraw()...');
  const attacker = ethers.Wallet.createRandom().connect(provider);
  try {
    await account.connect(attacker).withdraw.staticCall(USDG, attacker.address, 1n * 10n ** 6n);
    console.log('✗ UNEXPECTED: attacker withdraw did not revert!');
  } catch (e) {
    console.log(`✓ Reverted as expected (Forbidden)\n`);
  }

  // ── 6. Prove the bigger claim: even the SESSION KEY can't withdraw
  // after the user claims ownership. Transfer ownership to a fresh
  // "user" key, then try to withdraw with the server key.
  console.log('Transferring ownership to a user key (the "claim" step)...');
  const userKey = ethers.Wallet.createRandom().connect(provider);
  await (await account.transferOwnership(userKey.address)).wait();
  console.log(`✓ Owner is now ${userKey.address}`);

  console.log('SAGE server key attempting withdraw() post-claim...');
  try {
    await account.withdraw.staticCall(USDG, wallet.address, 1n * 10n ** 6n);
    console.log('✗ UNEXPECTED: server withdraw did not revert!');
  } catch (e) {
    console.log('✓ Reverted as expected — server cannot drain a claimed account');
  }

  console.log('Server key can still trade (limit orders keep working)...');
  const swap2 = await account.swap.staticCall(1n * 10n ** 6n, 0, [USDG, TSLA], deadline);
  console.log(`✓ swap() still allowed for session key (would receive ${ethers.formatEther(swap2)} TSLA)`);

  console.log(`
─────────────────────────────────────────────
SageAccountFactory: ${factoryAddr}
Demo SageAccount:   ${accountAddr}
Demo owner (user):  ${userKey.address}
─────────────────────────────────────────────
Add to your .env / Railway:
  SAGE_ACCOUNT_FACTORY=${factoryAddr}
─────────────────────────────────────────────`);
}

main().catch(e => { console.error(e); process.exit(1); });
