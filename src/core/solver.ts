/**
 * Gridlock City — solver.
 *
 * Two strategies, cheapest first:
 *
 *  1. **Exit-only search.** Vehicles never reposition, so occupancy is a pure
 *     function of "who is left" and the search memoises on a bitmask. When it
 *     succeeds the answer is provably optimal: clearing n vehicles needs at
 *     least n slides, and this clears them in exactly n.
 *  2. **Bounded best-first search** over full slide/pivot moves, for lots that
 *     genuinely need repositioning.
 *
 * Every shipped level is verified through this module (GDD §8: "every jam
 * solvable unaided, solver-verified, forever").
 */

import {
  applyMove,
  cloneLotState,
  createLotState,
  exitableVehicles,
  exitIndexAt,
  inBounds,
  isCleared,
  legalMoves,
  probe,
  stateKey,
  terrainAt,
} from './sim';
import { Dir, DX, DY, LevelDef, LotState, Move, MoveKind, Terrain } from './types';

export interface SolveResult {
  solvable: boolean;
  /** Minimum slides to clear the lot. −1 when unknown. */
  parSlides: number;
  /** A witness solution, shortest found. */
  moves: Move[];
  /** True when the result is a proven optimum rather than a bounded best effort. */
  optimal: boolean;
  nodes: number;
  /** True when the whole lot clears without any vehicle repositioning. */
  exitOnly: boolean;
}

export interface SolveOptions {
  /** Node budget for the fallback search. */
  maxNodes?: number;
  /** Skip the expensive fallback; exit-only failures report "not solvable here". */
  exitOnlyOnly?: boolean;
}

const DEFAULT_MAX_NODES = 120_000;
const MAX_F = 512;

const UNSOLVED: SolveResult = Object.freeze({
  solvable: false,
  parSlides: -1,
  moves: [] as Move[],
  optimal: false,
  nodes: 0,
  exitOnly: false,
});

/* ------------------------------------------------------------------ *
 * Strategy 1 — exit-only search
 * ------------------------------------------------------------------ */

/**
 * Find an order in which every remaining vehicle drives straight off the lot
 * with no repositioning. Returns vehicle indices in exit order, or null.
 */
export function solveExitOnly(start: LotState): number[] | null {
  const state = cloneLotState(start);
  const n = state.x.length;
  const useBitmask = n <= 30;
  const deadNum = new Set<number>();
  const deadStr = new Set<string>();
  const order: number[] = [];

  let mask = 0;
  if (useBitmask) for (let i = 0; i < n; i++) if (state.gone[i]) mask |= 1 << i;
  const goal = (1 << n) - 1;

  const walk = (m: number): boolean => {
    if (state.remaining === 0) return true;
    if (useBitmask) {
      if (m === goal) return true;
      if (deadNum.has(m)) return false;
    } else {
      const key = String.fromCharCode.apply(null, Array.from(state.gone));
      if (deadStr.has(key)) return false;
    }

    for (const vi of exitableVehicles(state)) {
      const mv = exitMoveFor(state, vi);
      if (!mv) continue;
      const undo = snapshot(state, vi);
      applyMove(state, mv);
      order.push(vi);
      if (walk(useBitmask ? m | (1 << vi) : 0)) return true;
      order.pop();
      restore(state, undo);
    }

    if (useBitmask) deadNum.add(m);
    else deadStr.add(String.fromCharCode.apply(null, Array.from(state.gone)));
    return false;
  };

  return walk(mask) ? order.slice() : null;
}

function exitMoveFor(s: LotState, vi: number): Move | null {
  const f = s.facing[vi] as Dir;
  const p = probe(s, vi, f);
  if (p.exitDist < 0) return null;
  return {
    kind: MoveKind.Exit,
    vi,
    dir: f,
    distance: p.exitDist,
    toX: s.x[vi] + DX[f] * p.exitDist,
    toY: s.y[vi] + DY[f] * p.exitDist,
    slidExtra: 0,
  };
}

interface Snapshot {
  vi: number;
  x: number;
  y: number;
  facing: number;
  gone: number;
  remaining: number;
  vips: number;
  slides: number;
  cells: Int32Array;
}

/** Cheap undo record for a single-vehicle move (avoids cloning the whole state). */
function snapshot(s: LotState, vi: number): Snapshot {
  const w = s.level.w;
  const f = s.facing[vi] as Dir;
  const cells = new Int32Array(s.len[vi]);
  for (let k = 0; k < s.len[vi]; k++) {
    cells[k] = (s.y[vi] - DY[f] * k) * w + (s.x[vi] - DX[f] * k);
  }
  return {
    vi,
    x: s.x[vi],
    y: s.y[vi],
    facing: s.facing[vi],
    gone: s.gone[vi],
    remaining: s.remaining,
    vips: s.vipsRemaining,
    slides: s.slides,
    cells,
  };
}

