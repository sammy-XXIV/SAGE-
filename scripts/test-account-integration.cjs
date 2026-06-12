// Validates the EXACT runtime path the server uses:
//   - a per-user EOA (not the deployer) is owner+sessionKey
//   - the deployer pays to create the account
//   - the EOA pays its own gas to swap through account.swap()
//   - the EOA (owner) can withdraw; output of swaps lands in the account
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
  'function swap(uint256 amountIn, uint256 amountOutMin, address[] path, uint256 deadline) external returns (uint256)',
  'function withdraw(address token, address to, uint256 amount) external',
  'function remainingToday() view returns (uint256)',
];
const ERC20 = [
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  const network  = new ethers.Network('rh', CHAIN_ID);
  const provider = new ethers.JsonRpcProvider(RPC, network, { staticNetwork: network });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  // Simulate a brand-new SAGE user EOA (the key the server would hold encrypted)
  const userEOA = ethers.Wallet.createRandom().connect(provider);
  const jid = `test-${Date.now()}@s.whatsapp.net`;
  const userId = ethers.keccak256(ethers.toUtf8Bytes(jid));
  console.log(`User EOA: ${userEOA.address}`);
  console.log(`jid:      ${jid}\n`);

  // 1. Deployer creates the account (gas paid by SAGE, not the user)
  console.log('1. Deployer creating account (owner=session=user EOA)...');
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, deployer);
  await (await factory.createAccount(userId, userEOA.address, userEOA.address)).wait();
  const accountAddr = await factory.accountOf(userId);
  console.log(`   ✓ Account: ${accountAddr}\n`);

  // 2. Deployer funds: account with USDG (assets) + EOA with ETH (gas)
  console.log('2. Funding account 10 USDG, EOA 0.002 ETH for gas...');
  const usdg = new ethers.Contract(USDG, ERC20, deployer);
  await (await usdg.transfer(accountAddr, 10n * 10n ** 6n)).wait();
  await (await deployer.sendTransaction({ to: userEOA.address, value: ethers.parseEther('0.002') })).wait();
  console.log(`   ✓ Account USDG: ${ethers.formatUnits(await usdg.balanceOf(accountAddr), 6)}`);
  console.log(`   ✓ EOA ETH:      ${ethers.formatEther(await provider.getBalance(userEOA.address))}\n`);

  // 3. The USER EOA signs account.swap() and pays its own gas (server runtime path)
  console.log('3. User EOA swapping 5 USDG → TSLA via account.swap() (pays own gas)...');
  const account  = new ethers.Contract(accountAddr, ACCOUNT_ABI, userEOA);
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const swapTx   = await account.swap(5n * 10n ** 6n, 0, [USDG, TSLA], deadline);
  await swapTx.wait();
  const tsla = new ethers.Contract(TSLA, ERC20, provider);
  console.log(`   ✓ ${swapTx.hash}`);
  console.log(`   ✓ Account TSLA: ${ethers.formatEther(await tsla.balanceOf(accountAddr))}`);
  console.log(`   ✓ Account USDG: ${ethers.formatUnits(await usdg.balanceOf(accountAddr), 6)}`);
  console.log(`   ✓ Cap left:     ${ethers.formatUnits(await account.remainingToday(), 6)} USDG\n`);

  // 4. The USER EOA (owner) withdraws TSLA to an external address
  console.log('4. User EOA withdrawing 0.001 TSLA to an external address...');
  const dest = ethers.Wallet.createRandom().address;
  const tslaBal = await tsla.balanceOf(accountAddr);
  const wAmt = tslaBal / 2n;
  await (await account.withdraw(TSLA, dest, wAmt)).wait();
  console.log(`   ✓ Withdrew ${ethers.formatEther(wAmt)} TSLA to ${dest}`);
  console.log(`   ✓ Dest TSLA: ${ethers.formatEther(await tsla.balanceOf(dest))}\n`);

  console.log('ALL RUNTIME PATHS PASS ✓ — server can create, swap, and withdraw via per-user EOA.');
}

main().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
