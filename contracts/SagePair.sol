// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface ISageFactory {
    function feeTo() external view returns (address);
}

/// @title SagePair
/// @notice Constant-product AMM pool (x * y = k) with LP tokens and TWAP oracle.
///         Swap fee: 0.3% (3/1000). Protocol fee: 1/6 of swap fee when enabled.
contract SagePair {

    // ─── LP Token ───────────────────────────────────────────────
    string  public constant name     = "Sage LP Token";
    string  public constant symbol   = "SAGE-LP";
    uint8   public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ─── AMM State ──────────────────────────────────────────────
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32  private blockTimestampLast;

    /// @notice Cumulative price accumulators for TWAP oracle
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    /// @notice Last sqrt(k) snapshot — used for protocol fee calculation
    uint256 public kLast;

    /// @notice Minimum liquidity permanently locked on first deposit (prevents manipulation)
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;

    uint256 private _unlocked = 1;

    // ─── AMM Events ─────────────────────────────────────────────
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    // ─── Errors ─────────────────────────────────────────────────
    error Locked();
    error Overflow();
    error InsufficientLiquidity();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InvalidRecipient();
    error InvariantViolated();

    // ─── Reentrancy Guard ────────────────────────────────────────
    modifier lock() {
        if (_unlocked != 1) revert Locked();
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    constructor(address _token0, address _token1, address _factory) {
        token0   = _token0;
        token1   = _token1;
        factory  = _factory;
    }

    // ─── LP Token Logic ──────────────────────────────────────────

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        balanceOf[from] -= value;
        balanceOf[to]   += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply    += value;
        balanceOf[to]  += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        balanceOf[from] -= value;
        totalSupply     -= value;
        emit Transfer(from, address(0), value);
    }

    // ─── Reserve Getters ─────────────────────────────────────────

    function getReserves() public view returns (
        uint112 _reserve0,
        uint112 _reserve1,
        uint32  _blockTimestampLast
    ) {
        _reserve0          = reserve0;
        _reserve1          = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    /// @notice Spot price of token0 in terms of token1 (scaled 1e18)
    function spotPrice0() external view returns (uint256) {
        if (reserve0 == 0) return 0;
        return (uint256(reserve1) * 1e18) / uint256(reserve0);
    }

    /// @notice Spot price of token1 in terms of token0 (scaled 1e18)
    function spotPrice1() external view returns (uint256) {
        if (reserve1 == 0) return 0;
        return (uint256(reserve0) * 1e18) / uint256(reserve1);
    }

    // ─── Internal: Update Reserves + TWAP ────────────────────────

    function _update(
        uint256 balance0,
        uint256 balance1,
        uint112 _reserve0,
        uint112 _reserve1
    ) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();

        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint32 timeElapsed;
        unchecked { timeElapsed = blockTimestamp - blockTimestampLast; }

        if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
            // UQ112x112 price accumulators — used for TWAP calculations
            unchecked {
                price0CumulativeLast += uint256(uq112x112(_reserve1, _reserve0)) * timeElapsed;
                price1CumulativeLast += uint256(uq112x112(_reserve0, _reserve1)) * timeElapsed;
            }
        }

        reserve0            = uint112(balance0);
        reserve1            = uint112(balance1);
        blockTimestampLast  = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    /// @dev UQ112x112 fixed-point division: numerator / denominator * 2^112
    function uq112x112(uint112 numerator, uint112 denominator) internal pure returns (uint224) {
        return (uint224(numerator) << 112) / denominator;
    }

    // ─── Internal: Protocol Fee ───────────────────────────────────

    function _mintProtocolFee(uint112 _reserve0, uint112 _reserve1) private returns (bool feeOn) {
        address feeTo = ISageFactory(factory).feeTo();
        feeOn = (feeTo != address(0));
        uint256 _kLast = kLast;
        if (feeOn) {
            if (_kLast != 0) {
                uint256 rootK     = _sqrt(uint256(_reserve0) * _reserve1);
                uint256 rootKLast = _sqrt(_kLast);
                if (rootK > rootKLast) {
                    // Mint 1/6 of growth to feeTo
                    uint256 numerator   = totalSupply * (rootK - rootKLast);
                    uint256 denominator = rootK * 5 + rootKLast;
                    uint256 liquidity   = numerator / denominator;
                    if (liquidity > 0) _mint(feeTo, liquidity);
                }
            }
        } else if (_kLast != 0) {
            kLast = 0;
        }
    }

    // ─── AMM Core ────────────────────────────────────────────────

    /// @notice Add liquidity. Tokens must be transferred in before calling.
    /// @return liquidity Amount of LP tokens minted
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 amount0  = balance0 - _reserve0;
        uint256 amount1  = balance1 - _reserve1;

        bool    feeOn      = _mintProtocolFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply;

        if (_totalSupply == 0) {
            // First deposit: geometric mean, minus minimum liquidity permanently locked
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
        } else {
            // Proportional share of existing supply
            liquidity = _min(
                (amount0 * _totalSupply) / _reserve0,
                (amount1 * _totalSupply) / _reserve1
            );
        }

        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);
        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Remove liquidity. LP tokens must be transferred in before calling.
    /// @return amount0 token0 returned
    /// @return amount1 token1 returned
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0   = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1   = IERC20Minimal(token1).balanceOf(address(this));
        uint256 liquidity  = balanceOf[address(this)];

        bool    feeOn      = _mintProtocolFee(_reserve0, _reserve1);
        uint256 _totalSupply = totalSupply;

        // Pro-rata share of pool balances
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();

        _burn(address(this), liquidity);
        IERC20Minimal(token0).transfer(to, amount0);
        IERC20Minimal(token1).transfer(to, amount1);

        balance0 = IERC20Minimal(token0).balanceOf(address(this));
        balance1 = IERC20Minimal(token1).balanceOf(address(this));
        _update(balance0, balance1, _reserve0, _reserve1);
        if (feeOn) kLast = uint256(reserve0) * reserve1;
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Execute a swap. Tokens must be transferred in before calling.
    /// @param amount0Out Amount of token0 to send out
    /// @param amount1Out Amount of token1 to send out
    /// @param to Recipient address
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();

        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        if (amount0Out >= _reserve0 || amount1Out >= _reserve1) revert InsufficientLiquidity();
        if (to == token0 || to == token1) revert InvalidRecipient();

        // Optimistically transfer output
        if (amount0Out > 0) IERC20Minimal(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20Minimal(token1).transfer(to, amount1Out);

        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));

        // Calculate input amounts
        uint256 amount0In = balance0 > _reserve0 - amount0Out
            ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out
            ? balance1 - (_reserve1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        // Verify constant product invariant holds after 0.3% fee
        // (balance0 * 1000 - amount0In * 3) * (balance1 * 1000 - amount1In * 3) >= k * 1_000_000
        uint256 b0Adj = balance0 * 1000 - amount0In * 3;
        uint256 b1Adj = balance1 * 1000 - amount1In * 3;
        if (b0Adj * b1Adj < uint256(_reserve0) * _reserve1 * 1_000_000) revert InvariantViolated();

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    /// @notice Sync reserves to current token balances (recovery function)
    function sync() external lock {
        _update(
            IERC20Minimal(token0).balanceOf(address(this)),
            IERC20Minimal(token1).balanceOf(address(this)),
            reserve0,
            reserve1
        );
    }

    // ─── Math Helpers ─────────────────────────────────────────────

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }
}
