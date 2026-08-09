/**
 * Gridlock City — the authored jam sequence (GDD §6 "Difficulty Curve Shape").
 *
 * Levels are described, not stored: `specForLevel` turns a global level index
 * into a fully determined LevelSpec, and JamForge turns that into the same lot
 * on every device, every time. 320 launch jams cost zero bundle bytes, and the
 * whole sequence is remote-config-shaped — every number here is a tunable.
 */

import {
  DifficultyTargets,
  generateLevel,
  LevelSpec,
  ModifierSpec,
  NO_MODIFIERS,
} from './generator';
import { hashString } from './rng';
import { Band, LevelDef } from './types';

/* ------------------------------------------------------------------ *
 * Chapters
 * ------------------------------------------------------------------ */

/** Jams per district. Sums to 320 — the launch content commitment (GDD §6). */
export const CHAPTER_SIZES: readonly number[] = [20, 22, 26, 26, 28, 28, 28, 28, 28, 28, 28, 30];

export const TOTAL_LEVELS = CHAPTER_SIZES.reduce((a, b) => a + b, 0);

const CHAPTER_STARTS: readonly number[] = (() => {
  const out: number[] = [];
  let n = 1;
  for (const size of CHAPTER_SIZES) {
    out.push(n);
    n += size;
  }
  return out;
})();

export interface ChapterPosition {
  /** 0-based district index. */
  district: number;
  /** 0-based position within the chapter. */
  pos: number;
  size: number;
}

export function chapterPosition(index: number): ChapterPosition {
  const clamped = Math.max(1, index);
  for (let d = CHAPTER_SIZES.length - 1; d >= 0; d--) {
    if (clamped >= CHAPTER_STARTS[d]) {
      const pos = clamped - CHAPTER_STARTS[d];
      // Levels past the launch sequence loop through the final chapter's shape.
      return { district: d, pos: pos % CHAPTER_SIZES[d], size: CHAPTER_SIZES[d] };
    }
  }
  return { district: 0, pos: 0, size: CHAPTER_SIZES[0] };
}

export function firstLevelOfDistrict(district: number): number {
  return CHAPTER_STARTS[Math.max(0, Math.min(CHAPTER_STARTS.length - 1, district))];
}

export function levelsInDistrict(district: number): number {
  return CHAPTER_SIZES[Math.max(0, Math.min(CHAPTER_SIZES.length - 1, district))];
}

/* ------------------------------------------------------------------ *
 * The tide — band assignment
 * ------------------------------------------------------------------ */

/**
 * The on-ramp ends at level 10.
 *
 * Levels 1–3 teach the verb, 4–9 add vocabulary at a standard difficulty, and
 * from 10 the chapter tide takes over at full strength. It is a deliberately
 * short runway: the curve is tuned for a player who wants to be thinking hard
 * almost immediately, not one who wants a fortnight of tutorial.
 */
const RAMP_ENDS = 10;

/**
 * A 20-slot chapter template, weighted to stretch jams: the rhythm of
 * breather → standard → stretch is kept because the goal gradient needs it,
 * but stretch is now the *default* texture of a chapter rather than its peak.
 * Breathers still exist — they are rest, not easy.
 */
const BAND_TEMPLATE: readonly Band[] = [
  // Slot 0 is never reached at pos 0 — a chapter opener is forced to a breather
  // above. It is reached at pos 1 of any chapter longer than twenty, so leaving
  // it a breather gave those districts two rest levels back to back.
  Band.Medium,
  Band.Medium,
  Band.Hard,
  Band.Hard,
  Band.Medium,
  Band.Easy,
  Band.Hard,
  Band.Hard,
  Band.Medium,
  // Slot 9 is level 10 in the opening chapter, the level the ramp hands over
  // on. It is a stretch jam on purpose: the step up should be felt, not eased.
  Band.Hard,
  Band.Hard,
  Band.Medium,
  Band.Hard,
  Band.Hard,
  Band.Easy,
  Band.Hard,
  Band.Medium,
  Band.Hard,
  Band.Medium,
  Band.Showcase,
];

