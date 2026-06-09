// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISagePair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external;
}

interface ISageFactory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @title SageRouter
/// @notice Peripheral contract for adding/removing liquidity and executing swaps
///         against SageFactory/SagePair pools. Stateless — all funds flow through transiently.
contract SageRouter {

    address public immutable factory;

    error Expired();
    error InsufficientOutputAmount();
    error InsufficientAAmount();
    error InsufficientBAmount();
    error InsufficientLiquidity();
    error ExcessiveInputAmount();
    error InvalidPath();
    error PairNotFound();

    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    constructor(address _factory) {
        factory = _factory;
    }

    // ─── Quote Helpers (pure) ─────────────────────────────────────

    /// @notice Given an input amount and reserves, return the maximum output (no fee)
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        public pure returns (uint256 amountB)
    {
        require(amountA > 0 && reserveA > 0 && reserveB > 0);
        amountB = (amountA * reserveB) / reserveA;
    }

    /// @notice Given exact input and reserves, return output amount (0.3% fee deducted)
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256 amountOut)
    {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0);
        uint256 amountInWithFee = amountIn * 997;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    /// @notice Given exact output and reserves, return required input amount (0.3% fee)
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256 amountIn)
    {
        require(amountOut > 0 && reserveIn > 0 && reserveOut > 0 && amountOut < reserveOut);
        amountIn = (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    /// @notice Chain getAmountOut through a multi-hop path
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 rIn, uint256 rOut) = _getReservesOrdered(path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }
    }

    /// @notice Chain getAmountIn through a multi-hop path
    function getAmountsIn(uint256 amountOut, address[] calldata path)
        external view returns (uint256[] memory amounts)
    {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 rIn, uint256 rOut) = _getReservesOrdered(path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], rIn, rOut);
        }
    }

    // ─── Add Liquidity ────────────────────────────────────────────

    /// @notice Add liquidity to (or create) a tokenA/tokenB pool
    /// @return amountA Actual tokenA deposited
    /// @return amountB Actual tokenB deposited
    /// @return liquidity LP tokens minted
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        address pair = ISageFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) pair = ISageFactory(factory).createPair(tokenA, tokenB);

        (amountA, amountB) = _calcLiquidityAmounts(
            tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin
        );

        IERC20(tokenA).transferFrom(msg.sender, pair, amountA);
        IERC20(tokenB).transferFrom(msg.sender, pair, amountB);
        liquidity = ISagePair(pair).mint(to);
    }

    // ─── Remove Liquidity ─────────────────────────────────────────

    /// @notice Remove liquidity from a tokenA/tokenB pool
    /// @return amountA tokenA returned
    /// @return amountB tokenB returned
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256 amountA, uint256 amountB) {
        address pair = _getPairOrRevert(tokenA, tokenB);

        // Transfer LP tokens from caller to pair, then burn
        IERC20(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = ISagePair(pair).burn(to);

        // Re-order to match caller's tokenA/tokenB view
        (address token0,) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);

        if (amountA < amountAMin) revert InsufficientAAmount();
        if (amountB < amountBMin) revert InsufficientBAmount();
    }

    // ─── Swaps ────────────────────────────────────────────────────

    /// @notice Swap an exact input amount through a path of token pairs
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 rIn, uint256 rOut) = _getReservesOrdered(path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();

        IERC20(path[0]).transferFrom(msg.sender, _getPairOrRevert(path[0], path[1]), amounts[0]);
        _executeSwaps(amounts, path, to);
    }

    /// @notice Swap tokens to receive an exact output amount
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external ensure(deadline) returns (uint256[] memory amounts) {
        if (path.length < 2) revert InvalidPath();
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 rIn, uint256 rOut) = _getReservesOrdered(path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], rIn, rOut);
        }
        if (amounts[0] > amountInMax) revert ExcessiveInputAmount();

        IERC20(path[0]).transferFrom(msg.sender, _getPairOrRevert(path[0], path[1]), amounts[0]);
        _executeSwaps(amounts, path, to);
    }

    // ─── Internal ────────────────────────────────────────────────

    function _executeSwaps(uint256[] memory amounts, address[] calldata path, address to) internal {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = _sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOut)
                : (amountOut, uint256(0));

            address recipient = i < path.length - 2
                ? _getPairOrRevert(output, path[i + 2])
                : to;

            ISagePair(_getPairOrRevert(input, output)).swap(amount0Out, amount1Out, recipient);
        }
    }

    function _calcLiquidityAmounts(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) internal view returns (uint256 amountA, uint256 amountB) {
        address pair = ISageFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) {
            // New pair — deposit desired amounts as-is
            return (amountADesired, amountBDesired);
        }
        (uint256 reserveA, uint256 reserveB) = _getReservesOrdered(tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            return (amountADesired, amountBDesired);
        }
        uint256 amountBOptimal = quote(amountADesired, reserveA, reserveB);
        if (amountBOptimal <= amountBDesired) {
            if (amountBOptimal < amountBMin) revert InsufficientBAmount();
            return (amountADesired, amountBOptimal);
        }
        uint256 amountAOptimal = quote(amountBDesired, reserveB, reserveA);
        if (amountAOptimal > amountADesired) revert InsufficientAAmount();
        if (amountAOptimal < amountAMin) revert InsufficientAAmount();
        return (amountAOptimal, amountBDesired);
    }

    function _getReservesOrdered(address tokenA, address tokenB)
        internal view returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = _getPairOrRevert(tokenA, tokenB);
        (uint112 r0, uint112 r1,) = ISagePair(pair).getReserves();
        (address token0,) = _sortTokens(tokenA, tokenB);
        (reserveA, reserveB) = tokenA == token0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _getPairOrRevert(address tokenA, address tokenB) internal view returns (address pair) {
        pair = ISageFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound();
    }

    function _sortTokens(address tokenA, address tokenB)
        internal pure returns (address token0, address token1)
    {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
