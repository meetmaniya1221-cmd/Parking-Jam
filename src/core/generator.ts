/**
 * JamForge — the level generator (GDD §6 "Production at Scale").
 *
 * ## Why this is built the way it is
 *
 * A vehicle only ever leaves the lot, and only ever straight along its facing.
 * Two facts fall out of that, and together they decide the whole design:
 *
 *  - **Taking a free exit is never a mistake**, because removing a car only
 *    frees cells. So if a lot can be cleared by exits alone, it can be cleared
 *    by tapping cars in *any* order — there is nothing to get wrong, and no
 *    amount of extra cars, blockers or knot depth changes that. It is a
 *    spot-the-open-lane exercise wearing a puzzle's clothes.
 *  - **A slide can be a mistake**, and a slide is the only thing that can be.
 *
 * So the unit of difficulty is not the blocking chain — it is the *cycle*. When
 * car A stands on car E's route and E stands on A's, neither can leave and no
 * ordering saves the player. The knot breaks only when A is shunted sideways
 * out of E's lane: a move that gets A no closer to its own exit and exists
 * purely to make room. That is the move the player has to find.
 *
 * ## How the lot gets built
 *
 * Backwards, from the empty lot, by inverse moves — so the construction *is* a
 * solution, replayed in reverse, and solvability is a property of the algorithm
 * rather than something the generator hopes a search will confirm:
 *
 *  - **un-exit**: park a car where it could drive straight off, and record that
 *    exit as the next-latest move. (This is the whole of the old generator.)
 *  - **un-slide**: haul a car already on the lot backwards along its lane to
 *    where it came from, and record the slide. Every car parked afterwards is
 *    a car that leaves *before* the slide, so the generator can then bury the
 *    slide behind prerequisites of its own.
 *
 * An un-slide is what mints a cycle. A car is dragged back into a cell that
 * sits on the route of a car already blocking it, and the two lock. Everything
 * else here — insertion scoring, the rejection gate — exists to make sure those
 * locks land on cars that matter and that nothing on the lot is scenery.
 */

import { Rng } from './rng';
import { analyseDifficulty, DifficultyMetrics, dependencyGraph, solveState } from './solver';
import { applyMove, createLotState, resolveMove, validateLevel } from './sim';
import {
  Band,
  BlockerStyle,
  Dir,
  DX,
  DY,
  ExitDef,
  LevelDef,
  Move,
  MoveKind,
  OPPOSITE,
  Terrain,
  VEHICLE_LENGTH,
  VehicleDef,
  VehicleKind,
  VehicleTag,
} from './types';

/* ------------------------------------------------------------------ *
 * Spec
 * ------------------------------------------------------------------ */

export interface ModifierSpec {
  blockers: number;
  oil: number;
  arrows: number;
  roundabouts: number;
  /** Internal wall with a gate opening — the "two rooms" read (GDD §6). */
  gate: boolean;
  vips: number;
  ambulances: number;
  trunks: number;
}

export const NO_MODIFIERS: ModifierSpec = Object.freeze({
  blockers: 0,
  oil: 0,
  arrows: 0,
  roundabouts: 0,
  gate: false,
  vips: 0,
  ambulances: 0,
  trunks: 0,
});

/**
 * The shape of the puzzle, as a set of numbers a designer can move.
 *
 * These are *targets*, not guarantees: a 5×6 lot cannot hold a depth-9 knot no
 * matter how many seeds it is offered. `generateLevel` builds candidates until
 * one clears the hard gates, and keeps the closest miss if none does.
 */
export interface DifficultyTargets {
  /** Longest "must leave before" chain the lot should reach. */
  dependencyDepth: number;
  /** Floor on the canonical line's length, in moves. */
  minimumSolutionMoves: number;
  /** Ceiling on cars that may drive off on move one. */
  maximumInitialExits: number;
  /** Floor on cars that start blocked, or blocking, or both. */
  minimumBlockedCars: number;
  /** Floor on cells that more than one route has to cross. */
  minimumBottlenecks: number;
  /**
   * Floor on cars that may drive off on move one.
   *
   * Zero is legal and, above the on-ramp, wanted: a lot whose first move is a
   * reposition is a lot the player has to read before they can touch it. The
   * on-ramp keeps this at one so a new player always has something to tap.
   */
  minimumInitialExits: number;
  /**
   * How many separate knots the construction should tie — loops of cars that
   * share no members with each other.
   */
  temporaryMoveRequirement: number;
  /**
   * Floor on repositioning slides in the *shortest* line the solver can find.
   *
   * Distinct from the above, and the honest number of the two: knots that share
   * cars come undone together, so a lot built with six interlocks may still
   * have a one-shunt solution. This is measured after the solve, not before.
   */
  minimumRequiredRepositions: number;
  /**
   * Cars that must still be standing once "tap whatever is free" runs dry.
   *
   * The single most important number here. At zero the lot is solvable by
   * reflex; the whole redesign is an attempt to hold this well above it.
   */
  minimumGreedyStall: number;
  /** Cars that must slide more than once, at least one of them turning around. */
  backtrackingRequirement: number;
  /** Ceiling on cars that block nobody and can leave whenever they like. */
  maximumIndependentCars: number;
}

export const DEFAULT_TARGETS: DifficultyTargets = Object.freeze({
  dependencyDepth: 3,
  minimumSolutionMoves: 0,
  maximumInitialExits: 99,
  minimumBlockedCars: 0,
  minimumBottlenecks: 0,
  minimumInitialExits: 1,
  temporaryMoveRequirement: 0,
  minimumRequiredRepositions: 0,
  minimumGreedyStall: 0,
  backtrackingRequirement: 0,
  maximumIndependentCars: 99,
});

export interface LevelSpec {
  id: string;
  index: number;
  seed: number;
  band: Band;
  patternTags: string[];
  w: number;
  h: number;
  /** How many edges open onto the street. */
  streetSides: number;
  /** Share of each of those edges that is curb cut, 0–1. */
  streetWidth: number;
  vehicleCount: number;
  /** Weighted length mix, e.g. { 2: 6, 3: 2, 4: 1 }. */
  lengthMix: Record<number, number>;
  modifiers: ModifierSpec;
  targets: DifficultyTargets;
}

/* ------------------------------------------------------------------ *
 * Working board
 * ------------------------------------------------------------------ */

interface Work {
  w: number;
  h: number;
  terrain: Terrain[];
  arrows: number[];
  blockerStyle: number[];
  spin: number[];
  exits: ExitDef[];
  occ: Int16Array;
  vehicles: VehicleDef[];
  len: number[];
  /**
   * Each vehicle's straight run from where it stands to its curb cut, whoever
   * happens to be parked on it. Exactly what `exitRoute` reports in the solver,
   * and kept exactly that so the generator and the analysis never disagree
   * about who is in whose way.
   */
  needs: number[][];
  /** The forward solution, built back to front. */
  witness: Move[];
  /** Slide directions recorded per vehicle, for the backtracking count. */
  slideDirs: Dir[][];
}

