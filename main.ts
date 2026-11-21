// sokoban-solver-makefun: a push-optimal Sokoban solver for make.fun's
// sokoban-solver-01-run-20261121. One program answers all 5 instances of a set.
//
// How it works (written from first principles for this competition):
//   * The generator's levels are a 1-wide hallway with 1-4 rooms off it; a box
//     pushed out of a room's door into the hallway can never come back, so
//     every box stays in its room and the level's push-optimum P* is the sum
//     of the rooms' optima. Rooms are therefore solved independently and the
//     per-room push sequences are stitched with hallway walks between rooms.
//   * Each room is solved by A* over push states (sorted box positions plus
//     the player's reachable region). The heuristic is the cheapest assignment
//     of boxes to goals under shortest-path distances through the room, which
//     never overestimates the pushes still needed, so the A* result is
//     push-optimal for the room. Dead states are pruned with a static dead-
//     square table (reverse reachability from the goals), 2x2 block checks and
//     a frozen-box check.
//   * The search is budgeted by a fixed number of node expansions, never by
//     the clock, and every tie-break is fixed, so two runs write identical
//     bytes. If the optimal search exhausts its budget, a greedy best-first
//     search tries to at least solve the room (a suboptimal solve still scores
//     ~500 x P*/pushes; an unsolved room scores 0). Every instance always gets
//     a valid solution file, even if it is only the walks between rooms.
//   * No wall-clock, environment or file outside /input, /output and /bot is
//     read. Node's built-in modules only; no dependencies, no network.
//
// Local run: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Dir = [number, number, string];
const DIRS: Dir[] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

// Node-expansion budgets: fixed work counts, never the clock.
const ASTAR_BUDGET = 250_000;
const GREEDY_BUDGET = 250_000;

type Board = {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// The cell at (x, y); outside the board counts as wall.
function cellAt(b: Board, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= b.w || y >= b.h) return -1;
  return y * b.w + x;
}

function isWall(b: Board, c: number): boolean {
  return c < 0 || c >= b.w * b.h || b.wall[c];
}

// Shortest walking path from `from` to `to` over floor cells, avoiding the
// cells in `blocked` and the cells in `boxes`. Fixed neighbour order, so the
// path is deterministic. Returns the move letters, or null if unreachable.
function walkPath(
  b: Board,
  blocked: Set<number>,
  boxes: Set<number>,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const n = b.w * b.h;
  const prev = new Int32Array(n).fill(-2);
  const prevDir = new Array<string>(n).fill('');
  prev[from] = -1;
  const q: number[] = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const cx = c % b.w;
    const cy = (c / b.w) | 0;
    for (const [dx, dy, letter] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nb = cellAt(b, nx, ny);
      if (nb < 0 || prev[nb] !== -2) continue;
      if (isWall(b, nb) || blocked.has(nb) || boxes.has(nb)) continue;
      prev[nb] = c;
      prevDir[nb] = letter;
      if (nb === to) {
        let moves = '';
        for (let t = to; t !== from; t = prev[t]!) moves = prevDir[t] + moves;
        return moves;
      }
      q.push(nb);
    }
  }
  return null;
}

// Every floor cell the player can reach from `from`, avoiding `blocked` and
// `boxes`. Returns the set and its smallest cell (a canonical representative
// of the region: two states with the same boxes and the same reachable region
// are the same state).
function reachRegion(
  b: Board,
  blocked: Set<number>,
  boxes: Set<number>,
  from: number,
): { set: Set<number>; min: number } {
  const set = new Set<number>([from]);
  let min = from;
  const q: number[] = [from];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const cx = c % b.w;
    const cy = (c / b.w) | 0;
    for (const [dx, dy] of DIRS) {
      const nb = cellAt(b, cx + dx, cy + dy);
      if (nb < 0 || set.has(nb)) continue;
      if (isWall(b, nb) || blocked.has(nb) || boxes.has(nb)) continue;
      set.add(nb);
      if (nb < min) min = nb;
      q.push(nb);
    }
  }
  return { set, min };
}

type RoomSpec = {
  boxes: number[];
  goals: number[];
  region: Set<number>;
  hallCell: number;
};

type RoomResult = { moves: string; pushes: number; endPlayer: number };