export function bandForLevel(index: number): Band {
  if (index <= 3) return Band.Easy;
  if (index < RAMP_ENDS) return Band.Medium;
  const { pos, size } = chapterPosition(index);
  if (pos === size - 1) return Band.Showcase;
  if (pos === 0) return Band.Easy;
  const slot = Math.min(BAND_TEMPLATE.length - 1, Math.floor((pos * BAND_TEMPLATE.length) / size));
  const band = BAND_TEMPLATE[slot];
  // Never introduce a new mechanic inside a stretch jam (GDD §4).
  if (band === Band.Hard && PATTERN_INTRO_LEVELS.has(index)) return Band.Medium;
  return band;
}

/* ------------------------------------------------------------------ *
 * Pattern vocabulary (GDD §6)
 * ------------------------------------------------------------------ */

export interface PatternDef {
  tag: string;
  label: string;
  /** Level that introduces the pattern. */
  intro: number;
  blurb: string;
}

/**
 * The whole vocabulary is taught inside the first two districts. A pattern
 * cannot appear before the mechanic it reads on has opened, so these intros sit
 * at or after their gate below.
 */
export const PATTERNS: readonly PatternDef[] = [
  { tag: 'zipper', label: 'Zipper', intro: 4, blurb: 'Interleaved rows — find which end unzips.' },
  { tag: 'plug', label: 'Plug', intro: 5, blurb: 'One car corks the only lane out.' },
  { tag: 'freightWall', label: 'Freight Wall', intro: 7, blurb: 'A box truck is the wall. Move the wall.' },
  { tag: 'comb', label: 'Comb', intro: 9, blurb: 'Parallel teeth, one crossing blocker.' },
  { tag: 'onion', label: 'Onion', intro: 11, blurb: 'Solve outside-in, exit inside-out.' },
  { tag: 'slickCorridor', label: 'Slick Corridor', intro: 12, blurb: 'Oil sends you to the wall.' },
  { tag: 'decoy', label: 'Decoy', intro: 13, blurb: 'The obvious car is a trap.' },
  { tag: 'velvetRope', label: 'Velvet Rope', intro: 15, blurb: 'The VIP leaves first, or nobody does.' },
  { tag: 'dominoRun', label: 'Domino Run', intro: 17, blurb: 'Every exit frees exactly one more.' },
  { tag: 'twoDoor', label: 'Two-Door', intro: 19, blurb: 'Two streets, two competing flows.' },
  { tag: 'carousel', label: 'Carousel', intro: 21, blurb: 'Roundabouts turn a hopeless facing.' },
  { tag: 'borderCrossing', label: 'Border Crossing', intro: 23, blurb: 'The read spans two rooms.' },
];

const PATTERN_INTRO_LEVELS = new Set(PATTERNS.map((p) => p.intro));

export function patternIntroducedAt(index: number): PatternDef | null {
  return PATTERNS.find((p) => p.intro === index) ?? null;
}

/** Patterns unlocked at or before `index`. */
export function unlockedPatterns(index: number): PatternDef[] {
  return PATTERNS.filter((p) => p.intro <= index);
}

function patternForLevel(index: number): PatternDef {
  const intro = patternIntroducedAt(index);
  if (intro) return intro;
  const pool = unlockedPatterns(index);
  if (pool.length === 0) return { tag: 'open', label: 'Open Lot', intro: 1, blurb: 'A plain jam.' };
  // Deterministic rotation so a level always wears the same pattern tag.
  return pool[hashString(`pattern:${index}`) % pool.length];
}

/* ------------------------------------------------------------------ *
 * Mechanic unlock gates (GDD §4 "Unlock Schedule")
 * ------------------------------------------------------------------ */

