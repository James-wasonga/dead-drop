import { Wallet, formatUnits } from "ethers";

export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const fmt = (v, dec = 6) => Number(formatUnits(v, dec)).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const cellName = (i) => "ABCDEF"[i % 6] + (Math.floor(i / 6) + 1);
export const heat = (clue) => (clue === 0 ? "#ffd166" : `hsl(${Math.round((Math.min(clue, 8) / 8) * 205)}deg 88% 58%)`);

export function clock(s) {
  if (s <= 0) return "0:00";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Turns ethers/MetaMask errors into something a person can act on.
const FRIENDLY = {
  ERC20InsufficientAllowance: "The token allowance is too low. Please try again.",
  ERC20InsufficientBalance: "You don't have enough of this token.",
};
export function reason(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001 || e?.code === 4001) return "You rejected the request in your wallet.";
  const name = e?.revert?.name;
  if (name && FRIENDLY[name]) return FRIENDLY[name];
  const nested = e?.info?.error?.data?.message || e?.info?.error?.message || e?.error?.message || e?.data?.message || e?.cause?.message || "";
  const generic = /could not coalesce|unknown custom error|missing revert data/i;
  let m = e?.reason;
  if (!m && e?.shortMessage && !generic.test(e.shortMessage)) m = e.shortMessage;
  if (!m && nested) m = nested;
  if (!m) m = e?.shortMessage || e?.message || "Something went wrong";
  if (/insufficient funds|gas \* price|exceeds the balance|insufficient balance for transfer/i.test(`${m} ${nested}`))
    return "Not enough ETH for gas on this network. Get testnet ETH for this network, then retry.";
  return m.replace("execution reverted: ", "").slice(0, 170);
}

// ---- secret boards live in this browser only (plus the backup file the hider downloads) ----
const bKey = (chainId, game, root) => `deaddrop:board:${chainId}:${game.toLowerCase()}:${root}`;
export const saveBoard = (chainId, game, board) => localStorage.setItem(bKey(chainId, game, board.root), JSON.stringify(board));
export function loadBoard(chainId, game, root) {
  try { return JSON.parse(localStorage.getItem(bKey(chainId, game, root))); } catch { return null; }
}
export function downloadJson(name, obj) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- autopilot: ONE throwaway key per browser, reused for all your hunts (fuel it once) ----
const PILOT = "deaddrop:pilot";
const pKey = (root) => `deaddrop:pilot:${root}`;
// hunts made before this change stored a key per hunt; those still work
export const getPilot = (root) => (root && localStorage.getItem(pKey(root))) || localStorage.getItem(PILOT);
export function ensurePilot() {
  const k = localStorage.getItem(PILOT);
  if (k) return new Wallet(k);
  const w = Wallet.createRandom();
  localStorage.setItem(PILOT, w.privateKey);
  return w;
}