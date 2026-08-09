/**
 * Gridlock City — solver and difficulty analysis.
 *
 * ## The one fact that shapes this module
 *
 * Vehicles only ever *leave*. Nothing is ever added to the lot, so removing a
 * car strictly frees cells: every move that was legal before an exit is still
 * legal after it. Two consequences follow, and they drive both the solver and
 * the generator:
 *
 *  1. **Taking an available exit is never a mistake.** If a car can drive off,
 *     driving it off cannot lengthen the rest of the solution — delete that
 *     car's moves from any optimal line and what remains is still legal. So the
 *     solver may greedily *cascade* every available exit before it thinks at
 *     all, and stay optimal.
 *  2. **A lot solvable by exits alone is not a puzzle.** It is confluent: any
 *     order works, so "tap whatever is free" clears it every time. The only
 *     thing a player can get *wrong* is a reposition, so the only thing that
 *     makes a lot hard is needing one.
 *
 * The search is therefore a Dijkstra-ish walk over *cascade-canonical* states —
 * states where nothing can leave — with slides as the only edges. Every exit
 * collapses into the canonicalisation, which removes the entire combinatorial
 * cost of ordering the easy part and leaves the search spending its budget on
 * the part that is actually a decision.
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
  probe,
  resolveMove,
  resolvePivot,
  stateKey,
  terrainAt,
} from './sim';
import { Dir, DX, DY, LevelDef, LotState, Move, MoveKind, OPPOSITE, Terrain } from './types';

export interface SolveResult {
  solvable: boolean;
  /** Slides to clear the lot. −1 when unknown. */
  parSlides: number;
  /** A witness solution, shortest found. */
  moves: Move[];
  /** True when the result is a proven optimum rather than a bounded best effort. */
  optimal: boolean;
  nodes: number;
  /** True when the whole lot clears without any vehicle repositioning. */
  exitOnly: boolean;
  /**
   * True when the search emptied its frontier inside budget. Only an exhausted
   * failure proves a lot is dead — a truncated one proves nothing, and the game
   * must never tell a player they are knotted on the strength of a timeout.
   */
  exhausted: boolean;
}

export interface SolveOptions {
  /** Node budget for the search. */
  maxNodes?: number;
  /** Skip the reposition search; exit-only failures report "not solvable here". */
  exitOnlyOnly?: boolean;
  /** A known-good line to fall back on when the search runs out of budget. */
  witness?: Move[];
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
  exhausted: false,
});

/* ------------------------------------------------------------------ *
 * Cheap single-vehicle undo
 * ------------------------------------------------------------------ */

