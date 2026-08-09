/**
 * Puzzle analysis — what actually makes a jam hard.
 *
 * The old measure of difficulty was knot depth plus car count, and both can be
 * high on a lot that is completely trivial to play. This module measures the
 * thing the player actually experiences: whether the board can be cleared
 * without ever thinking.
 *
 * ## The greedy theorem
 *
 * Call a strategy *greedy* if it repeatedly picks any vehicle that can drive
 * off right now and drives it off, never repositioning anything.
 *
 * If a lot can be cleared greedily at all, it can be cleared greedily in **any
 * order**. Exiting a vehicle only ever frees cells, so it can never take away
 * another vehicle's ability to leave; the set of exitable vehicles is monotone
 * non-decreasing under exits. (The Velvet Rope is the one ordering constraint,
 * and it only ever relaxes: clearing the last VIP unblocks everyone.)
 *
 * Two consequences, and they are the foundation of this whole module:
 *
 * 1. A single greedy run **decides** greedy-solvability. No search needed.
 * 2. If greedy stalls with cars still on the lot, then no exit-only solution
 *    exists, so the optimal solution *must* contain a repositioning move. The
 *    player is forced to plan.
 *
 * That makes `greedyCleared` the sharpest cheap signal we have, and it is why
 * a level that stalls greedy early is structurally — not decoratively — hard.
 */

import {
  applyMove,
  cloneLotState,
  createLotState,
  exitableVehicles,
  legalMoves,
  probe,
  terrainAt,
  arrowAt,
  inBounds,
  exitIndexAt,
} from './sim';
import { Dir, DX, DY, LevelDef, LotState, Move, MoveKind, Terrain } from './types';

/* ------------------------------------------------------------------ *
 * Dependency graph
 * ------------------------------------------------------------------ */

export interface DependencyGraph {
  /** `blockedBy[v]` — vehicles physically standing on v's path to its curb cut. */
  blockedBy: number[][];
  /** `blocks[v]` — vehicles that cannot leave until v does. */
  blocks: number[][];
  /** Longest chain of "must leave before" relations. */
  depth: number;
  /** Per-vehicle: length of the longest chain ending at this vehicle. */
  height: number[];
  /** Vehicles nothing is waiting on and which wait on nothing. */
  isolated: number[];
  /**
   * Vehicles whose route to a curb cut is blocked by something that will never
   * move — a wall, an adverse one-way, or no curb cut on that lane at all.
   * These *must* be repositioned, which is a provable lower bound on the number
   * of non-exit moves any solution needs.
   */
  mustReposition: number[];
}

/**
 * Walk `vi`'s straight path to its curb cut, reporting what is in the way.
 *
 * `blockers` are vehicles (they can move). `terrainBlocked` means the lane is
 * dead: a wall, an arrow pointing against travel, or an edge with no curb cut.
 */
function rayReport(
  s: LotState,
  vi: number,
): { blockers: number[]; terrainBlocked: boolean } {
  const level = s.level;
  const f = s.facing[vi] as Dir;
  const blockers: number[] = [];
  const limit = level.w + level.h;
  let x = s.x[vi];
  let y = s.y[vi];

  for (let step = 1; step <= limit; step++) {
    const cx = x + DX[f] * step;
    const cy = y + DY[f] * step;
    if (!inBounds(level, cx, cy)) {
      const px = x + DX[f] * (step - 1);
      const py = y + DY[f] * (step - 1);
      // Ran off the board: only a real curb cut counts as a way out.
      return { blockers, terrainBlocked: exitIndexAt(level, px, py, f) < 0 };
    }
    if (terrainAt(level, cx, cy) === Terrain.Blocked) return { blockers, terrainBlocked: true };
    const arrow = arrowAt(level, cx, cy);
    if (arrow >= 0 && arrow !== f) return { blockers, terrainBlocked: true };
    const occupant = s.occ[cy * level.w + cx];
    if (occupant !== -1 && occupant !== vi && !blockers.includes(occupant)) {
      blockers.push(occupant);
    }
  }
  return { blockers, terrainBlocked: true };
}

