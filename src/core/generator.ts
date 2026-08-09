/**
 * JamForge — the level generator (GDD §6 "Production at Scale").
 *
 * Lots are built **backwards**: vehicles are inserted one at a time, and each
 * insertion is only accepted if that vehicle could drive straight off the lot
 * given everything already placed. Replaying the insertions in reverse is
 * therefore always a valid solution, which makes every generated jam
 * solvable-by-construction — the guarantee GDD §8 makes to the player
 * ("every jam solvable unaided, solver-verified, forever").
 *
 * Nothing about the lot is hoped for. Every insertion is placed with an
 * explicit *intent* — anchor the knot, deepen it, cork a lane that is standing
 * open, add a red herring — chosen from where the partial lot currently stands
 * against its `DifficultyConfig`. Knot depth in particular is scored by the
 * chain each candidate placement would actually create, because chasing a
 * single chain tail stalls at three or four links: each link starts closer to
 * the street than the one it blocks.
 *
 * And nothing is shipped on trust. The finished lot is solved, measured and
 * graded back against the same config; a candidate that misses on cars, depth,
 * solution length, opening moves, bottlenecks, free parking or density is
 * discarded and another is rolled. That loop is what makes a level-fifteen lot
 * a level-fifteen lot rather than a level-five lot on a bigger board.
 */

import { DifficultyConfig, difficultyFor } from './difficulty';
import { Rng } from './rng';
import { analyseDifficulty, DifficultyMetrics, solveLevel, SolveResult } from './solver';
import { createLotState, validateLevel } from './sim';
import {
  Band,
  BlockerStyle,
  Dir,
  DX,
  DY,
  ExitDef,
  LevelDef,
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
  knotDepth: number;
  /** Share of vehicles deliberately placed off the critical path. */
  distractorRatio: number;
  /** Weighted length mix, e.g. { 2: 6, 3: 2, 4: 1 }. */
  lengthMix: Record<number, number>;
  modifiers: ModifierSpec;
  /**
   * The contract the delivered lot is graded against. `vehicleCount` and
   * `knotDepth` above are what the builder *aims* at; this is what the validator
   * *demands*, and a candidate that misses it is thrown away and rebuilt.
   */
  difficulty: DifficultyConfig;
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
  /** Per-cell curb-cut direction bitmask — the exit list, in O(1) form. */
  exitMask: Uint8Array;
  occ: Int16Array;
  vehicles: VehicleDef[];
  /** Cached forward ray of each placed vehicle: cell indices from nose to curb. */
  rays: number[][];

  /* --- Scratch, reused across every insertion of a build. --------------- *
   * A twelve-by-fifteen lot has 720 nose-and-facing placements to weigh on
   * every one of thirty-odd insertions, and a build is tried dozens of times
   * per level. Allocating per candidate is what made big lots unaffordable, so
   * everything below is allocated once and refilled. */

  /**
   * Cells between a nose here, facing this way, and its curb cut — or −1 when
   * no clear lane exists. Indexed `dir * cells + idx`.
   */
  clearRay: Int16Array;
  /** Head of the per-cell list of vehicles whose exit lane crosses that cell. */
  ownerHead: Int32Array;
  ownerVi: Int32Array;
  ownerNext: Int32Array;
  ownerNodes: number;
  /** Generation stamp per vehicle, for de-duplicating owners without a Set. */
  stamp: Int32Array;
  generation: number;
}

/** Upper bound on vehicles in one lot; sizes the de-duplication scratch. */
const MAX_VEHICLES = 64;

function makeWork(w: number, h: number): Work {
  const cells = w * h;
  const rayNodes = MAX_VEHICLES * (w + h);
  return {
    w,
    h,
    terrain: new Array(cells).fill(Terrain.Road),
    arrows: new Array(cells).fill(-1),
    blockerStyle: new Array(cells).fill(BlockerStyle.Cone),
    spin: new Array(cells).fill(0),
    exits: [],
    exitMask: new Uint8Array(cells),
    occ: new Int16Array(cells).fill(-1),
    vehicles: [],
    rays: [],
    clearRay: new Int16Array(cells * 4),
    ownerHead: new Int32Array(cells).fill(-1),
    ownerVi: new Int32Array(rayNodes),
    ownerNext: new Int32Array(rayNodes),
    ownerNodes: 0,
    stamp: new Int32Array(MAX_VEHICLES),
    generation: 0,
  };
}

