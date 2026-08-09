/**
 * The progression curve — one table that scales *everything* together.
 *
 * The old curve grew difficulty on a fixed lot: same seven-by-ten asphalt from
 * level ten to level three hundred, with more cars crammed onto it. That caps
 * the puzzle, because a dependency chain can only be as long as the lanes it
 * runs down, and a bottleneck only reads as one when there is enough lot around
 * it to be bottled.
 *
 * So the lot itself grows. `difficultyFor` turns a level index into a complete
 * contract — board size, car count, how deep the knot must run, how much of the
 * lot may be free to move on turn one — and JamForge builds against that
 * contract while the solver checks the delivered lot back against it. Every
 * number here is a tunable, and they are the only numbers that decide how a
 * level feels.
 *
 * The felt shape, which is what actually matters:
 *
 *   L1     6×8    5 cars   "Okay, I understand this game."
 *   L5     7×9    9 cars   "Now I need to plan a little."
 *   L10    9×11  15 cars   "This is becoming a real puzzle."
 *   L15   11×13  24 cars   "I need to think several moves ahead."
 *   L20   12×15  32 cars   "This is a serious parking jam."
 *
 * Cars keep their cell footprint the whole way; it is the *lot* that grows
 * around them, so a car occupies a steadily smaller share of the screen and a
 * late lot reads as a genuine parking structure rather than a puzzle diagram.
 */

import { Band } from './types';

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * The largest lot the game will ever build.
 *
 * This is a *playability* ceiling, not an engine one. Thirteen columns on a
 * 380 px-wide phone is a 29 px cell — right at the floor of what a thumb can
 * pick out of a packed lot, and the point past which the view has to start
 * panning rather than showing the whole jam at once (see MIN_CELL_PX in the
 * renderer). Growing past it would buy difficulty by making the game harder to
 * *see*, which is the one kind of difficulty worth refusing.
 */
export const MAX_BOARD_W = 13;
export const MAX_BOARD_H = 16;
export const MIN_BOARD_W = 5;
export const MIN_BOARD_H = 6;

/** Hard ceiling on cars, so a huge lot cannot ask for a hundred of them. */
export const MAX_CARS = 44;

/* ------------------------------------------------------------------ *
 * The curve
 * ------------------------------------------------------------------ */

interface CurveStop {
  /** Level index this stop describes exactly. */
  at: number;
  w: number;
  h: number;
  cars: number;
  /** Longest forced "must leave before" chain the lot should carry. */
  depth: number;
}

/**
 * Anchor points, linearly interpolated between. Anything not named here is a
 * blend of its neighbours, which is what keeps the growth felt rather than
 * stepped — a player crossing level 11 sees one more row, not a new game.
 *
 * The board grows fast through the first twenty levels and then holds: past
 * 12×15 the win is no longer legibility-free, so difficulty moves back onto
 * density, depth and vocabulary, which have no such ceiling.
 */