export function dependencyGraph(s: LotState): DependencyGraph {
  const n = s.x.length;
  const blockedBy: number[][] = Array.from({ length: n }, () => []);
  const blocks: number[][] = Array.from({ length: n }, () => []);
  const mustReposition: number[] = [];

  for (let vi = 0; vi < n; vi++) {
    if (s.gone[vi]) continue;
    const report = rayReport(s, vi);
    blockedBy[vi] = report.blockers;
    for (const b of report.blockers) blocks[b].push(vi);
    if (report.terrainBlocked) mustReposition.push(vi);
  }

  // Longest path in the precedence DAG, with a cycle guard: a genuine deadlock
  // ring (A on B's ray, B on A's) is possible and must not hang the walk.
  const colour = new Uint8Array(n);
  const height = new Array<number>(n).fill(1);
  const walk = (vi: number): number => {
    if (colour[vi] === 2) return height[vi];
    if (colour[vi] === 1) return 0;
    colour[vi] = 1;
    let best = 1;
    for (const w of blocks[vi]) best = Math.max(best, walk(w) + 1);
    height[vi] = best;
    colour[vi] = 2;
    return best;
  };
  for (let vi = 0; vi < n; vi++) if (!s.gone[vi]) walk(vi);

  const isolated: number[] = [];
  for (let vi = 0; vi < n; vi++) {
    if (s.gone[vi]) continue;
    if (blockedBy[vi].length === 0 && blocks[vi].length === 0) isolated.push(vi);
  }

  let depth = 0;
  for (let vi = 0; vi < n; vi++) if (!s.gone[vi]) depth = Math.max(depth, height[vi]);

  return { blockedBy, blocks, depth, height, isolated, mustReposition };
}

/**
 * Is there a ring of cars each parked in the next one's way?
 *
 * This is the single most useful structural fact about a lot. A car's route to
 * the curb is fixed, so "A is in B's way" never changes; the lot can be cleared
 * by exits alone exactly when that relation is acyclic. A cycle is therefore a
 * *proof* that some car must be shifted aside before anything can leave — no
 * amount of tapping will do, and the player has to plan.
 */
