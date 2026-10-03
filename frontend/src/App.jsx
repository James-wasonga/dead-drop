import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, MaxUint256, Wallet, parseEther, parseUnits, ZeroAddress } from "ethers";
import deployments from "./deployments.json";
import { ERC20_ABI, GAME_ABI, STATUS } from "./abi.mjs";
import { answerFor, candidates, newBoard, rootOf } from "./lib/board.mjs";
import { clock, downloadJson, fmt, getPilot, heat, loadBoard, newPilot, reason, same, saveBoard, short } from "./util.js";
import Board from "./Board.jsx";
import Create from "./Create.jsx";
import Practice from "./Practice.jsx";

const CHAINS = {
  421614: { chainId: "0x66eee", chainName: "Arbitrum Sepolia", rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.arbiscan.io"] },
  46630: { chainId: "0xb626", chainName: "Robinhood Chain Testnet", rpcUrls: ["https://rpc.testnet.chain.robinhood.com/rpc"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com"] },
  42161: { chainId: "0xa4b1", chainName: "Arbitrum One", rpcUrls: ["https://arb1.arbitrum.io/rpc"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://arbiscan.io"] },
  31337: { chainId: "0x7a69", chainName: "Local Hardhat", rpcUrls: ["http://127.0.0.1:8545"], nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 } },
};
const DEPLOYED = Object.keys(deployments).filter((k) => k !== "default").map(Number);
// open on Arbitrum Sepolia first (it is the Arbitrum testnet), then Robinhood
const DEFAULT_CHAIN = [421614, 46630, 42161, 4663, 31337].find((id) => deployments[id]) ?? deployments.default;
const FUEL = "0.0005"; // ETH sent to the autopilot key for gas
const MIN_FUEL = parseEther("0.00002");
const CHIP = { Open: "live", Found: "gold", Expired: "", Forfeited: "bad", Audited: "ok", Slashed: "bad", Cancelled: "" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends a transaction with a gas limit estimated on OUR rpc (not the wallet's), which gives a readable
// revert reason when something is wrong and avoids wallet-side estimation failures.
async function sendTx(contract, rp, from, method, ...args) {
  const gas = await contract.connect(rp)[method].estimateGas(...args, { from });
  const tx = await contract[method](...args, { gasLimit: (gas * 13n) / 10n + 30000n });
  return tx.wait();
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [walletChain, setWalletChain] = useState(null);
  const [viewChain, setViewChain] = useState(DEFAULT_CHAIN);
  const [data, setData] = useState({ drops: [], tokens: [], eth: undefined });
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [sel, setSel] = useState(null);
  const [cell, setCell] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showPractice, setShowPractice] = useState(false);
  const [assist, setAssist] = useState(true);
  const [auto, setAuto] = useState(true);
  const [tipAmt, setTipAmt] = useState("5");
  const inflight = useRef(new Set());
  const loading = useRef(false);
  const roomRef = useRef(null);
  const pick = (id) => { setSel(id); setTimeout(() => roomRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };

  const chainId = account && deployments[walletChain] ? walletChain : viewChain;
  const dep = deployments[chainId];
  const wrongChain = account && walletChain && !deployments[walletChain];

  const toast = useCallback((text, kind = "", key = null) => {
    const id = Math.random();
    setToasts((t) => [...t.filter((x) => !key || x.key !== key), { id, text, kind, key }].slice(-4));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);
  // reads go through VITE_RPC_<chainId> if you set one (e.g. an Alchemy URL), else the public RPC
  const rpcUrl = dep ? import.meta.env[`VITE_RPC_${chainId}`] || dep.rpc : null;
  const rp = useMemo(() => (rpcUrl ? new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true }) : null), [rpcUrl, chainId]);

  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);

  // ---------- wallet ----------
  const connect = async () => {
    if (!window.ethereum) return toast("No wallet found. Install MetaMask or Rabby to play, or try the practice round.", "err");
    try {
      const a = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(a[0]);
      setWalletChain(Number(await window.ethereum.request({ method: "eth_chainId" })));
    } catch (e) { toast(reason(e), "err"); }
  };
  useEffect(() => {
    if (!window.ethereum) return;
    window.ethereum.request({ method: "eth_accounts" }).then(async (a) => {
      if (a[0]) { setAccount(a[0]); setWalletChain(Number(await window.ethereum.request({ method: "eth_chainId" }))); }
    }).catch(() => {});
    const onA = (a) => setAccount(a[0] || null), onC = (c) => setWalletChain(Number(c));
    window.ethereum.on?.("accountsChanged", onA);
    window.ethereum.on?.("chainChanged", onC);
    return () => { window.ethereum.removeListener?.("accountsChanged", onA); window.ethereum.removeListener?.("chainChanged", onC); };
  }, []);
  const switchChain = async (id) => {
    try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAINS[id].chainId }] }); }
    catch (e) {
      if (e.code === 4902 || e?.data?.originalError?.code === 4902) await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CHAINS[id]] });
      else toast(reason(e), "err");
    }
  };
  const changeNet = (id) => { setViewChain(id); setSel(null); if (account && window.ethereum) switchChain(id); };

  // ---------- chain data ----------
  const load = useCallback(async () => {
    if (!dep || !rp || loading.current) return;
    loading.current = true;
    try {
      const game = new Contract(dep.game, GAME_ABI, rp);
      const tokens = await Promise.all(dep.tokens.map(async (t) => {
        const c = new Contract(t.address, ERC20_ABI, rp);
        const [balance, allowance] = account ? await Promise.all([c.balanceOf(account), c.allowance(account, dep.game)]) : [0n, 0n];
        return { ...t, balance, allowance };
      }));
      const n = Number(await game.dropCount());
      const ids = Array.from({ length: Math.min(n, 24) }, (_, k) => n - 1 - k);
      const drops = await Promise.all(ids.map(async (id) => {
        const [d, digs] = await Promise.all([game.getDrop(id), game.getDigs(id)]);
        return {
          id,
          token: d.token, hider: d.hider, winner: d.winner, root: d.root,
          prize: d.prize, bond: d.bond, tips: d.tips, fee: d.fee,
          respond: Number(d.respond), endTime: Number(d.endTime), auditBy: Number(d.auditBy), status: Number(d.status),
          digs: digs.map((x) => ({ seeker: x.seeker, cell: Number(x.cell), clue: Number(x.clue), state: Number(x.state), when: Number(x.when) })),
        };
      }));
      const eth = account ? await rp.getBalance(account) : undefined;
      setData({ drops, tokens, eth });
    } catch (e) { console.error(e); }
    loading.current = false;
  }, [dep, rp, account]);
  useEffect(() => { setData({ drops: [], tokens: [], eth: undefined }); load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const drop = data.drops.find((d) => d.id === sel) || null;
  useEffect(() => { if (sel === null && data.drops.length) setSel(data.drops[0].id); }, [data.drops, sel]);
  useEffect(() => setCell(null), [sel]);
  useEffect(() => { if (cell !== null && drop?.digs.some((d) => d.cell === cell)) setCell(null); }, [drop?.digs.length]); // eslint-disable-line

  const tokenOf = (d) => data.tokens.find((t) => same(t.address, d.token));
  const mainSigner = async () => new BrowserProvider(window.ethereum).getSigner();

  // ---------- transactions ----------
  // fn(send, gameWithSigner, signer): `send(contract, "method", ...args)` sends + waits.
  const run = async (label, fn, { token, need = 0n } = {}) => {
    if (!account) return toast("Connect your wallet first.", "err");
    if (walletChain !== chainId) return toast(`Switch your wallet to ${dep.name}.`, "err");
    if (data.eth !== undefined && data.eth < parseEther("0.00003")) {
      return toast(`This wallet has almost no ETH on ${dep.name}, so it can't pay gas. Get testnet ETH for ${dep.name} and retry.`, "err");
    }
    setBusy(true);
    try {
      const signer = await mainSigner();
      const send = (c, m, ...a) => sendTx(c, rp, account, m, ...a);
      if (token && need > 0n) {
        const reader = new Contract(token.address, ERC20_ABI, rp);
        if ((await reader.allowance(account, dep.game)) < need) {
          toast(`Step 1 of 2: allow Dead Drop to use your ${token.symbol}.`, "", label);
          await send(new Contract(token.address, ERC20_ABI, signer), "approve", dep.game, MaxUint256);
          for (let i = 0; i < 25; i++) { // wait until our RPC can see the approval
            if ((await reader.allowance(account, dep.game)) >= need) break;
            await sleep(1000);
          }
        }
      }
      toast(`${label}: confirm in your wallet…`, "", label);
      const out = await fn(send, new Contract(dep.game, GAME_ABI, signer), signer);
      toast(`${label}: done.`, "ok", label);
      await load();
      return out ?? true;
    } catch (e) { console.error(label, e); toast(`${label} failed: ${reason(e)}`, "err", label); }
    finally { setBusy(false); }
  };

  const faucet = (t) => run(`Get ${t.symbol}`, (send, _g, s) => send(new Contract(t.address, ERC20_ABI, s), "faucet"));

  const createDrop = async (o) => {
    if (o.pilot && data.eth !== undefined && data.eth < parseEther("0.0008")) {
      return toast(`Autopilot needs about 0.0008 ETH on ${dep.name} (fuel + gas). Get some from the faucet, or create the hunt without Autopilot.`, "err");
    }
    const board = newBoard(o.treasure);
    saveBoard(chainId, dep.game, board);
    if (o.backup) downloadJson(`dead-drop-board-${board.root.slice(2, 10)}.json`, board);
    let pilot = null;
    if (o.pilot) pilot = newPilot(board.root);
    const prize = parseUnits(String(o.prize), o.token.decimals);
    const params = { token: o.token.address, root: board.root, prize, fee: parseUnits(String(o.fee), o.token.decimals), respond: o.respond, duration: o.duration, responder: pilot ? pilot.address : ZeroAddress };
    const ok = await run("Bury treasure", (send, g) => send(g, "createDrop", params), { token: o.token, need: prize + prize / 2n });
    if (!ok) return;
    if (pilot) await run("Fuel the autopilot", async (_s, _g, s) => (await s.sendTransaction({ to: pilot.address, value: parseEther(FUEL) })).wait());
    await load();
    setSel(null);
    setTimeout(() => roomRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    toast("Treasure buried. Keep this tab open so the autopilot can answer digs.", "ok");
  };

  const refuel = (d) => run("Refuel autopilot", async (_s, _g, s) => { const k = getPilot(d.root); await (await s.sendTransaction({ to: new Wallet(k).address, value: parseEther(FUEL) })).wait(); });

  // ---------- hider automation: answer digs, close the hunt, audit ----------
  useEffect(() => {
    if (!auto || !dep || !rp || !account) return;
    for (const d of data.drops) {
      if (!same(d.hider, account)) continue;
      const board = loadBoard(chainId, dep.game, d.root);
      if (!board) continue;
      const last = d.digs.at(-1);
      const answered = d.digs.filter((x) => x.state === 1).length;
      const guard = (key, fn) => {
        if (inflight.current.has(key)) return;
        inflight.current.add(key);
        fn().catch((e) => { console.error(key, e); toast(`Auto-${key.split(":")[0]} failed: ${reason(e)}`, "err"); setTimeout(() => inflight.current.delete(key), 8000); });
      };
      if (d.status === 0 && last && last.state === 0 && now <= last.when + d.respond) {
        guard(`answer:${d.id}:${d.digs.length}`, async () => {
          const a = answerFor(board, last.cell);
          const pk = getPilot(d.root);
          let signer = null;
          if (pk) { const w = new Wallet(pk, rp); if ((await rp.getBalance(w.address)) > MIN_FUEL) signer = w; }
          if (!signer) { toast("Autopilot is out of fuel; confirm this answer in your wallet.", ""); signer = await mainSigner(); }
          const from = await signer.getAddress();
          await sendTx(new Contract(dep.game, GAME_ABI, signer), rp, from, "answer", d.id, a.clue, a.salt, a.proof);
          toast(`Answered the dig on cell ${"ABCDEF"[last.cell % 6]}${Math.floor(last.cell / 6) + 1}.`, "ok");
          load();
        });
      } else if (d.status === 0 && (!last || last.state !== 0) && (now > d.endTime || answered === 36)) {
        guard(`close:${d.id}`, async () => { await sendTx(new Contract(dep.game, GAME_ABI, await mainSigner()), rp, account, "expire", d.id); load(); });
      } else if (d.status === 1 || d.status === 2) {
        guard(`audit:${d.id}`, async () => {
          await sendTx(new Contract(dep.game, GAME_ABI, await mainSigner()), rp, account, "audit", d.id, board.clues, board.salts);
          toast("Audit passed: your board was honest. Bond returned.", "ok");
          load();
        });
      }
    }
  }, [data.drops, now, auto, account]); // eslint-disable-line

  // ---------- derived ----------
  const dugAnswered = drop ? drop.digs.filter((d) => d.state === 1) : [];
  const cands = useMemo(() => new Set(candidates(dugAnswered)), [drop?.id, drop?.digs.length, drop?.digs.at(-1)?.state]); // eslint-disable-line
  const isHider = drop && same(drop.hider, account);
  const myBoard = drop && isHider ? loadBoard(chainId, dep.game, drop.root) : null;
  const tok = drop ? tokenOf(drop) : null;
  const pending = drop?.digs.at(-1)?.state === 0 ? drop.digs.at(-1) : null;
  const lastAnswered = [...(drop?.digs || [])].reverse().find((d) => d.state === 1);
  const status = drop ? STATUS[drop.status] : "";
  const left = drop ? drop.endTime - now : 0;
  const pendingLeft = pending ? pending.when + drop.respond - now : 0;
  const canDig = drop && status === "Open" && left > 0 && !pending && !isHider && account && cell !== null;
  const importBoard = (file) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const b = JSON.parse(r.result);
        if (!b.salts || !b.clues || rootOf(b) !== drop.root) throw new Error("This backup doesn't match this hunt.");
        saveBoard(chainId, dep.game, b);
        toast("Board restored. Autopilot can answer again.", "ok");
        load();
      } catch (e) { toast(reason(e), "err"); }
    };
    r.readAsText(file);
  };
  const explorer = dep?.explorer ? `${dep.explorer}/address/${dep.game}` : null;

  return (
    <>
      <header className="top">
        <div className="wrap bar">
          <div className="logo"><Radar />DEAD DROP</div>
          <div className="row">
            {DEPLOYED.length > 1 ? (
              <select className="netsel" value={chainId} onChange={(e) => changeNet(Number(e.target.value))} aria-label="Network">
                {DEPLOYED.map((id) => <option key={id} value={id}>{deployments[id].name}</option>)}
              </select>
            ) : dep && <span className="pill">{dep.name}</span>}
            {data.tokens.map((t) => <span key={t.address} className="pill"><b>{fmt(t.balance, t.decimals)}</b> {t.symbol}</span>)}
            {account ? <span className="pill">{short(account)}</span> : <button className="btn" onClick={connect}>Connect wallet</button>}
          </div>
        </div>
      </header>

      <main className="wrap">
        {!dep && <div className="notice"><b>Contracts aren't deployed yet.</b> Run <code>npm run deploy:sepolia</code> in the project root, then reload.</div>}
        {wrongChain && <div className="notice">Your wallet is on a network Dead Drop isn't deployed on. <button className="btn" onClick={() => switchChain(chainId)}>Switch to {dep.name}</button></div>}

        <section className="hero">
          <div>
            <h1>Bury a prize.<br />Hunt for one.<br /><span>Nobody can cheat.</span></h1>
            <p className="lede">
              It's hide-and-seek for money. The hider writes their secret spot on a card and <em>seals it in an envelope first</em>.
              Hunters dig, and every answer must match the sealed envelope. When the game ends, a robot judge opens it and checks every answer was true.
              Lie, and you lose your deposit.
            </p>
            <div className="row">
              <button className="btn hot" onClick={() => setShowPractice(true)}>Try a practice round</button>
              {!account ? <button className="btn" onClick={connect}>Connect wallet</button> : (
                <>
                  <button className="btn" disabled={!dep} onClick={() => setShowCreate(true)}>Bury a treasure</button>
                  {data.tokens.filter((t) => t.mock).map((t) => <button key={t.address} className="btn go" disabled={busy} onClick={() => faucet(t)}>Get 1,000 {t.symbol}</button>)}
                </>
              )}
            </div>
            <ol className="steps">
              <li><b>Dig a cell.</b> Pay a small fee in USDG.</li>
              <li><b>Read the clue.</b> It's how far the treasure is from that cell.</li>
              <li><b>Triangulate.</b> Glowing cells are the only spots still possible.</li>
            </ol>
          </div>
          <Demo />
        </section>

        <div className="split">
          <aside>
            <div className="h2">Hunts</div>
            {data.drops.length === 0 && <p className="muted">No hunts on {dep?.name} yet. Bury the first treasure, or try a practice round.</p>}
            <div className="list">
              {data.drops.map((d) => {
                const t = tokenOf(d);
                return (
                  <button key={d.id} className={"hunt" + (sel === d.id ? " on" : "")} onClick={() => pick(d.id)}>
                    <span className="hid">#{d.id}</span>
                    <span className="amt">{t ? fmt(d.prize + d.tips, t.decimals) : "?"} <small>{t?.symbol}</small></span>
                    <span className={"chip " + CHIP[STATUS[d.status]]}>{STATUS[d.status]}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="room" ref={roomRef}>
            {!drop ? <p className="muted">Pick a hunt on the left.</p> : (
              <>
                <div className="room-head">
                  <div>
                    <div className="eyebrow">Hunt #{drop.id} · hidden by {isHider ? "you" : short(drop.hider)}</div>
                    <div className="prize">{tok ? fmt(drop.prize + drop.tips, tok.decimals) : "?"} <small>{tok?.symbol}</small></div>
                  </div>
                  <span className={"chip big " + CHIP[status]}>{status}</span>
                </div>

                <div className="stage">
                  <Board
                    digs={drop.digs} selected={cell} onSelect={setCell}
                    cands={cands} showCands={assist && status === "Open" && !isHider && dugAnswered.length > 0}
                    secret={myBoard} disabled={status !== "Open" || !!pending || isHider || left <= 0}
                    lastCell={lastAnswered?.cell} over={status !== "Open"}
                  />
                  <div className="side">
                    <div className="stats">
                      <div><span>Dig fee</span><b>{tok ? fmt(drop.fee, tok.decimals) : "?"} {tok?.symbol}</b></div>
                      <div><span>Time left</span><b className={left < 60 && status === "Open" ? "low" : ""}>{status === "Open" ? clock(left) : "ended"}</b></div>
                      <div><span>Spots still possible</span><b>{status === "Open" && !isHider ? cands.size : "-"}</b></div>
                      <div><span>Digs so far</span><b>{drop.digs.length} / 36</b></div>
                    </div>

                    {status === "Open" && !isHider && (
                      <div className="panel">
                        <label className="chk small"><input type="checkbox" checked={assist} onChange={(e) => setAssist(e.target.checked)} /><span>Glow the cells that are still possible</span></label>
                        {pending ? (
                          <div className="wait"><i className="dot" /> The hider has <b>{clock(Math.max(0, pendingLeft))}</b> to answer the dig on <b>{"ABCDEF"[pending.cell % 6]}{Math.floor(pending.cell / 6) + 1}</b>.
                            {pendingLeft <= 0 && <button className="btn hot" disabled={busy} onClick={() => run("Claim forfeit", (send, g) => send(g, "claimTimeout", drop.id))}>Hider went silent: claim everything</button>}
                          </div>
                        ) : (
                          <button className="btn go wide" disabled={!canDig || busy} onClick={() => run("Dig", (send, g) => send(g, "dig", drop.id, cell), { token: tok, need: drop.fee })}>
                            {cell === null ? "Pick a cell on the board" : `Dig ${"ABCDEF"[cell % 6]}${Math.floor(cell / 6) + 1} for ${tok ? fmt(drop.fee, tok.decimals) : "?"} ${tok?.symbol}`}
                          </button>
                        )}
                        <div className="tipbox">
                          <input type="number" min="1" value={tipAmt} onChange={(e) => setTipAmt(e.target.value)} aria-label="Tip amount" />
                          <button className="btn ghost" disabled={busy || !tok} onClick={() => run("Add to prize", (send, g) => send(g, "tip", drop.id, parseUnits(String(tipAmt || 0), tok.decimals)), { token: tok, need: parseUnits(String(tipAmt || 0), tok?.decimals || 6) })}>Add to the prize</button>
                        </div>
                        <p className="fine">Tips go to whoever finds the treasure. Only tip hunts you'd enjoy watching.</p>
                      </div>
                    )}

                    {isHider && (
                      <div className="panel">
                        <div className="eyebrow">You buried this</div>
                        {myBoard ? (
                          <>
                            <label className="chk small"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span>Auto-answer digs, close the hunt and audit</span></label>
                            <p className="fine">{auto ? "Autopilot is ON. Keep this tab open." : "Autopilot is OFF. Hunters can claim your deposit if you miss a dig."}</p>
                            {getPilot(drop.root) && <button className="btn ghost" disabled={busy} onClick={() => refuel(drop)}>Refuel autopilot ({FUEL} ETH)</button>}
                            <button className="btn ghost" onClick={() => downloadJson(`dead-drop-board-${drop.root.slice(2, 10)}.json`, myBoard)}>Download board backup</button>
                          </>
                        ) : (
                          <>
                            <p className="warn">This browser doesn't have your secret board. Restore your backup file or you will forfeit.</p>
                            <input type="file" accept="application/json" onChange={(e) => e.target.files[0] && importBoard(e.target.files[0])} />
                          </>
                        )}
                        {status === "Open" && drop.digs.length === 0 && <button className="btn ghost" disabled={busy} onClick={() => run("Cancel hunt", (send, g) => send(g, "cancel", drop.id))}>Cancel and get everything back</button>}
                      </div>
                    )}

                    {status === "Open" && left <= 0 && !pending && <button className="btn hot wide" disabled={busy} onClick={() => run("Close hunt", (send, g) => send(g, "expire", drop.id))}>Time's up: close the hunt</button>}
                    {(status === "Found" || status === "Expired") && (
                      <div className="panel">
                        {status === "Found" && <p>Treasure found by <b>{same(drop.winner, account) ? "you" : short(drop.winner)}</b>. Prize paid. The hider now has to prove the board was honest.</p>}
                        {status === "Expired" && <p>Nobody found it. The hider now has to prove the board was honest.</p>}
                        {now > drop.auditBy
                          ? <button className="btn hot wide" disabled={busy} onClick={() => run("Slash", (send, g) => send(g, "slash", drop.id))}>Audit deadline passed: slash the hider</button>
                          : <p className="fine">Audit deadline in {clock(drop.auditBy - now)}.</p>}
                      </div>
                    )}
                    {tok && same(drop.winner, account) && ["Found", "Audited", "Slashed"].includes(status) && (
                      <div className="panel gold"><b>You found it!</b> {fmt(drop.prize + drop.tips, tok.decimals)} {tok.symbol} was sent to your wallet.</div>
                    )}
                    {status === "Audited" && <div className="panel ok">Audit passed. Every clue was true and the board matched its seal.</div>}
                    {status === "Slashed" && <div className="panel bad">The hider failed the audit. Their deposit went to the hunters.</div>}
                    {status === "Forfeited" && <div className="panel bad">The hider went silent and forfeited everything to <b>{short(drop.winner)}</b>.</div>}
                  </div>
                </div>

                <div className="log">
                  <div className="h2">Dig log</div>
                  {drop.digs.length === 0 ? <p className="muted">No digs yet.</p> : (
                    <ol>
                      {drop.digs.map((d, i) => (
                        <li key={i}>
                          <span className="who">{same(d.seeker, account) ? "you" : short(d.seeker)}</span> dug <b>{"ABCDEF"[d.cell % 6]}{Math.floor(d.cell / 6) + 1}</b>
                          {d.state === 1 ? <> → clue <b style={{ color: heat(d.clue) }}>{d.clue === 0 ? "TREASURE" : d.clue}</b></> : d.state === 0 ? <> → waiting…</> : <> → hider forfeited</>}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <details className="trust">
                  <summary>Why can't the hider cheat?</summary>
                  <ul>
                    <li>The board is sealed into a fingerprint (Merkle root) before anyone digs. Every answer has to match it.</li>
                    <li>Ignore a dig and the hunter takes the prize, tips and the hider's 50% bond.</li>
                    <li>When the hunt ends the hider must reveal the whole board. The contract checks there is exactly one treasure and every clue is the true distance. Fail or vanish and the deposit is paid to the hunters.</li>
                    <li>Dig fees are capped so that a cheater can never come out ahead.</li>
                  </ul>
                </details>
              </>
            )}
          </section>
        </div>

        <footer>
          Built for Arbitrum Open House Singapore. Game contract {explorer ? <a href={explorer} target="_blank" rel="noreferrer"><code>{short(dep.game)}</code></a> : <code>{dep ? short(dep.game) : "-"}</code>}.
          Prizes are paid in Paxos USDG{dep?.tokens.some((t) => t.mock) ? " (this network also has a free test token, tUSDG)" : ""}. Unaudited prototype: use test money.
        </footer>
      </main>

      {showCreate && <Create tokens={data.tokens} hasEth={!!account} eth={data.eth} onClose={() => setShowCreate(false)} onCreate={createDrop} />}
      {showPractice && <Practice onClose={() => setShowPractice(false)} />}
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={"toast " + t.kind}>{t.text}</div>)}</div>
    </>
  );
}

function Radar() {
  return (
    <svg className="radar" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="16" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".6" />
      <path d="M16 16 L16 2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="arm" />
      <circle cx="22" cy="11" r="2.2" fill="#ffd166" />
    </svg>
  );
}

// a tiny looping demo of triangulation, so the idea lands in 5 seconds
function Demo() {
  const [step, setStep] = useState(0);
  useEffect(() => { const t = setInterval(() => setStep((s) => (s + 1) % 5), 1700); return () => clearInterval(t); }, []);
  const T = 14; // treasure at C3
  const dig = [{ cell: 0, clue: 4 }, { cell: 35, clue: 6 }, { cell: T, clue: 0 }];
  const shown = step === 0 ? [] : dig.slice(0, Math.min(step, 3)).map((d) => ({ ...d, state: 1 }));
  const c = new Set(candidates(shown));
  return (
    <div className="demo">
      <Board digs={shown} selected={null} onSelect={() => {}} cands={c} showCands={step > 0} disabled lastCell={shown.at(-1)?.cell} />
      <p className="muted center">{["Hidden board.", "Dig A1: clue 4. Only glowing cells are possible.", "Dig F6: clue 6. Narrowed again.", "Dig C3: clue 0. Found it.", "The judge opens the envelope: all honest."][step]}</p>
    </div>
  );
}