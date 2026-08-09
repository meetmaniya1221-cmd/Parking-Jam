/**
 * Gridlock City — the authored jam sequence (GDD §6 "Difficulty Curve Shape").
 *
 * Levels are described, not stored: `specForLevel` turns a global level index
 * into a fully determined LevelSpec, and JamForge turns that into the same lot
 * on every device, every time. 320 launch jams cost zero bundle bytes, and the
 * whole sequence is remote-config-shaped — every number here is a tunable.
 */

import { DifficultyConfig, difficultyFor } from './difficulty';
import { generateLevel, LevelSpec, ModifierSpec, NO_MODIFIERS } from './generator';
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

interface Street {
  sides: number;
  width: number;
}

/**
 * How much street the lot fronts onto.
 *
 * Counter-intuitively, *more* street makes a lot harder, not easier. A car only
 * ever leaves straight along its facing, so a curb cut on a given lane is what
 * makes that lane usable at all. Open one edge and every car must face the same
 * way — the lot is a shallow queue. Open four and lanes cross, dependency chains
 * can turn corners, and the lot both packs denser and knots deeper. Difficulty
 * therefore lives in density, distractors and vocabulary; frontage width is a
 * *simplicity* lever, reserved for the opening levels and for the Plug read.
 *
 * A big lot also *needs* the frontage: thirty-four cars on twelve columns only
 * fit if there are lanes out on every side, so the four-sided default is a
 * capacity requirement as much as a difficulty one.
 */
function streetFor(index: number, band: Band, pattern: string): Street {
  // The Plug and the Two-Door are frontage reads: one lane out, or two flows
  // competing for it. On a small lot that is the whole puzzle. On a 12×15 one
  // it stops being a read and becomes an amputation — a lot with only two
  // facings usable cannot chain deep, cannot pack, and half of it goes to
  // waste — so past the on-ramp they keep their pinch but not their blindfold.
  if (pattern === 'plug') return index < RAMP_ENDS ? { sides: 2, width: 0.5 } : { sides: 3, width: 0.5 };
  if (pattern === 'twoDoor') return index < RAMP_ENDS ? { sides: 2, width: 0.6 } : { sides: 3, width: 0.55 };
  if (index <= 2) return { sides: 2, width: 1 };
  if (index <= 5) return { sides: 3, width: 1 };
  if (index < RAMP_ENDS) return { sides: 3, width: 0.9 };
  // Four sides everywhere past the on-ramp — crossing lanes are what let a
  // chain turn a corner, and a thirty-car lot needs them to empty at all. The
  // band shows up in how *much* of each edge is curb cut, which is the lever
  // that actually decides how many cars can drive off on turn one.
  if (band === Band.Easy) return { sides: 4, width: 1 };
  if (band === Band.Hard) return { sides: 4, width: 0.7 };
  if (band === Band.Showcase) return { sides: 4, width: 0.72 };
  return { sides: 4, width: 0.9 };
}

/**
 * A deliberately pinched frontage really does hold fewer cars: a car can only
 * park somewhere it could have driven out of, so every curb cut the lot does
 * not have is lanes' worth of capacity it does not have either.
 */
function frontageFactor(street: Street): number {
  return Math.max(0.7, Math.min(1, 0.55 + street.sides * 0.08 + street.width * 0.25));
}

/**
 * Re-scale the contract for a pinched frontage, keeping it honest.
 *
 * Two things give here. Capacity, because a lot with one lane out really does
 * hold fewer cars — and the forced temporary move, because the deadlock that
 * causes it is a ring of four cars each leaving by a different side. With only
 * two sides open there is no such ring to build, and demanding one would just
 * make every candidate fail and ship the near-miss anyway.
 */