function makeWork(w: number, h: number): Work {
  return {
    w,
    h,
    terrain: new Array(w * h).fill(Terrain.Road),
    arrows: new Array(w * h).fill(-1),
    blockerStyle: new Array(w * h).fill(BlockerStyle.Cone),
    spin: new Array(w * h).fill(0),
    exits: [],
    occ: new Int16Array(w * h).fill(-1),
    vehicles: [],
    len: [],
    needs: [],
    witness: [],
    slideDirs: [],
  };
}

const inW = (k: Work, x: number, y: number) => x >= 0 && y >= 0 && x < k.w && y < k.h;

function hasExit(k: Work, x: number, y: number, dir: Dir): boolean {
  for (const e of k.exits) if (e.x === x && e.y === y && e.dir === dir) return true;
  return false;
}

/** Cells a vehicle with this nose/facing/length would occupy, or null if it does not fit. */
function bodyCells(k: Work, x: number, y: number, facing: Dir, len: number): number[] | null {
  const cells: number[] = [];
  for (let i = 0; i < len; i++) {
    const cx = x - DX[facing] * i;
    const cy = y - DY[facing] * i;
    if (!inW(k, cx, cy)) return null;
    const idx = cy * k.w + cx;
    if (k.terrain[idx] === Terrain.Blocked) return null;
    if (k.occ[idx] !== -1) return null;
    cells.push(idx);
  }
  return cells;
}

function occupiedCells(k: Work, vi: number): number[] {
  const v = k.vehicles[vi];
  const out: number[] = [];
  for (let i = 0; i < k.len[vi]; i++) {
    out.push((v.y - DY[v.facing] * i) * k.w + (v.x - DX[v.facing] * i));
  }
  return out;
}

/**
 * Straight path from a nose cell to a curb cut, as cell indices *ahead* of the
 * nose (exclusive). Returns null when no clear route exists.
 */
function exitRay(k: Work, x: number, y: number, facing: Dir): number[] | null {
  const path: number[] = [];
  const limit = k.w + k.h;
  for (let step = 1; step <= limit; step++) {
    const cx = x + DX[facing] * step;
    const cy = y + DY[facing] * step;
    if (!inW(k, cx, cy)) {
      const px = x + DX[facing] * (step - 1);
      const py = y + DY[facing] * (step - 1);
      return hasExit(k, px, py, facing) ? path : null;
    }
    const idx = cy * k.w + cx;
    if (k.terrain[idx] === Terrain.Blocked) return null;
    const arrow = k.arrows[idx];
    if (arrow >= 0 && arrow !== facing) return null;
    if (k.occ[idx] !== -1) return null;
    path.push(idx);
  }
  return null;
}

