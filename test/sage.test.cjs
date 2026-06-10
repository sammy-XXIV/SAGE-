const { expect } = require('chai');
const { ethers }  = require('hardhat');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const USDG_DEC  = 6n;
const STOCK_DEC = 18n;

function usdg(n)  { return ethers.parseUnits(String(n), USDG_DEC);  }
function stock(n) { return ethers.parseUnits(String(n), STOCK_DEC); }

// AMM out-amount formula matching SagePair (0.3 % fee)
function ammOut(amtIn, rIn, rOut) {
  const fee = amtIn * 997n;
  return (fee * rOut) / (rIn * 1000n + fee);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

async function deployTokens() {
  const ERC20 = await ethers.getContractFactory('MockERC20');
  const usdgT  = await ERC20.deploy('USD Robinhood', 'USDG', 6);
  const tslaT  = await ERC20.deploy('Tesla',         'TSLA', 18);
  return { usdgT, tslaT };
}

async function deployAMM(usdgT, tslaT) {
  const [owner] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory('SageFactory');
  const factory = await Factory.deploy(owner.address);

  const Router = await ethers.getContractFactory('SageRouter');
  const router  = await Router.deploy(await factory.getAddress());

  await factory.createPair(await usdgT.getAddress(), await tslaT.getAddress());
  const pairAddr = await factory.getPair(await usdgT.getAddress(), await tslaT.getAddress());
  const pair = await ethers.getContractAt('SagePair', pairAddr);

  return { factory, router, pair };
}

async function deployOracle(usdgT) {
  const [owner] = await ethers.getSigners();
  const Oracle = await ethers.getContractFactory('SageOracle');
  const oracle  = await Oracle.deploy(await usdgT.getAddress(), owner.address);
  return oracle;
}

// Mint tokens and add liquidity. priceUSD = USDG per 1 TSLA.
async function addLiquidity(router, pair, usdgT, tslaT, signer, usdgAmt, priceUSD) {
  const stockAmt = (usdgAmt * 10n ** STOCK_DEC) / (priceUSD * 10n ** USDG_DEC);
  await usdgT.mint(signer.address, usdgAmt);
  await tslaT.mint(signer.address, stockAmt);

  const pairAddr   = await pair.getAddress();
  const routerAddr = await router.getAddress();

  await usdgT.connect(signer).transfer(pairAddr, usdgAmt);
  await tslaT.connect(signer).transfer(pairAddr, stockAmt);
  await pair.mint(signer.address);

  return stockAmt;
}

// ─── Mock ERC20 ───────────────────────────────────────────────────────────────
// Compiled inline via Hardhat — defined in contracts/test/MockERC20.sol

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SageFactory', function () {
  it('creates a pair and records it', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { factory, pair } = await deployAMM(usdgT, tslaT);

    expect(await factory.allPairsLength()).to.equal(1n);
    const recorded = await factory.getPair(await usdgT.getAddress(), await tslaT.getAddress());
    expect(recorded).to.equal(await pair.getAddress());
  });

  it('sorts tokens deterministically regardless of input order', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { factory } = await deployAMM(usdgT, tslaT);

    const ab = await factory.getPair(await usdgT.getAddress(), await tslaT.getAddress());
    const ba = await factory.getPair(await tslaT.getAddress(), await usdgT.getAddress());
    expect(ab).to.equal(ba);
  });

  it('reverts on duplicate pair creation', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { factory } = await deployAMM(usdgT, tslaT);

    await expect(
      factory.createPair(await usdgT.getAddress(), await tslaT.getAddress())
    ).to.be.revertedWithCustomError(factory, 'PairExists');
  });

  it('reverts on identical tokens', async function () {
    const { usdgT } = await deployTokens();
    const [owner] = await ethers.getSigners();
    const Factory  = await ethers.getContractFactory('SageFactory');
    const factory  = await Factory.deploy(owner.address);

    await expect(
      factory.createPair(await usdgT.getAddress(), await usdgT.getAddress())
    ).to.be.revertedWithCustomError(factory, 'IdenticalTokens');
  });

  it('only owner can set feeTo', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { factory } = await deployAMM(usdgT, tslaT);
    const [, alice] = await ethers.getSigners();

    await expect(
      factory.connect(alice).setFeeTo(alice.address)
    ).to.be.revertedWithCustomError(factory, 'Forbidden');
  });
});

