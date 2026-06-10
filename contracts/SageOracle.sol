// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  SageOracle
/// @notice On-chain price oracle for SAGE's tokenized stock AMM pairs on Robinhood Chain.
///         Aggregates spot and TWAP prices across all registered USDG/stock pairs
///         deployed by SageFactory. Prices are denominated in USDG and expressed as
///         (rUSDG * 1e18 / rSTOCK) — divide by 1e6 to get the USD dollar price.
///
///         Two price modes:
///           • Spot  — reads current reserves directly; instant but manipulable in one block.
///           • TWAP  — time-weighted average over the last snapshot window; manipulation-resistant.
///
///         The SAGE price keeper calls updateAll() every 60 s, keeping TWAP snapshots fresh
///         and providing on-chain proof that the off-chain bot is alive.

interface ISagePair {
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function token0() external view returns (address);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

contract SageOracle {

    // ─── Constants ────────────────────────────────────────────────

    /// @notice Minimum elapsed time before a TWAP snapshot can be refreshed.
    uint32 public constant TWAP_PERIOD = 5 minutes;

    /// @notice Maximum age of a TWAP snapshot before twapPrice() reverts.
    uint256 public constant STALENESS_THRESHOLD = 2 hours;

    // ─── Types ────────────────────────────────────────────────────

    /// @param pair         Address of the SagePair (USDG/stock pool).
    /// @param usdgIsToken0 True when USDG == token0 inside the pair.
    /// @param symbol       Human-readable ticker (e.g. "TSLA").
    struct PairConfig {
        address pair;
        bool    usdgIsToken0;
        string  symbol;
    }

    /// @param priceCumulative Snapshot of the USDG-per-stock cumulative price.
    /// @param timestamp       Block timestamp when the snapshot was taken.
    struct Snapshot {
        uint256 priceCumulative;
        uint32  timestamp;
    }

    // ─── State ────────────────────────────────────────────────────

    /// @notice USDG token address (6 decimals).
    address public immutable USDG;

    /// @notice Contract owner — the only address that can register pairs.
    address public owner;

    /// @notice stock token address → pair config.
    mapping(address => PairConfig) public pairs;

    /// @notice stock token address → last TWAP snapshot.
    mapping(address => Snapshot) public snapshots;

    /// @notice Ordered list of registered stock token addresses.
    address[] public stockList;

    // ─── Events ───────────────────────────────────────────────────

    event PairRegistered(address indexed stock, address indexed pair, string symbol);
    event SnapshotTaken(address indexed stock, uint256 priceCumulative, uint32 timestamp);
    event OwnerUpdated(address indexed newOwner);

    // ─── Errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error PairNotRegistered();
    error AlreadyRegistered();
    error TwapPeriodNotElapsed();
    error StaleSnapshot();
    error NoLiquidity();
    error Forbidden();

    // ─── Constructor ──────────────────────────────────────────────

    /// @param _usdg  USDG token address on Robinhood Chain.
    /// @param _owner Initial owner (deployer).
    constructor(address _usdg, address _owner) {
        if (_usdg == address(0) || _owner == address(0)) revert ZeroAddress();
        USDG  = _usdg;
        owner = _owner;
    }

    // ─── Admin ────────────────────────────────────────────────────

    /// @notice Register a SagePair for price tracking.
    /// @param stock  Stock token address (TSLA, AMZN, PLTR, NFLX, or AMD).
    /// @param pair   Corresponding SagePair address from SageFactory.
    /// @param symbol Human-readable ticker symbol.
    function registerPair(
        address stock,
        address pair,
        string calldata symbol
    ) external {
        if (msg.sender != owner) revert Forbidden();
        if (stock == address(0) || pair == address(0)) revert ZeroAddress();
        if (pairs[stock].pair != address(0)) revert AlreadyRegistered();

        bool usdgIsToken0 = ISagePair(pair).token0() == USDG;
        pairs[stock] = PairConfig({ pair: pair, usdgIsToken0: usdgIsToken0, symbol: symbol });
        stockList.push(stock);

        _takeSnapshot(stock);

        emit PairRegistered(stock, pair, symbol);
    }

    /// @notice Transfer ownership.
    function setOwner(address _owner) external {
        if (msg.sender != owner) revert Forbidden();
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnerUpdated(_owner);
    }

    // ─── Snapshot Updates ─────────────────────────────────────────

    /// @notice Refresh the TWAP snapshot for a single stock.
    ///         Reverts if less than TWAP_PERIOD has elapsed since the last snapshot.
    ///         Anyone can call — no access restriction.
    /// @param stock Stock token address.
    function update(address stock) external {
        if (pairs[stock].pair == address(0)) revert PairNotRegistered();
        Snapshot memory snap = snapshots[stock];
        if (uint32(block.timestamp) - snap.timestamp < TWAP_PERIOD) revert TwapPeriodNotElapsed();
        _takeSnapshot(stock);
    }

    /// @notice Refresh TWAP snapshots for all registered stocks in one call.
    ///         Skips any stock whose TWAP_PERIOD has not yet elapsed.
    ///         Called by the SAGE price keeper every 60 s.
    function updateAll() external {
        uint256 n = stockList.length;
        for (uint256 i; i < n; ++i) {
            address stock = stockList[i];
            if (uint32(block.timestamp) - snapshots[stock].timestamp >= TWAP_PERIOD) {
                _takeSnapshot(stock);
            }
        }
    }

    /// @dev Store the current cumulative USDG-per-stock price (including the
    ///      unsaved interval since the pair's last internal update).
    function _takeSnapshot(address stock) internal {
        PairConfig memory cfg = pairs[stock];
        ISagePair pair = ISagePair(cfg.pair);

        uint256 cumulative = _currentCumulative(pair, cfg.usdgIsToken0);

        snapshots[stock] = Snapshot({
            priceCumulative: cumulative,
            timestamp: uint32(block.timestamp)
        });

        emit SnapshotTaken(stock, cumulative, uint32(block.timestamp));
    }

    /// @dev Compute the up-to-date USDG-per-stock cumulative price by adding
    ///      the current unsaved interval to the pair's stored accumulator.
    function _currentCumulative(
        ISagePair pair,
        bool usdgIsToken0
    ) internal view returns (uint256 cumulative) {
        // Select the accumulator that tracks USDG-per-stock:
        //   USDG == token0  →  price1CumulativeLast  (= token0/token1 = USDG/stock)
        //   USDG == token1  →  price0CumulativeLast  (= token1/token0 = USDG/stock)
        cumulative = usdgIsToken0
            ? pair.price1CumulativeLast()
            : pair.price0CumulativeLast();

        (uint112 r0, uint112 r1, uint32 pairTs) = pair.getReserves();

        uint32 elapsed;
        unchecked { elapsed = uint32(block.timestamp) - pairTs; }

        if (elapsed > 0 && r0 > 0 && r1 > 0) {
            // Add the current unsaved interval in UQ112x112 format.
            unchecked {
                if (usdgIsToken0) {
                    // price1 accumulates r0/r1 (USDG_raw / STOCK_raw)
                    cumulative += uint256((uint224(r0) << 112) / r1) * elapsed;
                } else {
                    // price0 accumulates r1/r0 (USDG_raw / STOCK_raw)
                    cumulative += uint256((uint224(r1) << 112) / r0) * elapsed;
                }
            }
        }
    }

    // ─── Price Reads ──────────────────────────────────────────────

    /// @notice Spot price of a stock denominated in USDG.
    ///         Reads directly from current reserves — instant but manipulable within one block.
    ///         Format: (rUSDG_raw * 1e18) / rSTOCK_raw.  Divide by 1e6 to get the USD price.
    /// @param stock Stock token address.
    /// @return price USDG-per-stock, scaled so that (price / 1e6) == USD dollar price.
    function spotPrice(address stock) external view returns (uint256 price) {
        PairConfig memory cfg = pairs[stock];
        if (cfg.pair == address(0)) revert PairNotRegistered();

        (uint112 r0, uint112 r1,) = ISagePair(cfg.pair).getReserves();
        if (r0 == 0 || r1 == 0) revert NoLiquidity();

        // (rUSDG_raw * 1e18) / rSTOCK_raw
        if (cfg.usdgIsToken0) {
            price = (uint256(r0) * 1e18) / uint256(r1);
        } else {
            price = (uint256(r1) * 1e18) / uint256(r0);
        }
    }

    /// @notice TWAP price of a stock denominated in USDG, over the elapsed window
    ///         since the last snapshot. More manipulation-resistant than spot.
    ///         Reverts if the stored snapshot is older than STALENESS_THRESHOLD.
    ///         Format: same as spotPrice — divide by 1e6 for USD.
    /// @param stock Stock token address.
    /// @return twap USDG-per-stock TWAP, scaled so that (twap / 1e6) == USD dollar price.
    function twapPrice(address stock) external view returns (uint256 twap) {
        PairConfig memory cfg = pairs[stock];
        if (cfg.pair == address(0)) revert PairNotRegistered();

        Snapshot memory snap = snapshots[stock];
        if (block.timestamp - snap.timestamp > STALENESS_THRESHOLD) revert StaleSnapshot();

        uint256 cumNow = _currentCumulative(ISagePair(cfg.pair), cfg.usdgIsToken0);

        uint32 dt;
        unchecked { dt = uint32(block.timestamp) - snap.timestamp; }
        if (dt == 0) revert TwapPeriodNotElapsed();

        // Average UQ112x112 price over the window, converted to the same
        // scale as spotPrice: (avgUQ * 1e18) >> 112.
        uint256 avgUQ = (cumNow - snap.priceCumulative) / dt;
        twap = (avgUQ * 1e18) >> 112;
    }

    /// @notice Bulk spot-price read for all registered stocks.
    ///         Returns zero for any pair with empty reserves instead of reverting.
    /// @return stocks Ordered array of stock token addresses.
    /// @return prices Corresponding spot prices (same format as spotPrice()).
    function allSpotPrices()
        external
        view
        returns (address[] memory stocks, uint256[] memory prices)
    {
        uint256 n = stockList.length;
        stocks = stockList;
        prices = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            PairConfig memory cfg = pairs[stocks[i]];
            (uint112 r0, uint112 r1,) = ISagePair(cfg.pair).getReserves();
            if (r0 == 0 || r1 == 0) continue;
            prices[i] = cfg.usdgIsToken0
                ? (uint256(r0) * 1e18) / uint256(r1)
                : (uint256(r1) * 1e18) / uint256(r0);
        }
    }

    /// @notice Number of stock pairs registered with this oracle.
    function stockCount() external view returns (uint256) {
        return stockList.length;
    }
}
