import { useState } from "react";
import { formatEther } from "ethers";
import { cellName } from "./util.js";

const DURATIONS = [["5 minutes (demo)", 300], ["1 hour", 3600], ["1 day", 86400], ["7 days", 604800]];
const RESPONDS = [["1 minute", 60], ["5 minutes", 300], ["1 hour", 3600], ["6 hours", 21600]];

export default function Create({ tokens, onClose, onCreate, hasEth, eth }) {
  const [ti, setTi] = useState(0);
  const [prize, setPrize] = useState("36");
  const [fee, setFee] = useState("1");
  const [dur, setDur] = useState(300);
  const [resp, setResp] = useState(60);
  const [pick, setPick] = useState(null); // null = random
  const [pilot, setPilot] = useState(true);
  const [backup, setBackup] = useState(true);
  const t = tokens[ti];
  const p = Number(prize), f = Number(fee);
  const maxFee = Math.floor((p / 36) * 100) / 100;
  const err = !(p > 0) ? "Enter a prize." : !(f > 0) ? "Enter a dig fee." : f > maxFee ? `Dig fee can be at most ${maxFee} (prize ÷ 36), so a cheating hider can never profit.` : null;
  const bal = t ? Number(t.balance) / 10 ** t.decimals : 0;
  const need = p * 1.5;
  const lowEth = pilot && eth !== undefined && eth < 800000000000000n; // autopilot fuel 0.0005 ETH + gas for 3 txs

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bury a treasure">
        <h2>Bury a treasure</h2>
        <p className="muted">Pick a prize, hide it, and the board is sealed. Hunters pay a small fee per dig and you earn those fees.</p>

        <label>Pay with
          <select value={ti} onChange={(e) => setTi(Number(e.target.value))}>
            {tokens.map((x, i) => <option key={x.address} value={i}>{x.symbol}{x.mock ? " (test faucet token)" : " (Paxos Global Dollar)"}</option>)}
          </select>
        </label>
        <div className="two">
          <label>Prize<input type="number" min="1" value={prize} onChange={(e) => setPrize(e.target.value)} /></label>
          <label>Fee per dig<input type="number" min="0.01" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} /></label>
        </div>
        <div className="two">
          <label>Hunt stays open
            <select value={dur} onChange={(e) => setDur(Number(e.target.value))}>{DURATIONS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label>You answer each dig within
            <select value={resp} onChange={(e) => setResp(Number(e.target.value))}>{RESPONDS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        </div>

        <div>
          <div className="lbl">Where is the treasure? <button className="link" onClick={() => setPick(null)}>{pick === null ? "random (recommended)" : "switch to random"}</button></div>
          <div className="mini">
            {Array.from({ length: 36 }, (_, i) => (
              <button key={i} className={"mc" + (pick === i ? " on" : "")} onClick={() => setPick(i)} aria-label={`Hide at ${cellName(i)}`}>{pick === i ? "◆" : ""}</button>
            ))}
          </div>
        </div>

        <label className="chk"><input type="checkbox" checked={pilot} onChange={(e) => setPilot(e.target.checked)} />
          <span><b>Autopilot</b> (recommended): a throwaway key answers digs for you with no wallet pop-ups. You fund it with a little ETH for gas.{!hasEth && " (needs a wallet connection)"}</span>
        </label>
        <label className="chk"><input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
          <span>Download a backup of my secret board. <b>If you lose it, you can't answer and you forfeit.</b></span>
        </label>

        <div className="sum">
          You lock <b>{need.toLocaleString(undefined, { maximumFractionDigits: 2 })} {t?.symbol}</b>: the {p || 0} prize plus a {(p / 2 || 0)} bond.
          You get the bond back when you prove the board was honest. Your balance: {bal.toLocaleString(undefined, { maximumFractionDigits: 2 })} {t?.symbol}.
        </div>
        {err && <div className="warn">{err}</div>}
        {!err && lowEth && <div className="warn">Autopilot needs about 0.0008 ETH on this network (fuel + gas). You have {Number(formatEther(eth)).toFixed(4)}. Get some from this network's faucet, or untick Autopilot.</div>}
        <div className="actions">
          <button className="btn go" disabled={!!err || !t} onClick={() => { onCreate({ token: t, prize: p, fee: f, duration: dur, respond: resp, treasure: pick ?? undefined, pilot: pilot && hasEth, backup }); onClose(); }}>Seal the board & bury</button>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}