export interface VehicleSnapshot {
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

/** Undo record for a single-vehicle move — far cheaper than cloning the lot. */
export function snapshotVehicle(s: LotState, vi: number): VehicleSnapshot {
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

export function restoreVehicle(s: LotState, u: VehicleSnapshot): void {
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
 * Lanes and routes
 * ------------------------------------------------------------------ */

/**
 * The cells a vehicle would drive through to reach its curb cut, ignoring other
 * vehicles. `null` when no straight route exists at all — a wall, a blocker, an
 * arrow pointing back, or simply no curb cut at the end of that lane.
 *
 * This is the backbone of every dependency claim the generator makes. A vehicle
 * leaves only along its facing, and a slide never changes which *lane* it is
 * in, so this route is fixed for the whole level except in distance. Whoever
 * stands on it has to be gone first — no ordering, no search, no argument.
 */
export function exitRoute(s: LotState, vi: number): number[] | null {
  const level = s.level;
  const f = s.facing[vi] as Dir;
  const cells: number[] = [];
  const limit = level.w + level.h;

  for (let k = 1; k <= limit; k++) {
    const cx = s.x[vi] + DX[f] * k;
    const cy = s.y[vi] + DY[f] * k;
    if (!inBounds(level, cx, cy)) {
      const px = s.x[vi] + DX[f] * (k - 1);
      const py = s.y[vi] + DY[f] * (k - 1);
      return exitIndexAt(level, px, py, f) >= 0 ? cells : null;
    }
    if (terrainAt(level, cx, cy) === Terrain.Blocked) return null;
    const arrow = level.arrows[cy * level.w + cx];
    if (arrow >= 0 && arrow !== f) return null;
    cells.push(cy * level.w + cx);
  }
  return null;
}

/**
 * Vehicles physically sitting on `vi`'s route to its curb cut.
 *
 * Because a vehicle only ever leaves along its facing, this list is an
 * *absolute* precedence: nothing on the route can be there when `vi` drives.
 * That makes the blocker graph a true DAG, independent of which valid order the
 * player picks.
 */
export function directBlockers(s: LotState, vi: number): number[] {
  const route = exitRoute(s, vi);
  if (!route) return [];
  const out: number[] = [];
  for (const c of route) {
    const occupant = s.occ[c];
    if (occupant >= 0 && occupant !== vi && !out.includes(occupant)) out.push(occupant);
  }
  return out;
}

/** Body cells a vehicle occupies right now. */
export function bodyCells(s: LotState, vi: number): number[] {
  const w = s.level.w;
  const f = s.facing[vi] as Dir;
  const out: number[] = [];
  for (let k = 0; k < s.len[vi]; k++) out.push((s.y[vi] - DY[f] * k) * w + (s.x[vi] - DX[f] * k));
  return out;
}

function bodyCellsAt(s: LotState, vi: number, x: number, y: number, f: Dir): number[] {
  const w = s.level.w;
  const out: number[] = [];
  for (let k = 0; k < s.len[vi]; k++) out.push((y - DY[f] * k) * w + (x - DX[f] * k));
  return out;
}

export function exitMoveFor(s: LotState, vi: number): Move | null {
  if (s.gone[vi]) return null;
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
 * The cascade
 * ------------------------------------------------------------------ */

/**
 * Drive off every car that can leave, repeatedly, until none can.
 *
 * Safe *and* optimal, for the reason in the module header: an exit never closes
 * a door. The fixpoint is unique — the order cars are taken in cannot change
 * which set ends up gone — so this doubles as a canonical form for search.
 */
export function cascadeExits(s: LotState, into?: Move[]): number {
  let taken = 0;
  for (;;) {
    let progressed = false;
    for (let vi = 0; vi < s.x.length; vi++) {
      if (s.gone[vi]) continue;
      const mv = exitMoveFor(s, vi);
      if (!mv) continue;
      applyMove(s, mv);
      into?.push(mv);
      taken++;
      progressed = true;
    }
    if (!progressed) return taken;
  }
}

/**
 * How far "tap whatever is free" gets on its own.
 *
 * This is the bot the whole redesign is aimed at. On a lot that needs no
 * repositioning it clears the board every time, whatever order it picks — which
 * is why such a lot has no puzzle in it.
 */
export function greedyClearance(level: LevelDef): { cleared: number; total: number } {
  const s = createLotState(level);
  const total = s.x.length;
  return { cleared: cascadeExits(s), total };
}

/* ------------------------------------------------------------------ *
 * Strategy 1 — exit-only search
 * ------------------------------------------------------------------ */

/**
 * An order in which every remaining vehicle drives straight off with no
 * repositioning, or null. The cascade settles this in one pass.
 */
export function solveExitOnly(start: LotState): number[] | null {
  const s = cloneLotState(start);
  const moves: Move[] = [];
  cascadeExits(s, moves);
  return s.remaining === 0 ? moves.map((m) => m.vi) : null;
}

/* ------------------------------------------------------------------ *
 * Strategy 2 — reposition search over cascade-canonical states
 * ------------------------------------------------------------------ */

interface SearchNode {
  state: LotState;
  moves: Move[];
  /** Slides spent. Exits are free: every car owes exactly one, always. */
  slides: number;
}

interface SlideOption {
  move: Move;
  /** True when the move takes the vehicle off cells somebody needs to drive through. */
  useful: boolean;
}

/** Every cell any surviving vehicle still has to drive across to get out. */
function routeCellSet(s: LotState): Set<number> {
  const out = new Set<number>();
  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    const r = exitRoute(s, vi);
    if (r) for (const c of r) out.add(c);
  }
  return out;
}

function overlapCount(cells: number[], set: Set<number>): number {
  let n = 0;
  for (const c of cells) if (set.has(c)) n++;
  return n;
}

/**
 * Every slide and pivot available, tagged with whether it clears contested
 * ground. Nothing is filtered out — a lot can need a car shuffled sideways
 * purely to make room for the car that matters — but the tag drives move
 * ordering, and move ordering is what keeps the search affordable.
 */
function slideOptions(s: LotState): SlideOption[] {
  const routes = routeCellSet(s);
  const out: SlideOption[] = [];

  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    const f = s.facing[vi] as Dir;
    const here = overlapCount(bodyCells(s, vi), routes);
    const seen = new Set<number>();

    for (const dir of [f, OPPOSITE[f]] as Dir[]) {
      const reach = probe(s, vi, dir).dist;
      for (let d = 1; d <= reach; d++) {
        const m = resolveMove(s, vi, dir, d);
        if (!m || m.kind !== MoveKind.Slide) continue;
        const key = m.toY * s.level.w + m.toX;
        if (seen.has(key)) continue;
        seen.add(key);
        const after = overlapCount(bodyCellsAt(s, vi, m.toX, m.toY, f), routes);
        out.push({ move: m, useful: after < here });
      }
    }

    const pv = resolvePivot(s, vi);
    // A pivot moves the vehicle into a different lane entirely, which is the
    // only way a car with no route at all ever gets one.
    if (pv) out.push({ move: pv, useful: true });
  }

  return out;
}

/**
 * Best-first over cascade-canonical states, `f = slides + remaining`.
 *
 * A slide costs 1 and clears nobody, so it raises f by one. A slide that
 * unlocks k cars drops f by k−1 once the cascade runs. Progress therefore sorts
 * itself to the front of the queue without any hand-tuned weighting.
 */
function searchRepositions(start: LotState, maxNodes: number): SolveResult {
  const seen = new Map<string, number>();
  const buckets: SearchNode[][] = [];
  let nodes = 0;
  let truncated = false;
  // The lowest bucket index holding work. It can move *down* as well as up:
  // one slide costs 1 but the cascade behind it may clear several cars, so a
  // child's f can be lower than its parent's. A single upward sweep would walk
  // past exactly the states that made the most progress and then report the lot
  // unsolvable — which, since that verdict tells the player they have ruined
  // the level, is the one wrong answer this search must never give.
  let cursor = 0;

  const root = cloneLotState(start);
  const rootMoves: Move[] = [];
  cascadeExits(root, rootMoves);

  const push = (node: SearchNode) => {
    const f = node.slides + node.state.remaining;
    if (f >= MAX_F) return;
    (buckets[f] ??= []).push(node);
    if (f < cursor) cursor = f;
  };

  push({ state: root, moves: rootMoves, slides: 0 });
  seen.set(stateKey(root), 0);

  while (cursor < MAX_F) {
    const bucket = buckets[cursor];
    if (!bucket || bucket.length === 0) {
      cursor++;
      continue;
    }
    const node = bucket.pop()!;
    if (isCleared(node.state)) {
      return {
        solvable: true,
        parSlides: node.moves.length,
        moves: node.moves,
        optimal: false,
        nodes,
        exitOnly: node.moves.every((m) => m.kind === MoveKind.Exit),
        exhausted: false,
      };
    }
    if (nodes >= maxNodes) {
      truncated = true;
      break;
    }

    const options = slideOptions(node.state);
    // Pushed useful-last so the bucket pops them first.
    options.sort((a, b) => Number(a.useful) - Number(b.useful));

    for (const opt of options) {
      const next = cloneLotState(node.state);
      applyMove(next, opt.move);
      const tail: Move[] = [opt.move];
      cascadeExits(next, tail);
      nodes++;
      const key = stateKey(next);
      const slides = node.slides + 1;
      const prev = seen.get(key);
      if (prev !== undefined && prev <= slides) continue;
      seen.set(key, slides);
      push({ state: next, moves: node.moves.concat(tail), slides });
    }
  }

  return { ...UNSOLVED, nodes, exhausted: !truncated };
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
      exhausted: true,
    };
  }

