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

/// @title  SageRouter
/// @notice Peripheral routing contract for the SageAMM protocol.
///         Handles liquidity provision, liquidity withdrawal, and single- or
///         multi-hop token swaps against pools deployed by SageFactory.
/// @dev    Stateless — no funds are held between calls. All token transfers
///         are transient: input lands in the pair, output is forwarded to the
///         recipient in the same transaction. Compatible with any ERC-20 pair
///         created by SageFactory using CREATE2 pair addresses.
contract SageRouter {

    /// @notice The SageFactory this router is bound to.
    address public immutable factory;

    // ─── Errors ───────────────────────────────────────────────────

    /// @notice Transaction submitted after its deadline timestamp.
    error Expired();

    /// @notice Swap output is below the caller's minimum acceptable amount.
    error InsufficientOutputAmount();

    /// @notice Liquidity removal returned less tokenA than the caller required.
    error InsufficientAAmount();

    /// @notice Liquidity removal returned less tokenB than the caller required.
    error InsufficientBAmount();

    /// @notice Pool reserves are empty — cannot quote or swap.
    error InsufficientLiquidity();

    /// @notice Swap input required exceeds the caller's maximum acceptable amount.
    error ExcessiveInputAmount();

    /// @notice Path array has fewer than two token addresses.
    error InvalidPath();

    /// @notice No SagePair exists for the requested token pair.
    error PairNotFound();

    // ─── Modifiers ────────────────────────────────────────────────

    /// @dev Reverts if the current block timestamp is past `deadline`.
    modifier ensure(uint256 deadline) {
        if (deadline < block.timestamp) revert Expired();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────

    /// @param _factory Address of the SageFactory contract.
    constructor(address _factory) {
        factory = _factory;
    }

    // ─── Quote Helpers (pure) ─────────────────────────────────────

    /// @notice Proportional quote: given `amountA` of tokenA and the current
    ///         reserves, return the equivalent amount of tokenB at spot price.
    ///         Does not account for the swap fee — use this only for liquidity
    ///         sizing, not for swap output estimation.
    /// @param amountA  Input amount of tokenA.
    /// @param reserveA Current pool reserve of tokenA.
    /// @param reserveB Current pool reserve of tokenB.
    /// @return amountB Equivalent tokenB at the current reserve ratio.
    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB)
        public pure returns (uint256 amountB)
    {
        require(amountA > 0 && reserveA > 0 && reserveB > 0);
        amountB = (amountA * reserveB) / reserveA;
    }

    /// @notice Compute the output of a swap given an exact input, after the
    ///         0.3% LP fee is deducted (997/1000 fee model).
    /// @param amountIn   Exact token amount being sold.
    /// @param reserveIn  Pool reserve of the input token before the swap.
    /// @param reserveOut Pool reserve of the output token before the swap.
    /// @return amountOut Maximum tokens receivable for `amountIn`.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256 amountOut)
    {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0);
        uint256 amountInWithFee = amountIn * 997;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    /// @notice Compute the input required to receive an exact output, after the
    ///         0.3% LP fee is added (rounds up by 1 to ensure the invariant holds).
    /// @param amountOut  Exact token amount to receive.
    /// @param reserveIn  Pool reserve of the input token before the swap.
    /// @param reserveOut Pool reserve of the output token before the swap.
    /// @return amountIn Minimum tokens that must be sold to receive `amountOut`.
    function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256 amountIn)
    {
        require(amountOut > 0 && reserveIn > 0 && reserveOut > 0 && amountOut < reserveOut);
        amountIn = (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    /// @notice Simulate a multi-hop swap through `path` and return the output
    ///         at each step. Each consecutive pair in `path` must have a pool.
    /// @param amountIn Exact amount of `path[0]` to sell.
    /// @param path     Ordered token addresses; each adjacent pair is one hop.
    /// @return amounts Output amounts at each step, where amounts[0] == amountIn
    ///                 and amounts[path.length - 1] is the final output.
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

    /// @notice Simulate a multi-hop swap in reverse: given a desired final
    ///         output, return the required input at each step.
    /// @param amountOut Exact amount of `path[path.length - 1]` to receive.
    /// @param path      Ordered token addresses; each adjacent pair is one hop.
    /// @return amounts  Required input amounts at each step, where
    ///                  amounts[path.length - 1] == amountOut and
    ///                  amounts[0] is the required input of `path[0]`.
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

    /// @notice Deposit tokenA and tokenB into their shared pool, receiving LP
    ///         tokens in return. Creates the pool if it does not yet exist.
    ///         The router deposits at the current reserve ratio; any excess
    ///         above the optimal amount is not transferred.
    /// @param tokenA        Address of the first token.
    /// @param tokenB        Address of the second token.
    /// @param amountADesired Maximum tokenA the caller is willing to deposit.
    /// @param amountBDesired Maximum tokenB the caller is willing to deposit.
    /// @param amountAMin    Minimum tokenA that must be deposited (slippage guard).
    /// @param amountBMin    Minimum tokenB that must be deposited (slippage guard).
    /// @param to            Recipient of the minted LP tokens.
    /// @param deadline      Unix timestamp after which the transaction reverts.
    /// @return amountA   Actual tokenA deposited.
    /// @return amountB   Actual tokenB deposited.
    /// @return liquidity LP tokens minted to `to`.
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

    /// @notice Burn LP tokens and withdraw the underlying tokenA and tokenB
    ///         from the pool at the current reserve ratio.
    /// @param tokenA    Address of the first token.
    /// @param tokenB    Address of the second token.
    /// @param liquidity Amount of LP tokens to burn.
    /// @param amountAMin Minimum tokenA the caller must receive (slippage guard).
    /// @param amountBMin Minimum tokenB the caller must receive (slippage guard).
    /// @param to        Recipient of the withdrawn tokens.
    /// @param deadline  Unix timestamp after which the transaction reverts.
    /// @return amountA tokenA returned to `to`.
    /// @return amountB tokenB returned to `to`.
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

        IERC20(pair).transferFrom(msg.sender, pair, liquidity);
        (uint256 amount0, uint256 amount1) = ISagePair(pair).burn(to);

        (address token0,) = _sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);

        if (amountA < amountAMin) revert InsufficientAAmount();
        if (amountB < amountBMin) revert InsufficientBAmount();
    }

    // ─── Swaps ────────────────────────────────────────────────────

    /// @notice Sell an exact `amountIn` of `path[0]` tokens, routing through
    ///         each pool in `path`, and deliver at least `amountOutMin` of
    ///         `path[path.length - 1]` to `to`.
    /// @param amountIn     Exact amount of the input token to sell.
    /// @param amountOutMin Minimum acceptable output (reverts if not met).
    /// @param path         Ordered token addresses defining the swap route.
    /// @param to           Recipient of the output tokens.
    /// @param deadline     Unix timestamp after which the transaction reverts.
    /// @return amounts     Input and output at each hop (amounts[0] == amountIn).
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

    /// @notice Buy an exact `amountOut` of `path[path.length - 1]` tokens,
    ///         spending at most `amountInMax` of `path[0]`.
    /// @param amountOut    Exact amount of the output token to receive.
    /// @param amountInMax  Maximum input the caller is willing to spend (reverts if exceeded).
    /// @param path         Ordered token addresses defining the swap route.
    /// @param to           Recipient of the output tokens.
    /// @param deadline     Unix timestamp after which the transaction reverts.
    /// @return amounts     Input and output at each hop (amounts[path.length-1] == amountOut).
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

    // ─── Internal ─────────────────────────────────────────────────

    /// @dev Execute the swap calls across each hop in `path`.
    ///      For a single-hop swap the output goes directly to `to`.
    ///      For multi-hop swaps intermediate output is forwarded to the
    ///      next pair in the path rather than to the caller.
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

    /// @dev Calculate the optimal tokenA/tokenB deposit amounts at the
    ///      current reserve ratio, respecting the caller's desired and
    ///      minimum amounts. Returns desired amounts unchanged for new pools.
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

    /// @dev Return reserves ordered to match the caller's (tokenA, tokenB) view
    ///      regardless of how the pair sorted them internally.
    function _getReservesOrdered(address tokenA, address tokenB)
        internal view returns (uint256 reserveA, uint256 reserveB)
    {
        address pair = _getPairOrRevert(tokenA, tokenB);
        (uint112 r0, uint112 r1,) = ISagePair(pair).getReserves();
        (address token0,) = _sortTokens(tokenA, tokenB);
        (reserveA, reserveB) = tokenA == token0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @dev Look up the pair address from the factory and revert if it does not exist.
    function _getPairOrRevert(address tokenA, address tokenB) internal view returns (address pair) {
        pair = ISageFactory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound();
    }

    /// @dev Sort two token addresses in ascending order (canonical pair key).
    function _sortTokens(address tokenA, address tokenB)
        internal pure returns (address token0, address token1)
    {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
