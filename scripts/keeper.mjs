// Keeper bot: answers digs for a hunt while you're offline, then closes it and proves the board is honest.
// Usage:  node scripts/keeper.mjs --drop 3 --board board-3.json [--chain 421614]
// The key in .env (PRIVATE_KEY) must be the hider's key, or the "responder" key set on the drop
// (a responder can answer digs but cannot audit; the audit needs the hider key).
import "dotenv/config";
import fs from "fs";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { GAME_ABI } from "../frontend/src/abi.mjs";
import { answerFor } from "../frontend/src/lib/board.mjs";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > -1 ? process.argv[i + 1] : d; };
const deployments = JSON.parse(fs.readFileSync(new URL("../frontend/src/deployments.json", import.meta.url)));
const chain = arg("chain", deployments.default);
const dep = deployments[chain];
const dropId = Number(arg("drop"));
const board = JSON.parse(fs.readFileSync(arg("board"), "utf8"));
if (!dep || Number.isNaN(dropId) || !board.salts) { console.error("Usage: node scripts/keeper.mjs --drop <id> --board <file.json> [--chain <id>]"); process.exit(1); }

const provider = new JsonRpcProvider(dep.rpc);
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const game = new Contract(dep.game, GAME_ABI, wallet);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log(`Keeper online for drop #${dropId} on ${dep.name} as ${wallet.address}`);

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const d = await game.getDrop(dropId);
    const status = Number(d.status);
    const digs = await game.getDigs(dropId);
    const last = digs.at(-1);
    const now = Math.floor(Date.now() / 1000);
    if (status === 0 && last && Number(last.state) === 0) {
      const a = answerFor(board, Number(last.cell));
      log(`Answering dig on cell ${last.cell}: clue ${a.clue}`);
      await (await game.answer(dropId, a.clue, a.salt, a.proof)).wait();
    } else if (status === 0 && (now > Number(d.endTime) || digs.length === 36)) {
      log("Hunt over, closing it");
      await (await game.expire(dropId)).wait();
    } else if (status === 1 || status === 2) {
      log("Proving the board is honest (audit)");
      await (await game.audit(dropId, board.clues, board.salts)).wait();
      log("Audit passed. Bond returned. Done.");
      process.exit(0);
    } else if (status >= 3) {
      log("Drop is finished (status " + status + "). Nothing to do.");
      process.exit(0);
    }
  } catch (e) {
    log("Retrying:", (e.shortMessage || e.message || "").slice(0, 120));
  }
  busy = false;
}
setInterval(tick, 2500);
tick();
