// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  SageAccount
/// @notice Per-user smart wallet for SAGE on Robinhood Chain. Holds the user's
///         USDG and tokenized stock balances and enforces the SAGE Risk Guard
///         on-chain instead of trusting the off-chain server.
///
///         Two roles:
///           • sessionKey — SAGE's server key. Can ONLY swap on SageRouter, and
///             every swap output is forced back to this account. Spending is
///             capped per rolling 24h window, denominated in USDG.
///           • owner — the user's key. The only role that can withdraw funds to
///             an external address, rotate the session key, or change limits.
///
///         Security property: a fully compromised SAGE server (session key
///         leaked) can at worst shuffle tokens between USDG and stocks inside
///         this account, within the daily cap. It cannot move funds out —
///         there is no code path for it.
///
///         Progressive decentralization: accounts start with owner == SAGE
///         (custodial, same UX as today). The user claims ownership later via
///         transferOwnership, after which withdrawals require their key.

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ISageRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract SageAccount {

    // ─── State ────────────────────────────────────────────────────

    /// @notice The user's key — sole authority over withdrawals and config.
    address public owner;

    /// @notice SAGE server's trading key — swap-only, capped.
    address public sessionKey;

    /// @notice SageRouter this account is allowed to trade on. Immutable so a
    ///         compromised session key can't be pointed at a malicious router.
    address public immutable router;

    /// @notice USDG token address (6 decimals) — the cap denomination.
    address public immutable USDG;

    /// @notice Tokens the session key is allowed to trade (stock tokens + USDG).
    mapping(address => bool) public allowedToken;

    /// @notice Max USDG volume the session key may trade per 24h window. 0 = trading paused.
    uint256 public dailyCap;

    /// @notice USDG volume traded in the current window.
    uint256 public spentToday;

    /// @notice Timestamp when the current 24h window started.
    uint256 public dayStart;

    /// @dev Reentrancy lock.
    uint256 private _locked = 1;

    // ─── Events ───────────────────────────────────────────────────

    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 usdgVolume);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SessionKeyRotated(address indexed previousKey, address indexed newKey);
    event DailyCapUpdated(uint256 newCap);
    event TokenAllowed(address indexed token, bool allowed);

    // ─── Errors ───────────────────────────────────────────────────

    error Forbidden();
    error ZeroAddress();
    error BadPath();
    error TokenNotAllowed();
    error DailyCapExceeded();
    error Reentrancy();
    error TransferFailed();

    // ─── Modifiers ────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert Forbidden();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ─── Constructor ──────────────────────────────────────────────

    /// @param _owner      Initial owner (SAGE server pre-claim, user post-claim).
    /// @param _sessionKey SAGE server trading key.
    /// @param _router     SageRouter address.
    /// @param _usdg       USDG token address.
    /// @param _tokens     Stock tokens tradable by the session key.
    /// @param _dailyCap   Initial 24h trading cap in USDG raw units (6 decimals).
    constructor(
        address _owner,
        address _sessionKey,
        address _router,
        address _usdg,
        address[] memory _tokens,
        uint256 _dailyCap
    ) {
        if (_owner == address(0) || _sessionKey == address(0) || _router == address(0) || _usdg == address(0)) revert ZeroAddress();
        owner      = _owner;
        sessionKey = _sessionKey;
        router     = _router;
        USDG       = _usdg;
        dailyCap   = _dailyCap;
        dayStart   = block.timestamp;

        allowedToken[_usdg] = true;
        for (uint256 i; i < _tokens.length; ++i) {
            allowedToken[_tokens[i]] = true;
            emit TokenAllowed(_tokens[i], true);
        }
    }

    receive() external payable {}

    // ─── Trading (session key or owner) ───────────────────────────

    /// @notice Swap tokens held by this account on SageRouter. Output is forced
    ///         back to this account — funds can never leave via this function.
    ///         Volume is capped per 24h window, denominated in USDG.
    /// @param amountIn     Exact input amount.
    /// @param amountOutMin Minimum acceptable output (slippage protection).
    /// @param path         Swap path — first and last token must be allowed,
    ///                     and one end must be USDG (every SAGE pair is vs USDG).
    /// @param deadline     Unix deadline passed through to the router.
    /// @return amountOut   Actual output amount received by this account.
    function swap(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != sessionKey && msg.sender != owner) revert Forbidden();
        if (path.length < 2) revert BadPath();

        address tokenIn  = path[0];
        address tokenOut = path[path.length - 1];
        if (!allowedToken[tokenIn] || !allowedToken[tokenOut]) revert TokenNotAllowed();

        if (!IERC20(tokenIn).approve(router, amountIn)) revert TransferFailed();

        uint256[] memory amounts = ISageRouter(router).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this), // hard invariant: output always returns here
            deadline
        );
        amountOut = amounts[amounts.length - 1];

        // Measure trade volume in USDG regardless of direction.
        uint256 usdgVolume;
        if (tokenIn == USDG)       usdgVolume = amountIn;
        else if (tokenOut == USDG) usdgVolume = amountOut;
        else revert BadPath();

        _consumeCap(usdgVolume);

        emit SwapExecuted(tokenIn, tokenOut, amountIn, amountOut, usdgVolume);
    }

    /// @dev Roll the 24h window if elapsed, then consume cap or revert.
    function _consumeCap(uint256 usdgVolume) internal {
        if (block.timestamp >= dayStart + 1 days) {
            dayStart   = block.timestamp;
            spentToday = 0;
        }
        spentToday += usdgVolume;
        if (spentToday > dailyCap) revert DailyCapExceeded();
    }

    // ─── Withdrawals (owner only) ─────────────────────────────────

    /// @notice Withdraw an ERC-20 token to any address. Owner only — the
    ///         session key has no path to this function.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(token, to, amount);
    }

    /// @notice Withdraw native ETH to any address. Owner only.
    function withdrawETH(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(address(0), to, amount);
    }

    // ─── Config (owner only) ──────────────────────────────────────

    /// @notice Claim or transfer ownership. This is the "decentralize yourself"
    ///         step — once the user holds the owner key, SAGE can no longer
    ///         withdraw or reconfigure this account.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Rotate the SAGE trading key (e.g. after a server incident).
    function setSessionKey(address newKey) external onlyOwner {
        if (newKey == address(0)) revert ZeroAddress();
        emit SessionKeyRotated(sessionKey, newKey);
        sessionKey = newKey;
    }

    /// @notice Update the 24h USDG trading cap. 0 pauses trading entirely.
    function setDailyCap(uint256 newCap) external onlyOwner {
        dailyCap = newCap;
        emit DailyCapUpdated(newCap);
    }

    /// @notice Allow or disallow a token for session-key trading.
    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    // ─── Views ────────────────────────────────────────────────────

    /// @notice USDG trading volume still available in the current 24h window.
    function remainingToday() external view returns (uint256) {
        if (block.timestamp >= dayStart + 1 days) return dailyCap;
        return spentToday >= dailyCap ? 0 : dailyCap - spentToday;
    }
}