/**
 * Two kinds of gate live here, and they move independently.
 *
 * **Mechanic** gates decide what a lot may contain, so they set how hard the
 * game is allowed to be. They are front-loaded: the full puzzle vocabulary is
 * open by level 18, because a lot with nothing in it but cars can only be made
 * harder by piling on more cars, and that is tedium rather than difficulty.
 *
 * **Meta** gates decide when a screen or a mode appears, and they are paced for
 * a player learning an app, not a puzzle. They stay where they were — in
 * particular Metered Lots, the one mode with a real fail state, is still held
 * back until the player has mastered the unlimited one.
 */
export const GATES = {
  cityMap: 5,
  blockers: 6,
  trunks: 6,
  oneWays: 8,
  garage: 10,
  oil: 10,
  trailers: 10,
  vips: 12,
  interstitials: 12,
  ambulances: 14,
  cleanRun: 14,
  dispatchBoard: 15,
  roundabouts: 16,
  gates: 18,
  rushHour: 20,
  cityPass: 25,
  ambulanceRun: 28,
  hornLibrary: 34,
  meteredLots: 45,
  goldPlates: 70,
  overtime: 80,
} as const;

export type GateKey = keyof typeof GATES;

export function isUnlocked(gate: GateKey, highestLevelReached: number): boolean {
  return highestLevelReached >= GATES[gate];
}

/* ------------------------------------------------------------------ *
 * Difficulty vector
 * ------------------------------------------------------------------ */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

interface Dimensions {
  w: number;
  h: number;
}

/**
 * The lot has to be big enough to hold the knot being asked of it.
 *
 * Depth past four links needs a chain that turns corners, and a corner needs a
 * crossing lane with its own curb cut — so grid size is not decoration, it is
 * the ceiling on every other difficulty lever. It grows fast to clear the way
 * for the level-10 step up, then settles: past 7×10 the cells get too small to
 * touch comfortably on a phone.
 */
function gridForLevel(index: number, band: Band): Dimensions {
  let w: number;
  let h: number;
  if (index <= 4) [w, h] = [5, 6];
  else if (index < RAMP_ENDS) [w, h] = [6, 7];
  else if (index <= 24) [w, h] = [7, 9];
  else [w, h] = [7, 10];

  if (band === Band.Showcase) {
    w = Math.min(8, w + 1);
    h = Math.min(10, h + 1);
  } else if (band === Band.Easy && index >= RAMP_ENDS) {
    // Breathers are wide and shallow: many exits, little thinking (GDD §6).
    h = Math.max(6, h - 1);
  }
  return { w, h };
}

/**
 * How many cars the lot carries.
 *
 * Lower than it used to be, deliberately. A car needs an empty cell in its own
 * lane before it can be shunted anywhere, so a lot packed to three-quarters
 * full is a lot where nothing can reposition — every knot in it has to be
 * untied by exit order alone, which is to say it unties itself. Density past
 * roughly half the lot buys crowding and sells the puzzle, and crowding was
 * never the thing that made a jam hard.
 */
function vehicleCountFor(index: number, band: Band, dims: Dimensions): number {
  let base: number;
  if (index < RAMP_ENDS) base = lerp(4, 8, (index - 1) / (RAMP_ENDS - 2));
  else if (index <= 30) base = lerp(11, 13, (index - RAMP_ENDS) / 20);
  else if (index <= 120) base = lerp(13, 15, (index - 30) / 90);
  else base = lerp(15, 16, (index - 120) / 200);

  const bandAdjust =
    band === Band.Easy ? -1 : band === Band.Hard ? 1 : band === Band.Showcase ? 2 : 0;
  // Breathers carry MORE cars but a shallower knot — pure goal-gradient candy.
  const breatherBonus = band === Band.Easy && index >= RAMP_ENDS ? 3 : 0;

  const capacity = Math.floor((dims.w * dims.h) / 4.4);
  return Math.max(3, Math.min(capacity, Math.round(base) + bandAdjust + breatherBonus));
}

/**
 * A lot only holds as many cars as it has usable lanes, so a deliberately
 * constrained frontage has to ask for fewer. Keeping the spec honest matters:
 * an unreachable target would silently degrade every other tuning signal.
 */
function densityFactor(street: Street): number {
  return Math.min(1, 0.45 + street.sides * 0.1 + street.width * 0.3);
}