// Push-space search (A*, or greedy best-first when `greedy`) over one room.
// `blocked` holds the current positions of every box that is not this room's.
// Boxes may only be pushed onto cells of the room's region.
function searchRoom(
  b: Board,
  spec: RoomSpec,
  startPlayer: number,
  blocked: Set<number>,
  budget: number,
  greedy: boolean,
): RoomResult | null {
  const w = b.w;
  const goalSet = new Set(spec.goals);
  const regionList = [...spec.region].sort((a, b2) => a - b2);
  const startBoxes = spec.boxes.slice().sort((a, bb) => a - bb);
  if (startBoxes.every((x) => goalSet.has(x))) {
    return { moves: '', pushes: 0, endPlayer: startPlayer };
  }

  // Shortest-path distances between room cells, through room cells only.
  const dist = new Map<number, Map<number, number>>();
  for (const a of regionList) {
    const d = new Map<number, number>([[a, 0]]);
    const q = [a];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi]!;
      for (const [dx, dy] of DIRS) {
        const nb = cellAt(b, (c % w) + dx, ((c / w) | 0) + dy);
        if (nb < 0 || !spec.region.has(nb) || d.has(nb)) continue;
        d.set(nb, d.get(c)! + 1);
        q.push(nb);
      }
    }
    dist.set(a, d);
  }

  // Static dead squares: a room cell is live when a box on it can still be
  // pushed towards a goal. Start from the goals; a cell joins when some push
  // from it lands on a live cell with the player able to stand on the far
  // side (the hallway square outside the door counts as a standing square).
  const live = new Set<number>(spec.goals);
  const standable = (c: number): boolean => spec.region.has(c) || c === spec.hallCell;
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of regionList) {
      if (live.has(c)) continue;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        if (live.has(c + d) && standable(c - d)) {
          live.add(c);
          changed = true;
          break;
        }
      }
    }
  }
  const dead = new Set<number>(regionList.filter((c) => !live.has(c)));

  // Cheapest assignment of boxes to goals under the distance table. Each
  // push moves one box one cell, so this never overestimates the pushes left.
  const heuristic = (boxes: number[]): number => {
    const n = boxes.length;
    let best = Infinity;
    const used = new Array<boolean>(n).fill(false);
    const rec = (i: number, acc: number): void => {
      if (acc >= best) return;
      if (i === n) {
        best = acc;
        return;
      }
      const dm = dist.get(boxes[i]!)!;
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = dm.get(spec.goals[j]!);
        if (d === undefined) continue;
        used[j] = true;
        rec(i + 1, acc + d);
        used[j] = false;
      }
    };
    rec(0, 0);
    return best;
  };

  // True when this box set can never be solved: a box on a dead square, a
  // 2x2 block of wall-or-box with no goal, or a box that can never be pushed
  // again while off its goal.
  const isDeadBoxes = (boxes: number[]): boolean => {
    const set = new Set(boxes);
    for (const bx of boxes) {
      if (goalSet.has(bx)) continue;
      if (dead.has(bx)) return true;
      const x = bx % w;
      const y = (bx / w) | 0;
      for (const [ox, oy] of [
        [0, 0],
        [-1, 0],
        [0, -1],
        [-1, -1],
      ]) {
        const cells = [
          cellAt(b, x + ox, y + oy),
          cellAt(b, x + ox + 1, y + oy),
          cellAt(b, x + ox, y + oy + 1),
          cellAt(b, x + ox + 1, y + oy + 1),
        ];
        if (
          cells.every((c) => c >= 0 && !goalSet.has(c) && (isWall(b, c) || set.has(c)))
        ) {
          return true;
        }
      }
      // A box is frozen only when no push of it can ever become possible:
      // every direction is closed by a wall, by a box of another room (those
      // never enter this room), or by the room's edge. Boxes of this room do
      // NOT count: one standing on a push's standing square, or in its way,
      // can move off later, so treating them as permanent wrongly prunes
      // solvable states.
      let canMove = false;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const dest = bx + d;
        const stand = bx - d;
        if (
          spec.region.has(dest) &&
          !isWall(b, dest) &&
          !blocked.has(dest) &&
          !isWall(b, stand) &&
          !blocked.has(stand)
        ) {
          canMove = true;
          break;
        }
      }
      if (!canMove) return true;
    }
    return false;
  };

  const stateKey = (boxes: number[], regionMin: number): string =>
    `${boxes.join(',')}|${regionMin}`;

  // A* state tables.
  const sBoxes: number[][] = [startBoxes];
  const sPlayer: number[] = [startPlayer];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sSeg: string[] = [''];
  const sKey: string[] = [];
  const startRegion = reachRegion(b, blocked, new Set(startBoxes), startPlayer);
  sKey.push(stateKey(startBoxes, startRegion.min));
  const best = new Map<string, number>([[sKey[0]!, 0]]);

  // Binary heap on [f, h, sequence, state]; the sequence breaks ties in
  // insertion order, so the order is fully deterministic.
  const heap: Array<[number, number, number, number]> = [];
  let seq = 0;
  const heapLess = (
    a: [number, number, number, number],
    c: [number, number, number, number],
  ): boolean =>
    a[0] < c[0] ||
    (a[0] === c[0] && (a[1] < c[1] || (a[1] === c[1] && a[2] < c[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(startBoxes);
  if (h0 === Infinity || isDeadBoxes(startBoxes)) return null;
  heapPush([greedy ? h0 : h0, h0, seq++, 0]);

  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    if (best.get(sKey[s]!) !== s) continue;
    if (++expanded > budget) return null;
    const boxes = sBoxes[s]!;
    const player = sPlayer[s]!;
    const boxSet = new Set(boxes);
    const reg = reachRegion(b, blocked, boxSet, player);
    for (const bx of boxes) {
      for (const [dx, dy, letter] of DIRS) {
        const d = dy * w + dx;
        const dest = bx + d;
        const stand = bx - d;
        if (!spec.region.has(dest)) continue;
        if (isWall(b, dest) || blocked.has(dest) || boxSet.has(dest)) continue;
        if (!reg.set.has(stand)) continue;
        const nb = boxes.slice();
        nb[nb.indexOf(bx)] = dest;
        nb.sort((a, bb) => a - bb);
        if (isDeadBoxes(nb)) continue;
        const h = heuristic(nb);
        if (h === Infinity) continue;
        const nPlayer = bx;
        const nRegion = reachRegion(b, blocked, new Set(nb), nPlayer);
        const k = stateKey(nb, nRegion.min);
        const ng = sG[s]! + 1;
        const prev = best.get(k);
        if (prev !== undefined && sG[prev]! <= ng) continue;
        const walk = walkPath(b, blocked, boxSet, player, stand);
        if (walk === null) continue;
        const t = sBoxes.length;
        sBoxes.push(nb);
        sPlayer.push(nPlayer);
        sG.push(ng);
        sParent.push(s);
        sSeg.push(walk + letter);
        sKey.push(k);
        best.set(k, t);
        if (nb.every((x) => goalSet.has(x))) {
          let moves = '';
          for (let u = t; u > 0; u = sParent[u]!) moves = sSeg[u] + moves;
          return { moves, pushes: ng, endPlayer: nPlayer };
        }
        heapPush([greedy ? h : ng + h, h, seq++, t]);
      }
    }
  }
  return null;
}

// Detect the rooms of a level: the player starts in the hallway, so the
// hallway is the player's row. A door is a non-wall cell in the row just
// above or below the hallway, over a hallway floor cell. A room's region is
// the flood from its door over the room side of that wall row.
function detectRooms(b: Board): RoomSpec[] {
  const hallRow = (b.player / b.w) | 0;
  const rooms: RoomSpec[] = [];
  for (const side of [-1, 1]) {
    const doorRow = hallRow + side;
    if (doorRow < 0 || doorRow >= b.h) continue;
    for (let x = 1; x < b.w - 1; x++) {
      const doorCell = doorRow * b.w + x;
      const hallCell = hallRow * b.w + x;
      if (isWall(b, doorCell) || isWall(b, hallCell)) continue;
      const region = new Set<number>([doorCell]);
      const q = [doorCell];
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi]!;
        const cx = c % b.w;
        const cy = (c / b.w) | 0;
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (side === -1 ? ny >= hallRow : ny <= hallRow) continue;
          const nb = cellAt(b, nx, ny);
          if (nb < 0 || region.has(nb) || isWall(b, nb)) continue;
          region.add(nb);
          q.push(nb);
        }
      }
      const boxes = b.boxes.filter((v) => region.has(v));
      const goals = b.goals.filter((v) => region.has(v));
      if (boxes.length === 0) continue;
      rooms.push({ boxes, goals, region, hallCell });
    }
  }
  // Deterministic order: rooms above the hallway first, then below, each by
  // door column.
  rooms.sort((a, c2) => a.hallCell - c2.hallCell);
  return rooms;
}