  const cascaded = cloneLotState(start);
  const moves: Move[] = [];
  cascadeExits(cascaded, moves);
  if (cascaded.remaining === 0) {
    // Clearing n cars needs at least n moves and this used exactly n.
    return {
      solvable: true,
      parSlides: moves.length,
      moves,
      optimal: true,
      nodes: 0,
      exitOnly: true,
      exhausted: true,
    };
  }

  if (opts.exitOnlyOnly) return { ...UNSOLVED, exhausted: true };

  const found = searchRepositions(start, opts.maxNodes ?? DEFAULT_MAX_NODES);
  if (found.solvable || !opts.witness) return found;

  // Budget ran out on a lot we were handed a line for. The line is still a line.
  return {
    solvable: true,
    parSlides: opts.witness.length,
    moves: opts.witness,
    optimal: false,
    nodes: found.nodes,
    exitOnly: opts.witness.every((m) => m.kind === MoveKind.Exit),
    exhausted: false,
  };
}

export function solveLevel(level: LevelDef, opts: SolveOptions = {}): SolveResult {
  return solveState(createLotState(level), {
    witness: level.parSolution,
    ...opts,
  });
}

/**
 * Dispatcher Call hint: the next few vehicles of a valid line from the player's
 * current position (GDD §5 "highlights the next 3 vehicles").
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

/** First move of a valid line — keeps a hint actionable mid-reposition. */
export function nextMoveHint(state: LotState): Move | null {
  const res = solveState(state, { maxNodes: 40_000 });
  return res.solvable && res.moves.length ? res.moves[0] : null;
}