function knotDepthFor(index: number, band: Band, vehicles: number): number {
  // Calibrated against what the lot geometry can actually hold: a chain has to
  // turn corners to grow past four links, and each turn needs a curb cut on the
  // crossing lane. Held a notch below the old curve because the lots now carry
  // fewer cars on purpose, and a chain cannot be longer than the cars in it.
  let base: number;
  if (index < RAMP_ENDS) base = lerp(2, 4, (index - 1) / (RAMP_ENDS - 2));
  else if (index <= 30) base = lerp(4, 5, (index - RAMP_ENDS) / 20);
  else if (index <= 120) base = lerp(5, 6, (index - 30) / 90);
  else base = lerp(6, 7, (index - 120) / 200);

  const bandAdjust =
    band === Band.Easy ? -1.5 : band === Band.Hard ? 1 : band === Band.Showcase ? 1.5 : 0;
  return Math.max(2, Math.min(vehicles - 1, Math.round(base + bandAdjust)));
}

/**
 * How many repositioning slides a lot must demand.
 *
 * This is the difficulty dial now, and it is the one number that cannot be
 * faked. Every other lever — car count, blocker density, chain depth — leaves a
 * lot that "tap whatever is free" still clears on its own, because taking a
 * free exit is never a mistake. Only a lot that *has* to be untied with a slide
 * asks the player a question they can get wrong.
 *
 * The on-ramp genuinely gets none: levels 1–4 teach the verb, and a lot you can
 * clear by reading it is the right place to learn what reading it means.
 */
function repositionsFor(index: number, band: Band, vehicles: number): number {
  if (index <= 4) return 0;
  if (index < RAMP_ENDS) return 1;

  const base = lerp(2.4, 5.2, Math.min(1, (index - RAMP_ENDS) / 140));
  const bandAdjust =
    band === Band.Easy ? -1.2 : band === Band.Hard ? 1.4 : band === Band.Showcase ? 2.2 : 0;
  // Interlocks need cars to lock together; a sparse lot cannot hold many.
  return Math.max(1, Math.min(Math.floor(vehicles / 2.5), Math.round(base + bandAdjust)));
}

/**
 * The full difficulty vector for a level.
 *
 * Read top to bottom this is the design brief: how deep the knot goes, how few
 * cars may leave unaided, how much of the lot is still standing when reflex runs
 * out, and how much of it has to be untied deliberately.
 */
function targetsFor(index: number, band: Band, vehicles: number): DifficultyTargets {
  const repositions = repositionsFor(index, band, vehicles);
  const onRamp = index < RAMP_ENDS;

  // What share of the lot must survive "tap whatever is free". At zero the lot
  // is a pure ordering exercise; the campaign holds it well above that from
  // level 10 on. The numbers are calibrated against what the geometry actually
  // delivers — a 7×10 lot reliably holds a third to a half of its cars behind
  // a knot, and asking for more only makes the gate reject everything and ship
  // the best miss, which is worse than asking for what is there.
  const stallShare = onRamp
    ? index <= 4
      ? 0
      : 0.2
    : band === Band.Easy
      ? 0.22
      : band === Band.Hard
        ? 0.4
        : band === Band.Showcase
          ? 0.44
          : 0.3;

  const openShare = onRamp ? 0.55 : band === Band.Easy ? 0.5 : band === Band.Medium ? 0.35 : 0.3;

  return {
    dependencyDepth: knotDepthFor(index, band, vehicles),
    // The user-facing shape of a jam: how many meaningful steps it takes. Set
    // by band rather than by car count, because "twenty moves" is the thing a
    // designer means when they say a level should take real thought.
    minimumSolutionMoves: onRamp
      ? 5
      : band === Band.Easy
        ? 11
        : band === Band.Hard
          ? 14
          : band === Band.Showcase
            ? 16
            : 12,
    maximumInitialExits: Math.max(1, Math.round(vehicles * openShare)),
    // The opening is a floor as well as a ceiling, because the generator will
    // otherwise cork every lot as tight as it can and breathers would come out
    // tighter than the stretch jams they are meant to be a rest from. A
    // breather opens with a handful of cars ready to go; a stretch jam is
    // allowed to open with none at all, which is the point of it.
    minimumInitialExits:
      onRamp || band === Band.Easy
        ? 2
        : band === Band.Medium
          ? 1
          : 0,
    minimumBlockedCars: Math.round(vehicles * (onRamp ? 0.7 : 0.85)),
    minimumBottlenecks: onRamp ? 0 : band === Band.Easy ? 2 : band === Band.Medium ? 4 : 6,
    temporaryMoveRequirement: repositions,
    // What the *solver* must still need after it has found the shortest line.
    // Far smaller than the number of knots the construction ties, and that gap
    // is the point of measuring it: a lot can be built with six interlocks and
    // still come apart in one well-chosen shunt, because the loops turned out
    // to share cars. Only this number says what the player cannot avoid.
    minimumRequiredRepositions: onRamp
      ? 1
      : band === Band.Easy
        ? 1
        : band === Band.Showcase
          ? 3
          : 2,
    minimumGreedyStall: Math.round(vehicles * stallShare),
    // Turning a car round mid-solution is the rarest read of all — rare enough
    // that a lot of this size can seldom produce one, so it is chased through
    // the score rather than demanded through the gate. Demanding it only
    // guaranteed every stretch jam would miss a target and fall back.
    backtrackingRequirement: 0,
    // Scenery is pruned outright rather than tolerated, so this can be absolute.
    maximumIndependentCars: 0,
  };
}