export function hasBlockingCycle(s: LotState): boolean {
  const n = s.x.length;
  const blockedBy: number[][] = [];
  for (let vi = 0; vi < n; vi++) {
    blockedBy.push(s.gone[vi] ? [] : rayReport(s, vi).blockers);
  }

  const colour = new Uint8Array(n);
  const walk = (vi: number): boolean => {
    if (colour[vi] === 1) return true; // back edge — a ring
    if (colour[vi] === 2) return false;
    colour[vi] = 1;
    for (const b of blockedBy[vi]) if (walk(b)) return true;
    colour[vi] = 2;
    return false;
  };
  for (let vi = 0; vi < n; vi++) {
    if (s.gone[vi]) continue;
    if (walk(vi)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Greedy
 * ------------------------------------------------------------------ */

export interface GreedyOutcome {
  /** Vehicles cleared before greedy ran out of exits. */
  cleared: number;
  total: number;
  /** True when tapping obvious cars clears the whole lot. */
  solves: boolean;
  /** Vehicles greedy could exit before its first stall — the "free" opening. */
  firstStallAt: number;
  /** Exit order greedy took, for reporting. */
  order: number[];
}

/**
 * Run the greedy strategy to exhaustion.
 *
 * By the theorem above this single run decides greedy-solvability for the lot,
 * so there is no need to try alternative orderings.
 */
export function greedyOutcome(start: LotState): GreedyOutcome {
  const s = cloneLotState(start);
  const total = s.remaining;
  const order: number[] = [];

  for (;;) {
    const options = exitableVehicles(s);
    if (options.length === 0) break;
    const vi = options[0];
    const f = s.facing[vi] as Dir;
    const p = probe(s, vi, f);
    if (p.exitDist < 0) break;
    applyMove(s, {
      kind: MoveKind.Exit,
      vi,
      dir: f,
      distance: p.exitDist,
      toX: s.x[vi] + DX[f] * p.exitDist,
      toY: s.y[vi] + DY[f] * p.exitDist,
      slidExtra: 0,
    });
    order.push(vi);
  }

  const cleared = total - s.remaining;
  return { cleared, total, solves: s.remaining === 0, firstStallAt: cleared, order };
}

/* ------------------------------------------------------------------ *
 * Bottlenecks
 * ------------------------------------------------------------------ */

/**
 * Cells that more than one vehicle needs.
 *
 * A cell wanted by three different cars' routes is a place where the player has
 * to choose, and choosing wrong costs a move — which is what a bottleneck
 * actually is, as opposed to a board that merely looks tight.
 */
export function bottleneckCells(s: LotState): { cells: number[]; contention: number } {
  const level = s.level;
  const want = new Map<number, Set<number>>();

  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    const f = s.facing[vi] as Dir;
    const limit = level.w + level.h;
    for (let step = 1; step <= limit; step++) {
      const cx = s.x[vi] + DX[f] * step;
      const cy = s.y[vi] + DY[f] * step;
      if (!inBounds(level, cx, cy)) break;
      if (terrainAt(level, cx, cy) === Terrain.Blocked) break;
      const idx = cy * level.w + cx;
      const set = want.get(idx) ?? new Set<number>();
      set.add(vi);
      want.set(idx, set);
    }
  }

  const cells: number[] = [];
  let contention = 0;
  for (const [idx, users] of want) {
    if (users.size >= 2) {
      cells.push(idx);
      contention += users.size - 1;
    }
  }
  return { cells, contention };
}

/* ------------------------------------------------------------------ *
 * Full metric set
 * ------------------------------------------------------------------ */

export interface PuzzleMetrics {
  vehicles: number;
  /** Vehicles that can drive off on move one. Requirement: keep this low. */
  initialExits: number;
  initialExitShare: number;
  /** Longest "must leave before" chain. */
  dependencyDepth: number;
  /** Vehicles blocking nobody and blocked by nobody — pure scenery. */
  isolatedCars: number;
  /** Vehicles whose lane is dead until they reposition. */
  forcedRepositions: number;
  /** How many cars a no-thought greedy run clears. */
  greedyCleared: number;
  greedyShare: number;
  /** True when the lot falls to "tap whatever has a clear exit". */
  greedySolves: boolean;
  /** Cells contested by two or more vehicles. */
  bottleneckCells: number;
  bottleneckContention: number;
  /** Reference-solution measures. Zero when no solution was supplied. */
  solutionMoves: number;
  /** Moves in the reference solution that are not exits — the planning tax. */
  repositionMoves: number;
  /** Distinct vehicles that move more than once. */
  repositionedCars: number;
  /** How many moves happen before the first car can leave. */
  firstExitAt: number;
  /** Solution states offering more than one legal move. */
  decisionPoints: number;
  /** Mean legal-move count along the solution. */
  branchingFactor: number;
}

const EMPTY_SOLUTION = {
  solutionMoves: 0,
  repositionMoves: 0,
  repositionedCars: 0,
  firstExitAt: 0,
  decisionPoints: 0,
  branchingFactor: 0,
};

/**
 * Measure a lot.
 *
 * `solution` is any valid move sequence — the generator's own construction
 * trace at build time, or the solver's optimum in tests. The structural
 * measures (greedy, dependency, bottlenecks) do not depend on it.
 */
export function analysePuzzle(
  level: LevelDef,
  solution?: readonly Move[],
  withBranching = true,
): PuzzleMetrics {
  const state = createLotState(level);
  const graph = dependencyGraph(state);
  const greedy = greedyOutcome(state);
  const neck = bottleneckCells(state);
  const initialExits = exitableVehicles(state).length;
  const vehicles = state.remaining;

  let sol = { ...EMPTY_SOLUTION };
  if (solution && solution.length) {
    const replay = cloneLotState(state);
    const moveCount = new Map<number, number>();
    let firstExitAt = -1;
    let decisionPoints = 0;
    let branchTotal = 0;

    for (let i = 0; i < solution.length; i++) {
      // Branching is the one measure that needs the full legal-move list, and
      // that list is expensive — every slide distance for every car, both ways.
      // The generator rejects thousands of candidates and never reads it, so it
      // is opt-in; reports and tests ask for it, generation does not.
      if (withBranching) {
        const options = legalMoves(replay).length;
        branchTotal += options;
        if (options > 1) decisionPoints++;
      }
      const m = solution[i];
      if (m.kind === MoveKind.Exit && firstExitAt < 0) firstExitAt = i;
      moveCount.set(m.vi, (moveCount.get(m.vi) ?? 0) + 1);
      applyMove(replay, m);
    }

    const exits = solution.filter((m) => m.kind === MoveKind.Exit).length;
    sol = {
      solutionMoves: solution.length,
      repositionMoves: solution.length - exits,
      repositionedCars: [...moveCount.values()].filter((c) => c > 1).length,
      firstExitAt: firstExitAt < 0 ? solution.length : firstExitAt,
      decisionPoints,
      branchingFactor: branchTotal / solution.length,
    };
  }

  return {
    vehicles,
    initialExits,
    initialExitShare: vehicles ? initialExits / vehicles : 0,
    dependencyDepth: graph.depth,
    isolatedCars: graph.isolated.length,
    forcedRepositions: graph.mustReposition.length,
    greedyCleared: greedy.cleared,
    greedyShare: vehicles ? greedy.cleared / vehicles : 0,
    greedySolves: greedy.solves,
    bottleneckCells: neck.cells.length,
    bottleneckContention: neck.contention,
    ...sol,
  };
}

/* ------------------------------------------------------------------ *
 * Difficulty targets
 * ------------------------------------------------------------------ */

/**
 * What a tier demands of a lot. These are the knobs the campaign turns; the
 * generator rejects any candidate that misses them.
 */
export interface DifficultyTarget {
  /** Minimum longest "must leave before" chain. */
  dependencyDepth: number;
  /** Minimum total moves in the construction solution. */
  minimumSolutionMoves: number;
  /** Minimum non-exit moves any solution needs. 0 allows a pure exit-only lot. */
  temporaryMoveRequirement: number;
  /** Ceiling on the share of cars that may drive off on move one. */
  maximumInitialExitShare: number;
  /** Ceiling on the share of cars a no-thought greedy run may clear. */
  maximumGreedyShare: number;
  /** Ceiling on cars that neither block nor are blocked. */
  maximumIsolatedShare: number;
  /** Minimum contested cells. */
  minimumBottlenecks: number;
}

/** Score a candidate against a target: 0 is a perfect fit, negative is a miss. */
export function targetPenalty(m: PuzzleMetrics, t: DifficultyTarget): number {
  let penalty = 0;
  if (m.dependencyDepth < t.dependencyDepth) penalty += (m.dependencyDepth - t.dependencyDepth) * 6;
  if (m.solutionMoves < t.minimumSolutionMoves) {
    penalty += (m.solutionMoves - t.minimumSolutionMoves) * 2;
  }
  if (m.repositionMoves < t.temporaryMoveRequirement) {
    penalty += (m.repositionMoves - t.temporaryMoveRequirement) * 10;
  }
  if (m.initialExitShare > t.maximumInitialExitShare) {
    penalty += (t.maximumInitialExitShare - m.initialExitShare) * 40;
  }
  if (m.greedyShare > t.maximumGreedyShare) {
    penalty += (t.maximumGreedyShare - m.greedyShare) * 60;
  }
  const isolatedShare = m.vehicles ? m.isolatedCars / m.vehicles : 0;
  if (isolatedShare > t.maximumIsolatedShare) {
    penalty += (t.maximumIsolatedShare - isolatedShare) * 30;
  }
  if (m.bottleneckCells < t.minimumBottlenecks) {
    penalty += (m.bottleneckCells - t.minimumBottlenecks) * 1.5;
  }
  return penalty;
}

/**
 * True when a candidate satisfies the requirements that actually define the
 * tier, as opposed to the ones that merely describe it.
 *
 * Only four things are hard gates, and they are the four that decide whether
 * the player has to think:
 *
 * - the lot cannot be drained by thoughtless tapping;
 * - the solution genuinely repositions cars;
 * - not much is free on move one;
 * - few cars are bystanders.
 *
 * Dependency depth, solution length and bottleneck count are *descriptions* of
 * a hard lot rather than causes of one — a board can score well on all three
 * and still fall apart to tapping. Gating on them too made every requirement
 * fail together, so the generator shipped near-misses on exactly the lots that
 * needed to be hardest. They stay in the score, where a shortfall costs a
 * candidate its ranking without disqualifying it.
 */
export function meetsTarget(m: PuzzleMetrics, t: DifficultyTarget): boolean {
  // The headline requirement is a *boolean*, not a share: the lot must not be
  // finishable by tapping. How far tapping gets before it stalls is a matter of
  // degree that belongs in the score — rejecting a lot that strands the player
  // at 40% because the tier asked for 30% throws away a perfectly hard puzzle,
  // and on a tight board there may not be a better one to find.
  if (t.maximumGreedyShare < 1 && m.greedySolves) return false;
  return (
    m.repositionMoves >= t.temporaryMoveRequirement &&
    m.initialExitShare <= t.maximumInitialExitShare &&
    (m.vehicles === 0 || m.isolatedCars / m.vehicles <= t.maximumIsolatedShare)
  );
}