/**
 * True when the lot can still be cleared from here.
 *
 * Deliberately one-sided: only a search that emptied its frontier is allowed to
 * say "dead". A budget that ran out means the game does not know, and a game
 * that does not know must not accuse the player of having ruined the lot.
 */
export function isStillSolvable(state: LotState): boolean {
  const res = solveState(state, { maxNodes: 60_000 });
  if (res.solvable) return true;
  return !res.exhausted;
}

/* ------------------------------------------------------------------ *
 * Dependency graph
 * ------------------------------------------------------------------ */

export type VehicleRole = 'chain' | 'gate' | 'blocked' | 'independent';

export interface DependencyNode {
  /** Index into the LotState arrays, which is also the index into level.vehicles. */
  vi: number;
  id: number;
  /** Human-readable lane, e.g. "col 3 ↓". */
  lane: string;
  /** Cars standing on this car's route out. All of them must clear first. */
  blockedBy: number[];
  /** Cars whose route this car stands on. */
  blocks: number[];
  /**
   * Blockers that share this car's axis. They cannot be nudged aside — a
   * vehicle never leaves its lane — so each one has to drive off the lot.
   */
  mustExitFirst: number[];
  /** Blockers lying across the lane, which can be repositioned instead. */
  canBeNudged: number[];
  /** Longest precedence chain ending at this car. */
  depth: number;
  /** True when this car has no straight route to any curb cut as it stands. */
  strandedUntilMoved: boolean;
  role: VehicleRole;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  /** `[blocker, waiter]` — blocker must clear before waiter can go. */
  edges: Array<[number, number]>;
  depth: number;
  /** Cars that block nobody and can drive off right now: pure scenery. */
  independent: number[];
}

function laneLabel(s: LotState, vi: number): string {
  const f = s.facing[vi] as Dir;
  const arrow = ['↑', '→', '↓', '←'][f];
  return f === 0 || f === 2 ? `col ${s.x[vi]} ${arrow}` : `row ${s.y[vi]} ${arrow}`;
}

/**
 * Who waits on whom, and why.
 *
 * The distinction that matters for difficulty is `mustExitFirst` versus
 * `canBeNudged`. A blocker on the same axis is a hard precedence — it shares
 * the lane and can never step out of it, so it has to leave the lot. A blocker
 * lying across the lane can be shunted sideways, which is what turns a lot from
 * an ordering exercise into a planning one.
 */