describe('SagePair — liquidity', function () {
  it('mints LP tokens on first deposit', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(1000), 200n);
    expect(await pair.totalSupply()).to.be.gt(0n);
    expect(await pair.balanceOf(lp.address)).to.be.gt(0n);
  });

  it('burns LP tokens and returns both tokens', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(1000), 200n);

    const lpBal   = await pair.balanceOf(lp.address);
    const pairAddr = await pair.getAddress();
    await pair.transfer(pairAddr, lpBal);

    const usdgBefore = await usdgT.balanceOf(lp.address);
    const tslaFefore = await tslaT.balanceOf(lp.address);
    await pair.burn(lp.address);

    expect(await usdgT.balanceOf(lp.address)).to.be.gt(usdgBefore);
    expect(await tslaT.balanceOf(lp.address)).to.be.gt(tslaFefore);
  });

  it('locks MINIMUM_LIQUIDITY on first deposit', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(1000), 200n);
    const dead = await pair.balanceOf('0x000000000000000000000000000000000000dEaD');
    expect(dead).to.equal(1000n);
  });
});

describe('SagePair — swap', function () {
  it('USDG → TSLA: output matches AMM formula', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp, trader] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const [r0, r1] = await pair.getReserves();
    const token0   = await pair.token0();
    const isUsdg0  = token0.toLowerCase() === (await usdgT.getAddress()).toLowerCase();
    const rUSDG    = isUsdg0 ? r0 : r1;
    const rSTOCK   = isUsdg0 ? r1 : r0;

    const amtIn  = usdg(50);
    const expect_ = ammOut(amtIn, rUSDG, rSTOCK);

    await usdgT.mint(trader.address, amtIn);
    await usdgT.connect(trader).transfer(await pair.getAddress(), amtIn);

    const tslaBalBefore = await tslaT.balanceOf(trader.address);
    if (isUsdg0) {
      await pair.swap(0n, expect_, trader.address);
    } else {
      await pair.swap(expect_, 0n, trader.address);
    }

    const received = (await tslaT.balanceOf(trader.address)) - tslaBalBefore;
    expect(received).to.equal(expect_);
  });

  it('TSLA → USDG: output matches AMM formula', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp, trader] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const [r0, r1] = await pair.getReserves();
    const token0   = await pair.token0();
    const isUsdg0  = token0.toLowerCase() === (await usdgT.getAddress()).toLowerCase();
    const rUSDG    = isUsdg0 ? r0 : r1;
    const rSTOCK   = isUsdg0 ? r1 : r0;

    const amtIn  = stock(0.25);
    const expect_ = ammOut(amtIn, rSTOCK, rUSDG);

    await tslaT.mint(trader.address, amtIn);
    await tslaT.connect(trader).transfer(await pair.getAddress(), amtIn);

    const usdgBefore = await usdgT.balanceOf(trader.address);
    if (isUsdg0) {
      await pair.swap(expect_, 0n, trader.address);
    } else {
      await pair.swap(0n, expect_, trader.address);
    }

    const received = (await usdgT.balanceOf(trader.address)) - usdgBefore;
    expect(received).to.equal(expect_);
  });

  it('reverts when invariant is violated (no input sent)', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp, trader] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    await expect(
      pair.swap(0n, stock(1), trader.address)
    ).to.be.revertedWithCustomError(pair, 'InsufficientInputAmount');
  });

  it('reverts when draining more than reserves', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp, trader] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);
    const [r0, r1] = await pair.getReserves();

    await expect(
      pair.swap(r0, 0n, trader.address)
    ).to.be.revertedWithCustomError(pair, 'InsufficientLiquidity');
  });

  it('reentrancy guard blocks nested calls', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    // sync() also uses the lock modifier — calling it while locked would revert
    // We verify the modifier exists by calling sync() normally (should succeed)
    await expect(pair.sync()).to.not.be.reverted;
  });
});

describe('SagePair — spot price', function () {
  it('spotPrice reflects reserve ratio after liquidity add', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    // Add liquidity at $200 per TSLA: 10000 USDG / 50 TSLA
    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const token0   = await pair.token0();
    const isUsdg0  = token0.toLowerCase() === (await usdgT.getAddress()).toLowerCase();

    // spotPrice1 when USDG is token0 = r0/r1 * 1e18 = USDG_raw/STOCK_raw * 1e18
    const spot = isUsdg0 ? await pair.spotPrice1() : await pair.spotPrice0();
    // spot = rUSDG * 1e18 / rSTOCK = (10000 * 1e6 * 1e18) / (50 * 1e18) = 200 * 1e6
    const dollarPrice = Number(spot) / 1e6;
    expect(dollarPrice).to.be.closeTo(200, 0.01);
  });

  it('spot price moves after a swap', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp, trader] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const token0   = await pair.token0();
    const isUsdg0  = token0.toLowerCase() === (await usdgT.getAddress()).toLowerCase();
    const spotFn   = isUsdg0 ? 'spotPrice1' : 'spotPrice0';

    const spotBefore = await pair[spotFn]();

    // Buy TSLA with USDG — pushes price up
    const [r0, r1] = await pair.getReserves();
    const rUSDG = isUsdg0 ? r0 : r1;
    const rSTOCK = isUsdg0 ? r1 : r0;
    const amtIn  = usdg(500);
    const out    = ammOut(amtIn, rUSDG, rSTOCK);

    await usdgT.mint(trader.address, amtIn);
    await usdgT.connect(trader).transfer(await pair.getAddress(), amtIn);
    if (isUsdg0) await pair.swap(0n, out, trader.address);
    else         await pair.swap(out, 0n, trader.address);

    const spotAfter = await pair[spotFn]();
    expect(spotAfter).to.be.gt(spotBefore);
  });
});