const CURVE: readonly CurveStop[] = [
  { at: 1, w: 6, h: 8, cars: 5, depth: 2 },
  { at: 3, w: 6, h: 8, cars: 7, depth: 3 },
  { at: 6, w: 7, h: 9, cars: 10, depth: 4 },
  { at: 9, w: 8, h: 10, cars: 13, depth: 6 },
  { at: 12, w: 10, h: 12, cars: 18, depth: 8 },
  { at: 15, w: 11, h: 13, cars: 24, depth: 10 },
  { at: 18, w: 12, h: 14, cars: 30, depth: 12 },
  { at: 22, w: 12, h: 15, cars: 34, depth: 13 },
  { at: 60, w: 12, h: 15, cars: 36, depth: 14 },
  { at: 320, w: 12, h: 15, cars: 38, depth: 15 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/** The interpolated curve value at `index`, before any band adjustment. */
function sample(index: number): CurveStop {
  const i = Math.max(1, index);
  if (i <= CURVE[0].at) return CURVE[0];
  const last = CURVE[CURVE.length - 1];
  if (i >= last.at) return last;
  for (let k = 1; k < CURVE.length; k++) {
    const hi = CURVE[k];
    if (i > hi.at) continue;
    const lo = CURVE[k - 1];
    const t = (i - lo.at) / (hi.at - lo.at);
    return {
      at: i,
      w: lerp(lo.w, hi.w, t),
      h: lerp(lo.h, hi.h, t),
      cars: lerp(lo.cars, hi.cars, t),
      depth: lerp(lo.depth, hi.depth, t),
    };
  }
  return last;
}

/**
 * The on-ramp ends at level 10 (mirrors `RAMP_ENDS` in the campaign).
 *
 * Band adjustments are suppressed below it: levels 1–9 are a taught sequence,
 * and a breather that quietly adds three cars to level 2 is not a breather, it
 * is a broken tutorial.
 */
const RAMP_ENDS = 10;

interface BandShift {
  cars: number;
  depth: number;
  w: number;
  h: number;
}

/**
 * What a band does to the curve.
 *
 * Breathers are deliberately *fuller but shallower* — more cars, far less to
 * work out. That is the goal-gradient rest beat: it should look like a lot of
 * work and take almost none. Stretch jams go the other way, and showcase
 * finales get the extra row and column that make them the biggest lots in
 * their district.
 *
 * Note what no band does: shrink the lot. Board size is the one axis the player
 * reads at a glance, so it only ever grows with the level number — a rest beat
 * that visibly *un*-built the parking structure would read as going backwards.
 */
const BAND_SHIFT: Record<Band, BandShift> = {
  [Band.Easy]: { cars: 2, depth: -3, w: 0, h: 0 },
  [Band.Medium]: { cars: 0, depth: 0, w: 0, h: 0 },
  [Band.Hard]: { cars: 2, depth: 1, w: 0, h: 0 },
  [Band.Showcase]: { cars: 3, depth: 2, w: 1, h: 1 },
};

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

/**
 * Everything a level promises, and everything the generator is checked against.
 *
 * Requirements are split into a target (`targetCars`, `boardWidth`…) and floors
 * or ceilings the delivered lot has to clear (`minCars`, `maxInitialFreeCars`…).
 * The generator builds toward the target and the validator rejects against the
 * bounds, which is what lets a candidate that is *better* than asked be kept.
 */
export interface DifficultyConfig {
  index: number;
  band: Band;
  boardWidth: number;
  boardHeight: number;
  /** What the generator aims for. */
  targetCars: number;
  /** Fewer than this and the lot is rejected as under-filled. */
  minCars: number;
  /** More than this and the lot is too tight to read. */
  maxCars: number;
  /** Longest chain of forced precedence the lot must carry. */
  minDependencyDepth: number;
  /** Total moves the shortest solution must take — cars plus repositions. */
  minSolutionMoves: number;
  /** How many cars may drive off on turn one before the lot reads as open. */
  maxInitialFreeCars: number;
  /** A lot with no legal first move is never shippable; early lots want several. */
  minInitialFreeCars: number;
  /** Cars that at least `BOTTLENECK_SPAN` others transitively wait on. */
  minBottlenecks: number;
  /** Cars that neither block nor are blocked, as a share of the lot. */
  maxIndependentRatio: number;
  /** Share of lot cells that must sit under a car. */
  minDensity: number;
  /** True when clearing the lot must require pulling a car temporarily aside. */
  temporaryMoveRequirement: boolean;
  /** Share of cars deliberately parked off the critical path. */
  distractorRatio: number;
  /** Weighted vehicle-length mix, e.g. { 2: 6, 3: 3, 4: 1 }. */
  lengthMix: Record<number, number>;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Bigger lots carry longer vehicles.
 *
 * A five-cell bus on a 6×8 lot is a wall across the whole board; on a 12×15 it
 * is a freight bay you have to plan around. Length mix is therefore gated on
 * the curve rather than on level number alone.
 */
function lengthMixFor(index: number, cells: number): Record<number, number> {
  if (index < 5) return { 2: 1 };
  if (index < 10) return { 2: 6, 3: 2 };
  if (index < 14 || cells < 100) return { 2: 6, 3: 3, 4: 1 };
  if (index < 20 || cells < 150) return { 2: 5, 3: 3, 4: 2 };
  return { 2: 5, 3: 3, 4: 2, 5: 1 };
}

function averageLength(mix: Record<number, number>): number {
  let total = 0;
  let weight = 0;
  for (const key of Object.keys(mix)) {
    const len = Number(key);
    total += len * mix[len];
    weight += mix[len];
  }
  return weight === 0 ? 2 : total / weight;
}

/**
 * How open the lot may look on turn one, as a share of the cars in it.
 *
 * Measured as a share because four free cars out of eight and four out of
 * thirty-four are not the same lot at all — the first is half the jam solved on
 * sight, the second is a thread to pull. The absolute cap on top of it is what
 * stops a huge breather from opening with fifteen free cars.
 */
function opennessCeiling(index: number, band: Band, cars: number): number {
  if (index <= 3) return cars; // the tutorial is allowed to be transparent
  const share =
    band === Band.Easy ? 0.55 : band === Band.Hard ? 0.28 : band === Band.Showcase ? 0.26 : 0.4;
  const absolute = index < RAMP_ENDS ? 6 : 14;
  return clamp(Math.round(cars * share), 2, absolute);
}

/**
 * …and how closed it may be.
 *
 * A thirty-car lot with exactly one legal opening move is not hard, it is
 * dictated: the first five minutes play themselves and the player never gets to
 * choose wrongly. Difficulty in this game lives in picking the right thread out
 * of several plausible ones, so there has to be more than one to pick from.
 */
function opennessFloor(index: number, band: Band, cars: number): number {
  if (index <= 3) return 2;
  const share =
    band === Band.Easy ? 0.35 : band === Band.Hard ? 0.09 : band === Band.Showcase ? 0.08 : 0.12;
  // A breather is *defined* by its opening: a wide, obviously-workable lot that
  // happens to be big. It gets a much higher ceiling on this floor than the
  // other bands, because "thirty cars and six of them can move" is not rest.
  const ceiling = band === Band.Easy ? 14 : 6;
  return clamp(Math.round(cars * share), index < RAMP_ENDS ? 1 : 2, ceiling);
}

/**
 * Bottlenecks are the shape of a large jam.
 *
 * On a small lot every car is nearly a bottleneck and the count means nothing;
 * on a big one, "how many cars does a quarter of the lot wait on" is the single
 * best proxy for whether the player has to *plan* rather than scan. It only
 * starts being asked for once the lot is big enough for the number to mean
 * something.
 */
function bottlenecksFor(index: number, band: Band): number {
  if (index < 7) return 0;
  const base = index < 10 ? 1 : index < 13 ? 2 : index < 16 ? 3 : 4;
  if (band === Band.Easy) return Math.max(0, base - 2);
  if (band === Band.Hard || band === Band.Showcase) return base + 1;
  return base;
}

/**
 * Ceiling on cars that neither block anybody nor are blocked by anybody.
 *
 * Free parking is fine as scenery early and poison late: a level-twenty lot
 * where a third of the cars can be cleared in any order is a big lot, not a
 * hard one. This is the lever that turns "more cars" into "more puzzle".
 */
function independenceCeiling(index: number, band: Band): number {
  const base = index <= 3 ? 1 : index < 7 ? 0.5 : index < 10 ? 0.4 : index < 13 ? 0.3 : index < 16 ? 0.25 : 0.2;
  return band === Band.Easy ? Math.min(1, base + 0.15) : base;
}

function distractorRatioFor(index: number, band: Band): number {
  const base = index < RAMP_ENDS ? clamp(0.05 * (index - 1), 0, 0.2) : clamp(lerp(0.42, 0.6, (index - RAMP_ENDS) / 110), 0.42, 0.6);
  return band === Band.Easy ? Math.min(0.7, base + 0.1) : base;
}

/**
 * Temporary repositioning — the last difficulty lever, and the one that changes
 * what kind of thinking the lot asks for.
 *
 * Up to here every jam clears by driving cars straight off in the right order,
 * so the read is "find the order". A lot that needs a car pulled aside and put
 * back in play breaks that habit: the answer is no longer a permutation, and
 * the player has to hold a board state in their head. It arrives once the
 * vocabulary is fully open, on the harder bands only, and never on a breather.
 */
function temporaryMoveFor(index: number, band: Band): boolean {
  if (index < 13) return false;
  return band === Band.Hard || band === Band.Showcase;
}

/** The full contract for a level. Deterministic; no randomness anywhere. */
export function difficultyFor(index: number, band: Band): DifficultyConfig {
  const i = Math.max(1, Math.floor(index));
  const curve = sample(i);
  const shift = i < RAMP_ENDS ? BAND_SHIFT[Band.Medium] : BAND_SHIFT[band];

  const boardWidth = clamp(Math.round(curve.w + shift.w), MIN_BOARD_W, MAX_BOARD_W);
  const boardHeight = clamp(Math.round(curve.h + shift.h), MIN_BOARD_H, MAX_BOARD_H);
  const cells = boardWidth * boardHeight;
  const lengthMix = lengthMixFor(i, cells);
  const avgLen = averageLength(lengthMix);

  // A lot only holds so many cars before there is no lane left to leave down.
  // Half the cells under metal is already a very full parking structure.
  const capacity = Math.floor((cells * 0.52) / avgLen);
  const targetCars = clamp(Math.round(curve.cars + shift.cars), 3, Math.min(MAX_CARS, capacity));
  const minCars = Math.max(3, Math.round(targetCars * (i <= 3 ? 1 : 0.88)));
  const maxCars = Math.min(MAX_CARS, capacity);

  const minDependencyDepth = clamp(Math.round(curve.depth + shift.depth), 2, targetCars - 1);

  return {
    index: i,
    band,
    boardWidth,
    boardHeight,
    targetCars,
    minCars,
    maxCars,
    minDependencyDepth,
    // Every car costs a slide, so the car floor *is* the move floor — plus the
    // reposition when one is demanded.
    minSolutionMoves: minCars + (temporaryMoveFor(i, band) ? 1 : 0),
    maxInitialFreeCars: opennessCeiling(i, band, targetCars),
    minInitialFreeCars: opennessFloor(i, band, targetCars),
    minBottlenecks: bottlenecksFor(i, band),
    maxIndependentRatio: independenceCeiling(i, band),
    // Follows from the car target rather than being an independent dial: the
    // point of the floor is to catch a lot that met its count with nothing but
    // sedans parked round the rim, leaving a hollow middle.
    minDensity: (minCars * avgLen * 0.82) / cells,
    temporaryMoveRequirement: temporaryMoveFor(i, band),
    distractorRatio: distractorRatioFor(i, band),
    lengthMix,
  };
}