export function dependencyGraph(level: LevelDef): DependencyGraph {
  const s = createLotState(level);
  const n = s.x.length;

  const blockedBy: number[][] = [];
  const routeless: boolean[] = [];
  for (let vi = 0; vi < n; vi++) {
    blockedBy.push(directBlockers(s, vi));
    routeless.push(exitRoute(s, vi) === null);
  }

  const blocks: number[][] = Array.from({ length: n }, () => []);
  const edges: Array<[number, number]> = [];
  for (let vi = 0; vi < n; vi++) {
    for (const b of blockedBy[vi]) {
      blocks[b].push(vi);
      edges.push([b, vi]);
    }
  }

  // Longest path through the precedence DAG. 0 = unvisited, 1 = on the stack,
  // 2 = settled; an on-stack hit means a cycle, only possible when the lot needs
  // repositioning to break it, and is treated as a zero-length edge.
  const colour = new Uint8Array(n);
  const depth = new Array<number>(n).fill(1);
  const depthOf = (vi: number): number => {
    if (colour[vi] === 2) return depth[vi];
    if (colour[vi] === 1) return 0;
    colour[vi] = 1;
    let best = 1;
    for (const b of blockedBy[vi]) best = Math.max(best, depthOf(b) + 1);
    depth[vi] = best;
    colour[vi] = 2;
    return best;
  };

  const nodes: DependencyNode[] = [];
  const independent: number[] = [];
  for (let vi = 0; vi < n; vi++) {
    const d = depthOf(vi);
    const axis = (s.facing[vi] as Dir) % 2;
    const mustExitFirst = blockedBy[vi].filter((b) => (s.facing[b] as Dir) % 2 === axis);
    const canBeNudged = blockedBy[vi].filter((b) => (s.facing[b] as Dir) % 2 !== axis);
    const free = blockedBy[vi].length === 0 && !routeless[vi];
    const role: VehicleRole = free
      ? blocks[vi].length > 0
        ? 'gate'
        : 'independent'
      : blocks[vi].length > 0
        ? 'chain'
        : 'blocked';
    if (role === 'independent') independent.push(vi);
    nodes.push({
      vi,
      id: s.ids[vi],
      lane: laneLabel(s, vi),
      blockedBy: blockedBy[vi],
      blocks: blocks[vi],
      mustExitFirst,
      canBeNudged,
      depth: d,
      strandedUntilMoved: routeless[vi],
      role,
    });
  }

  return {
    nodes,
    edges,
    depth: nodes.reduce((a, b) => Math.max(a, b.depth), 0),
    independent,
  };
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
  /** `openExits` as a share of the lot, which is the comparable number. */
  openShare: number;
  /** Steps of the canonical solution with exactly one legal exit. */
  forcedSteps: number;
  vehicleCount: number;
  parSlides: number;

  /* --- the reposition-era metrics --- */

  /** Cars left standing after "tap whatever is free" runs out of moves. */
  greedyStall: number;
  /** `greedyStall` as a share. 0 means the lot is a pure ordering exercise. */
  greedyStallShare: number;
  /** True when tapping alone clears the lot — i.e. there is no puzzle here. */
  greedySolves: boolean;
  /** Repositioning slides in the canonical line. */
  repositionMoves: number;
  /** Cars that block nobody *and* have an open route: pure scenery. */
  independentCars: number;
  /** Share of cars that either block someone or are blocked by someone. */
  participation: number;
  /** Cars with no straight route out until something repositions. */
  strandedCars: number;
  /** Cells more than one vehicle must drive across — the contested ground. */
  bottleneckCells: number;
  /** Mean vehicles-per-contested-cell over those bottlenecks. */
  bottleneckPressure: number;
  /** Steps of the canonical line where the player had more than one option. */
  decisionPoints: number;
  /** Mean number of legal options across the canonical line. */
  branchingFactor: number;
}

/**
 * Contested ground: cells more than one car has to drive across.
 *
 * Two is the threshold that means something at this board size. A 7×10 lot with
 * fourteen cars has only about forty route-cells in total spread over seventy
 * cells, so insisting on three-deep contention would report zero on lots that
 * are visibly full of shared corridors. `pressure` carries the depth for the
 * lots that do stack higher.
 */
function bottlenecks(s: LotState): { cells: number; pressure: number } {
  const load = new Map<number, number>();
  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    const r = exitRoute(s, vi);
    if (!r) continue;
    for (const c of r) load.set(c, (load.get(c) ?? 0) + 1);
  }
  let cells = 0;
  let total = 0;
  for (const n of load.values()) {
    if (n < 2) continue;
    cells++;
    total += n;
  }
  return { cells, pressure: cells === 0 ? 0 : total / cells };
}

