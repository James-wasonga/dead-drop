// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title DeadDrop
/// @notice Hide-and-seek for money, where the hider cannot cheat.
///
///  A hider buries a prize on a secret 6x6 grid and publishes only a sealed fingerprint of the
///  board (a Merkle root). Hunters pay a small fee to dig one cell at a time. The hider must answer
///  each dig with a proof that matches the fingerprint, revealing a CLUE: the distance from that
///  cell to the treasure (0 = you found it). Hunters triangulate like a radar.
///
///  Honesty is enforced, not assumed:
///   - every answer must match the sealed fingerprint, so the board can't change mid-game;
///   - ignore a dig and you forfeit prize + bond to that hunter;
///   - when the hunt ends the hider must reveal the whole board; the contract re-checks that there is
///     exactly one treasure and every clue is the true distance. Fail (or stay silent) and you're slashed.
contract DeadDrop is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant SIDE = 6;
    uint8 public constant CELLS = 36;
    uint8 public constant DEPTH = 6; // 64 leaves (36 cells + 28 zero pads)
    uint256 public constant MIN_RESPOND = 60;
    uint256 public constant MAX_RESPOND = 1 days;
    uint256 public constant MIN_DURATION = 120;
    uint256 public constant MAX_DURATION = 14 days;
    uint256 public constant MIN_AUDIT_WINDOW = 10 minutes;
    uint256 public constant MAX_TIPS = 64;

    enum Status { Open, Found, Expired, Forfeited, Audited, Slashed, Cancelled }
    enum DigState { Pending, Answered, TimedOut }

    struct Drop {
        IERC20 token;
        address hider;
        address winner;
        bytes32 root;
        uint128 prize;
        uint128 bond;
        uint128 tips;
        uint128 fee;
        uint32 respond;
        uint64 endTime;
        uint64 auditBy;
        Status status;
    }

    struct Dig {
        address seeker;
        uint8 cell;
        uint8 clue;
        DigState state;
        uint64 when;
    }

    struct Tip {
        address who;
        uint128 amt;
    }

    struct CreateParams {
        IERC20 token;
        bytes32 root;
        uint128 prize;
        uint128 fee;
        uint32 respond;
        uint32 duration;
        address responder;
    }

    Drop[] private drops;
    mapping(uint256 => Dig[]) private digs;
    mapping(uint256 => Tip[]) private tipList;
    mapping(uint256 => uint64) public dugMask;
    mapping(uint256 => address) public responder;
    mapping(address => bool) public isAllowedToken;
    address[] private tokenList;

    event DropCreated(uint256 indexed id, address indexed hider, address token, uint256 prize, uint256 fee, uint64 endTime);
    event Dug(uint256 indexed id, address indexed seeker, uint8 cell);
    event Answered(uint256 indexed id, uint8 cell, uint8 clue);
    event Found(uint256 indexed id, address indexed winner, uint256 pot);
    event Forfeited(uint256 indexed id, address indexed winner, uint256 pot);
    event Expired(uint256 indexed id);
    event Audited(uint256 indexed id);
    event Slashed(uint256 indexed id, uint256 pool, uint256 diggers);
    event Cancelled(uint256 indexed id);
    event Tipped(uint256 indexed id, address indexed who, uint256 amount);

    constructor(address[] memory tokens) {
        require(tokens.length > 0 && tokens.length <= 4, "1-4 tokens");
        for (uint256 i = 0; i < tokens.length; i++) {
            isAllowedToken[tokens[i]] = true;
            tokenList.push(tokens[i]);
        }
    }

    // ───────────────────────── hide ─────────────────────────
    /// @notice Bury a prize. You lock `prize` plus a bond of 50% of the prize.
    function createDrop(CreateParams calldata p) external nonReentrant returns (uint256 id) {
        require(isAllowedToken[address(p.token)], "token not allowed");
        require(p.prize > 0 && p.fee > 0, "zero amount");
        // keeps cheating unprofitable: all 36 fees together never exceed the prize
        require(uint256(p.fee) * CELLS <= p.prize, "fee too high");
        require(p.respond >= MIN_RESPOND && p.respond <= MAX_RESPOND, "bad respond");
        require(p.duration >= MIN_DURATION && p.duration <= MAX_DURATION, "bad duration");

        uint128 bond = p.prize / 2;
        id = drops.length;
        drops.push(
            Drop({
                token: p.token,
                hider: msg.sender,
                winner: address(0),
                root: p.root,
                prize: p.prize,
                bond: bond,
                tips: 0,
                fee: p.fee,
                respond: p.respond,
                endTime: uint64(block.timestamp + p.duration),
                auditBy: 0,
                status: Status.Open
            })
        );
        responder[id] = p.responder;
        p.token.safeTransferFrom(msg.sender, address(this), uint256(p.prize) + bond);
        emit DropCreated(id, msg.sender, address(p.token), p.prize, p.fee, uint64(block.timestamp + p.duration));
    }

    function setResponder(uint256 id, address who) external {
        require(msg.sender == drops[id].hider, "hider only");
        responder[id] = who;
    }

    /// @notice Hider backs out before anyone has dug. Everything is refunded.
    function cancel(uint256 id) external nonReentrant {
        Drop storage d = drops[id];
        require(msg.sender == d.hider, "hider only");
        require(d.status == Status.Open && digs[id].length == 0, "can't cancel");
        d.status = Status.Cancelled;
        _refundTips(id, d.token);
        d.token.safeTransfer(d.hider, uint256(d.prize) + d.bond);
        emit Cancelled(id);
    }

    // ───────────────────────── hunt ─────────────────────────
    /// @notice Anyone can add to the prize while the hunt is open. Tips go to the finder.
    function tip(uint256 id, uint128 amount) external nonReentrant {
        Drop storage d = drops[id];
        require(d.status == Status.Open && block.timestamp <= d.endTime, "closed");
        require(amount > 0 && tipList[id].length < MAX_TIPS, "bad tip");
        d.token.safeTransferFrom(msg.sender, address(this), amount);
        d.tips += amount;
        tipList[id].push(Tip(msg.sender, amount));
        emit Tipped(id, msg.sender, amount);
    }

    /// @notice Pay the fee and dig one cell. One dig at a time; the hider then has `respond` seconds to answer.
    function dig(uint256 id, uint8 cell) external nonReentrant {
        Drop storage d = drops[id];
        require(d.status == Status.Open, "closed");
        require(block.timestamp <= d.endTime, "hunt ended");
        require(cell < CELLS, "bad cell");
        require(msg.sender != d.hider, "hider can't dig");
        require(!_hasPending(id), "dig pending");
        uint64 bit = uint64(1) << cell;
        require(dugMask[id] & bit == 0, "already dug");

        d.token.safeTransferFrom(msg.sender, address(this), d.fee);
        dugMask[id] |= bit;
        digs[id].push(Dig(msg.sender, cell, 0, DigState.Pending, uint64(block.timestamp)));
        emit Dug(id, msg.sender, cell);
    }

    /// @notice Hider (or their keeper) reveals the clue for the pending dig with a proof against the sealed board.
    function answer(uint256 id, uint8 clue, bytes32 salt, bytes32[] calldata proof) external nonReentrant {
        Drop storage d = drops[id];
        require(msg.sender == d.hider || msg.sender == responder[id], "not hider");
        require(d.status == Status.Open, "closed");
        Dig storage g = _lastDig(id);
        require(g.state == DigState.Pending, "nothing pending");
        require(block.timestamp <= uint256(g.when) + d.respond, "too late");
        require(clue <= 2 * (SIDE - 1), "bad clue");
        require(proof.length == DEPTH, "bad proof length");
        bytes32 leaf = keccak256(abi.encode(uint256(g.cell), uint256(clue), salt));
        require(MerkleProof.verify(proof, d.root, leaf), "bad proof");

        g.clue = clue;
        g.state = DigState.Answered;
        d.token.safeTransfer(d.hider, d.fee); // the hider earns the dig fee
        emit Answered(id, g.cell, clue);

        if (clue == 0) {
            d.status = Status.Found;
            d.winner = g.seeker;
            d.auditBy = uint64(block.timestamp + _auditWindow(d.respond));
            uint256 pot = uint256(d.prize) + d.tips;
            d.token.safeTransfer(g.seeker, pot);
            emit Found(id, g.seeker, pot);
        }
    }

    /// @notice The hider ignored a dig. The hunter takes the prize, the tips and the hider's bond.
    function claimTimeout(uint256 id) external nonReentrant {
        Drop storage d = drops[id];
        require(d.status == Status.Open, "closed");
        Dig storage g = _lastDig(id);
        require(g.state == DigState.Pending, "nothing pending");
        require(block.timestamp > uint256(g.when) + d.respond, "still time");
        g.state = DigState.TimedOut;
        d.status = Status.Forfeited;
        d.winner = g.seeker;
        uint256 pot = uint256(d.prize) + d.tips + d.bond;
        d.token.safeTransfer(g.seeker, pot + d.fee); // dig fee comes back too
        emit Forfeited(id, g.seeker, pot);
    }

    /// @notice Close a hunt nobody won (time is up, or all cells were dug). Starts the hider's audit window.
    function expire(uint256 id) external {
        Drop storage d = drops[id];
        require(d.status == Status.Open, "closed");
        require(block.timestamp > d.endTime || dugMask[id] == type(uint64).max >> 28, "still running");
        require(!_hasPending(id), "dig pending");
        d.status = Status.Expired;
        d.auditBy = uint64(block.timestamp + _auditWindow(d.respond));
        emit Expired(id);
    }

    // ───────────────────────── prove honesty ─────────────────────────
    /// @notice Reveal the whole board. Passing returns the bond (and the prize if nobody found it).
    function audit(uint256 id, uint8[36] calldata clues, bytes32[36] calldata salts) external nonReentrant {
        Drop storage d = drops[id];
        require(msg.sender == d.hider, "hider only");
        require(d.status == Status.Found || d.status == Status.Expired, "nothing to audit");
        _verifyBoard(d.root, clues, salts);

        bool found = d.status == Status.Found;
        d.status = Status.Audited;
        if (found) {
            d.token.safeTransfer(d.hider, d.bond);
        } else {
            _refundTips(id, d.token);
            d.token.safeTransfer(d.hider, uint256(d.prize) + d.bond);
        }
        emit Audited(id);
    }

    /// @notice Nobody audited in time (or the audit can't pass): pay the penalty to the hunters. Anyone can call.
    function slash(uint256 id) external nonReentrant {
        Drop storage d = drops[id];
        require(d.status == Status.Found || d.status == Status.Expired, "nothing to slash");
        require(block.timestamp > d.auditBy, "audit window open");

        bool found = d.status == Status.Found;
        d.status = Status.Slashed;
        uint256 pool = found ? d.bond : uint256(d.prize) + d.bond;
        if (!found) _refundTips(id, d.token);

        Dig[] storage ds = digs[id];
        uint256 n = ds.length;
        if (n == 0) {
            d.token.safeTransfer(d.hider, pool); // nobody was hurt
        } else {
            uint256 each = pool / n;
            uint256 paid;
            for (uint256 i = 0; i < n; i++) {
                uint256 amt = i == n - 1 ? pool - paid : each;
                paid += amt;
                d.token.safeTransfer(ds[i].seeker, amt);
            }
        }
        emit Slashed(id, pool, n);
    }

    // ───────────────────────── internals ─────────────────────────
    function _hasPending(uint256 id) internal view returns (bool) {
        Dig[] storage ds = digs[id];
        return ds.length > 0 && ds[ds.length - 1].state == DigState.Pending;
    }

    function _lastDig(uint256 id) internal view returns (Dig storage) {
        Dig[] storage ds = digs[id];
        require(ds.length > 0, "no digs");
        return ds[ds.length - 1];
    }

    function _auditWindow(uint32 respond) internal pure returns (uint256) {
        return respond < MIN_AUDIT_WINDOW ? MIN_AUDIT_WINDOW : respond;
    }

    function _refundTips(uint256 id, IERC20 token) internal {
        Tip[] storage ts = tipList[id];
        for (uint256 i = 0; i < ts.length; i++) token.safeTransfer(ts[i].who, ts[i].amt);
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32 h) {
        (a, b) = a < b ? (a, b) : (b, a);
        assembly {
            mstore(0x00, a)
            mstore(0x20, b)
            h := keccak256(0x00, 0x40)
        }
    }

    /// @dev Exactly one treasure, every other clue equals the true Manhattan distance, and the
    ///      rebuilt Merkle root equals the one sealed at creation.
    function _verifyBoard(bytes32 root, uint8[36] calldata clues, bytes32[36] calldata salts) internal pure {
        uint256 t = type(uint256).max;
        for (uint256 i = 0; i < CELLS; i++) {
            if (clues[i] == 0) {
                require(t == type(uint256).max, "two treasures");
                t = i;
            }
        }
        require(t != type(uint256).max, "no treasure");
        uint256 tr = t / SIDE;
        uint256 tc = t % SIDE;

        bytes32[64] memory nodes;
        for (uint256 i = 0; i < CELLS; i++) {
            uint256 r = i / SIDE;
            uint256 c = i % SIDE;
            uint256 dr = r > tr ? r - tr : tr - r;
            uint256 dc = c > tc ? c - tc : tc - c;
            require(clues[i] == dr + dc, "bad clue");
            nodes[i] = keccak256(abi.encode(i, uint256(clues[i]), salts[i]));
        }
        uint256 n = 64;
        while (n > 1) {
            for (uint256 j = 0; j < n / 2; j++) nodes[j] = _pair(nodes[2 * j], nodes[2 * j + 1]);
            n /= 2;
        }
        require(nodes[0] == root, "root mismatch");
    }

    // ───────────────────────── views ─────────────────────────
    function dropCount() external view returns (uint256) {
        return drops.length;
    }

    function getDrop(uint256 id) external view returns (Drop memory) {
        return drops[id];
    }

    function getDigs(uint256 id) external view returns (Dig[] memory) {
        return digs[id];
    }

    function getTips(uint256 id) external view returns (Tip[] memory) {
        return tipList[id];
    }

    function allowedTokens() external view returns (address[] memory) {
        return tokenList;
    }
}