function lengthMixFor(index: number): Record<number, number> {
  if (index < 5) return { 2: 1 };
  if (index < GATES.trailers) return { 2: 6, 3: 2 };
  if (index <= 24) return { 2: 6, 3: 3, 4: 1 };
  return { 2: 5, 3: 3, 4: 2 };
}

interface Street {
  sides: number;
  width: number;
}

/**
 * How much street the lot fronts onto.
 *
 * Counter-intuitively, *more* street makes a lot harder, not easier — and on
 * this board the count of open edges is not a preference, it is a hard gate on
 * whether the lot can be a puzzle at all.
 *
 * A car leaves straight along its facing, so a curb cut is what makes a lane
 * usable. With curb cuts on only two edges, give every car a number: how far it
 * still has to travel toward the streets that exist. Standing in someone's way
 * always means standing *ahead* of them, so every "must leave first" arrow
 * points from a smaller number to a larger one — the dependency graph cannot
 * contain a loop, and a graph with no loop always has somebody who can drive
 * off. Which means the lot can always be cleared by tapping, however dense it
 * looks. A third edge does not fix it: with (say) north, south and east open,
 * the same argument runs on the east–west axis alone.
 *
 * Only with all four edges open does the shortest loop become constructible —
 * four cars, one facing each way, each parked across the next one's lane. That
 * loop is the thing a player has to *solve* rather than merely read, so every
 * lot expected to demand a reposition fronts onto four streets. Narrowness is
 * still the design lever: the Plug's cork read now comes from a two-cell
 * frontage on each edge rather than from bricking two edges up entirely.
 */
function streetFor(index: number, band: Band, pattern: string): Street {
  // The first four lots are a single frontage on purpose: one direction, one
  // idea, and nothing that can knot.
  if (index <= 4) return { sides: 1, width: 1 };
  // Narrow frontage turned out to be an *anti*-difficulty lever. Cutting the
  // curb back shrinks the patch of lot served by all four directions, and that
  // patch is the only place a loop can be tied — so a miserly frontage buys a
  // cramped-looking lot that unties itself. The Plug keeps the tightest curb of
  // the set, but not tight enough to squeeze the puzzle out of it.
  if (pattern === 'plug') return { sides: 4, width: 0.7 };
  if (pattern === 'twoDoor') return { sides: 4, width: 0.8 };
  if (index < RAMP_ENDS) return { sides: 4, width: 1 };
  if (band === Band.Easy) return { sides: 4, width: 1 };
  return { sides: 4, width: 0.85 };
}