export function analyseDifficulty(level: LevelDef, solution?: Move[]): DifficultyMetrics {
  const graph = dependencyGraph(level);
  const state = createLotState(level);
  const n = state.x.length;

  const blocksSomeone = new Set<number>();
  for (const node of graph.nodes) for (const b of node.blockedBy) blocksSomeone.add(b);
  const engaged = graph.nodes.filter(
    (v) => v.blockedBy.length > 0 || v.blocks.length > 0 || v.strandedUntilMoved,
  ).length;

  const moves = solution ?? level.parSolution ?? solveLevel(level).moves;

  const replay = createLotState(level);
  const openExits = exitableVehicles(replay).length;
  let forcedSteps = 0;
  let decisionPoints = 0;
  let optionTotal = 0;
  for (const m of moves) {
    const exits = exitableVehicles(replay).length;
    if (m.kind === MoveKind.Exit && exits === 1) forcedSteps++;
    // Every step offers both the free exits and the shunts worth considering.
    // Counting only exits made a lot look forced whenever one car happened to
    // be free, when in fact that was the step with the most to think about.
    const options = exits + slideOptions(replay).filter((o) => o.useful).length;
    optionTotal += options;
    if (options > 1) decisionPoints++;
    applyMove(replay, m);
  }

  const greedy = greedyClearance(level);
  const stall = greedy.total - greedy.cleared;
  const neck = bottlenecks(state);

  return {
    knotDepth: graph.depth,
    distractorRatio: n === 0 ? 0 : 1 - blocksSomeone.size / n,
    openExits,
    openShare: n === 0 ? 0 : openExits / n,
    forcedSteps,
    vehicleCount: n,
    parSlides: moves.length,

    greedyStall: stall,
    greedyStallShare: n === 0 ? 0 : stall / n,
    greedySolves: stall === 0,
    repositionMoves: moves.filter((m) => m.kind !== MoveKind.Exit).length,
    independentCars: graph.independent.length,
    participation: n === 0 ? 0 : engaged / n,
    strandedCars: graph.nodes.filter((v) => v.strandedUntilMoved).length,
    bottleneckCells: neck.cells,
    bottleneckPressure: neck.pressure,
    decisionPoints,
    branchingFactor: moves.length === 0 ? 0 : optionTotal / moves.length,
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

/**
 * Can this lot be knotted for good, or only made awkward?
 *
 * On plain asphalt, every slide is reversible: a car that has just vacated a
 * run of cells can always drive straight back into them, because nothing else
 * moved in between. So the whole move history is walkable backwards, and since
 * an exit only ever frees cells, no reachable position is worse off than the
 * start — a lot with no one-ways, no oil and no plates cannot be ruined, only
 * lengthened.
 *
 * Which means the "you have knotted this for good" check — a full solve — never
 * needs to run at all on most lots. That matters now that a stretch jam may
 * legitimately open with nothing able to leave: without this, every reposition
 * on such a lot would kick off a search for a dead end that cannot exist.
 */
export function canDeadlock(level: LevelDef): boolean {
  if (level.arrows.some((a) => a >= 0)) return true;
  // Oil overshoots the cell the player asked for, and a plate only turns one
  // way. Either can leave a car somewhere it cannot retrace.
  return level.terrain.some((t) => t === Terrain.Oil || t === Terrain.Roundabout);
}

/**
 * Deadlock exposure: the share of opening slides that strand the lot for good.
 *
 * Sampled rather than exhaustive, and only meaningful on lots with one-way
 * arrows or oil, since every other slide can simply be driven back. Anything
 * above zero here is a lot that can punish a wrong first move — which the
 * design allows, but only where undo can walk it back.
 */
export function deadlockRisk(level: LevelDef, sample = 12): number {
  if (!canDeadlock(level)) return 0;
  const base = createLotState(level);
  const options = slideOptions(base);
  if (options.length === 0) return 0;
  const step = Math.max(1, Math.floor(options.length / sample));
  let tried = 0;
  let dead = 0;
  for (let i = 0; i < options.length; i += step) {
    const next = cloneLotState(base);
    applyMove(next, options[i].move);
    tried++;
    const res = solveState(next, { maxNodes: 20_000 });
    if (!res.solvable && res.exhausted) dead++;
  }
  return tried === 0 ? 0 : dead / tried;
}