/** Same walk but tolerating vehicles: the lane a car needs, whoever is on it. */
function exitRayThroughVehicles(k: Work, x: number, y: number, facing: Dir): number[] | null {
  const path: number[] = [];
  const limit = k.w + k.h;
  for (let step = 1; step <= limit; step++) {
    const cx = x + DX[facing] * step;
    const cy = y + DY[facing] * step;
    if (!inW(k, cx, cy)) {
      const px = x + DX[facing] * (step - 1);
      const py = y + DY[facing] * (step - 1);
      return hasExit(k, px, py, facing) ? path : null;
    }
    const idx = cy * k.w + cx;
    if (k.terrain[idx] === Terrain.Blocked) return null;
    const arrow = k.arrows[idx];
    if (arrow >= 0 && arrow !== facing) return null;
    path.push(idx);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Board furniture
 * ------------------------------------------------------------------ */

/**
 * Open the lot onto the street.
 *
 * A frontage is a contiguous run of curb cuts along one edge, not a lone gap:
 * that is what a real lot looks like, and it is what lets a lot hold fifteen
 * cars while still reading cleanly. Narrowing the run is the design lever —
 * a two-cell frontage is the Plug, a wide one is a breather.
 *
 * Edges open in opposing pairs, bottom first, and **the two edges of a pair get
 * the same run of cells**. That is not cosmetic. A dependency loop needs cars
 * pushing against each other on both axes at once, which needs a patch of lot
 * where all four facings have somewhere to go: the columns served north *and*
 * south, crossed with the rows served east *and* west. Offset the runs
 * independently and a narrow-frontage lot can end up with that patch empty —
 * every car still has a way out, but no four of them can ever lock. Sharing the
 * offset makes the served core a solid block, and reads on screen as a street
 * running clean through the lot.
 */
function placeExits(k: Work, rng: Rng, sideCount: number, widthRatio: number): void {
  // Vertical pair first: curb cuts near the thumb read best in portrait.
  const pairs: Array<[Dir, Dir]> = [
    [2, 0],
    [1, 3],
  ];
  let opened = 0;
  const wanted = Math.max(1, Math.min(4, sideCount));

  for (const pair of pairs) {
    if (opened >= wanted) break;
    const edgeLen = pair[0] === 0 || pair[0] === 2 ? k.w : k.h;
    // A frontage under two cells starves the lot: only one lane could ever leave.
    const span = Math.max(2, Math.min(edgeLen, Math.round(edgeLen * widthRatio)));
    const start = rng.int(edgeLen - span + 1);
    for (const dir of pair) {
      if (opened >= wanted) break;
      for (let j = start; j < start + span; j++) {
        if (dir === 0) k.exits.push({ x: j, y: 0, dir });
        else if (dir === 2) k.exits.push({ x: j, y: k.h - 1, dir });
        else if (dir === 1) k.exits.push({ x: k.w - 1, y: j, dir });
        else k.exits.push({ x: 0, y: j, dir });
      }
      opened++;
    }
  }
}

/** Curb-cut cells: never buried under a blocker or an internal wall. */
function exitApproachCells(k: Work): Set<number> {
  const keep = new Set<number>();
  for (const e of k.exits) keep.add(e.y * k.w + e.x);
  return keep;
}

function placeGate(k: Work, rng: Rng): void {
  // An internal wall with a single opening splits the lot into two rooms.
  const vertical = k.w >= k.h;
  const keep = exitApproachCells(k);
  if (vertical) {
    const col = Math.floor(k.w / 2);
    const gap = rng.range(1, k.h - 2);
    for (let y = 0; y < k.h; y++) {
      if (y === gap) continue;
      const idx = y * k.w + col;
      if (keep.has(idx)) continue;
      k.terrain[idx] = Terrain.Blocked;
      k.blockerStyle[idx] = BlockerStyle.Wall;
    }
  } else {
    const row = Math.floor(k.h / 2);
    const gap = rng.range(1, k.w - 2);
    for (let x = 0; x < k.w; x++) {
      if (x === gap) continue;
      const idx = row * k.w + x;
      if (keep.has(idx)) continue;
      k.terrain[idx] = Terrain.Blocked;
      k.blockerStyle[idx] = BlockerStyle.Wall;
    }
  }
}

function scatterTerrain(k: Work, rng: Rng, spec: LevelSpec): void {
  const keep = exitApproachCells(k);
  const free: number[] = [];
  for (let i = 0; i < k.terrain.length; i++) {
    if (k.terrain[i] === Terrain.Road && !keep.has(i)) free.push(i);
  }
  rng.shuffle(free);
  let cursor = 0;

  const take = () => (cursor < free.length ? free[cursor++] : -1);

  for (let i = 0; i < spec.modifiers.blockers; i++) {
    const idx = take();
    if (idx < 0) break;
    k.terrain[idx] = Terrain.Blocked;
    k.blockerStyle[idx] = rng.pick([BlockerStyle.Cone, BlockerStyle.Dumpster, BlockerStyle.Planter]);
  }
  for (let i = 0; i < spec.modifiers.oil; i++) {
    const idx = take();
    if (idx < 0) break;
    k.terrain[idx] = Terrain.Oil;
  }
  for (let i = 0; i < spec.modifiers.roundabouts; i++) {
    const idx = take();
    if (idx < 0) break;
    k.terrain[idx] = Terrain.Roundabout;
    k.spin[idx] = rng.bool() ? 1 : -1;
  }
  for (let i = 0; i < spec.modifiers.arrows; i++) {
    const idx = take();
    if (idx < 0) break;
    k.arrows[idx] = rng.int(4);
  }
}

/* ------------------------------------------------------------------ *
 * Un-exit: park a car that could drive straight off
 * ------------------------------------------------------------------ */

interface Candidate {
  x: number;
  y: number;
  facing: Dir;
  cells: number[];
  /** Cars already on the lot that this candidate would stand in the way of. */
  blocks: number[];
  /** Cells between this candidate's nose and its own curb cut. */
  rayLen: number;
  /** Cells of that run somebody else also has to drive across. */
  shared: number;
}

function collectCandidates(k: Work, len: number): Candidate[] {
  const out: Candidate[] = [];
  // How many cars already need each cell — the map of contested ground.
  const load = new Map<number, number>();
  for (const need of k.needs) for (const c of need) load.set(c, (load.get(c) ?? 0) + 1);

  for (let y = 0; y < k.h; y++) {
    for (let x = 0; x < k.w; x++) {
      for (let f = 0 as Dir; f < 4; f = (f + 1) as Dir) {
        const cells = bodyCells(k, x, y, f, len);
        if (!cells) continue;
        const ray = exitRay(k, x, y, f);
        if (!ray) continue;
        const blocks: number[] = [];
        for (let vi = 0; vi < k.vehicles.length; vi++) {
          for (const c of cells) {
            if (k.needs[vi].includes(c)) {
              blocks.push(vi);
              break;
            }
          }
        }
        let shared = 0;
        for (const c of ray) shared += load.get(c) ?? 0;
        out.push({ x, y, facing: f, cells, blocks, rayLen: ray.length, shared });
      }
    }
  }
  return out;
}

/**
 * How many cars are still standing once "tap whatever is free" runs dry, read
 * straight off the partial lot.
 *
 * The same fixpoint `cascadeExits` computes in the simulator, done here on the
 * cell arrays so the generator can steer by it while it works rather than
 * finding out after the fact.
 */
function stalledCount(k: Work): number {
  const n = k.vehicles.length;
  const gone = new Uint8Array(n);
  const occ = Int16Array.from(k.occ);
  let left = n;
  for (;;) {
    let progressed = false;
    for (let vi = 0; vi < n; vi++) {
      if (gone[vi]) continue;
      if (k.needs[vi].some((c) => occ[c] !== -1)) continue;
      gone[vi] = 1;
      left--;
      progressed = true;
      for (const c of occupiedCells(k, vi)) occ[c] = -1;
    }
    if (!progressed) return left;
  }
}

/** Cars nobody is standing in front of — the ones that could drive off today. */
function openVehicles(k: Work): Set<number> {
  const open = new Set<number>();
  for (let vi = 0; vi < k.vehicles.length; vi++) {
    let blocked = false;
    for (const c of k.needs[vi]) {
      if (k.occ[c] !== -1) {
        blocked = true;
        break;
      }
    }
    if (!blocked) open.add(vi);
  }
  return open;
}

/**
 * For every car on the partial lot, the length of the longest precedence chain
 * that *ends* at it — how deep the knot already is above that car.
 *
 * Parking a new vehicle in front of car `b` therefore yields a chain of
 * `heights[b] + 1`, which is what lets the generator deepen the knot from
 * whichever car happens to be reachable rather than from one designated tail.
 */
function chainHeights(k: Work): number[] {
  const n = k.vehicles.length;
  const waiters: number[][] = Array.from({ length: n }, () => []);
  for (let vi = 0; vi < n; vi++) {
    const seen = new Set<number>();
    for (const c of k.needs[vi]) {
      const occupant = k.occ[c];
      if (occupant !== -1 && occupant !== vi && !seen.has(occupant)) {
        seen.add(occupant);
        waiters[occupant].push(vi);
      }
    }
  }

  const colour = new Uint8Array(n);
  const height = new Array<number>(n).fill(1);
  const walk = (vi: number): number => {
    if (colour[vi] === 2) return height[vi];
    if (colour[vi] === 1) return 0;
    colour[vi] = 1;
    let best = 1;
    for (const w of waiters[vi]) best = Math.max(best, walk(w) + 1);
    height[vi] = best;
    colour[vi] = 2;
    return best;
  };
  for (let vi = 0; vi < n; vi++) walk(vi);
  return height;
}

/** Pick randomly from the best few candidates — keeps lots varied but purposeful. */
function chooseBest<T>(rng: Rng, pool: T[], score: (c: T) => number, topK = 4): T {
  const scored = pool.map((c) => ({ c, s: score(c) }));
  scored.sort((a, b) => b.s - a.s);
  return scored[rng.int(Math.min(topK, scored.length))].c;
}

function kindForLength(len: number, tags: number, rng: Rng): VehicleKind {
  if (tags & VehicleTag.Ambulance) return VehicleKind.Ambulance;
  switch (len) {
    case 2:
      return rng.pick([VehicleKind.Sedan, VehicleKind.Taxi, VehicleKind.Coupe]);
    case 3:
      return rng.pick([VehicleKind.Van, VehicleKind.BoxTruck]);
    case 4:
      return VehicleKind.Trailer;
    default:
      return VehicleKind.Bus;
  }
}

function commit(k: Work, rng: Rng, c: Candidate, tags: number): void {
  const id = k.vehicles.length;
  const len = c.cells.length;
  for (const idx of c.cells) k.occ[idx] = id;
  k.vehicles.push({
    id,
    kind: kindForLength(len, tags, rng),
    x: c.x,
    y: c.y,
    facing: c.facing,
    tags,
    hue: rng.int(8),
  });
  k.len.push(len);
  k.slideDirs.push([]);
  k.needs.push(exitRayThroughVehicles(k, c.x, c.y, c.facing) ?? []);
  // This car's exit is the next-latest move in the forward line. The nose
  // travels to the curb-cut cell itself, which is the last cell of the ray.
  k.witness.unshift({
    kind: MoveKind.Exit,
    vi: id,
    dir: c.facing,
    distance: c.rayLen,
    toX: c.x + DX[c.facing] * c.rayLen,
    toY: c.y + DY[c.facing] * c.rayLen,
    slidExtra: 0,
  });
}

function pickLength(rng: Rng, mix: Record<number, number>): number {
  const lens = Object.keys(mix).map(Number);
  const weights = lens.map((l) => mix[l]);
  return rng.weighted(lens, weights);
}

/* ------------------------------------------------------------------ *
 * Un-slide: haul a car back to where it came from
 * ------------------------------------------------------------------ */

interface Unslide {
  vi: number;
  /** Direction the car will travel when the player finally makes this move. */
  dir: Dir;
  distance: number;
  /** Nose the car is being moved back to. */
  fromX: number;
  fromY: number;
  /** Every cell the car's body passes over on its way forward again, inclusive. */
  swept: number[];
  /** Body cells at the new, earlier position. */
  cells: number[];
  /** Cars whose route this car will now be sitting on. */
  blocks: number[];
  /** Of those, the ones that already have to clear before *it* can go. */
  cycles: number[];
}

/**
 * Who, transitively, has to be gone before each car can leave.
 *
 * `reach[b][v]` is "b must clear before v". Parking cars one at a time can only
 * ever produce a DAG here — a car is parked with its own lane clear, so it can
 * only ever come to block cars parked *earlier* — and a DAG is precisely why
 * the old lots fell to tapping: a DAG always has a source, so something can
 * always leave. Reading the closure is how the generator finds a drag that puts
 * a car back into the lane of something already ahead of it in the order, which
 * is the one way to close the loop.
 */
function blockingClosure(k: Work): { edge: boolean[][]; reach: boolean[][] } {
  const n = k.vehicles.length;
  const edge = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (let v = 0; v < n; v++) {
    for (const c of k.needs[v]) {
      const b = k.occ[c];
      if (b !== -1 && b !== v) edge[b][v] = true;
    }
  }
  const reach = edge.map((row) => row.slice());
  for (let m = 0; m < n; m++) {
    for (let b = 0; b < n; b++) {
      if (!reach[b][m]) continue;
      for (let v = 0; v < n; v++) if (reach[m][v]) reach[b][v] = true;
    }
  }
  return { edge, reach };
}

interface InterlockResult {
  undo: () => void;
  /**
   * True when the loop this drag closed is made entirely of cars no earlier
   * loop touched — the only case that adds a reposition to the *minimum*
   * solution rather than merely to the generator's own line.
   */
  standalone: boolean;
}

/** Shortest chain of "must clear first" arrows from `from` to `to`, inclusive. */
function blockingPath(edge: boolean[][], from: number, to: number): number[] {
  const n = edge.length;
  const prev = new Int32Array(n).fill(-2);
  const queue = [from];
  prev[from] = -1;
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    if (u === to) break;
    for (let v = 0; v < n; v++) {
      if (!edge[u][v] || prev[v] !== -2) continue;
      prev[v] = u;
      queue.push(v);
    }
  }
  if (prev[to] === -2) return [from, to];
  const path: number[] = [];
  for (let at = to; at !== -1; at = prev[at]) path.push(at);
  return path;
}

/**
 * Every legal way to drag `vi` backwards along its lane.
 *
 * The swept corridor is held to plain asphalt on purpose. Oil would carry the
 * car past where the generator meant to stop it, an arrow could bar the move
 * the line depends on, and a roundabout invites a pivot mid-slide — all three
 * would break the promise that the recorded move is the move the player makes.
 */
function unslideOptions(
  k: Work,
  vi: number,
  maxDistance: number,
  reach: boolean[][],
): Unslide[] {
  const v = k.vehicles[vi];
  const f = v.facing;
  const len = k.len[vi];
  const here = occupiedCells(k, vi);
  const out: Unslide[] = [];

  // Lift the car off the board for the duration: every question asked below —
  // is the lane clear, would the drag reach the curb — is about the lot without
  // it, and its own body would answer all of them wrongly.
  for (const c of here) k.occ[c] = -1;

  for (const dir of [f, OPPOSITE[f]] as Dir[]) {
    const swept: number[] = [...here];
    for (let d = 1; d <= maxDistance; d++) {
      const nx = v.x - DX[dir] * d;
      const ny = v.y - DY[dir] * d;
      // Dragging forward, the body's trailing end reaches furthest back;
      // reversing, it is the nose that leads. Either way exactly one new cell
      // comes into play per cell of travel.
      const lead =
        dir === f ? { x: nx - DX[f] * (len - 1), y: ny - DY[f] * (len - 1) } : { x: nx, y: ny };
      if (!inW(k, lead.x, lead.y)) break;
      const idx = lead.y * k.w + lead.x;
      if (k.terrain[idx] !== Terrain.Road) break;
      if (k.arrows[idx] !== -1) break;
      if (k.occ[idx] !== -1) break;
      swept.push(idx);

      const cells: number[] = [];
      for (let i = 0; i < len; i++) cells.push((ny - DY[f] * i) * k.w + (nx - DX[f] * i));

      // Would the player's drag run straight out of the lot rather than stop
      // here? Only a forward drag can, and only if the curb is within reach.
      if (dir === f) {
        const ray = exitRay(k, nx, ny, f);
        if (ray && ray.length <= d) continue;
      }

      const blocks: number[] = [];
      const cycles: number[] = [];
      for (let u = 0; u < k.vehicles.length; u++) {
        if (u === vi) continue;
        if (!cells.some((c) => k.needs[u].includes(c))) continue;
        blocks.push(u);
        // u already has to clear before this car can go, and parking here puts
        // this car in u's way. Now neither can leave, and no exit order unties
        // it — only the drag back out does.
        if (reach[u][vi]) cycles.push(u);
      }

      out.push({
        vi,
        dir,
        distance: d,
        fromX: nx,
        fromY: ny,
        swept: swept.slice(),
        cells,
        blocks,
        cycles,
      });
    }
  }

  for (const c of here) k.occ[c] = vi;
  return out;
}

/** Apply an interlock, returning the undo — the caller decides if it earned its move. */
function applyUnslide(k: Work, u: Unslide): () => void {
  const v = k.vehicles[u.vi];
  const to = { x: v.x, y: v.y };
  const wasNeeds = k.needs[u.vi];
  const wasCells = occupiedCells(k, u.vi);

  for (const c of wasCells) k.occ[c] = -1;
  v.x = u.fromX;
  v.y = u.fromY;
  for (const c of u.cells) k.occ[c] = u.vi;

  k.slideDirs[u.vi].push(u.dir);
  // Re-read the run to the curb from where the car now stands. Note this is
  // *not* the sweep it will make: a car dragged backwards out of somebody's
  // lane ends up nearer its own curb than it started, and if that run is clear
  // it simply drives off without ever making the recorded move. The recorded
  // move is a line the player *may* take, and the route is what they need.
  k.needs[u.vi] = exitRayThroughVehicles(k, u.fromX, u.fromY, v.facing) ?? [];

  k.witness.unshift({
    kind: MoveKind.Slide,
    vi: u.vi,
    dir: u.dir,
    distance: u.distance,
    toX: to.x,
    toY: to.y,
    slidExtra: 0,
  });

  return () => {
    k.witness.shift();
    k.slideDirs[u.vi].pop();
    k.needs[u.vi] = wasNeeds;
    for (const c of u.cells) k.occ[c] = -1;
    v.x = to.x;
    v.y = to.y;
    for (const c of wasCells) k.occ[c] = u.vi;
  };
}

/**
 * Author one interlock: haul some car backwards until it is standing in
 * somebody's way, and record the drag that will get it out again.
 *
 * The preference order is the whole design. A drag that creates a **cycle** —
 * this car is in that car's lane and that car is in this one's — is worth far
 * more than one that merely creates a blocker, because a cycle is the only
 * thing a better exit order cannot untie. Corking a car that could otherwise
 * drive off comes next, since that is what stops the lot being read at a
 * glance. Short drags beat long ones: a car shuffling one cell aside to let
 * another past reads as a decision, where a car crossing the lot reads as a
 * second exit.
 */
function tryInterlock(
  k: Work,
  rng: Rng,
  maxDistance: number,
  cyclesOnly: boolean,
  openFloor: number,
  knotted: Set<number>,
): InterlockResult | null {
  const { edge, reach } = blockingClosure(k);
  const open = openVehicles(k);
  const idle = new Set<number>(k.vehicles.keys());
  for (let vi = 0; vi < k.vehicles.length; vi++) {
    for (let u = 0; u < k.vehicles.length; u++) if (u !== vi && reach[vi][u]) idle.delete(vi);
  }

  const pool: Unslide[] = [];
  for (const vi of k.vehicles.keys()) {
    for (const opt of unslideOptions(k, vi, maxDistance, reach)) {
      if (opt.blocks.length > 0) pool.push(opt);
    }
  }

  const cyclic = pool.filter((o) => o.cycles.length > 0);
  // The cars a loop is made of, so two loops can be told apart. Two loops that
  // share a car are not two problems: one shunt unties both, and the lot's
  // *minimum* solution still holds a single reposition however many knots the
  // construction thinks it tied. Only a loop of untouched cars adds a move the
  // player has to find, so this is what the quota counts.
  const members = new Map<Unslide, number[]>();
  for (const o of cyclic) {
    const vs = new Set<number>([o.vi]);
    for (const c of o.cycles) for (const v of blockingPath(edge, c, o.vi)) vs.add(v);
    members.set(o, [...vs]);
  }
  const isFresh = (o: Unslide) => (members.get(o) ?? [o.vi]).every((v) => !knotted.has(v));

  // A drag that only adds a blocker leaves the lot a DAG, and a DAG still falls
  // to tapping. Where the quota is what matters, take it anyway; where the
  // point is the knot, hold out for a real loop.
  const fresh = cyclic.filter(isFresh);
  const use = fresh.length > 0 ? fresh : cyclic.length > 0 ? cyclic : cyclesOnly ? [] : pool;
  if (use.length === 0) return null;

  const n = k.vehicles.length;
  const pick = chooseBest(rng, use, (o) => {
    const turnaround = k.slideDirs[o.vi].some((d) => d === OPPOSITE[o.dir]) ? 8 : 0;
    // Corking is worth points only while the lot still has cars to spare above
    // the opening its band is supposed to offer.
    const corks = open.size > openFloor ? o.blocks.filter((b) => open.has(b)).length : 0;
    // A car that is in nobody's way is scenery; giving it a job is worth doing.
    const rescue = idle.has(o.vi) ? 12 : 0;
    // Everything downstream of the new knot is stuck behind it too. A loop tied
    // at the mouth of the lot holds far more cars than one tied in a corner,
    // and holding cars is the entire point.
    let trapped = 0;
    for (let v = 0; v < n; v++) {
      if (v === o.vi) continue;
      if (reach[o.vi][v] || o.cycles.some((c) => reach[c][v])) trapped++;
    }
    return (
      o.cycles.length * 40 +
      trapped * 5 +
      corks * 26 +
      o.blocks.length * 6 +
      rescue +
      turnaround -
      o.distance * 2
    );
  });

  const standalone = isFresh(pick) && pick.cycles.length > 0;
  for (const v of members.get(pick) ?? [pick.vi]) knotted.add(v);
  return { undo: applyUnslide(k, pick), standalone };
}

/* ------------------------------------------------------------------ *
 * Scenery removal
 * ------------------------------------------------------------------ */

/** Take a car off the lot, and its move out of the line. */
function removeVehicle(k: Work, vi: number): void {
  for (const c of occupiedCells(k, vi)) k.occ[c] = -1;
  k.vehicles.splice(vi, 1);
  k.len.splice(vi, 1);
  k.needs.splice(vi, 1);
  k.slideDirs.splice(vi, 1);
  for (let i = 0; i < k.vehicles.length; i++) k.vehicles[i].id = i;
  for (let i = 0; i < k.occ.length; i++) if (k.occ[i] > vi) k.occ[i]--;
  k.witness = k.witness
    .filter((m) => m.vi !== vi)
    .map((m) => (m.vi > vi ? { ...m, vi: m.vi - 1 } : m));
}

/**
 * Drop any car that blocks nobody and could drive off whenever it liked.
 *
 * Such a car is not a distractor, it is furniture: the player removes it in one
 * tap and the lot is exactly as it was. Better a smaller jam where every car is
 * load-bearing than a fuller one padded out with cars that are only there to
 * look busy. Removing a car can never make a lot unsolvable — it only frees
 * cells — so this is always safe.
 *
 * Bounded, because a lot that keeps producing scenery after three removals is
 * a lot built wrong, and the seed after it costs less than salvaging this one.
 */
function pruneScenery(k: Work, limit: number): boolean {
  for (let removed = 0; removed <= limit; removed++) {
    let victim = -1;
    for (let vi = 0; vi < k.vehicles.length && victim < 0; vi++) {
      if (k.needs[vi].some((c) => k.occ[c] !== -1)) continue;
      const mine = occupiedCells(k, vi);
      let useful = false;
      for (let u = 0; u < k.vehicles.length && !useful; u++) {
        if (u !== vi) useful = mine.some((c) => k.needs[u].includes(c));
      }
      if (!useful) victim = vi;
    }
    if (victim < 0) return true;
    if (removed === limit) return false;
    removeVehicle(k, victim);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

function buildOnce(spec: LevelSpec, seed: number): LevelDef | null {
  const rng = new Rng(seed);
  const k = makeWork(spec.w, spec.h);
  const t = spec.targets;

  placeExits(k, rng, spec.streetSides, spec.streetWidth);
  if (spec.modifiers.gate) placeGate(k, rng);
  scatterTerrain(k, rng, spec);

  const total = spec.vehicleCount;
  // VIPs must leave first, so under reverse construction they go in last.
  const vipFrom = total - spec.modifiers.vips;
  // Interlocks need cars to lock together, so they start once the lot has some.
  // They are spread through the run rather than saved for the end: a drag
  // authored halfway through can be buried behind cars parked afterwards, and
  // that is what puts the repositions *inside* the solution instead of all at
  // its opening.
  const knotted = new Set<number>();
  const firstInterlock = Math.max(2, Math.round(total * 0.3));
  const interlockEvery = Math.max(
    1,
    Math.floor((total - firstInterlock) / Math.max(1, t.temporaryMoveRequirement)),
  );
  let interlocks = 0;
  /** Interlocks that closed a loop of cars no earlier loop touched. */
  let knots = 0;

  for (let i = 0; i < total; i++) {
    const len = pickLength(rng, spec.lengthMix);
    let candidates = collectCandidates(k, len);
    if (candidates.length === 0 && len > 2) candidates = collectCandidates(k, 2);
    if (candidates.length === 0) break;

    const heights = i === 0 ? [] : chainHeights(k);
    const open = openVehicles(k);

    let pool: Candidate[];
    let score: (c: Candidate) => number;

    if (i === 0) {
      // Anchor the knot deep in the lot so the chain has room to grow.
      pool = candidates;
      score = (c) => c.rayLen;
    } else {
      // Never park scenery. A candidate that blocks nobody is only considered
      // when the lot has nothing better to offer.
      pool = candidates.filter((c) => c.blocks.length > 0);
      if (pool.length === 0) pool = candidates;
      // Graded by how open the band wants its opening to be. Corking is the
      // only lever on the first move, so a lot that must leave several cars
      // free needs it turned almost off — otherwise every breather comes out
      // tighter than the stretch jam it is meant to be a rest from.
      const corkWeight = t.minimumInitialExits === 0 ? 40 : t.minimumInitialExits === 1 ? 20 : 4;
      score = (c) => {
        let depth = 1;
        for (const b of c.blocks) depth = Math.max(depth, heights[b] + 1);
        const corks = c.blocks.filter((b) => open.has(b)).length;
        // Corking an open car is the only thing that tightens the opening, and
        // a tight opening is what stops the lot being read at a glance.
        // `shared` routes this car out along ground others already need, which
        // is how a lot ends up with corridors instead of private lanes.
        return (
          corks * corkWeight +
          Math.min(depth, t.dependencyDepth + 2) * 14 +
          c.blocks.length * 4 +
          c.shared * 3 +
          c.rayLen
        );
      };
    }

    const pick = chooseBest(rng, pool, score);
    let tags = 0;
    if (i >= vipFrom && spec.modifiers.vips > 0) tags |= VehicleTag.Vip;
    commit(k, rng, pick, tags);

    // Straight after parking a car, while its lane out is still empty, is the
    // best moment to drag somebody into it. Paced rather than rationed: if the
    // lot has no interlock to give this turn it is tried again on the next,
    // because space to slide into only ever gets scarcer as the lot fills.
    if (
      i >= firstInterlock &&
      knots < t.temporaryMoveRequirement &&
      i >= firstInterlock + interlocks * interlockEvery
    ) {
      const tied = tryInterlock(k, rng, 4, true, t.minimumInitialExits, knotted);
      if (tied) {
        interlocks++;
        if (tied.standalone) knots++;
      }
    }
  }

  if (k.vehicles.length < 2) return null;

  // Keep tying knots until the lot actually holds — steered by the number of
  // cars left standing rather than by a quota of drags, and stopped the moment
  // a drag stops earning its keep. A slide that traps nothing new is a move the
  // player pays for and learns nothing from, and enough of them turn a puzzle
  // into a chore. Loops are insisted on while the budget lasts; only at the end
  // will any interlock do.
  const ceiling = t.temporaryMoveRequirement + 6;
  let guard = 0;
  let stale = 0;
  while (interlocks < ceiling && guard++ < 40 && stale < 5) {
    const before = stalledCount(k);
    if (knots >= t.temporaryMoveRequirement && before >= t.minimumGreedyStall) break;
    const tied = tryInterlock(k, rng, 4, stale < 3, t.minimumInitialExits, knotted);
    if (!tied) {
      stale++;
      continue;
    }
    // Worth its move if it closed a new loop, or if it holds more cars back.
    // Otherwise it is a slide the player pays for and learns nothing from.
    if (!tied.standalone && stalledCount(k) <= before) {
      tied.undo();
      stale++;
      continue;
    }
    interlocks++;
    if (tied.standalone) knots++;
  }

  // One last sweep for cars that ended up doing nothing at all.
  if (!pruneScenery(k, 3)) return null;
  if (k.vehicles.length < 2) return null;

  applyRoleTags(k, rng, spec);

  const level: LevelDef = {
    id: spec.id,
    index: spec.index,
    w: k.w,
    h: k.h,
    terrain: k.terrain,
    arrows: k.arrows,
    blockerStyle: k.blockerStyle,
    roundaboutSpin: k.spin,
    exits: k.exits,
    vehicles: k.vehicles,
    parSlides: k.witness.length,
    band: spec.band,
    patternTags: spec.patternTags,
    modifierLoad: countModifierFamilies(spec.modifiers),
    knotDepth: 1,
    seed,
    parSolution: k.witness,
    repositionMoves: k.witness.filter((m) => m.kind !== MoveKind.Exit).length,
  };

  if (validateLevel(level).length > 0) return null;
  // The construction is a proof, but only if it replays. Anything that does not
  // is a generator bug, and shipping it would be worse than dropping the seed.
  if (!replays(level, k.witness)) return null;

  level.knotDepth = dependencyGraph(level).depth;
  return level;
}

/**
 * Walk the witness through the real simulation and check the lot empties.
 *
 * Deliberately paranoid: each move is re-resolved through `resolveMove`, the
 * same call the player's drag goes through, rather than replayed by fiat. A
 * line the generator believes in but the sim would refuse is a generator bug,
 * and shipping it would be worse than dropping the seed.
 */
function replays(level: LevelDef, witness: Move[]): boolean {
  const state = createLotState(level);
  for (const m of witness) {
    const mv = resolveMove(state, m.vi, m.dir, Math.max(1, m.distance));
    if (!mv || mv.kind !== m.kind) return false;
    if (mv.kind === MoveKind.Slide && (mv.toX !== m.toX || mv.toY !== m.toY)) return false;
    applyMove(state, mv);
  }
  return state.remaining === 0;
}

/** Ambulance and Mystery Trunk tags never affect legality, so they go on last. */
function applyRoleTags(k: Work, rng: Rng, spec: LevelSpec): void {
  const plain = k.vehicles.filter((v) => v.tags === 0).map((v) => v.id);
  rng.shuffle(plain);
  let cursor = 0;

  for (let i = 0; i < spec.modifiers.ambulances && cursor < plain.length; i++) {
    const v = k.vehicles[plain[cursor++]];
    // Ambulances are 3 cells; only retag a vehicle that already is.
    if (VEHICLE_LENGTH[v.kind] === 3) {
      v.kind = VehicleKind.Ambulance;
      v.tags |= VehicleTag.Ambulance;
    } else {
      i--; // try another vehicle
      if (cursor >= plain.length) break;
    }
  }
  for (let i = 0; i < spec.modifiers.trunks && cursor < plain.length; i++) {
    k.vehicles[plain[cursor++]].tags |= VehicleTag.Trunk;
  }
}

function countModifierFamilies(m: ModifierSpec): number {
  let n = 0;
  if (m.blockers > 0) n++;
  if (m.oil > 0) n++;
  if (m.arrows > 0) n++;
  if (m.roundabouts > 0) n++;
  if (m.gate) n++;
  if (m.vips > 0) n++;
  return n;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

export interface LevelVerdict {
  metrics: DifficultyMetrics;
  /** Named checks that failed. Empty means shippable. */
  failed: string[];
  /** How close the lot came, for picking the best of a bad batch. */
  score: number;
}

/**
 * Judge a finished lot against its spec.
 *
 * The first check is the one that matters: a lot "tap whatever is free" clears
 * on its own is rejected outright above the on-ramp, however many cars it has
 * and however deep its blocking chains look on paper.
 */
export function judgeLevel(level: LevelDef, spec: LevelSpec): LevelVerdict {
  const t = spec.targets;
  const m = analyseDifficulty(level, level.parSolution);
  const failed: string[] = [];

  if (m.greedyStall < t.minimumGreedyStall) failed.push('greedy');
  if (m.knotDepth < t.dependencyDepth) failed.push('depth');
  if (m.parSlides < t.minimumSolutionMoves) failed.push('length');
  if (m.openExits > t.maximumInitialExits) failed.push('openExits');
  if (m.openExits < t.minimumInitialExits) failed.push('sealed');
  if (m.vehicleCount - m.independentCars < t.minimumBlockedCars) failed.push('blocked');
  if (m.independentCars > t.maximumIndependentCars) failed.push('independent');
  if (m.bottleneckCells < t.minimumBottlenecks) failed.push('bottlenecks');
  if (m.repositionMoves < t.minimumRequiredRepositions) failed.push('repositions');
  if (backtrackCount(level) < t.backtrackingRequirement) failed.push('backtracking');

  // Distance from target, so a batch of misses can still be ranked.
  const miss = (have: number, want: number) => Math.min(0, have - want);
  const over = (have: number, want: number) => Math.min(0, want - have);
  const score =
    miss(m.greedyStall, t.minimumGreedyStall) * 10 +
    miss(m.repositionMoves, t.minimumRequiredRepositions) * 12 +
    miss(m.knotDepth, t.dependencyDepth) * 5 +
    over(m.independentCars, t.maximumIndependentCars) * 5 +
    over(m.openExits, t.maximumInitialExits) * 9 +
    miss(m.bottleneckCells, t.minimumBottlenecks) * 2 +
    // Not required anywhere, but always worth having: a car that has to be put
    // back where it came from is the deepest read the board can offer.
    backtrackCount(level) * 4 +
    miss(m.parSlides, t.minimumSolutionMoves) +
    miss(m.openExits, t.minimumInitialExits) * 9 +
    -Math.abs(m.vehicleCount - spec.vehicleCount) * 3;

  return { metrics: m, failed, score };
}

/** Cars that slide more than once and turn around doing it. */
export function backtrackCount(level: LevelDef): number {
  const line = level.parSolution;
  if (!line) return 0;
  const dirs = new Map<number, Dir[]>();
  for (const m of line) {
    if (m.kind !== MoveKind.Slide) continue;
    const list = dirs.get(m.vi) ?? [];
    list.push(m.dir);
    dirs.set(m.vi, list);
  }
  let n = 0;
  for (const list of dirs.values()) {
    if (list.length > 1 && list.some((d, i) => i > 0 && d === OPPOSITE[list[i - 1]])) n++;
  }
  return n;
}

export interface GenerateOptions {
  /** How many seeds to try before settling for the best near-miss. */
  attempts?: number;
}

/**
 * How many lots to build before keeping the best one.
 *
 * A demanding spec needs more tries, because the interlocks it asks for depend
 * on cars happening to land where they can lock together — geometry the seed
 * decides, not the scorer. Stretch and showcase jams get the largest budget
 * because they are the ones asking for depth the board can only just deliver.
 */
function attemptsFor(spec: LevelSpec): number {
  if (spec.band === Band.Showcase) return 110;
  if (spec.band === Band.Hard) return 90;
  if (spec.band === Band.Medium) return 56;
  return 32;
}

/**
 * Generate a level matching `spec` as closely as the board allows. Always
 * returns a valid, solvable level — never throws, never returns null.
 */
export function generateLevel(spec: LevelSpec, opts: GenerateOptions = {}): LevelDef {
  const attempts = opts.attempts ?? attemptsFor(spec);
  let best: LevelDef | null = null;
  let bestScore = -Infinity;
  let knotted: LevelDef | null = null;
  let knottedScore = -Infinity;

  for (let a = 0; a < attempts; a++) {
    const level = buildOnce(spec, (spec.seed + a * 0x9e3779b1) >>> 0);
    if (!level) continue;

    // Judge the constructed line first — it is free, and most candidates are
    // eliminated on structure alone. Only the ones still in contention are worth
    // the solve, and they have to have it: the generator's own line is an upper
    // bound, and a lot whose knot the solver unties in one shunt is not the
    // four-shunt lot the construction thought it was building.
    if (judgeLevel(level, spec).failed.length <= 2) tighten(level);

    const verdict = judgeLevel(level, spec);
    if (verdict.failed.length === 0) return level;
    if (verdict.score > bestScore) {
      bestScore = verdict.score;
      best = level;
    }
    // Kept separately from the best overall: a lot that holds *something* back
    // from the tapping bot beats a lot that scores better on every other axis
    // and still unties itself, and the score alone will not always say so.
    if (verdict.metrics.greedyStall > 0 && verdict.score > knottedScore) {
      knottedScore = verdict.score;
      knotted = level;
    }
  }

  if (knotted) return tighten(knotted);

  // Not one seed in the batch could be knotted. That is a geometry problem, not
  // a luck problem, and the fix is room to manoeuvre: a car needs an empty cell
  // in its own lane before it can be shunted anywhere. Thin the lot and widen
  // the curb rather than shipping a jam that clears itself.
  if (spec.targets.minimumGreedyStall > 0 && spec.vehicleCount > 4) {
    return generateLevel(
      {
        ...spec,
        vehicleCount: spec.vehicleCount - 2,
        streetWidth: Math.min(1, spec.streetWidth + 0.15),
        targets: {
          ...spec.targets,
          minimumGreedyStall: Math.max(1, spec.targets.minimumGreedyStall - 1),
        },
      },
      opts,
    );
  }

  return best ? tighten(best) : fallbackLevel(spec);
}

/**
 * Last pass before shipping: see whether the solver can beat the constructed
 * line, and if it can, par against the shorter one. The witness stays as the
 * hint of last resort either way.
 */
function tighten(level: LevelDef): LevelDef {
  const built = level.parSolution?.length ?? level.vehicles.length;
  const found = solveState(createLotState(level), {
    maxNodes: 30_000,
    witness: level.parSolution,
  });
  if (found.solvable && found.moves.length < built) {
    level.parSolution = found.moves;
    level.repositionMoves = found.moves.filter((m) => m.kind !== MoveKind.Exit).length;
  }
  level.parSlides = level.parSolution?.length ?? built;
  return level;
}

/** Last-resort lot: a tiny, always-valid jam. Should be unreachable in practice. */
function fallbackLevel(spec: LevelSpec): LevelDef {
  const w = 4;
  const h = 4;
  const vehicles: VehicleDef[] = [
    { id: 0, kind: VehicleKind.Sedan, x: 1, y: 3, facing: 2, tags: 0, hue: 0 },
    { id: 1, kind: VehicleKind.Sedan, x: 2, y: 3, facing: 2, tags: 0, hue: 1 },
  ];
  return {
    id: spec.id,
    index: spec.index,
    w,
    h,
    terrain: new Array(w * h).fill(Terrain.Road),
    arrows: new Array(w * h).fill(-1),
    blockerStyle: new Array(w * h).fill(BlockerStyle.Cone),
    roundaboutSpin: new Array(w * h).fill(0),
    exits: [
      { x: 0, y: 3, dir: 2 },
      { x: 1, y: 3, dir: 2 },
      { x: 2, y: 3, dir: 2 },
      { x: 3, y: 3, dir: 2 },
    ],
    vehicles,
    parSlides: 2,
    band: spec.band,
    patternTags: spec.patternTags,
    modifierLoad: 0,
    knotDepth: 1,
    seed: spec.seed,
  };
}

/* ------------------------------------------------------------------ *
 * Inspection
 * ------------------------------------------------------------------ */

/** Bot-persona validation hook used by tests and the tuning scripts (GDD §6 step 4). */
export function auditLevel(level: LevelDef) {
  const state = createLotState(level);
  const solved = solveState(createLotState(level), { witness: level.parSolution });
  const metrics = analyseDifficulty(level, level.parSolution ?? solved.moves);
  return {
    ...metrics,
    valid: validateLevel(level).length === 0,
    solvable: solved.solvable,
    parSlides: level.parSlides,
    vehicles: state.x.length,
    backtracks: backtrackCount(level),
  };
}

/**
 * Why every car on the lot is there, in words.
 *
 * Written for the design review rather than the game: it answers, per car, what
 * blocks it, what it blocks, whether it can be nudged aside or has to drive off,
 * and whether it is doing any work at all.
 */
export function explainLevel(level: LevelDef): string {
  const graph = dependencyGraph(level);
  const m = analyseDifficulty(level, level.parSolution);
  const name = (vi: number) => String.fromCharCode(65 + (vi % 26));
  const lines: string[] = [];

  lines.push(`${level.id} — ${level.w}×${level.h}, ${level.vehicles.length} cars, band ${level.band}`);
  lines.push(
    `depth ${m.knotDepth} · par ${m.parSlides} (${m.repositionMoves} repositions) · ` +
      `open ${m.openExits} · greedy stalls with ${m.greedyStall} left · ` +
      `bottlenecks ${m.bottleneckCells} · independent ${m.independentCars}`,
  );
  lines.push('');
  for (const node of graph.nodes) {
    const waits = node.blockedBy.length
      ? `waits on ${node.blockedBy.map(name).join(', ')}`
      : 'route clear';
    const holds = node.blocks.length ? `blocks ${node.blocks.map(name).join(', ')}` : 'blocks nobody';
    const forced = node.mustExitFirst.length
      ? ` — ${node.mustExitFirst.map(name).join(', ')} share its lane and must drive off`
      : '';
    const nudge = node.canBeNudged.length
      ? ` — ${node.canBeNudged.map(name).join(', ')} lie across it and can be shunted`
      : '';
    lines.push(
      `${name(node.vi)} ${level.vehicles[node.vi].kind.padEnd(8)} ${node.lane.padEnd(9)} ` +
        `depth ${node.depth} ${node.role.padEnd(11)} ${waits}; ${holds}${forced}${nudge}`,
    );
  }
  return lines.join('\n');
}

/** The dependency graph in Mermaid form, for design docs and reviews. */
export function dependencyDiagram(level: LevelDef): string {
  const graph = dependencyGraph(level);
  const name = (vi: number) => String.fromCharCode(65 + (vi % 26));
  const out = ['flowchart LR'];
  for (const node of graph.nodes) {
    out.push(`  ${name(node.vi)}["${name(node.vi)} · ${node.lane}"]`);
  }
  for (const [blocker, waiter] of graph.edges) {
    const cyclic = graph.nodes[blocker].blockedBy.includes(waiter);
    out.push(`  ${name(blocker)} ${cyclic ? '<==>' : '-->'} ${name(waiter)}`);
  }
  return out.join('\n');
}

/** A plain-text picture of the lot, one letter per car. */
export function renderLevel(level: LevelDef): string {
  const s = createLotState(level);
  const rows: string[] = [];
  for (let y = 0; y < level.h; y++) {
    let row = '';
    for (let x = 0; x < level.w; x++) {
      const idx = y * level.w + x;
      const occupant = s.occ[idx];
      if (occupant >= 0) row += String.fromCharCode(65 + (occupant % 26));
      else if (level.terrain[idx] === Terrain.Blocked) row += '#';
      else if (level.terrain[idx] === Terrain.Oil) row += '~';
      else if (level.terrain[idx] === Terrain.Roundabout) row += 'o';
      else row += '·';
    }
    rows.push(row);
  }
  return rows.join('\n');
}

