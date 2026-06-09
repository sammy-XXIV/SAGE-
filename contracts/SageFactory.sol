// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SagePair.sol";

/// @title SageFactory
/// @notice Deploys and tracks all SagePair AMM pools
contract SageFactory {
    address public feeTo;
    address public owner;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 totalPairs);
    event FeeToUpdated(address indexed feeTo);
    event OwnerUpdated(address indexed owner);

    error IdenticalTokens();
    error ZeroAddress();
    error PairExists();
    error Forbidden();

    constructor(address _owner) {
        owner = _owner;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Deploy a new AMM pair for two tokens
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalTokens();

        // Sort tokens so pair address is deterministic regardless of input order
        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        pair = address(new SagePair{salt: salt}(token0, token1, address(this)));

        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    /// @notice Set the address that receives protocol fees
    function setFeeTo(address _feeTo) external {
        if (msg.sender != owner) revert Forbidden();
        feeTo = _feeTo;
        emit FeeToUpdated(_feeTo);
    }

    function setOwner(address _owner) external {
        if (msg.sender != owner) revert Forbidden();
        owner = _owner;
        emit OwnerUpdated(_owner);
    }
}