/**
 * Modifier load is capped at 2 families early and 3 once the vocabulary is
 * open (GDD §4), and a brand-new mechanic never shares a lot with another
 * while it is still being taught.
 *
 * That teaching window is three levels rather than five. It is the one guard
 * rail the compressed curve genuinely trades against — a mechanic still gets a
 * clean lot to be introduced on, just not a long one.
 */
function modifiersFor(index: number, band: Band, pattern: string, dims: Dimensions): ModifierSpec {
  const cells = dims.w * dims.h;
  const m: ModifierSpec = { ...NO_MODIFIERS };
  const cap = index < 20 ? 2 : 3;

  const intro = patternIntroducedAt(index);
  const isFreshMechanic = (gate: number) => index >= gate && index < gate + 3;
  const soloMechanic = intro !== null || isFreshMechanic(GATES.oil) || isFreshMechanic(GATES.vips);

  const families: Array<() => void> = [];

  if (pattern === 'slickCorridor' && index >= GATES.oil) {
    families.push(() => (m.oil = Math.max(2, Math.round(cells * 0.06))));
  }
  if (pattern === 'velvetRope' && index >= GATES.vips) {
    families.push(() => (m.vips = 1));
  }
  if (pattern === 'carousel' && index >= GATES.roundabouts) {
    families.push(() => (m.roundabouts = Math.max(1, Math.round(cells * 0.03))));
  }
  if (pattern === 'borderCrossing' && index >= GATES.gates) {
    families.push(() => (m.gate = true));
  }

  const secondary: Array<() => void> = [];
  if (index >= GATES.blockers) {
    secondary.push(() => {
      const density = band === Band.Easy ? 0.03 : band === Band.Hard ? 0.08 : 0.05;
      m.blockers = Math.max(1, Math.round(cells * density));
    });
  }
  if (index >= GATES.oneWays) {
    secondary.push(() => (m.arrows = Math.max(1, Math.round(cells * 0.03))));
  }
  if (index >= GATES.oil) {
    secondary.push(() => (m.oil = Math.max(1, Math.round(cells * 0.04))));
  }
  if (index >= GATES.vips) secondary.push(() => (m.vips = 1));
  if (index >= GATES.roundabouts) secondary.push(() => (m.roundabouts = 1));

  const chosen = families.slice(0, cap);
  if (!soloMechanic) {
    const seed = hashString(`mods:${index}`);
    let cursor = seed % Math.max(1, secondary.length);
    while (chosen.length < cap && secondary.length > 0 && chosen.length < 3) {
      const fn = secondary[cursor % secondary.length];
      if (!chosen.includes(fn)) chosen.push(fn);
      cursor++;
      if (cursor > seed % Math.max(1, secondary.length) + secondary.length) break;
    }
  }
  for (const apply of chosen) apply();

  // Role tags ride along on top of the modifier cap — they never change legality.
  if (index >= GATES.trunks && hashString(`trunk:${index}`) % 6 === 0) m.trunks = 1;
  if (index >= GATES.ambulances && hashString(`amb:${index}`) % 5 === 0) m.ambulances = 1;

  return m;
}

/* ------------------------------------------------------------------ *
 * Metered Lots — the one opt-in constraint mode (GDD §4, §8)
 * ------------------------------------------------------------------ */

/**
 * A Metered Lot caps the number of slides. It is the only place in the game
 * with a real fail state, and the only place the save-me offer exists — which
 * is exactly why it is held back until the player has mastered the unlimited
 * mode, never lands on a skill-check, and never shares a lot with a mechanic
 * in its first five outings.
 */
export function meteredLimit(index: number, parSlides: number): number | null {
  if (index < GATES.meteredLots) return null;
  if (patternIntroducedAt(index)) return null;
  const band = bandForLevel(index);
  // Skill-checks are never Metered, and neither are showcase finales.
  if (band === Band.Showcase) return null;
  if (hashString(`metered:${index}`) % 7 !== 0) return null;

  // A new mechanic gets five clean appearances before it may be constrained.
  for (const gate of [GATES.oil, GATES.vips, GATES.ambulances, GATES.roundabouts, GATES.gates]) {
    if (index >= gate && index < gate + 5) return null;
  }

  const slack = band === Band.Easy ? 4 : band === Band.Hard ? 2 : 3;
  return parSlides + slack;
}

