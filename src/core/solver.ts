/**
 * Gridlock City — solver.
 *
 * Two strategies, cheapest first:
 *
 *  1. **Exit closure.** A vehicle only ever leaves along its own facing, so
 *     removing one can never block another: "who can leave right now" grows
 *     monotonically as the lot empties. Exit-only play is therefore *confluent*
 *     — repeatedly driving off whoever can go reaches the same terminal lot no
 *     matter what order you pick, and reaches it in linear time. That single
 *     observation replaces what used to be an exponential memoised DFS, and it
 *     is what makes forty-car lots tractable at all.
 *  2. **Reposition search.** When the closure strands cars, the lot needs a
 *     temporary move. Because exits are never harmful, taking every available
 *     exit before considering a slide loses no solutions — so the search only
 *     ever branches on slides from a stuck lot, and iterative deepening on the
 *     number of repositions returns a provably minimal answer.
 *
 * Every shipped level is verified through this module (GDD §8: "every jam
 * solvable unaided, solver-verified, forever").
 */

import {
  applyMove,
  cloneLotState,
  createLotState,
  exitableVehicles,
  hasExitAt,
  inBounds,
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
  /** Non-exit moves in the witness solution — the temporary repositions. */
  repositions: number;
}

export interface SolveOptions {
  /** Node budget for the reposition search. */
  maxNodes?: number;
  /**
   * How many temporary repositions the search may spend. 0 means exit-only:
   * a lot that needs a car pulled aside reports "not solvable here".
   */
  maxRepositions?: number;
  /** Legacy alias for `maxRepositions: 0`. */
  exitOnlyOnly?: boolean;
}

/**
 * Node budget for the reposition search. A node is one slide plus the exit
 * closure that follows it, so this is a few thousand full lot replays — plenty
 * for the one- or two-move knots the generator actually builds, and small
 * enough that a hint on a forty-car lot still lands inside a frame or two.
 */
const DEFAULT_MAX_NODES = 4_000;
const DEFAULT_MAX_REPOSITIONS = 2;

const UNSOLVED: SolveResult = Object.freeze({
  solvable: false,
  parSlides: -1,
  moves: [] as Move[],
  optimal: false,
  nodes: 0,
  exitOnly: false,
  repositions: 0,
});

/* ------------------------------------------------------------------ *
 * Strategy 1 — exit closure
 * ------------------------------------------------------------------ */

/**
 * Drive off everyone who can go, repeatedly, mutating `state`. Returns the exit
 * order — every vehicle when the lot clears, a prefix when it strands.
 *
 * Confluence (see the module note) means the stranded remainder is a property
 * of the lot, not of the order: this is the lot's *residual knot*.
 */
function exitClosure(state: LotState, out: Move[]): void {
  let progress = true;
  while (progress && state.remaining > 0) {
    progress = false;
    for (const vi of exitableVehicles(state)) {
      const mv = exitMoveFor(state, vi);
      if (!mv) continue;
      applyMove(state, mv);
      out.push(mv);
      progress = true;
    }
  }
}

/**
 * Find an order in which every remaining vehicle drives straight off the lot
 * with no repositioning. Returns vehicle indices in exit order, or null.
 */
