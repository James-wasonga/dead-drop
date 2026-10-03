const { expect } = require("chai");
const hre = require("hardhat");
const path = require("path");
const { pathToFileURL } = require("url");
const { ethers } = hre;

const U = (n) => BigInt(Math.round(n * 1e6));
const advance = async (s) => {
  await hre.network.provider.send("evm_increaseTime", [s]);
  await hre.network.provider.send("evm_mine");
};
async function reverts(p, msg) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err, "expected a revert").to.not.equal(undefined);
  if (msg) expect(String(err.message)).to.contain(msg);
}

describe("DeadDrop", () => {
  let B, usdg, game, hider, h1, h2, h3, keeper, other;
  let gameAddr;
  const PRIZE = U(36), FEE = U(1), RESPOND = 300, DURATION = 3600;

  before(async () => {
    B = await import(pathToFileURL(path.join(__dirname, "..", "frontend", "src", "lib", "board.mjs")).href);
  });

  beforeEach(async () => {
    [hider, h1, h2, h3, keeper, other] = await ethers.getSigners();
    usdg = await (await ethers.getContractFactory("MockUSDG")).deploy();
    game = await (await ethers.getContractFactory("DeadDrop")).deploy([await usdg.getAddress()]);
    gameAddr = await game.getAddress();
    for (const s of [hider, h1, h2, h3, other]) {
      await usdg.connect(s).faucet();
      await usdg.connect(s).approve(gameAddr, ethers.MaxUint256);
    }
  });

  async function create(board, extra = {}) {
    await game.connect(hider).createDrop({
      token: await usdg.getAddress(), root: board.root, prize: PRIZE, fee: FEE,
      respond: RESPOND, duration: DURATION, responder: ethers.ZeroAddress, ...extra,
    });
    return 0;
  }
  async function digAndAnswer(id, board, who, cell) {
    await game.connect(who).dig(id, cell);
    const a = B.answerFor(board, cell);
    await game.connect(hider).answer(id, a.clue, a.salt, a.proof);
  }
  const auditArgs = (b) => [b.clues, b.salts];

  it("locks prize + 50% bond and seals the board", async () => {
    const board = B.newBoard(14);
    await create(board);
    const d = await game.getDrop(0);
    expect(d.prize).to.equal(PRIZE);
    expect(d.bond).to.equal(PRIZE / 2n);
    expect(await usdg.balanceOf(gameAddr)).to.equal(PRIZE + PRIZE / 2n);
  });

  it("honest hunt: clues triangulate, finder gets prize + tips, hider keeps fees and gets bond back", async () => {
    const board = B.newBoard(14); // row 2, col 2
    await create(board);
    await game.connect(other).tip(0, U(10));
    const hiderStart = await usdg.balanceOf(hider.address);

    await digAndAnswer(0, board, h1, 0);
    const first = (await game.getDigs(0))[0];
    expect(Number(first.clue)).to.equal(B.dist(0, 14));
    const d1 = (await game.getDigs(0)).map((x) => ({ cell: Number(x.cell), clue: Number(x.clue) }));
    expect(B.candidates(d1)).to.include(14);

    const h2Start = await usdg.balanceOf(h2.address);
    await digAndAnswer(0, board, h2, 14); // treasure
    expect((await game.getDrop(0)).status).to.equal(1n); // Found
    expect(await usdg.balanceOf(h2.address)).to.equal(h2Start - FEE + PRIZE + U(10));

    await game.connect(hider).audit(0, ...auditArgs(board));
    expect((await game.getDrop(0)).status).to.equal(4n); // Audited
    // hider: received 2 fees, got the bond back, prize went to the finder
    expect(await usdg.balanceOf(hider.address)).to.equal(hiderStart + 2n * FEE + PRIZE / 2n);
    expect(await usdg.balanceOf(gameAddr)).to.equal(0n);
  });

  it("the board cannot change: a wrong clue or salt fails the proof", async () => {
    const board = B.newBoard(20);
    await create(board);
    await game.connect(h1).dig(0, 3);
    const a = B.answerFor(board, 3);
    await reverts(game.connect(hider).answer(0, a.clue + 1, a.salt, a.proof), "bad proof");
    await reverts(game.connect(hider).answer(0, a.clue, ethers.hexlify(ethers.randomBytes(32)), a.proof), "bad proof");
    await game.connect(hider).answer(0, a.clue, a.salt, a.proof); // the truth works
  });

  it("silent hider forfeits prize + tips + bond to the hunter", async () => {
    const board = B.newBoard(5);
    await create(board);
    await game.connect(other).tip(0, U(4));
    await game.connect(h1).dig(0, 9);
    await reverts(game.claimTimeout(0), "still time");
    await advance(RESPOND + 1);
    const before = await usdg.balanceOf(h1.address);
    await game.claimTimeout(0);
    expect(await usdg.balanceOf(h1.address)).to.equal(before + PRIZE + U(4) + PRIZE / 2n + FEE);
    expect((await game.getDrop(0)).status).to.equal(3n); // Forfeited
  });

  it("nobody finds it: honest hider gets prize + bond back, tippers are refunded", async () => {
    const board = B.newBoard(30);
    await create(board);
    await game.connect(other).tip(0, U(7));
    const otherBefore = await usdg.balanceOf(other.address);
    await digAndAnswer(0, board, h1, 1);
    await reverts(game.expire(0), "still running");
    await advance(DURATION + 1);
    await game.expire(0);
    await game.connect(hider).audit(0, ...auditArgs(board));
    expect(await usdg.balanceOf(other.address)).to.equal(otherBefore + U(7));
    expect(await usdg.balanceOf(gameAddr)).to.equal(0n);
  });

  it("CHEAT: a board with no treasure can't pass the audit, and the hunters are paid at least their fees back", async () => {
    const good = B.newBoard(10);
    const bad = { ...good, clues: good.clues.map((c) => (c === 0 ? 1 : c)) }; // treasure erased
    bad.root = B.rootOf(bad);
    await create(bad);
    const starts = [await usdg.balanceOf(h1.address), await usdg.balanceOf(h2.address)];
    await digAndAnswer(0, bad, h1, 0);
    await digAndAnswer(0, bad, h2, 1);
    await advance(DURATION + 1);
    await game.expire(0);
    await reverts(game.connect(hider).audit(0, ...auditArgs(bad)), "no treasure");
    await reverts(game.slash(0), "audit window open");
    await advance(601);
    await game.slash(0);
    expect((await game.getDrop(0)).status).to.equal(5n); // Slashed
    const pool = PRIZE + PRIZE / 2n;
    expect(await usdg.balanceOf(h1.address)).to.equal(starts[0] - FEE + pool / 2n);
    expect((await usdg.balanceOf(h2.address)) > starts[1] - FEE).to.equal(true); // made whole, and then some
    expect(await usdg.balanceOf(gameAddr)).to.equal(0n);
  });

  it("CHEAT: lying about one clue is caught by the audit and the bond is slashed to the hunters", async () => {
    const board = B.newBoard(22);
    const liar = { ...board, clues: board.clues.slice() };
    liar.clues[5] = board.clues[5] + 2; // wrong but internally "sealed"
    liar.root = B.rootOf(liar);
    await create(liar);
    await digAndAnswer(0, liar, h1, 5); // the lie is accepted at dig time (proof matches the seal)...
    await digAndAnswer(0, liar, h2, 22); // ...someone still finds the treasure
    await reverts(game.connect(hider).audit(0, ...auditArgs(liar)), "bad clue");
    await advance(601);
    const h1Before = await usdg.balanceOf(h1.address);
    await game.slash(0);
    expect(await usdg.balanceOf(h1.address)).to.equal(h1Before + PRIZE / 2n / 2n);
  });

  it("a hider who vanishes after the hunt gets slashed by anyone", async () => {
    const board = B.newBoard(8);
    await create(board);
    await digAndAnswer(0, board, h1, 8);
    await reverts(game.connect(other).slash(0), "audit window open");
    await advance(601);
    await game.connect(other).slash(0);
    expect((await game.getDrop(0)).status).to.equal(5n);
  });

  it("a delegated keeper can answer; strangers can't", async () => {
    const board = B.newBoard(33);
    await create(board, { responder: keeper.address });
    await game.connect(h1).dig(0, 2);
    const a = B.answerFor(board, 2);
    await reverts(game.connect(other).answer(0, a.clue, a.salt, a.proof), "not hider");
    await game.connect(keeper).answer(0, a.clue, a.salt, a.proof);
    expect(Number((await game.getDigs(0))[0].clue)).to.equal(B.dist(2, 33));
  });

  it("rules: one pending dig, no double dig, hider can't dig, bad inputs rejected, cancel works", async () => {
    const board = B.newBoard(1);
    await create(board);
    await reverts(game.connect(hider).dig(0, 4), "hider can't dig");
    await game.connect(h1).dig(0, 4);
    await reverts(game.connect(h2).dig(0, 5), "dig pending");
    const a = B.answerFor(board, 4);
    await game.connect(hider).answer(0, a.clue, a.salt, a.proof);
    await reverts(game.connect(h2).dig(0, 4), "already dug");
    await reverts(game.connect(h2).dig(0, 99), "bad cell");
    await reverts(game.connect(hider).cancel(0), "can't cancel");

    const t = await usdg.getAddress();
    const base = { token: t, root: board.root, prize: PRIZE, fee: FEE, respond: RESPOND, duration: DURATION, responder: ethers.ZeroAddress };
    await reverts(game.connect(hider).createDrop({ ...base, fee: U(2) }), "fee too high");
    await reverts(game.connect(hider).createDrop({ ...base, token: other.address }), "token not allowed");
    await reverts(game.connect(hider).createDrop({ ...base, respond: 5 }), "bad respond");

    const before = await usdg.balanceOf(hider.address);
    await game.connect(hider).createDrop(base);
    await game.connect(hider).cancel(1);
    expect(await usdg.balanceOf(hider.address)).to.equal(before);
  });

  it("digging all 36 cells makes the hunt closable early", async () => {
    const board = B.newBoard(35);
    await create(board);
    for (let c = 0; c < 35; c++) await digAndAnswer(0, board, [h1, h2, h3][c % 3], c);
    await digAndAnswer(0, board, h1, 35);
    expect((await game.getDrop(0)).status).to.equal(1n);
  });
});
