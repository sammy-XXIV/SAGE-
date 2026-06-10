require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    compilers: [
      { version: "0.5.16" },
      { version: "0.6.6" },
      { version: "0.8.20" },
    ],
  },
  networks: {
    robinhood: {
      url: process.env.RPC_URL || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: [process.env.DEPLOYER_PRIVATE_KEY],
    },
  },
};
