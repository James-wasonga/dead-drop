import { useMemo, useState } from "react";
import Board from "./Board.jsx";
import { candidates, newBoard } from "./lib/board.mjs";
import { cellName } from "./util.js";

// A no-wallet, no-money practice round so anyone can feel the mechanic in ten seconds.
export default function Practice({ onClose }) {
  const [board, setBoard] = useState(() => newBoard());
  const [digs, setDigs] = useState([]);
  const [sel, setSel] = useState(null);
  const cands = useMemo(() => new Set(candidates(digs)), [digs]);
  const won = digs.some((d) => d.clue === 0);
  const dig = () => {
    if (sel === null) return;
    setDigs((d) => [...d, { cell: sel, clue: board.clues[sel], state: 1 }]);
    setSel(null);
  };
  const again = () => { setBoard(newBoard()); setDigs([]); setSel(null); };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Practice round">
        <h2>Practice round</h2>
        <p className="muted">No wallet, no money. A treasure is hidden somewhere. Each dig tells you how many steps away it is. Glowing cells are the only spots still possible.</p>
        <Board digs={digs} selected={sel} onSelect={setSel} cands={cands} showCands={digs.length > 0 && !won} disabled={won} lastCell={digs.at(-1)?.cell} over={won} />
        {won ? (
          <div className="panel gold"><b>Found it in {digs.length} {digs.length === 1 ? "dig" : "digs"}.</b> In a real hunt every clue is checked against a sealed board, so the hider can't bluff.</div>
        ) : (
          <div className="panel">
            <button className="btn go wide" disabled={sel === null} onClick={dig}>{sel === null ? "Pick a cell" : `Dig ${cellName(sel)}`}</button>
            <p className="fine">Digs so far: {digs.length}. Spots still possible: {digs.length ? cands.size : 36}.</p>
          </div>
        )}
        <div className="actions">
          <button className="btn hot" onClick={again}>New board</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}