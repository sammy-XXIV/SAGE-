// Proves the claim-ownership flow end to end:
//   - SAGE (server EOA) owns the account, can trade + withdraw
//   - user claims: server transfers ownership to the user's own key
//   - after claim: server can STILL trade, but can NO LONGER withdraw
//   - the user's key CAN withdraw
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
const ACCOUNT_ABI = [
  'function swap(uint256,uint256,address[],uint256) external returns (uint256)',
  'function withdraw(address,address,uint256) external',
  'function transferOwnership(address) external',
  'function owner() view returns (address)',
];
const ERC20 = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

async function main() {
  const net = new ethers.Network('rh', CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const serverEOA = ethers.Wallet.createRandom().connect(provider); // SAGE-held key
  const userKey   = ethers.Wallet.createRandom().connect(provider); // user's MetaMask
  const jid = `claim-${Date.now()}@s.whatsapp.net`;
  const userId = ethers.keccak256(ethers.toUtf8Bytes(jid));
  console.log(`Server EOA (SAGE): ${serverEOA.address}`);
  console.log(`User key (MetaMask): ${userKey.address}\n`);

  // Setup: create account (server is owner+session), fund account + both EOAs' gas
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer);
  await (await factory.createAccount(userId, serverEOA.address, serverEOA.address)).wait();
  const accountAddr = await factory.accountOf(userId);
  const usdg = new ethers.Contract(USDG, ERC20, deployer);
  await (await usdg.transfer(accountAddr, 10n * 10n ** 6n)).wait();
  await (await deployer.sendTransaction({ to: serverEOA.address, value: ethers.parseEther('0.0004') })).wait();
  await (await deployer.sendTransaction({ to: userKey.address,   value: ethers.parseEther('0.0002') })).wait();
  console.log(`Account ${accountAddr} funded with 10 USDG\n`);

  const asServer = new ethers.Contract(accountAddr, ACCOUNT_ABI, serverEOA);
  const asUser   = new ethers.Contract(accountAddr, ACCOUNT_ABI, userKey);
  const tsla = new ethers.Contract(TSLA, ERC20, provider);
  const deadline = () => Math.floor(Date.now()/1000)+300;

  // 1. Pre-claim: server can trade
  console.log('1. Pre-claim: server swaps 3 USDG → TSLA...');
  await (await asServer.swap(3n*10n**6n, 0, [USDG, TSLA], deadline())).wait();
  console.log(`   ✓ Account TSLA: ${ethers.formatEther(await tsla.balanceOf(accountAddr))}\n`);

  // 2. CLAIM: server transfers ownership to the user's key (the claim_ownership tool path)
  console.log('2. CLAIM: server transferOwnership → user key...');
  await (await asServer.transferOwnership(userKey.address)).wait();
  console.log(`   ✓ Owner is now: ${await asServer.owner()} (user)\n`);

  // 3. Post-claim: server can STILL trade
  console.log('3. Post-claim: server still swaps 3 USDG → TSLA...');
  await (await asServer.swap(3n*10n**6n, 0, [USDG, TSLA], deadline())).wait();
  console.log(`   ✓ Trading still works for SAGE\n`);

  // 4. Post-claim: server can NO LONGER withdraw
  console.log('4. Post-claim: server tries to withdraw → should REVERT...');
  try {
    await asServer.withdraw.staticCall(TSLA, serverEOA.address, 1n);
    console.log('   ✗ UNEXPECTED: server withdraw did not revert!'); process.exit(1);
  } catch { console.log('   ✓ Reverted — SAGE cannot drain a claimed account\n'); }

  // 5. Post-claim: the USER key CAN withdraw
  console.log('5. Post-claim: user key withdraws TSLA to itself...');
  const amt = (await tsla.balanceOf(accountAddr)) / 2n;
  await (await asUser.withdraw(TSLA, userKey.address, amt)).wait();
  console.log(`   ✓ User received ${ethers.formatEther(await tsla.balanceOf(userKey.address))} TSLA\n`);

  console.log('CLAIM FLOW PASS ✓ — self-custody is real: SAGE trades, only the user withdraws.');
}

main().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
