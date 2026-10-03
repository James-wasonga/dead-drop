// The secret board. Used by the browser UI, the keeper bot and the tests, so they can never disagree.
import { AbiCoder, ZeroHash, concat, hexlify, keccak256, randomBytes } from "ethers";

export const SIDE = 6;
export const CELLS = 36;
export const DEPTH = 6;
const coder = AbiCoder.defaultAbiCoder();

export const rc = (i) => [Math.floor(i / SIDE), i % SIDE];
export const dist = (a, b) => {
  const [ar, ac] = rc(a), [br, bc] = rc(b);
  return Math.abs(ar - br) + Math.abs(ac - bc);
};

export const leafHash = (i, clue, salt) =>
  keccak256(coder.encode(["uint256", "uint256", "bytes32"], [i, clue, salt]));

const pair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

function levelsOf(board) {
  let cur = [];
  for (let i = 0; i < 64; i++) cur.push(i < CELLS ? leafHash(i, board.clues[i], board.salts[i]) : ZeroHash);
  const levels = [cur];
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(pair(cur[i], cur[i + 1]));
    levels.push(next);
    cur = next;
  }
  return levels;
}

/** Build a fresh board. `treasure` is 0..35; random if omitted. */
export function newBoard(treasure) {
  const t = treasure ?? randomInt(CELLS);
  const clues = Array.from({ length: CELLS }, (_, i) => dist(i, t));
  const salts = Array.from({ length: CELLS }, () => hexlify(randomBytes(32)));
  const board = { treasure: t, clues, salts };
  board.root = levelsOf(board).at(-1)[0];
  return board;
}

/** Rebuild the root from a saved board (used when loading a backup). */
export const rootOf = (board) => levelsOf(board).at(-1)[0];

/** Everything the contract's answer() needs for one cell. */
export function answerFor(board, cell) {
  const levels = levelsOf(board);
  const proof = [];
  let idx = cell;
  for (let l = 0; l < DEPTH; l++) {
    proof.push(levels[l][idx ^ 1]);
    idx >>= 1;
  }
  return { clue: board.clues[cell], salt: board.salts[cell], proof };
}

function randomInt(n) {
  const b = randomBytes(4);
  return (((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0) % n;
}

/** Cells still consistent with every answered dig: the hunter's deduction. */
export function candidates(answeredDigs) {
  const dug = new Set(answeredDigs.map((d) => d.cell));
  const out = [];
  for (let c = 0; c < CELLS; c++) {
    if (dug.has(c)) continue;
    if (answeredDigs.every((d) => dist(c, d.cell) === d.clue)) out.push(c);
  }
  return out;
}