function restore(s: LotState, u: Snapshot): void {
  const w = s.level.w;
  if (!s.gone[u.vi]) {
    const f = s.facing[u.vi] as Dir;
    for (let k = 0; k < s.len[u.vi]; k++) {
      s.occ[(s.y[u.vi] - DY[f] * k) * w + (s.x[u.vi] - DX[f] * k)] = -1;
    }
  }
  s.x[u.vi] = u.x;
  s.y[u.vi] = u.y;
  s.facing[u.vi] = u.facing;
  s.gone[u.vi] = u.gone;
  s.remaining = u.remaining;
  s.vipsRemaining = u.vips;
  s.slides = u.slides;
  if (!u.gone) for (const c of u.cells) s.occ[c] = u.vi;
}

/* ------------------------------------------------------------------ *
 * Strategy 2 — bounded best-first search
 * ------------------------------------------------------------------ */

interface SearchNode {
  state: LotState;
  moves: Move[];
  cost: number;
}

/**
 * Best-first over f = slides + vehicles-remaining. Every edge costs 1 slide and
 * removes at most one vehicle, so f never decreases — a bucket queue scanned
 * upward behaves exactly like Dijkstra, and the first goal popped is optimal
 * unless the node budget truncated the frontier.
 */
function searchGeneral(start: LotState, maxNodes: number): SolveResult {
  const seen = new Map<string, number>();
  const buckets: SearchNode[][] = [];
  let nodes = 0;
  let truncated = false;

  const push = (node: SearchNode) => {
    const f = node.cost + node.state.remaining;
    if (f >= MAX_F) return;
    (buckets[f] ??= []).push(node);
  };

  push({ state: start, moves: [], cost: 0 });
  seen.set(stateKey(start), 0);

  for (let f = 0; f < MAX_F && !truncated; f++) {
    const bucket = buckets[f];
    if (!bucket) continue;
    while (bucket.length) {
      const node = bucket.pop()!;
      if (isCleared(node.state)) {
        return {
          solvable: true,
          parSlides: node.cost,
          moves: node.moves,
          optimal: !truncated,
          nodes,
          exitOnly: node.moves.every((m) => m.kind === MoveKind.Exit),
        };
      }
      if (nodes >= maxNodes) {
        truncated = true;
        break;
      }
      for (const mv of legalMoves(node.state)) {
        const next = cloneLotState(node.state);
        applyMove(next, mv);
        nodes++;
        const key = stateKey(next);
        const cost = node.cost + 1;
        const prev = seen.get(key);
        if (prev !== undefined && prev <= cost) continue;
        seen.set(key, cost);
        push({ state: next, moves: node.moves.concat(mv), cost });
      }
    }
  }

  return { ...UNSOLVED, optimal: !truncated, nodes };
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

export function solveState(start: LotState, opts: SolveOptions = {}): SolveResult {
  if (start.remaining === 0) {
    return { solvable: true, parSlides: 0, moves: [], optimal: true, nodes: 0, exitOnly: true };
  }

  const order = solveExitOnly(start);
  if (order) {
    const replay = cloneLotState(start);
    const moves: Move[] = [];
    for (const vi of order) {
      const mv = exitMoveFor(replay, vi);
      if (!mv) break;
      moves.push(mv);
      applyMove(replay, mv);
    }
    return {
      solvable: true,
      parSlides: moves.length,
      moves,
      optimal: true,
      nodes: 0,
      exitOnly: true,
    };
  }

  if (opts.exitOnlyOnly) return { ...UNSOLVED };
  return searchGeneral(cloneLotState(start), opts.maxNodes ?? DEFAULT_MAX_NODES);
}

export function solveLevel(level: LevelDef, opts: SolveOptions = {}): SolveResult {
  return solveState(createLotState(level), opts);
}

/**
 * Dispatcher Call hint: the next few vehicles of a valid exit order from the
 * player's current position (GDD §5 "highlights the next 3 vehicles").
 */
export function hintFrom(state: LotState, count = 3): number[] {
  const res = solveState(state, { maxNodes: 40_000 });
  if (!res.solvable) return [];
  const out: number[] = [];
  for (const m of res.moves) {
    if (m.kind !== MoveKind.Exit) continue;
    out.push(m.vi);
    if (out.length >= count) break;
  }
  if (out.length === 0 && res.moves.length) out.push(res.moves[0].vi);
  return out;
}

/** First move of a valid solution — keeps a hint actionable even mid-reposition. */
export function nextMoveHint(state: LotState): Move | null {
  const res = solveState(state, { maxNodes: 40_000 });
  return res.solvable && res.moves.length ? res.moves[0] : null;
}

/** True when the lot can still be cleared from here. Used to guard against dead ends. */
export function isStillSolvable(state: LotState): boolean {
  return solveState(state, { maxNodes: 60_000 }).solvable;
}

/* ------------------------------------------------------------------ *
 * Difficulty analysis
 * ------------------------------------------------------------------ */

export interface DifficultyMetrics {
  /** Longest chain of "must leave before" dependencies (GDD §4 knot depth). */
  knotDepth: number;
  /** Share of vehicles that block nobody — scenery that thickens the read. */
  distractorRatio: number;
  /** Vehicles that can drive off on move one. Low = tense opening. */
  openExits: number;
  /** Steps of the canonical solution with exactly one legal exit. */
  forcedSteps: number;
  vehicleCount: number;
  parSlides: number;
}

/**
 * Vehicles physically sitting on `vi`'s straight path to its curb cut.
 *
 * A vehicle only ever leaves along its facing, so this list is an *absolute*
 * precedence: every car on the ray has to be gone first. That makes the blocker
 * graph a true DAG — independent of which valid exit order the player picks.
 */
export function directBlockers(s: LotState, vi: number): number[] {
  const level = s.level;
  const f = s.facing[vi] as Dir;
  const blockers: number[] = [];
  const limit = level.w + level.h;

  for (let k = 1; k <= limit; k++) {
    const cx = s.x[vi] + DX[f] * k;
    const cy = s.y[vi] + DY[f] * k;
    if (!inBounds(level, cx, cy)) {
      const px = s.x[vi] + DX[f] * (k - 1);
      const py = s.y[vi] + DY[f] * (k - 1);
      return exitIndexAt(level, px, py, f) >= 0 ? blockers : [];
    }
    if (terrainAt(level, cx, cy) === Terrain.Blocked) return []; // no straight route at all
    const arrow = level.arrows[cy * level.w + cx];
    if (arrow >= 0 && arrow !== f) return [];
    const occupant = s.occ[cy * level.w + cx];
    if (occupant >= 0 && occupant !== vi && !blockers.includes(occupant)) blockers.push(occupant);
  }
  return [];
}

export function analyseDifficulty(level: LevelDef, solution?: Move[]): DifficultyMetrics {
  const state = createLotState(level);
  const n = state.x.length;

  const blockers: number[][] = [];
  for (let vi = 0; vi < n; vi++) blockers.push(directBlockers(state, vi));

  // Longest path through the precedence DAG. 0 = unvisited, 1 = on the stack,
  // 2 = settled; an on-stack hit can only happen on an unsolvable lot, and is
  // treated as a zero-length edge so the walk still terminates.
  const colour = new Uint8Array(n);
  const depth = new Array<number>(n).fill(1);
  const depthOf = (vi: number): number => {
    if (colour[vi] === 2) return depth[vi];
    if (colour[vi] === 1) return 0;
    colour[vi] = 1;
    let best = 1;
    for (const b of blockers[vi]) best = Math.max(best, depthOf(b) + 1);
    depth[vi] = best;
    colour[vi] = 2;
    return best;
  };

  let knotDepth = 0;
  for (let vi = 0; vi < n; vi++) knotDepth = Math.max(knotDepth, depthOf(vi));

  const blocksSomeone = new Set<number>();
  for (const list of blockers) for (const b of list) blocksSomeone.add(b);

  const replay = createLotState(level);
  const openExits = exitableVehicles(replay).length;
  let forcedSteps = 0;
  const moves = solution ?? solveLevel(level).moves;
  for (const m of moves) {
    if (m.kind === MoveKind.Exit && exitableVehicles(replay).length === 1) forcedSteps++;
    applyMove(replay, m);
  }

  return {
    knotDepth,
    distractorRatio: n === 0 ? 0 : 1 - blocksSomeone.size / n,
    openExits,
    forcedSteps,
    vehicleCount: n,
    parSlides: moves.length,
  };
}

/**
 * Bump-likelihood proxy (GDD §6): the chance a greedy player's first pick is
 * blocked. High = the lot "reads as tricky" without being unfair.
 */
export function bumpLikelihood(level: LevelDef): number {
  const state = createLotState(level);
  const n = state.x.length;
  if (n === 0) return 0;
  return 1 - exitableVehicles(state).length / n;
}