/* ------------------------------------------------------------------ *
 * Specs
 * ------------------------------------------------------------------ */

/** Hand-authored openings — the first three minutes are too important to generate. */
const TUTORIAL_SPECS: Record<number, Partial<LevelSpec>> = {
  1: { w: 4, h: 5, vehicleCount: 4, streetSides: 1, streetWidth: 1 },
  2: { w: 5, h: 5, vehicleCount: 5, streetSides: 1, streetWidth: 1 },
  3: { w: 5, h: 6, vehicleCount: 6, streetSides: 2, streetWidth: 0.8 },
};

export function specForLevel(index: number): LevelSpec {
  const band = bandForLevel(index);
  const pattern = patternForLevel(index);
  const dims = gridForLevel(index, band);
  const street = streetFor(index, band, pattern.tag);
  const vehicleCount = Math.max(
    3,
    Math.round(vehicleCountFor(index, band, dims) * densityFactor(street)),
  );
  const spec: LevelSpec = {
    id: `L${index}`,
    index,
    seed: hashString(`gridlock:v2:L${index}`),
    band,
    patternTags: [pattern.tag],
    w: dims.w,
    h: dims.h,
    streetSides: street.sides,
    streetWidth: street.width,
    vehicleCount,
    lengthMix: lengthMixFor(index),
    modifiers: modifiersFor(index, band, pattern.tag, dims),
    targets: targetsFor(index, band, vehicleCount),
  };

  const override = TUTORIAL_SPECS[index];
  if (override) {
    Object.assign(spec, override, { modifiers: { ...NO_MODIFIERS }, lengthMix: { 2: 1 } });
    spec.patternTags = ['tutorial'];
    spec.targets = targetsFor(index, band, spec.vehicleCount);
  }
  return spec;
}

const levelCache = new Map<number, LevelDef>();

/** The lot for a global level index. Deterministic and memoised. */
export function getLevel(index: number): LevelDef {
  const clamped = Math.max(1, Math.floor(index));
  const cached = levelCache.get(clamped);
  if (cached) return cached;
  const level = generateLevel(specForLevel(clamped));
  levelCache.set(clamped, level);
  return level;
}

/** Warm the cache off the critical path so level transitions never hitch. */
export function prefetchLevel(index: number): void {
  if (levelCache.has(index)) return;
  const run = () => {
    try {
      getLevel(index);
    } catch {
      /* prefetch is best-effort */
    }
  };
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (ric) ric(run);
  else setTimeout(run, 0);
}

/* ------------------------------------------------------------------ *
 * Endless content — Overtime Shifts (GDD §3 Stage 8)
 * ------------------------------------------------------------------ */

export interface OvertimeJam {
  level: LevelDef;
  tag: string;
}

/** A daily rotating set of ten rated jams, tagged by pattern. */
export function overtimeSet(dayNumber: number, count = 10): OvertimeJam[] {
  const out: OvertimeJam[] = [];
  const pool = PATTERNS;
  for (let i = 0; i < count; i++) {
    const seed = hashString(`overtime:${dayNumber}:${i}`);
    const pattern = pool[seed % pool.length];
    const band = i < 3 ? Band.Easy : i < 8 ? Band.Medium : Band.Hard;
    const dims = { w: 7, h: 9 };
    const vehicleCount = vehicleCountFor(120 + i * 6, band, dims);
    const spec: LevelSpec = {
      id: `OT-${dayNumber}-${i}`,
      index: 1000 + i,
      seed,
      band,
      patternTags: [pattern.tag, 'overtime'],
      w: dims.w,
      h: dims.h,
      streetSides: band === Band.Hard ? 4 : 3,
      streetWidth: 0.85,
      vehicleCount,
      lengthMix: { 2: 5, 3: 3, 4: 2, 5: 1 },
      modifiers: modifiersFor(120 + i * 6, band, pattern.tag, dims),
      targets: targetsFor(120 + i * 6, band, vehicleCount),
    };
    out.push({ level: generateLevel(spec), tag: pattern.label });
  }
  return out;
}