const inW = (k: Work, x: number, y: number) => x >= 0 && y >= 0 && x < k.w && y < k.h;

function hasExit(k: Work, x: number, y: number, dir: Dir): boolean {
  if (!inW(k, x, y)) return false;
  return (k.exitMask[y * k.w + x] & (1 << dir)) !== 0;
}

function addExit(k: Work, x: number, y: number, dir: Dir): void {
  k.exits.push({ x, y, dir });
  k.exitMask[y * k.w + x] |= 1 << dir;
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

/**
 * Recompute, for every cell and facing at once, how far a nose parked there
 * could drive before reaching its curb cut — and whether it could at all.
 *
 * Walking each lane per candidate is the same work done `w+h` times over; a
 * sweep from the kerb inward answers all of them in one pass, because a lane is
 * clear from a cell exactly when the next cell along is passable *and* clear
 * from there. That single change is what makes a 12×15 lot cost about what a
 * 7×10 one used to.
 */
function refreshRays(k: Work): void {
  const { w, h, clearRay, terrain, arrows, occ } = k;
  const cells = w * h;

  for (let f = 0 as Dir; f < 4; f = (f + 1) as Dir) {
    const base = f * cells;
    const dx = DX[f];
    const dy = DY[f];
    // Sweep from the kerb this facing exits through, so the cell ahead is
    // always already solved.
    const xFrom = dx > 0 ? w - 1 : 0;
    const xStep = dx > 0 ? -1 : 1;
    const yFrom = dy > 0 ? h - 1 : 0;
    const yStep = dy > 0 ? -1 : 1;

    for (let yi = 0; yi < h; yi++) {
      const y = yFrom + yStep * yi;
      for (let xi = 0; xi < w; xi++) {
        const x = xFrom + xStep * xi;
        const idx = y * w + x;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          clearRay[base + idx] = hasExit(k, x, y, f) ? 0 : -1;
          continue;
        }
        const nIdx = ny * w + nx;
        const arrow = arrows[nIdx];
        if (terrain[nIdx] === Terrain.Blocked || occ[nIdx] !== -1 || (arrow >= 0 && arrow !== f)) {
          clearRay[base + idx] = -1;
          continue;
        }
        const ahead = clearRay[base + nIdx];
        clearRay[base + idx] = ahead < 0 ? -1 : ahead + 1;
      }
    }
  }
}

/** Rebuild "which placed cars route through this cell" from the cached rays. */
function refreshOwners(k: Work): void {
  k.ownerHead.fill(-1);
  k.ownerNodes = 0;
  for (let vi = 0; vi < k.vehicles.length; vi++) {
    for (const cell of k.rays[vi]) {
      const node = k.ownerNodes++;
      if (node >= k.ownerVi.length) return; // scratch exhausted; ignore the tail
      k.ownerVi[node] = vi;
      k.ownerNext[node] = k.ownerHead[cell];
      k.ownerHead[cell] = node;
    }
  }
}

