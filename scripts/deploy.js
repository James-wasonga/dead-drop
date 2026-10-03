// Deploys DeadDrop with real Paxos USDG (where it exists) and, on test networks, a faucet token "tUSDG"
// so anyone can play instantly. Writes frontend/src/deployments.json for the UI.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;

// Paxos-published USDG addresses (docs.paxos.com: "USDG on Main Networks" / "USDG on Test Networks"). 6 decimals.
const USDG = {
  42161: "0x004B506865409877C9fA29bfb1ebA929984B9bbC", // Arbitrum One
  4663: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", // Robinhood Chain
  421614: "0xFFC95faa3d63Cde504a05B567C600B78C0b41892", // Arbitrum Sepolia
  46630: "0x7E955252E15c84f5768B83c41a71F9eba181802F", // Robinhood Chain testnet
};
const NET = {
  31337: { name: "Local", rpc: "http://127.0.0.1:8545", explorer: "", testnet: true },
  421614: { name: "Arbitrum Sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io", testnet: true },
  46630: { name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com/rpc", explorer: "https://explorer.testnet.chain.robinhood.com", testnet: true },
  42161: { name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", testnet: false },
  4663: { name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com", testnet: false },
};
const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Did you set PRIVATE_KEY in .env?");
  const id = Number((await ethers.provider.getNetwork()).chainId);
  const net = NET[id] || { name: `Chain ${id}`, rpc: "", explorer: "", testnet: true };
  console.log(`Deploying to ${net.name} (${id}) as ${deployer.address}`);

  const tokens = [];

  // 1) real Paxos USDG, if it exists on this chain and looks right
  if (USDG[id] && (await ethers.provider.getCode(USDG[id])) !== "0x") {
    const t = new ethers.Contract(USDG[id], ERC20, ethers.provider);
    const [sym, dec] = await Promise.all([t.symbol(), t.decimals()]);
    if (sym === "USDG" && Number(dec) === 6) {
      tokens.push({ address: USDG[id], symbol: sym, decimals: 6, mock: false });
      console.log("Using real Paxos USDG at", USDG[id]);
    } else {
      console.log(`WARNING: ${USDG[id]} reports ${sym}/${dec}, not USDG/6. Skipping it.`);
    }
  } else if (USDG[id]) {
    console.log("WARNING: no contract at the documented USDG address on this chain. Skipping real USDG.");
  }

  // 2) faucet token on test networks so judges can play without hunting for testnet USDG
  let mock;
  if (net.testnet) {
    mock = await (await ethers.getContractFactory("MockUSDG")).deploy();
    await mock.waitForDeployment();
    tokens.push({ address: await mock.getAddress(), symbol: "tUSDG", decimals: 6, mock: true });
    console.log("Test token tUSDG ", tokens.at(-1).address);
  }
  if (tokens.length === 0) throw new Error("No token available on this network.");

  const game = await (await ethers.getContractFactory("DeadDrop")).deploy(tokens.map((t) => t.address));
  await game.waitForDeployment();
  const gameAddr = await game.getAddress();
  console.log("DeadDrop         ", gameAddr);

  const file = path.join(__dirname, "..", "frontend", "src", "deployments.json");
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  all[id] = { name: net.name, rpc: net.rpc, explorer: net.explorer, game: gameAddr, tokens };
  all.default = id;
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  console.log("Wrote", path.relative(process.cwd(), file));
}

main().catch((e) => { console.error(e); process.exit(1); });