export function solveExitOnly(start: LotState): number[] | null {
  const state = cloneLotState(start);
  const moves: Move[] = [];
  exitClosure(state, moves);
  return state.remaining === 0 ? moves.map((m) => m.vi) : null;
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

/* ------------------------------------------------------------------ *
 * Strategy 2 — reposition search
 * ------------------------------------------------------------------ */

/**
 * Slides worth trying from a stranded lot.
 *
 * Everything that could drive off already has, so the only useful thing a slide
 * can do is take a car out of somebody else's lane. Cars that stand on nobody's
 * route are therefore skipped outright — on a packed lot that is most of them,
 * and it is the difference between a branching factor of two hundred and one of
 * a dozen.
 */
function usefulSlides(state: LotState): Move[] {
  const slides = legalMoves(state).filter((m) => m.kind !== MoveKind.Exit);
  // A handful of stranded cars is cheap to search exhaustively, and doing so
  // keeps the answer exact — including the second-order case where a car has to
  // shuffle out of the way of the car that is actually in the way.
  if (state.remaining <= EXHAUSTIVE_REMAINDER) return slides;

  const inTheWay = new Set<number>();
  for (let vi = 0; vi < state.x.length; vi++) {
    if (state.gone[vi]) continue;
    for (const b of directBlockers(state, vi)) inTheWay.add(b);
  }
  const filtered = slides.filter((m) => m.kind === MoveKind.Pivot || inTheWay.has(m.vi));
  return filtered.length > 0 ? filtered : slides;
}

/** Below this many cars left, the reposition search stops pruning its branches. */
const EXHAUSTIVE_REMAINDER = 8;

interface SearchBudget {
  nodes: number;
  limit: number;
}

/** Deepest remaining-reposition budget a state has already been expanded with. */
type SeenDepths = Map<string, number>;

/**
 * Can this lot clear using at most `budgetMoves` temporary repositions?
 *
 * Exits never hurt — driving one car off can only free lanes for the rest — so
 * every solution can be rewritten to take all available exits before its next
 * slide. Running the closure at each node and branching only on slides is
 * therefore lossless, and searching depth 0, then 1, then 2 returns a line with
 * the fewest possible repositions.
 */
function searchRepositions(
  state: LotState,
  depth: number,
  moves: Move[],
  seen: SeenDepths,
  budget: SearchBudget,
): Move[] | null {
  exitClosure(state, moves);
  if (state.remaining === 0) return moves;
  if (depth === 0) return null;

  for (const mv of usefulSlides(state)) {
    if (budget.nodes >= budget.limit) return null;
    budget.nodes++;
    const next = cloneLotState(state);
    applyMove(next, mv);
    const key = stateKey(next);
    // Re-expand a state only when there is more reposition budget left than the
    // last time it was reached; otherwise the earlier visit already covered it.
    const before = seen.get(key);
    if (before !== undefined && before >= depth - 1) continue;
    seen.set(key, depth - 1);
    const line = searchRepositions(next, depth - 1, moves.concat(mv), seen, budget);
    if (line) return line;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Public entry points
 * ------------------------------------------------------------------ */

export function solveState(start: LotState, opts: SolveOptions = {}): SolveResult {
  if (start.remaining === 0) {
    return {
      solvable: true,
      parSlides: 0,
      moves: [],
      optimal: true,
      nodes: 0,
      exitOnly: true,
      repositions: 0,
    };
  }

  const maxRepositions = opts.exitOnlyOnly ? 0 : (opts.maxRepositions ?? DEFAULT_MAX_REPOSITIONS);
  const budget: SearchBudget = { nodes: 0, limit: opts.maxNodes ?? DEFAULT_MAX_NODES };

  // Iterative deepening on repositions, so the first line found is the one that
  // asks the player for the fewest temporary moves.
  for (let depth = 0; depth <= maxRepositions; depth++) {
    const line = searchRepositions(cloneLotState(start), depth, [], new Map(), budget);
    if (line) {
      const repositions = line.reduce((n, m) => n + (m.kind === MoveKind.Exit ? 0 : 1), 0);
      return {
        solvable: true,
        parSlides: line.length,
        moves: line,
        optimal: true,
        nodes: budget.nodes,
        exitOnly: repositions === 0,
        repositions,
      };
    }
    if (budget.nodes >= budget.limit) break;
  }

  return { ...UNSOLVED, optimal: budget.nodes < budget.limit, nodes: budget.nodes };
}

export function solveLevel(level: LevelDef, opts: SolveOptions = {}): SolveResult {
  return solveState(createLotState(level), opts);
}

/**
 * Dispatcher Call hint: the next few vehicles of a valid exit order from the
 * player's current position (GDD §5 "highlights the next 3 vehicles").
 */
export function hintFrom(state: LotState, count = 3): number[] {
  const res = solveState(state, { maxNodes: 2_000 });
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
  const res = solveState(state, { maxNodes: 2_000 });
  return res.solvable && res.moves.length ? res.moves[0] : null;
}

/**
 * True when the lot can still be cleared from here. Used to guard against dead
 * ends, so it errs generous: a search that runs out of budget reports "keep
 * playing" rather than telling a player their lot is dead when it may not be.
 */
export function isStillSolvable(state: LotState): boolean {
  const res = solveState(state, { maxNodes: 3_000, maxRepositions: 3 });
  return res.solvable || !res.optimal;
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
  /**
   * Cars that at least `BOTTLENECK_SPAN` others transitively wait on. These are
   * the corks: the lot does not open until they do, and finding them is the
   * whole read of a large jam.
   */
  bottlenecks: number;
  /** The single most-waited-on car's transitive dependent count. */
  widestBottleneck: number;
  /** Share of cars that neither block anybody nor are blocked — free parking. */
  independentRatio: number;
  /** Share of lot cells under a vehicle. The lot's visual and tactical fullness. */
  density: number;
  /** Non-exit moves the shortest known solution needs. */
  repositions: number;
}

/** How many waiting cars make a car a bottleneck rather than merely a blocker. */
export const BOTTLENECK_SPAN = 3;

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
      return hasExitAt(level, px, py, f) ? blockers : [];
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
  const isBlocked = blockers.map((list) => list.length > 0);

  // Transitive dependents: everyone downstream of each car in the precedence
  // DAG. A wide fan-out here is what a bottleneck actually is — one car whose
  // exit unlocks a whole quarter of the lot.
  const waiters: number[][] = Array.from({ length: n }, () => []);
  for (let vi = 0; vi < n; vi++) for (const b of blockers[vi]) waiters[b].push(vi);

  let bottlenecks = 0;
  let widestBottleneck = 0;
  const stack: number[] = [];
  for (let vi = 0; vi < n; vi++) {
    if (waiters[vi].length === 0) continue;
    const reached = new Set<number>();
    stack.length = 0;
    stack.push(vi);
    while (stack.length) {
      const at = stack.pop()!;
      for (const w of waiters[at]) {
        if (reached.has(w)) continue;
        reached.add(w);
        stack.push(w);
      }
    }
    if (reached.size > widestBottleneck) widestBottleneck = reached.size;
    if (reached.size >= BOTTLENECK_SPAN) bottlenecks++;
  }

  let independent = 0;
  let occupied = 0;
  for (let vi = 0; vi < n; vi++) {
    if (!isBlocked[vi] && !blocksSomeone.has(vi)) independent++;
    occupied += state.len[vi];
  }

  const replay = createLotState(level);
  const openExits = exitableVehicles(replay).length;
  let forcedSteps = 0;
  const moves = solution ?? solveLevel(level).moves;
  let repositions = 0;
  for (const m of moves) {
    if (m.kind === MoveKind.Exit) {
      if (exitableVehicles(replay).length === 1) forcedSteps++;
    } else {
      repositions++;
    }
    applyMove(replay, m);
  }

  return {
    knotDepth,
    distractorRatio: n === 0 ? 0 : 1 - blocksSomeone.size / n,
    openExits,
    forcedSteps,
    vehicleCount: n,
    parSlides: moves.length,
    bottlenecks,
    widestBottleneck,
    independentRatio: n === 0 ? 0 : independent / n,
    density: occupied / (level.w * level.h),
    repositions,
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
