/**
 * JamForge — the board, and the accept/reject loop around it.
 *
 * This module owns where the street frontage opens and where walls, slicks,
 * plates and one-ways go. Where the *cars* go is `forge.ts`, which builds the
 * puzzle backwards from the empty lot and is the part that decides whether a
 * jam is genuinely hard.
 *
 * ## What changed, and why it had to
 *
 * The previous generator inserted every vehicle at a spot it could drive
 * straight off from, and then rejected any candidate lacking a pure exit-only
 * solution. That made two guarantees at once, and the second was fatal:
 *
 * - solvability, which is worth keeping; and
 * - that **no car ever needs repositioning**, which meant every level fell to
 *   tapping whatever currently had a clear lane. Exits only free cells, so
 *   driving one car off can never cost another its route: if an exit-only
 *   solution exists, every exit order is a winning order.
 *
 * Measured over the shipped campaign, greedy cleared 320 of 320 levels across
 * 8,320 runs, with a median 47% of cars able to leave on move one. The knot
 * depth those levels reported was real, but nothing in the game ever asked the
 * player to use it.
 *
 * Generation is now reject-and-retry against structural measurements
 * (`analysis.ts`): build a candidate, work out how much of it falls to
 * thoughtless tapping and how much repositioning its solution needs, and throw
 * it away unless it clears its tier. Looking busy is not difficulty.
 */

import {
  analysePuzzle,
  DifficultyTarget,
  meetsTarget,
  PuzzleMetrics,
  targetPenalty,
} from './analysis';
import { forgeScrambled } from './forge';
import { Rng } from './rng';
import { analyseDifficulty, solveLevel } from './solver';
import { createLotState, validateLevel } from './sim';
import {
  Band,
  BlockerStyle,
  Dir,
  ExitDef,
  LevelDef,
  Move,
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
  /** Structural difficulty a candidate must satisfy to be accepted. */
  target: DifficultyTarget;
  /**
   * Extra un-slides to attempt beyond the tier's requirement.
   *
   * Later construction can undo an earlier shift, and a full board simply runs
   * out of room, so asking for exactly the requirement lands under it more
   * often than not. The slack is what makes the requirement reachable.
   */
  scrambleSlack: number;
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
  vehicles: VehicleDef[];
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
    vehicles: [],
  };
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

/** A built candidate, carrying the solution its own construction proved. */
export interface BuiltLevel {
  level: LevelDef;
  solution: Move[];
  metrics: PuzzleMetrics;
}

function buildOnce(spec: LevelSpec, seed: number): BuiltLevel | null {
  const rng = new Rng(seed);
  const k = makeWork(spec.w, spec.h);

  placeExits(k, rng, spec.streetSides, spec.streetWidth);
  if (spec.modifiers.gate) placeGate(k, rng);
  scatterTerrain(k, rng, spec);

  const lengths: number[] = [];
  for (let i = 0; i < spec.vehicleCount; i++) lengths.push(pickLength(rng, spec.lengthMix));

  // The skeleton carries the board; the forge decides where the cars go.
  const skeleton: LevelDef = {
    id: spec.id,
    index: spec.index,
    w: k.w,
    h: k.h,
    terrain: k.terrain,
    arrows: k.arrows,
    blockerStyle: k.blockerStyle,
    roundaboutSpin: k.spin,
    exits: k.exits,
    vehicles: [],
    parSlides: 0,
    band: spec.band,
    patternTags: spec.patternTags,
    modifierLoad: countModifierFamilies(spec.modifiers),
    knotDepth: 1,
    seed,
  };

  const forged = forgeScrambled(
    {
      level: skeleton,
      lengths,
      vips: spec.modifiers.vips,
      scrambleTarget: spec.target.temporaryMoveRequirement + spec.scrambleSlack,
      distractorRatio: spec.distractorRatio,
      // Seal to the tier's own ceiling on how much may be free on move one.
      sealTo: Math.floor(spec.target.maximumInitialExitShare * spec.vehicleCount),
      // One ring is a proof the lot cannot be tapped out; more rings spread the
      // proof around the board so greedy stalls early rather than near the end.
      ringTarget: spec.target.maximumGreedyShare >= 1 ? 0 : spec.target.maximumGreedyShare <= 0.3 ? 3 : 2,
    },
    rng,
  );
  if (!forged || forged.placements.length < 2) return null;

  const vehicles: VehicleDef[] = forged.placements.map((p, id) => ({
    id,
    kind: kindForLength(p.len, p.tags, rng),
    x: p.x,
    y: p.y,
    facing: p.facing,
    tags: p.tags,
    hue: rng.int(8),
  }));
  k.vehicles = vehicles;

  const level: LevelDef = {
    ...skeleton,
    vehicles,
    parSlides: forged.solution.length,
    solution: forged.solution,
  };

  // Role tags never change legality, so they go on once the puzzle is settled.
  applyRoleTags(k, rng, spec);

  if (validateLevel(level).length > 0) return null;

  // Branching is left out here: it is the expensive measure and generation
  // never reads it. Reports and tests compute it on the handful of levels that
  // actually ship.
  const metrics = analysePuzzle(level, forged.solution, false);
  level.knotDepth = metrics.dependencyDepth;
  return { level, solution: forged.solution, metrics };
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
 * How many lots to build before keeping the best one.
 *
 * A tier's structural requirements are a much narrower target than "is legal",
 * so the harder bands need far more rolls. A miss is cheap — the expensive part
 * of a build is the forge, and it bails early on a board with no room left.
 */
function attemptsFor(spec: LevelSpec): number {
  if (spec.band === Band.Showcase) return 140;
  if (spec.band === Band.Hard) return 120;
  if (spec.band === Band.Medium) return 72;
  return 36;
}

/**
 * Generate a level matching `spec` as closely as the board allows. Always
 * returns a valid, solvable level — never throws, never returns null.
 *
 * A candidate is accepted only when it satisfies every structural requirement
 * of its tier. If no seed manages that, the closest miss ships rather than
 * nothing: an under-target lot is a disappointment, an absent one is a crash.
 */
export function generateLevel(spec: LevelSpec, opts: GenerateOptions = {}): LevelDef {
  const attempts = opts.attempts ?? attemptsFor(spec);
  let best: LevelDef | null = null;
  let bestScore = -Infinity;

  for (let a = 0; a < attempts; a++) {
    const built = buildOnce(spec, (spec.seed + a * 0x9e3779b1) >>> 0);
    if (!built) continue;
    const { level, metrics } = built;

    // One car short is not worth rejecting a structurally sound lot over.
    if (meetsTarget(metrics, spec.target) && level.vehicles.length >= spec.vehicleCount - 1) {
      return level;
    }

    const score = targetPenalty(metrics, spec.target) - Math.abs(level.vehicles.length - spec.vehicleCount) * 3;
    if (score > bestScore) {
      bestScore = score;
      best = level;
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
