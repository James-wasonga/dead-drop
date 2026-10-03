import { cellName, heat } from "./util.js";

// 6x6 radar board. `digs` = [{cell, clue, state}], `cands` = Set of still-possible cells.
export default function Board({ digs, selected, onSelect, cands, showCands, secret, disabled, lastCell, over }) {
  const byCell = new Map(digs.map((d) => [d.cell, d]));
  return (
    <div className={"board" + (over ? " over" : "")}>
      <div className="sweep" aria-hidden="true" />
      <div className="cols" aria-hidden="true">{"ABCDEF".split("").map((c) => <span key={c}>{c}</span>)}</div>
      <div className="grid6" role="grid" aria-label="Treasure board">
        {Array.from({ length: 36 }, (_, i) => {
          const d = byCell.get(i);
          const answered = d && d.state === 1;
          const pending = d && d.state === 0;
          const isTreasure = answered && d.clue === 0;
          const cls = ["cell"];
          if (answered) cls.push("dug");
          if (pending) cls.push("pending");
          if (isTreasure) cls.push("gold");
          if (!d && showCands && cands.has(i)) cls.push("cand");
          if (selected === i) cls.push("sel");
          if (secret && secret.treasure === i && !isTreasure) cls.push("secret");
          if (lastCell === i) cls.push("ping");
          return (
            <button
              key={i}
              role="gridcell"
              className={cls.join(" ")}
              style={answered ? { "--h": heat(d.clue) } : undefined}
              disabled={disabled || !!d}
              onClick={() => onSelect(i)}
              aria-label={`Cell ${cellName(i)}${answered ? `, clue ${d.clue}` : pending ? ", waiting for the hider" : ""}`}
              title={secret ? `${cellName(i)} · clue ${secret.clues[i]}` : cellName(i)}
            >
              {answered ? (isTreasure ? <Gem /> : d.clue) : pending ? <i className="dot" /> : secret && secret.treasure === i ? <Gem dim /> : null}
              <span className="nm">{cellName(i)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Gem({ dim }) {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" style={{ opacity: dim ? 0.55 : 1 }}>
      <path d="M12 2 21 9 12 22 3 9Z" fill="#ffd166" stroke="#7a4b00" strokeWidth="1.2" />
      <path d="M3 9h18M12 2 8 9l4 13 4-13Z" fill="none" stroke="#7a4b00" strokeWidth="1" />
    </svg>
  );
}