/** Same walk but tolerating vehicles: returns the ray plus who is standing on it. */
function exitRayThroughVehicles(
  k: Work,
  x: number,
  y: number,
  facing: Dir,
): { path: number[]; blockers: number[] } | null {
  const path: number[] = [];
  const blockers: number[] = [];
  const limit = k.w + k.h;
  for (let step = 1; step <= limit; step++) {
    const cx = x + DX[facing] * step;
    const cy = y + DY[facing] * step;
    if (!inW(k, cx, cy)) {
      const px = x + DX[facing] * (step - 1);
      const py = y + DY[facing] * (step - 1);
      return hasExit(k, px, py, facing) ? { path, blockers } : null;
    }
    const idx = cy * k.w + cx;
    if (k.terrain[idx] === Terrain.Blocked) return null;
    const arrow = k.arrows[idx];
    if (arrow >= 0 && arrow !== facing) return null;
    const occupant = k.occ[idx];
    if (occupant !== -1 && !blockers.includes(occupant)) blockers.push(occupant);
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
 * a one-cell frontage is the Plug, two facing runs are the Two-Door.
 */
function placeExits(k: Work, rng: Rng, sideCount: number, widthRatio: number): void {
  const order = rng.shuffle<Dir>([1, 3, 0]);
  // The bottom edge always comes first: curb cuts near the thumb read best in portrait.
  const sides: Dir[] = [2, ...order];
  const wanted = Math.max(1, Math.min(4, sideCount));

  for (let i = 0; i < wanted; i++) {
    const dir = sides[i];
    const edgeLen = dir === 0 || dir === 2 ? k.w : k.h;
    // A frontage under two cells starves the lot: only one lane could ever leave.
    const span = Math.max(2, Math.min(edgeLen, Math.round(edgeLen * widthRatio)));
    const start = rng.int(edgeLen - span + 1);
    for (let j = start; j < start + span; j++) {
      if (dir === 0) addExit(k, j, 0, dir);
      else if (dir === 2) addExit(k, j, k.h - 1, dir);
      else if (dir === 1) addExit(k, k.w - 1, j, dir);
      else addExit(k, 0, j, dir);
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

function scatterTerrain(k: Work, rng: Rng, spec: LevelSpec, reserved: Set<number> | null): void {
  const keep = exitApproachCells(k);
  const free: number[] = [];
  for (let i = 0; i < k.terrain.length; i++) {
    if (k.terrain[i] !== Terrain.Road) continue;
    if (keep.has(i) || k.occ[i] !== -1) continue;
    if (reserved?.has(i)) continue;
    free.push(i);
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
 * Vehicle insertion
 * ------------------------------------------------------------------ */

interface Candidate {
  x: number;
  y: number;
  facing: Dir;
  /** Distinct previously-placed vehicles this candidate would stand in front of. */
  blockCount: number;
  /** Knot depth parking here would create: `max(height[blocked]) + 1`. */
  gain: number;
  /** How many of the blocked cars could drive off right now. */
  sealGain: number;
  /** Cells between this candidate's nose and its own curb cut. */
  rayLen: number;
}

/** What the next insertion is trying to achieve. */
const enum Intent {
  /** The first car: anchor the knot deep, where a chain has room to grow. */
  Anchor,
  /** Deepen the dependency chain as far as this placement can. */
  Deepen,
  /** Thicken the read without deepening it — park clear of every lane. */
  Distract,
  /** Add another blocker anywhere it stands in someone's way. */
  Block,
  /** Cork lanes that are currently wide open, to tighten the opening move. */
  Seal,
  /** The opposite: park a car where it can leave and nothing can trap it. */
  Air,
}

function scoreCandidate(c: Candidate, intent: Intent): number {
  switch (intent) {
    case Intent.Anchor:
      return c.rayLen;
    case Intent.Deepen:
      // Rank by the depth this placement would actually produce, then break
      // ties toward lanes with room left to grow into — and, all else equal,
      // toward standing in front of a car that could otherwise drive off, so
      // the opening tightens as a side effect of the knot getting deeper.
      return c.gain * 12 + c.rayLen * 2 + c.sealGain * 3 + c.blockCount * 0.5;
    case Intent.Distract:
      // A distractor blocks nobody, so parking it deep in the lot leaves room
      // for a later car to park in front of *it*. Parked by the kerb instead it
      // would be free to drive off on turn one, and a lot whose red herrings are
      // all immediately gone is not much of a lot.
      return c.rayLen;
    case Intent.Seal:
      // Every insertion arrives with a clear lane of its own, so corking the
      // opening only nets out when a placement stands in front of *two* cars
      // that can currently leave. Those are the crossings; find them.
      return c.sealGain * 9 + c.blockCount * 2 - c.rayLen * 0.5;
    case Intent.Air:
      // Right by the kerb, where a later insertion has no room to park in front
      // of it — the placement most likely to still be free at the opening move.
      return -c.rayLen;
    default:
      return c.blockCount * 2 - c.rayLen;
  }
}

/**
 * Weigh every legal placement of a vehicle this long and keep the best few, then
 * pick among them at random — purposeful lots, but never the same lot twice.
 *
 * This is the generator's inner loop and it runs `cells × 4` times per
 * insertion, so it scores in place rather than building and sorting a candidate
 * list: on a 12×15 lot that list was seven hundred objects with two arrays each,
 * thirty times per build, dozens of builds per level.
 *
 * `require` lets a caller demand a placement that blocks somebody (or nobody)
 * and fall back to the unrestricted best when the lot has none left to offer.
 */
function bestPlacement(
  k: Work,
  rng: Rng,
  len: number,
  intent: Intent,
  heights: number[],
  openNow: Uint8Array,
  require: 'any' | 'blocking' | 'free',
): Candidate | null {
  const cells = k.w * k.h;
  const topK = 5;
  const best: Candidate[] = [];
  const bestScores: number[] = [];
  const fallback: Candidate[] = [];
  const fallbackScores: number[] = [];

  const offer = (c: Candidate, score: number, pool: Candidate[], scores: number[]) => {
    if (pool.length < topK) {
      pool.push(c);
      scores.push(score);
      return;
    }
    let worst = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] < scores[worst]) worst = i;
    if (score > scores[worst]) {
      pool[worst] = c;
      scores[worst] = score;
    }
  };

  for (let y = 0; y < k.h; y++) {
    for (let x = 0; x < k.w; x++) {
      for (let f = 0 as Dir; f < 4; f = (f + 1) as Dir) {
        const rayLen = k.clearRay[f * cells + y * k.w + x];
        if (rayLen < 0) continue;

        // Body fit, walked inline: the tail runs backwards from the nose.
        let fits = true;
        let bx = x;
        let by = y;
        for (let i = 0; i < len; i++) {
          if (bx < 0 || by < 0 || bx >= k.w || by >= k.h) {
            fits = false;
            break;
          }
          const idx = by * k.w + bx;
          if (k.terrain[idx] === Terrain.Blocked || k.occ[idx] !== -1) {
            fits = false;
            break;
          }
          bx -= DX[f];
          by -= DY[f];
        }
        if (!fits) continue;

        // Who would be waiting on this car: every placed vehicle whose exit lane
        // runs through a cell of this body.
        const generation = ++k.generation;
        let blockCount = 0;
        let sealGain = 0;
        let gain = 1;
        bx = x;
        by = y;
        for (let i = 0; i < len; i++) {
          const idx = by * k.w + bx;
          for (let node = k.ownerHead[idx]; node !== -1; node = k.ownerNext[node]) {
            const vi = k.ownerVi[node];
            if (k.stamp[vi] === generation) continue;
            k.stamp[vi] = generation;
            blockCount++;
            if (openNow[vi]) sealGain++;
            const h = heights[vi] + 1;
            if (h > gain) gain = h;
          }
          bx -= DX[f];
          by -= DY[f];
        }

        const candidate: Candidate = { x, y, facing: f, blockCount, gain, sealGain, rayLen };
        const score = scoreCandidate(candidate, intent);
        offer(candidate, score, fallback, fallbackScores);
        const wanted =
          require === 'any' ||
          (require === 'blocking' ? blockCount > 0 : blockCount === 0);
        if (wanted) offer(candidate, score, best, bestScores);
      }
    }
  }

  const pool = best.length > 0 ? best : fallback;
  return pool.length === 0 ? null : pool[rng.int(pool.length)];
}

/**
 * For every car on the partial board, the length of the longest precedence
 * chain that *ends* at it — i.e. how deep the knot already is above that car.
 *
 * Parking a new vehicle in front of car `b` therefore yields a chain of
 * `heights[b] + 1`, which is what lets the generator deepen the knot from
 * whichever car happens to be reachable rather than from one designated tail.
 * Chasing a single tail stalls at three or four links, because each link starts
 * closer to the street than the one it blocks; scoring every candidate by the
 * depth it would actually create does not.
 *
 * The maximum entry is the current knot depth.
 */
function chainHeights(k: Work): number[] {
  const n = k.vehicles.length;
  // waiters[b] = cars that cannot leave until b does.
  const waiters: number[][] = Array.from({ length: n }, () => []);
  for (let vi = 0; vi < n; vi++) {
    const seen = new Set<number>();
    for (const c of k.rays[vi]) {
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

function commit(k: Work, rng: Rng, c: Candidate, len: number, tags: number): void {
  const id = k.vehicles.length;
  const cells = bodyCells(k, c.x, c.y, c.facing, len);
  if (!cells) return;
  for (const idx of cells) k.occ[idx] = id;
  const kind = kindForLength(len, tags, rng);
  k.vehicles.push({ id, kind, x: c.x, y: c.y, facing: c.facing, tags, hue: rng.int(8) });
  const ray = exitRayThroughVehicles(k, c.x, c.y, c.facing);
  k.rays.push(ray ? ray.path : []);
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

function pickLength(rng: Rng, mix: Record<number, number>): number {
  const lens = Object.keys(mix).map(Number);
  const weights = lens.map((l) => mix[l]);
  return rng.weighted(lens, weights);
}

function longestLength(mix: Record<number, number>): number {
  let best = 2;
  for (const key of Object.keys(mix)) {
    const len = Number(key);
    if (mix[len] > 0 && len > best) best = len;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

interface Built {
  level: LevelDef;
  metrics: DifficultyMetrics;
  solved: SolveResult;
}

function buildOnce(spec: LevelSpec, seed: number): Built | null {
  const rng = new Rng(seed);
  const k = makeWork(spec.w, spec.h);

  placeExits(k, rng, spec.streetSides, spec.streetWidth);
  if (spec.modifiers.gate) placeGate(k, rng);

  // The one knot that cannot be untied by driving cars off in the right order
  // goes down first, into an empty lot — that is what makes it provably
  // escapable once everything else has left. It goes down before the furniture
  // too, so a stray cone cannot land in the lane its escape depends on.
  const pinwheel = spec.difficulty.temporaryMoveRequirement ? placePinwheel(k, rng) : null;
  scatterTerrain(k, rng, spec, pinwheel);

  const total = Math.min(MAX_VEHICLES, spec.vehicleCount);
  // VIPs must leave first, so under reverse construction they go in last.
  const vipFrom = total - spec.modifiers.vips;
  // Keep some insertions in reserve for distractors; the rest may chase depth.
  // A chain of n links needs n insertions to build, though, so a deep spec keeps
  // whatever budget it needs regardless of how many distractors it also wants.
  const chainBudget = Math.max(
    spec.knotDepth + 3,
    total - Math.round(total * spec.distractorRatio * 0.8),
  );
  const openNow = new Uint8Array(MAX_VEHICLES);

  for (let i = k.vehicles.length; i < total; i++) {
    refreshRays(k);
    refreshOwners(k);

    const heights = i === 0 ? [] : chainHeights(k);
    let currentDepth = 0;
    for (const height of heights) if (height > currentDepth) currentDepth = height;

    // Who could drive off if the lot stopped here. Tracked as we build, because
    // the opening move is the first thing a player reads and a lot that hands
    // them a dozen free cars has already answered its own question.
    let openCount = 0;
    for (let vi = 0; vi < k.vehicles.length; vi++) {
      let clear = 1;
      for (const cell of k.rays[vi]) {
        if (k.occ[cell] !== -1) {
          clear = 0;
          break;
        }
      }
      openNow[vi] = clear;
      openCount += clear;
    }

    const wantsDepth = i < chainBudget && currentDepth < spec.knotDepth;
    // Sealing normally waits until the knot is as deep as it was asked to be,
    // but a lot running badly open cannot afford to wait: corking is slow work
    // (each new car arrives with a clear lane of its own) so it has to start
    // early enough to finish.
    const over = openCount - spec.difficulty.maxInitialFreeCars;
    const wantsSeal = over > 0 && (!wantsDepth || over > 2);
    // The mirror of it, and the reason the last few insertions are reserved:
    // whatever is parked at the kerb at the end of the build is what the player
    // can move on turn one, and a lot with a single legal opening plays itself.
    const air = spec.difficulty.minInitialFreeCars - openCount;
    const wantsAir = air > 0 && total - i <= air;

    const intent =
      i === 0
        ? Intent.Anchor
        : wantsAir
          ? Intent.Air
          : wantsDepth && !wantsSeal
            ? Intent.Deepen
            : wantsSeal
              ? Intent.Seal
              : rng.next() < spec.distractorRatio
                ? Intent.Distract
                : Intent.Block;
    const require =
      intent === Intent.Distract || intent === Intent.Air
        ? 'free'
        : intent === Intent.Block || intent === Intent.Seal
          ? 'blocking'
          : 'any';

    // Corking is the one job where size is the whole point — a box truck laid
    // across a corridor takes three lanes out of play where a coupe takes one —
    // so a sealing insertion shops for length instead of rolling for it.
    let len = intent === Intent.Seal ? longestLength(spec.lengthMix) : pickLength(rng, spec.lengthMix);
    let pick = bestPlacement(k, rng, len, intent, heights, openNow, require);
    // A lot too full for a long vehicle usually still has room for a short one.
    while (!pick && len > 2) {
      len--;
      pick = bestPlacement(k, rng, len, intent, heights, openNow, require);
    }
    if (!pick) break;

    let tags = 0;
    if (i >= vipFrom && spec.modifiers.vips > 0) tags |= VehicleTag.Vip;
    commit(k, rng, pick, len, tags);
  }

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
    parSlides: k.vehicles.length,
    band: spec.band,
    patternTags: spec.patternTags,
    modifierLoad: countModifierFamilies(spec.modifiers),
    knotDepth: 1,
    seed,
  };

  if (validateLevel(level).length > 0) return null;

  // A pinwheel lot is solvable by construction but *not* exit-only, so the
  // solver is given exactly the one reposition the escape needs — and if it
  // cannot find a line, the candidate is thrown away rather than shipped.
  const solved = solveLevel(level, { maxRepositions: pinwheel ? 1 : 0 });
  if (!solved.solvable) return null;

  level.parSlides = solved.parSlides;
  const metrics = analyseDifficulty(level, solved.moves);
  level.knotDepth = metrics.knotDepth;
  return { level, metrics, solved };
}

/* ------------------------------------------------------------------ *
 * The pinwheel — the one knot an exit order cannot untie
 * ------------------------------------------------------------------ */

/**
 * Four cars in a ring, each blocking the next.
 *
 *      A A . .          A faces east into B
 *      . . . B          B faces south into C
 *      D . . B          C faces west into D
 *      D . C C          D faces north into A
 *
 * Nobody in the ring can drive off, and no *exit* ever will help: the lot has
 * to be opened by pulling one car backwards out of the lane it is standing
 * across, which is the "temporary reposition" the late curve asks for. It is
 * the Rush Hour deadlock, and it is the only shape in this movement model that
 * genuinely forces a non-exit move — cars travel in straight lines along a fixed
 * facing, so any knot without a cycle in it unties by exits alone.
 *
 * Placed into the empty lot before anything else, which is what makes the
 * escape provable: JamForge builds backwards, so the ring is the *last* thing
 * left on the lot, alone, with the reverse lane and all four exit lanes it was
 * checked for still clear.
 *
 * Any of the four can be the car that breaks it — the ring is symmetric under
 * rotation — so each spot is tried four ways before being given up on. That
 * matters: the escape lane runs *outward* from the ring, so which car can back
 * out depends entirely on where in the lot the ring happens to sit.
 */
function placePinwheel(k: Work, rng: Rng): Set<number> | null {
  const spots: Array<{ x: number; y: number }> = [];
  for (let y = 0; y + 3 < k.h; y++) {
    for (let x = 0; x + 3 < k.w; x++) spots.push({ x, y });
  }
  rng.shuffle(spots);

  for (const spot of spots) {
    const { x, y } = spot;
    // Nose, facing and body of each car in the ring.
    const ring: Array<{ x: number; y: number; facing: Dir }> = [
      { x: x + 1, y, facing: 1 }, // A — east, body (x,y)-(x+1,y)
      { x: x + 3, y: y + 1, facing: 2 }, // B — south, body (x+3,y)-(x+3,y+1)
      { x: x + 2, y: y + 3, facing: 3 }, // C — west, body (x+2,y+3)-(x+3,y+3)
      { x, y: y + 2, facing: 0 }, // D — north, body (x,y+2)-(x,y+3)
    ];

    // Every cell the ring stands on has to be plain road: oil or a plate would
    // change how the escape plays out, and a blocker would break it outright.
    const footprint: number[] = [];
    const plain = (cx: number, cy: number) =>
      inW(k, cx, cy) && k.terrain[cy * k.w + cx] === Terrain.Road && k.occ[cy * k.w + cx] === -1;

    let ok = true;
    for (const car of ring) {
      for (let i = 0; i < 2 && ok; i++) {
        const cx = car.x - DX[car.facing] * i;
        const cy = car.y - DY[car.facing] * i;
        if (!plain(cx, cy)) ok = false;
        else footprint.push(cy * k.w + cx);
      }
      if (!ok) break;
    }
    if (!ok) continue;

    // Try each car as the one that backs out of the ring.
    let lanes: Array<{ x: number; y: number; facing: Dir }> | null = null;
    let escape: number[] | null = null;
    for (let r = 0; r < 4 && !lanes; r++) {
      const car = ring[r];
      const back = OPPOSITE[car.facing];
      const bx = car.x + DX[back] * 2;
      const by = car.y + DY[back] * 2;
      // Backing up by one is not enough: the cell that traps the next car in the
      // ring is this one's *tail*, so it has to reverse a full body length to
      // clear the lane. Those are the cells two and three behind the nose, and
      // they have to be free road that is not one-way against the reverse.
      let clear = true;
      for (let step = 2; step <= 3 && clear; step++) {
        const cx = car.x + DX[back] * step;
        const cy = car.y + DY[back] * step;
        if (!plain(cx, cy) || arrowBars(k, cx, cy, back)) clear = false;
      }
      if (!clear) continue;

      // Every car's lane out, ignoring the ring, has to reach a curb cut — with
      // the one that reversed checked from where it ends up.
      const attempt = ring.map((c, i) => (i === r ? { x: bx, y: by, facing: c.facing } : c));
      if (attempt.every((lane) => laneClear(k, lane.x, lane.y, lane.facing, footprint))) {
        lanes = attempt;
        escape = [
          by * k.w + bx,
          (car.y + DY[back] * 3) * k.w + (car.x + DX[back] * 3),
        ];
      }
    }
    if (!lanes || !escape) continue;

    for (const car of ring) {
      const id = k.vehicles.length;
      for (let i = 0; i < 2; i++) {
        const cx = car.x - DX[car.facing] * i;
        const cy = car.y - DY[car.facing] * i;
        k.occ[cy * k.w + cx] = id;
      }
      k.vehicles.push({
        id,
        kind: rng.pick([VehicleKind.Sedan, VehicleKind.Taxi, VehicleKind.Coupe]),
        x: car.x,
        y: car.y,
        facing: car.facing,
        tags: 0,
        hue: rng.int(8),
      });
      const ray = exitRayThroughVehicles(k, car.x, car.y, car.facing);
      k.rays.push(ray ? ray.path : []);
    }

    // Hand back everything the escape route depends on. Cars may park in these
    // lanes — they will have driven off long before the ring unwinds — but a
    // cone or an oil slick is permanent, and either would strand the lot.
    const reserved = new Set<number>(footprint);
    for (const cell of escape) reserved.add(cell);
    for (const lane of lanes) {
      for (let step = 1; step <= k.w + k.h; step++) {
        const cx = lane.x + DX[lane.facing] * step;
        const cy = lane.y + DY[lane.facing] * step;
        if (!inW(k, cx, cy)) break;
        reserved.add(cy * k.w + cx);
      }
    }
    return reserved;
  }
  return null;
}

function arrowBars(k: Work, x: number, y: number, dir: Dir): boolean {
  if (!inW(k, x, y)) return false;
  const arrow = k.arrows[y * k.w + x];
  return arrow >= 0 && arrow !== dir;
}

/**
 * Is there a straight lane from this nose to a curb cut, treating the cells in
 * `ignore` as empty? Used to prove each ring car can leave once the ring unwinds.
 */
function laneClear(k: Work, x: number, y: number, facing: Dir, ignore: number[]): boolean {
  const limit = k.w + k.h;
  for (let step = 1; step <= limit; step++) {
    const cx = x + DX[facing] * step;
    const cy = y + DY[facing] * step;
    if (!inW(k, cx, cy)) return hasExit(k, cx - DX[facing], cy - DY[facing], facing);
    const idx = cy * k.w + cx;
    if (k.terrain[idx] === Terrain.Blocked) return false;
    if (arrowBars(k, cx, cy, facing)) return false;
    if (k.occ[idx] !== -1 && !ignore.includes(idx)) return false;
  }
  return false;
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

export interface GenerateOptions {
  /** How many seeds to try before settling for the best near-miss. */
  attempts?: number;
}

/* ------------------------------------------------------------------ *
 * Acceptance — the level has to pass the contract it was built against
 * ------------------------------------------------------------------ */

/** Every way a candidate lot can miss its brief, worst first. */
export interface Shortfall {
  code: string;
  /** How badly it missed, in units the scorer can compare across candidates. */
  amount: number;
}

/**
 * Grade a built lot against its difficulty contract.
 *
 * This is the step that makes the curve real rather than aspirational. A level
 * fifteen candidate with eight cars able to drive off on turn one, a ten-move
 * solution and most of the lot independent is not a level fifteen — it is a
 * level five on a big board — and the honest thing to do with it is throw it
 * away and roll again.
 */
export function gradeLevel(
  metrics: DifficultyMetrics,
  config: DifficultyConfig,
  solved: SolveResult,
): Shortfall[] {
  const out: Shortfall[] = [];
  const miss = (code: string, amount: number) => {
    if (amount > 0) out.push({ code, amount });
  };

  miss('cars', config.minCars - metrics.vehicleCount);
  miss('carsOver', metrics.vehicleCount - config.maxCars);
  miss('depth', config.minDependencyDepth - metrics.knotDepth);
  miss('moves', config.minSolutionMoves - solved.parSlides);
  miss('tooOpen', metrics.openExits - config.maxInitialFreeCars);
  miss('sealed', config.minInitialFreeCars - metrics.openExits);
  miss('bottlenecks', config.minBottlenecks - metrics.bottlenecks);
  // Ratios are scaled so a ten-per-cent miss weighs like one missing car.
  miss('independent', (metrics.independentRatio - config.maxIndependentRatio) * 10);
  miss('density', (config.minDensity - metrics.density) * 10);
  if (config.temporaryMoveRequirement && metrics.repositions < 1) {
    miss('noTemporaryMove', 3);
  }

  out.sort((a, b) => b.amount - a.amount);
  return out;
}

/**
 * How many lots to build before keeping the best one.
 *
 * A demanding spec needs more rolls: the knot a lot can hold is capped by its
 * geometry, and a run that packs cells with furniture and distractors leaves
 * JamForge fewer valid insertions to chain through. But a big lot also *costs*
 * more per roll — a 12×15 build weighs seven hundred placements on each of
 * thirty-odd insertions — so the budget is scaled back down by size. Difficulty
 * buys attempts; area spends them.
 */
function attemptsFor(spec: LevelSpec): number {
  const byBand =
    spec.band === Band.Showcase ? 72 : spec.band === Band.Hard ? 60 : spec.band === Band.Medium ? 40 : 24;
  const work = spec.w * spec.h * Math.max(4, spec.vehicleCount);
  // Calibrated so a small on-ramp lot keeps its full budget and a full-size late
  // lot still gets enough rolls to hit its contract.
  const scale = Math.min(1, 9_000 / work);
  return Math.max(8, Math.round(byBand * scale));
}

/**
 * Generate a level matching `spec` as closely as the board allows. Always
 * returns a valid, solvable level — never throws, never returns null.
 *
 * The loop is generate → solve → grade → reject, and it stops early the moment
 * a candidate clears its whole contract. When none does — a pinched frontage
 * asking for a knot its lanes cannot hold, say — the closest near-miss ships
 * rather than nothing, because an unbuildable level is worse than a slightly
 * easy one.
 */
export function generateLevel(spec: LevelSpec, opts: GenerateOptions = {}): LevelDef {
  const attempts = opts.attempts ?? attemptsFor(spec);
  const config = spec.difficulty;
  let best: LevelDef | null = null;
  let bestScore = Infinity;

  for (let a = 0; a < attempts; a++) {
    const built = buildOnce(spec, (spec.seed + a * 0x9e3779b1) >>> 0);
    if (!built) continue;

    const shortfalls = gradeLevel(built.metrics, config, built.solved);
    if (shortfalls.length === 0) return built.level;

    // Rank near-misses by total shortfall, with the distractor mix as a
    // tie-break so the fallback still reads like the level it was meant to be.
    let score = 0;
    for (const s of shortfalls) score += s.amount;
    score += Math.abs(built.metrics.distractorRatio - config.distractorRatio);
    if (score < bestScore) {
      bestScore = score;
      best = built.level;
    }
  }

  return best ?? fallbackLevel(spec);
}

/**
 * Last-resort lot: a tiny, always-valid jam. Should be unreachable in practice —
 * `buildOnce` only returns null for a lot that failed validation or the solver.
 */
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

/** Bot-persona validation hook used by tests and the tuning scripts (GDD §6 step 4). */
export function auditLevel(level: LevelDef, config?: DifficultyConfig) {
  const state = createLotState(level);
  const solved = solveLevel(level);
  const metrics = analyseDifficulty(level, solved.moves);
  const contract = config ?? difficultyFor(level.index, level.band);
  return {
    ...metrics,
    valid: validateLevel(level).length === 0,
    solvable: solved.solvable,
    parSlides: solved.parSlides,
    vehicles: state.x.length,
    /** Which parts of the level's own difficulty contract it fails, if any. */
    shortfalls: gradeLevel(metrics, contract, solved),
  };
}