function withFrontage(config: DifficultyConfig, street: Street): DifficultyConfig {
  const factor = frontageFactor(street);
  const temporaryMoveRequirement = config.temporaryMoveRequirement && street.sides >= 4;
  // A chain of cars only turns a corner where a crossing lane has its own curb
  // cut, so a lot fronting onto fewer streets has a hard geometric ceiling on
  // how deep its knot can go — roughly one link per two cells of its longest
  // queue. Asking past that would fail every candidate and ship the near-miss.
  const depthCeiling =
    street.sides >= 4
      ? config.minDependencyDepth
      : Math.max(3, Math.floor(Math.max(config.boardWidth, config.boardHeight) / 2) + street.sides);
  const targetCars = Math.max(3, Math.round(config.targetCars * factor));
  const minCars = Math.max(3, Math.round(config.minCars * factor));
  return {
    ...config,
    targetCars,
    minCars,
    temporaryMoveRequirement,
    minDependencyDepth: Math.min(config.minDependencyDepth, depthCeiling, targetCars - 1),
    minSolutionMoves: minCars + (temporaryMoveRequirement ? 1 : 0),
    maxInitialFreeCars: Math.max(2, Math.round(config.maxInitialFreeCars * factor)),
    minInitialFreeCars: Math.max(1, Math.round(config.minInitialFreeCars * factor)),
    minDensity: config.minDensity * factor,
  };
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
/**
 * Furniture counts are a *share* of the lot, but a share with a ceiling.
 *
 * Six per cent of a 5×6 lot is two oil slicks and reads as a feature; six per
 * cent of a 12×15 lot is eleven, and eleven of anything stops being a feature
 * and starts being terrain. Worse, every blocker is a cell the generator cannot
 * park a car on, so an uncapped share would quietly eat the density the whole
 * curve is built on.
 */
function furniture(cells: number, share: number, floor: number, ceiling: number): number {
  return Math.max(floor, Math.min(ceiling, Math.round(cells * share)));
}

interface Dimensions {
  w: number;
  h: number;
}

/**
 * How many VIPs the rope holds back.
 *
 * While a VIP is on the lot nobody else may leave, so the number of VIPs *is*
 * the number of legal opening moves. One is a clean read on a small lot and a
 * near-lockout on a thirty-car one, where the player would be hunting a single
 * legal move among thirty — so a big lot ropes off a small group instead.
 */
function ropeCount(cells: number, band: Band): number {
  const base = cells >= 160 ? 3 : cells >= 110 ? 2 : 1;
  // A stretch jam ropes off a smaller group, because the rope's whole effect is
  // on the opening move and that is precisely where a stretch jam should bite.
  return band === Band.Hard || band === Band.Showcase ? Math.max(1, base - 1) : base;
}

function modifiersFor(index: number, band: Band, pattern: string, dims: Dimensions): ModifierSpec {
  const cells = dims.w * dims.h;
  const m: ModifierSpec = { ...NO_MODIFIERS };
  const cap = index < 20 ? 2 : 3;

  const intro = patternIntroducedAt(index);
  const isFreshMechanic = (gate: number) => index >= gate && index < gate + 3;
  const soloMechanic = intro !== null || isFreshMechanic(GATES.oil) || isFreshMechanic(GATES.vips);

  const families: Array<() => void> = [];

  if (pattern === 'slickCorridor' && index >= GATES.oil) {
    families.push(() => (m.oil = furniture(cells, 0.06, 2, 8)));
  }
  if (pattern === 'velvetRope' && index >= GATES.vips) {
    families.push(() => (m.vips = ropeCount(cells, band)));
  }
  if (pattern === 'carousel' && index >= GATES.roundabouts) {
    families.push(() => (m.roundabouts = furniture(cells, 0.03, 1, 4)));
  }
  if (pattern === 'borderCrossing' && index >= GATES.gates) {
    families.push(() => (m.gate = true));
  }

  const secondary: Array<() => void> = [];
  if (index >= GATES.blockers) {
    secondary.push(() => {
      const density = band === Band.Easy ? 0.03 : band === Band.Hard ? 0.08 : 0.05;
      m.blockers = furniture(cells, density, 1, 9);
    });
  }
  if (index >= GATES.oneWays) {
    secondary.push(() => (m.arrows = furniture(cells, 0.03, 1, 6)));
  }
  if (index >= GATES.oil) {
    secondary.push(() => (m.oil = furniture(cells, 0.04, 1, 6)));
  }
  // Never on a breather: the rope is the one mechanic that shuts a lot
  // completely, and a rest beat the player cannot open is not a rest beat.
  if (index >= GATES.vips && band !== Band.Easy) {
    secondary.push(() => (m.vips = ropeCount(cells, band)));
  }
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

interface SpecRequest {
  id: string;
  /** Identity inside the sim; event jams sit above the campaign range. */
  index: number;
  seed: number;
  band: Band;
  patternTags: string[];
  /** Level the difficulty curve is sampled at — an event jam borrows a rung of it. */
  curveIndex: number;
  /** Level the modifier schedule is read at, so an event jam can carry late vocabulary. */
  modifierIndex?: number;
  pattern: string;
}

/**
 * Assemble a spec from the curve. Every jam in the game — campaign, daily,
 * Overtime, Gauntlet — comes through here, so they all scale together and no
 * mode can quietly drift onto its own private board size.
 */
function buildSpec(req: SpecRequest): LevelSpec {
  const street = streetFor(req.curveIndex, req.band, req.pattern);
  let difficulty = withFrontage(difficultyFor(req.curveIndex, req.band), street);
  const dims = { w: difficulty.boardWidth, h: difficulty.boardHeight };
  const modifiers = modifiersFor(req.modifierIndex ?? req.curveIndex, req.band, req.pattern, dims);

  // The Velvet Rope *is* a closed opening: while a VIP is on the lot nobody
  // else may leave, so a roped lot opens with exactly as many legal moves as it
  // has VIPs, by design. Asking it for more would be asking it not to be roped.
  if (modifiers.vips > 0) {
    difficulty = {
      ...difficulty,
      minInitialFreeCars: Math.min(difficulty.minInitialFreeCars, modifiers.vips),
    };
  }

  return {
    id: req.id,
    index: req.index,
    seed: req.seed,
    band: req.band,
    patternTags: req.patternTags,
    w: dims.w,
    h: dims.h,
    streetSides: street.sides,
    streetWidth: street.width,
    vehicleCount: difficulty.targetCars,
    knotDepth: difficulty.minDependencyDepth,
    distractorRatio: difficulty.distractorRatio,
    lengthMix: difficulty.lengthMix,
    modifiers,
    difficulty,
  };
}

/**
 * The first three minutes are too important to leave entirely to the dice.
 *
 * These lots are still generated — hand-placing them would fossilise them — but
 * against a contract with every sharp edge filed off: no vocabulary, no long
 * vehicles, no distractors, a wide-open frontage and a knot barely worth the
 * name. What the player should take from level one is the verb, not a lesson in
 * humility.
 */
function tutorialSpec(index: number, spec: LevelSpec): LevelSpec {
  const difficulty: DifficultyConfig = {
    ...spec.difficulty,
    minDependencyDepth: Math.min(spec.difficulty.minDependencyDepth, index + 1),
    distractorRatio: 0,
    minBottlenecks: 0,
    maxIndependentRatio: 1,
    temporaryMoveRequirement: false,
    lengthMix: { 2: 1 },
  };
  return {
    ...spec,
    patternTags: ['tutorial'],
    knotDepth: difficulty.minDependencyDepth,
    distractorRatio: 0,
    lengthMix: { 2: 1 },
    modifiers: { ...NO_MODIFIERS },
    difficulty,
  };
}

export function specForLevel(index: number): LevelSpec {
  const band = bandForLevel(index);
  const pattern = patternForLevel(index);
  const spec = buildSpec({
    id: `L${index}`,
    index,
    seed: hashString(`gridlock:v2:L${index}`),
    band,
    patternTags: [pattern.tag],
    curveIndex: index,
    pattern: pattern.tag,
  });
  return index <= 3 ? tutorialSpec(index, spec) : spec;
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
    // The set climbs across the day's ten jams, from a district-two lot to a
    // full-size one.
    const spec = buildSpec({
      id: `OT-${dayNumber}-${i}`,
      index: 1000 + i,
      seed,
      band,
      patternTags: [pattern.tag, 'overtime'],
      curveIndex: 12 + i * 2,
      modifierIndex: 120 + i * 6,
      pattern: pattern.tag,
    });
    out.push({ level: generateLevel(spec), tag: pattern.label });
  }
  return out;
}

/** One authored-feeling hard jam per day, identical for every player (GDD §9). */
export function rushHourJam(dayNumber: number): LevelDef {
  const seed = hashString(`rush:${dayNumber}`);
  const pattern = PATTERNS[seed % PATTERNS.length];
  // The daily is meant to be the hardest thing on offer, so it is built at the
  // top of the curve regardless of how far the player has actually got.
  return generateLevel(
    buildSpec({
      id: `RH-${dayNumber}`,
      index: 900,
      seed,
      band: Band.Hard,
      patternTags: [pattern.tag, 'rushHour'],
      curveIndex: 22,
      modifierIndex: 140,
      pattern: pattern.tag,
    }),
  );
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
  // Twelve rungs walk the whole curve, from a district-one lot to bigger than
  // anything in the campaign — one continuous path you either walk or you do not.
  const curveIndex = Math.round(8 + (rung * 16) / (GAUNTLET_LENGTH - 1));
  return generateLevel(
    buildSpec({
      id: `GG-${period}-${rung}`,
      index: 950 + rung,
      seed,
      band,
      patternTags: [pattern.tag, 'gauntlet'],
      curveIndex,
      modifierIndex: 60 + rung * 12,
      pattern: pattern.tag,
    }),
  );
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