function solve(text: string): string {
  const b = parseLevel(text);
  let rooms = detectRooms(b);
  if (rooms.length === 0) {
    // Unexpected geometry: solve the whole level as one room.
    const region = new Set<number>();
    for (let i = 0; i < b.w * b.h; i++) if (!b.wall[i]) region.add(i);
    rooms = [{ boxes: b.boxes, goals: b.goals, region, hallCell: b.player }];
  }
  // Current position of every box, updated as rooms are solved.
  const boxPos = new Map<number, number>();
  for (const v of b.boxes) boxPos.set(v, v);
  let player = b.player;
  let moves = '';
  for (const room of rooms) {
    const others = new Set<number>();
    for (const [from, at] of boxPos) {
      if (!room.boxes.includes(from)) others.add(at);
    }
    const allBoxes = new Set<number>(boxPos.values());
    const walk = walkPath(b, new Set<number>(), allBoxes, player, room.hallCell);
    if (walk !== null) {
      moves += walk;
      player = room.hallCell;
    }
    const roomBoxesNow = room.boxes.map((from) => boxPos.get(from)!).sort((a, c) => a - c);
    const spec: RoomSpec = {
      boxes: roomBoxesNow,
      goals: room.goals,
      region: room.region,
      hallCell: room.hallCell,
    };
    let result = searchRoom(b, spec, player, others, ASTAR_BUDGET, false);
    if (result === null) {
      result = searchRoom(b, spec, player, others, GREEDY_BUDGET, true);
    }
    if (result === null) {
      // Leave the room unsolved rather than writing an illegal move; the
      // level scores 0, but the answer stays valid and the next room can
      // still be attempted.
      continue;
    }
    moves += result.moves;
    player = result.endPlayer;
    // The room's boxes now sit on its goals.
    const sortedGoals = room.goals.slice().sort((a, c) => a - c);
    room.boxes.forEach((from, i) => boxPos.set(from, sortedGoals[i]!));
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