/** One authored-feeling hard jam per day, identical for every player (GDD §9). */
export function rushHourJam(dayNumber: number): LevelDef {
  const seed = hashString(`rush:${dayNumber}`);
  const pattern = PATTERNS[seed % PATTERNS.length];
  const dims = { w: 7, h: 9 };
  const spec: LevelSpec = {
    id: `RH-${dayNumber}`,
    index: 900,
    seed,
    band: Band.Hard,
    patternTags: [pattern.tag, 'rushHour'],
    w: dims.w,
    h: dims.h,
    streetSides: 4,
    streetWidth: 0.8,
    vehicleCount: 18,
    lengthMix: { 2: 5, 3: 3, 4: 2 },
    modifiers: modifiersFor(140, Band.Hard, pattern.tag, dims),
    targets: targetsFor(140, Band.Hard, 18),
  };
  return generateLevel(spec);
}

/* ------------------------------------------------------------------ *
 * Gridlock Gauntlet — one continuous path, twelve escalating jams (GDD §9)
 * ------------------------------------------------------------------ */

export const GAUNTLET_LENGTH = 12;
/** Chests sit at these one-based rungs. */
export const GAUNTLET_CHECKPOINTS: readonly number[] = [4, 8, 12];

/** The Gauntlet resets monthly; this is the period key it is seeded from. */
export function gauntletPeriod(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Rung `index` (0-based) of the month's Gauntlet. Difficulty climbs from a
 * warm-up to a lot harder than anything in the campaign, because the whole
 * point is a single continuous path you either walk or you do not.
 */
export function gauntletJam(period: string, index: number): LevelDef {
  const rung = Math.max(0, Math.min(GAUNTLET_LENGTH - 1, index));
  const seed = hashString(`gauntlet:${period}:${rung}`);
  const pattern = PATTERNS[seed % PATTERNS.length];
  const band = rung < 3 ? Band.Medium : rung < 9 ? Band.Hard : Band.Showcase;
  const dims = { w: rung < 4 ? 6 : 7, h: rung < 4 ? 8 : rung < 9 ? 9 : 10 };
  const vehicleCount = Math.round(lerp(9, 21, rung / (GAUNTLET_LENGTH - 1)));
  const spec: LevelSpec = {
    id: `GG-${period}-${rung}`,
    index: 950 + rung,
    seed,
    band,
    patternTags: [pattern.tag, 'gauntlet'],
    w: dims.w,
    h: dims.h,
    streetSides: rung < 6 ? 3 : 4,
    streetWidth: 0.8,
    vehicleCount,
    lengthMix: rung < 4 ? { 2: 6, 3: 2 } : { 2: 5, 3: 3, 4: 2 },
    modifiers: modifiersFor(60 + rung * 12, band, pattern.tag, dims),
    targets: targetsFor(60 + rung * 12, band, vehicleCount),
  };
  return generateLevel(spec);
}

export function gauntletRungLabel(index: number): string {
  return `Rung ${Math.min(GAUNTLET_LENGTH, index + 1)} of ${GAUNTLET_LENGTH}`;
}

/** Rush Hour jams are named, because a daily must feel signed. */
const RUSH_NAMES: readonly string[] = [
  'The Fishbone',
  'Cannery Row',
  'The Pinch',
  'Long Monday',
  'Eight Below',
  'The Hairpin',
  'Cold Start',
  'Double Yellow',
  'The Keystone',
  'Last Bell',
  'The Tuning Fork',
  'Blind Corner',
];

export function rushHourName(dayNumber: number): string {
  return RUSH_NAMES[hashString(`rushname:${dayNumber}`) % RUSH_NAMES.length];
}
