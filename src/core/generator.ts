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
 * Knot depth is *authored*, not hoped for: the first `knotDepth` insertions are
 * required to block the vehicle inserted just before them, which lays down an
 * explicit dependency chain. The rest are placed as blockers or distractors
 * according to the band's distractor ratio.
 */

import { Rng } from './rng';
import { analyseDifficulty, solveLevel } from './solver';
import { createLotState, validateLevel } from './sim';
import {
  Band,
  BlockerStyle,
  Dir,
  DX,
  DY,
  ExitDef,
  LevelDef,
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
  /** Cached forward ray of each placed vehicle: cell indices from nose to curb. */
  rays: number[][];
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
    rays: [],
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

/**
 * Straight path from a nose cell to a curb cut, as cell indices *ahead* of the
 * nose (exclusive). Returns null when no clear route exists.
 */
function exitRay(k: Work, x: number, y: number, facing: Dir, ignore = -1): number[] | null {
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
    const occupant = k.occ[idx];
    if (occupant !== -1 && occupant !== ignore) return null;
    path.push(idx);
  }
  return null;
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
      if (dir === 0) k.exits.push({ x: j, y: 0, dir });
      else if (dir === 2) k.exits.push({ x: j, y: k.h - 1, dir });
      else if (dir === 1) k.exits.push({ x: k.w - 1, y: j, dir });
      else k.exits.push({ x: 0, y: j, dir });
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
 * Vehicle insertion
 * ------------------------------------------------------------------ */

interface Candidate {
  x: number;
  y: number;
  facing: Dir;
  cells: number[];
  /** Previously-placed vehicles this candidate would stand in front of. */
  blocks: number[];
  /** Cells between this candidate's nose and its own curb cut. */
  rayLen: number;
}

function collectCandidates(k: Work, len: number): Candidate[] {
  const out: Candidate[] = [];
  for (let y = 0; y < k.h; y++) {
    for (let x = 0; x < k.w; x++) {
      for (let f = 0 as Dir; f < 4; f = (f + 1) as Dir) {
        const cells = bodyCells(k, x, y, f, len);
        if (!cells) continue;
        const ray = exitRay(k, x, y, f);
        if (!ray) continue;
        const blocks: number[] = [];
        for (let vi = 0; vi < k.vehicles.length; vi++) {
          const other = k.rays[vi];
          for (const c of cells) {
            if (other.includes(c)) {
              blocks.push(vi);
              break;
            }
          }
        }
        out.push({ x, y, facing: f, cells, blocks, rayLen: ray.length });
      }
    }
  }
  return out;
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

/** Pick randomly from the best few candidates — keeps lots varied but purposeful. */
function chooseCandidate(
  rng: Rng,
  pool: Candidate[],
  score: (c: Candidate) => number,
  topK = 5,
): Candidate {
  let best: Candidate[] = [];
  let bestScore = -Infinity;
  const scored = pool.map((c) => ({ c, s: score(c) }));
  scored.sort((a, b) => b.s - a.s);
  for (const entry of scored) {
    if (best.length >= topK && entry.s < bestScore) break;
    if (entry.s > bestScore) bestScore = entry.s;
    best.push(entry.c);
    if (best.length >= topK) break;
  }
  if (best.length === 0) best = pool;
  return best[rng.int(best.length)];
}

function commit(k: Work, rng: Rng, c: Candidate, len: number, tags: number): void {
  const id = k.vehicles.length;
  for (const idx of c.cells) k.occ[idx] = id;
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

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

function buildOnce(spec: LevelSpec, seed: number): LevelDef | null {
  const rng = new Rng(seed);
  const k = makeWork(spec.w, spec.h);

  placeExits(k, rng, spec.streetSides, spec.streetWidth);
  if (spec.modifiers.gate) placeGate(k, rng);
  scatterTerrain(k, rng, spec);

  const total = spec.vehicleCount;
  // VIPs must leave first, so under reverse construction they go in last.
  const vipFrom = total - spec.modifiers.vips;
  // Keep some insertions in reserve for distractors; the rest may chase depth.
  const chainBudget = total - Math.round(total * spec.distractorRatio * 0.8);

  for (let i = 0; i < total; i++) {
    const len = pickLength(rng, spec.lengthMix);
    let candidates = collectCandidates(k, len);
    if (candidates.length === 0 && len > 2) candidates = collectCandidates(k, 2);
    if (candidates.length === 0) break;

    const heights = i === 0 ? [] : chainHeights(k);
    const currentDepth = heights.length ? Math.max(...heights) : 0;
    const wantsDepth = i < chainBudget && currentDepth < spec.knotDepth;

    let pool: Candidate[];
    let score: (c: Candidate) => number;

    if (i === 0) {
      // Anchor the knot deep in the lot so the chain has room to grow.
      pool = candidates;
      score = (c) => c.rayLen;
    } else if (wantsDepth) {
      // Rank every placement by the knot depth it would actually produce, then
      // break ties toward lanes with room left to grow into.
      pool = candidates;
      score = (c) => {
        let gain = 1;
        for (const b of c.blocks) gain = Math.max(gain, heights[b] + 1);
        return gain * 12 + c.rayLen * 2 + c.blocks.length * 0.5;
      };
    } else if (rng.next() < spec.distractorRatio) {
      // Distractors thicken the read without deepening it, so park them where
      // they consume the least lane: nearest the street.
      pool = candidates.filter((c) => c.blocks.length === 0);
      score = (c) => -c.rayLen;
    } else {
      pool = candidates.filter((c) => c.blocks.length > 0);
      score = (c) => c.blocks.length * 2 - c.rayLen;
    }
    if (pool.length === 0) pool = candidates;

    const pick = chooseCandidate(rng, pool, score);
    let tags = 0;
    if (i >= vipFrom && spec.modifiers.vips > 0) tags |= VehicleTag.Vip;
    commit(k, rng, pick, pick.cells.length, tags);
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

  const solved = solveLevel(level, { exitOnlyOnly: true });
  if (!solved.solvable) return null;

  level.parSlides = solved.parSlides;
  level.knotDepth = analyseDifficulty(level, solved.moves).knotDepth;
  return level;
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

/**
 * What share of the lot may drive off on move one.
 *
 * Too few and the lot reads as a wall; too many and there is no read at all.
 * Breathers want a generous opening (goal-gradient candy), stretch jams want
 * the player to have to look for the thread. Measured as a *share*, because
 * four free cars out of eight and four out of twenty are nothing alike.
 */
function opennessFit(open: number, band: Band, vehicles: number): number {
  if (open === 0) return -14; // a lot with no legal first move is never shippable
  if (vehicles === 0) return 0;
  const [lo, hi] =
    band === Band.Easy
      ? [0.35, 0.9]
      : band === Band.Hard
        ? [0.12, 0.4]
        : band === Band.Showcase
          ? [0.15, 0.45]
          : [0.2, 0.55];
  const share = open / vehicles;
  if (share < lo) return (share - lo) * 30;
  if (share > hi) return (hi - share) * 20;
  return 3;
}

/** Harder bands get more shots at the dice — a deep knot is a rarer roll. */
/**
 * How many lots to build before keeping the best one.
 *
 * The knot a lot can hold is capped by its geometry, and a run that packs cells
 * with blockers and distractors leaves JamForge fewer valid insertions to chain
 * through — so a demanding spec needs more tries to find a build that actually
 * reaches its target depth, not just a build that is legal. Stretch and
 * showcase jams get the largest budget because they are the ones asking for
 * depth the board can only just deliver.
 */
function attemptsFor(spec: LevelSpec): number {
  if (spec.band === Band.Showcase) return 96;
  if (spec.band === Band.Hard) return 80;
  if (spec.band === Band.Medium) return 48;
  return 28;
}

/**
 * Generate a level matching `spec` as closely as the board allows. Always
 * returns a valid, solvable level — never throws, never returns null.
 */
export function generateLevel(spec: LevelSpec, opts: GenerateOptions = {}): LevelDef {
  const attempts = opts.attempts ?? attemptsFor(spec);
  let best: LevelDef | null = null;
  let bestScore = -Infinity;

  for (let a = 0; a < attempts; a++) {
    const level = buildOnce(spec, (spec.seed + a * 0x9e3779b1) >>> 0);
    if (!level) continue;

    const metrics = analyseDifficulty(level);
    const countScore = -Math.abs(level.vehicles.length - spec.vehicleCount) * 3;
    // Overshooting the target depth is a bonus, not a miss.
    const knotScore = Math.min(0, level.knotDepth - spec.knotDepth) * 5;
    const distractorScore = -Math.abs(metrics.distractorRatio - spec.distractorRatio) * 6;
    const opennessScore = opennessFit(metrics.openExits, spec.band, level.vehicles.length);
    const score = countScore + knotScore + distractorScore + opennessScore;

    if (score > bestScore) {
      bestScore = score;
      best = level;
    }
    if (
      level.vehicles.length === spec.vehicleCount &&
      level.knotDepth >= spec.knotDepth &&
      opennessFit(metrics.openExits, spec.band, level.vehicles.length) > 0
    ) {
      return level;
    }
  }

  return best ?? fallbackLevel(spec);
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

/** Bot-persona validation hook used by tests and the tuning scripts (GDD §6 step 4). */
export function auditLevel(level: LevelDef) {
  const state = createLotState(level);
  const solved = solveLevel(level);
  const metrics = analyseDifficulty(level, solved.moves);
  return {
    ...metrics,
    valid: validateLevel(level).length === 0,
    solvable: solved.solvable,
    parSlides: solved.parSlides,
    vehicles: state.x.length,
  };
}
