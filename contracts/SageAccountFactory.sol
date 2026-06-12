// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SageAccount.sol";

/// @title  SageAccountFactory
/// @notice Deploys and indexes SageAccount smart wallets for SAGE users on
///         Robinhood Chain. One account per userId — the server derives the
///         userId as keccak256 of the user's WhatsApp jid, so the on-chain
///         registry never exposes phone numbers.
///
///         Standard config (router, USDG, tradable stock tokens, default cap)
///         is fixed at factory deployment so every account starts with the
///         same on-chain guard rails.

contract SageAccountFactory {

    // ─── State ────────────────────────────────────────────────────

    /// @notice SageRouter baked into every account.
    address public immutable router;

    /// @notice USDG token baked into every account.
    address public immutable USDG;

    /// @notice Default 24h trading cap (USDG raw units) for new accounts.
    uint256 public immutable defaultDailyCap;

    /// @notice Stock tokens enabled on every new account.
    address[] public defaultTokens;

    /// @notice userId (keccak256 of WhatsApp jid) → account address.
    mapping(bytes32 => address) public accountOf;

    /// @notice All accounts ever created, in creation order.
    address[] public allAccounts;

    // ─── Events ───────────────────────────────────────────────────

    event AccountCreated(bytes32 indexed userId, address indexed account, address owner, address sessionKey);

    // ─── Errors ───────────────────────────────────────────────────

    error ZeroAddress();
    error AccountExists();

    // ─── Constructor ──────────────────────────────────────────────

    /// @param _router          SageRouter address.
    /// @param _usdg            USDG token address.
    /// @param _tokens          Stock tokens tradable on every account.
    /// @param _defaultDailyCap Default 24h cap in USDG raw units (6 decimals).
    constructor(
        address _router,
        address _usdg,
        address[] memory _tokens,
        uint256 _defaultDailyCap
    ) {
        if (_router == address(0) || _usdg == address(0)) revert ZeroAddress();
        router          = _router;
        USDG            = _usdg;
        defaultTokens   = _tokens;
        defaultDailyCap = _defaultDailyCap;
    }

    // ─── Account creation ─────────────────────────────────────────

    /// @notice Deploy a SageAccount for a user. Permissionless — the account's
    ///         own role checks are what protect funds, not who deployed it.
    /// @param userId     keccak256 of the user's WhatsApp jid.
    /// @param owner      Initial owner (SAGE server pre-claim, user key post-claim).
    /// @param sessionKey SAGE server trading key.
    /// @return account   Address of the new SageAccount.
    function createAccount(
        bytes32 userId,
        address owner,
        address sessionKey
    ) external returns (address account) {
        if (accountOf[userId] != address(0)) revert AccountExists();

        account = address(new SageAccount(
            owner,
            sessionKey,
            router,
            USDG,
            defaultTokens,
            defaultDailyCap
        ));

        accountOf[userId] = account;
        allAccounts.push(account);

        emit AccountCreated(userId, account, owner, sessionKey);
    }

    // ─── Views ────────────────────────────────────────────────────

    /// @notice Total number of accounts created.
    function accountCount() external view returns (uint256) {
        return allAccounts.length;
    }

    /// @notice Number of stock tokens in the default config.
    function defaultTokenCount() external view returns (uint256) {
        return defaultTokens.length;
    }
}