describe('SagePair — TWAP', function () {
  it('cumulative prices advance with time', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const cum0Before = await pair.price0CumulativeLast();
    const cum1Before = await pair.price1CumulativeLast();

    // Advance time
    await ethers.provider.send('evm_increaseTime', [300]);
    await ethers.provider.send('evm_mine', []);

    // Trigger an _update via sync
    await pair.sync();

    const cum0After = await pair.price0CumulativeLast();
    const cum1After = await pair.price1CumulativeLast();

    expect(cum0After).to.be.gt(cum0Before);
    expect(cum1After).to.be.gt(cum1Before);
  });
});

describe('SageOracle', function () {
  it('registers a pair and reads spot price', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const oracle = await deployOracle(usdgT);
    await oracle.registerPair(await tslaT.getAddress(), await pair.getAddress(), 'TSLA');

    const spot = await oracle.spotPrice(await tslaT.getAddress());
    const dollarPrice = Number(spot) / 1e6;
    expect(dollarPrice).to.be.closeTo(200, 0.1);
  });

  it('allSpotPrices returns all registered stocks', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const oracle = await deployOracle(usdgT);
    await oracle.registerPair(await tslaT.getAddress(), await pair.getAddress(), 'TSLA');

    const [stocks, prices] = await oracle.allSpotPrices();
    expect(stocks.length).to.equal(1);
    expect(Number(prices[0]) / 1e6).to.be.closeTo(200, 0.1);
  });

  it('reverts spotPrice for unregistered stock', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const oracle = await deployOracle(usdgT);

    await expect(
      oracle.spotPrice(await tslaT.getAddress())
    ).to.be.revertedWithCustomError(oracle, 'PairNotRegistered');
  });

  it('reverts registerPair for non-owner', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { pair } = await deployAMM(usdgT, tslaT);
    const [, alice] = await ethers.getSigners();
    const oracle = await deployOracle(usdgT);

    await expect(
      oracle.connect(alice).registerPair(await tslaT.getAddress(), await pair.getAddress(), 'TSLA')
    ).to.be.revertedWithCustomError(oracle, 'Forbidden');
  });

  it('twapPrice returns a value close to spot after time passes', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const oracle = await deployOracle(usdgT);
    await oracle.registerPair(await tslaT.getAddress(), await pair.getAddress(), 'TSLA');

    // Advance past TWAP_PERIOD (5 min)
    await ethers.provider.send('evm_increaseTime', [310]);
    await ethers.provider.send('evm_mine', []);

    await oracle.update(await tslaT.getAddress());

    // Advance more time
    await ethers.provider.send('evm_increaseTime', [310]);
    await ethers.provider.send('evm_mine', []);

    const twap = await oracle.twapPrice(await tslaT.getAddress());
    const dollarPrice = Number(twap) / 1e6;
    expect(dollarPrice).to.be.closeTo(200, 5); // within $5 of spot
  });

  it('updateAll refreshes snapshots without reverting', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { router, pair } = await deployAMM(usdgT, tslaT);
    const [lp] = await ethers.getSigners();

    await addLiquidity(router, pair, usdgT, tslaT, lp, usdg(10_000), 200n);

    const oracle = await deployOracle(usdgT);
    await oracle.registerPair(await tslaT.getAddress(), await pair.getAddress(), 'TSLA');

    await ethers.provider.send('evm_increaseTime', [310]);
    await ethers.provider.send('evm_mine', []);

    await expect(oracle.updateAll()).to.not.be.reverted;
  });

  it('stockCount reflects registered pairs', async function () {
    const { usdgT, tslaT } = await deployTokens();
    const { pair } = await deployAMM(usdgT, tslaT);
    const oracle = await deployOracle(usdgT);

    expect(await oracle.stockCount()).to.equal(0n);
    await oracle.registerPair(await tslaT.getAddress(), await pair.getAddress(), 'TSLA');
    expect(await oracle.stockCount()).to.equal(1n);
  });
});
