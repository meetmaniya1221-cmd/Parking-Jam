/**
 * Gridlock City — the authored jam sequence (GDD §6 "Difficulty Curve Shape").
 *
 * Levels are described, not stored: `specForLevel` turns a global level index
 * into a fully determined LevelSpec, and JamForge turns that into the same lot
 * on every device, every time. 320 launch jams cost zero bundle bytes, and the
 * whole sequence is remote-config-shaped — every number here is a tunable.
 */

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
 * A 20-slot chapter template: two standard jams → one stretch → one breather,
 * peaking at 80% with the chapter boss and closing breather-then-showcase so
 * the district timelapse lands on a high. Ratios match GDD §6: 25/50/20/5.
 */
const BAND_TEMPLATE: readonly Band[] = [
  Band.Easy,
  Band.Medium,
  Band.Medium,
  Band.Hard,
  Band.Easy,
  Band.Medium,
  Band.Medium,
  Band.Hard,
  Band.Medium,
  Band.Easy,
  Band.Medium,
  Band.Medium,
  Band.Hard,
  Band.Easy,
  Band.Medium,
  Band.Medium,
  Band.Hard,
  Band.Medium,
  Band.Easy,
  Band.Showcase,
];

export function bandForLevel(index: number): Band {
  if (index <= 3) return Band.Easy;
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

export const PATTERNS: readonly PatternDef[] = [
  { tag: 'zipper', label: 'Zipper', intro: 4, blurb: 'Interleaved rows — find which end unzips.' },
  { tag: 'plug', label: 'Plug', intro: 7, blurb: 'One car corks the only lane out.' },
  { tag: 'freightWall', label: 'Freight Wall', intro: 9, blurb: 'A box truck is the wall. Move the wall.' },
  { tag: 'comb', label: 'Comb', intro: 11, blurb: 'Parallel teeth, one crossing blocker.' },
  { tag: 'onion', label: 'Onion', intro: 17, blurb: 'Solve outside-in, exit inside-out.' },
  { tag: 'decoy', label: 'Decoy', intro: 23, blurb: 'The obvious car is a trap.' },
  { tag: 'slickCorridor', label: 'Slick Corridor', intro: 26, blurb: 'Oil sends you to the wall.' },
  { tag: 'dominoRun', label: 'Domino Run', intro: 27, blurb: 'Every exit frees exactly one more.' },
  { tag: 'velvetRope', label: 'Velvet Rope', intro: 31, blurb: 'The VIP leaves first, or nobody does.' },
  { tag: 'twoDoor', label: 'Two-Door', intro: 38, blurb: 'Two streets, two competing flows.' },
  { tag: 'carousel', label: 'Carousel', intro: 52, blurb: 'Roundabouts turn a hopeless facing.' },
  { tag: 'borderCrossing', label: 'Border Crossing', intro: 60, blurb: 'The read spans two rooms.' },
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

export const GATES = {
  cityMap: 5,
  trunks: 8,
  garage: 10,
  interstitials: 12,
  blockers: 14,
  cleanRun: 14,
  dispatchBoard: 15,
  oneWays: 16,
  rushHour: 20,
  trailers: 21,
  cityPass: 25,
  oil: 26,
  ambulanceRun: 28,
  vips: 31,
  hornLibrary: 34,
  ambulances: 37,
  meteredLots: 45,
  roundabouts: 52,
  gates: 60,
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

function gridForLevel(index: number, band: Band): Dimensions {
  let w: number;
  let h: number;
  if (index <= 10) [w, h] = [5, 6];
  else if (index <= 20) [w, h] = [5, 7];
  else if (index <= 40) [w, h] = [6, 7];
  else if (index <= 60) [w, h] = [6, 8];
  else if (index <= 100) [w, h] = [7, 9];
  else [w, h] = [7, 10];

  if (band === Band.Showcase) {
    w = Math.min(8, w + 1);
    h = Math.min(10, h + 1);
  } else if (band === Band.Easy && index > 20) {
    // Breathers are wide and shallow: many exits, little thinking (GDD §6).
    h = Math.max(5, h - 1);
  }
  return { w, h };
}

function vehicleCountFor(index: number, band: Band, dims: Dimensions): number {
  let base: number;
  if (index <= 20) base = lerp(4, 6, (index - 1) / 19);
  else if (index <= 60) base = lerp(7, 13, (index - 20) / 40);
  else if (index <= 180) base = lerp(13, 19, (index - 60) / 120);
  else base = lerp(19, 22, (index - 180) / 140);

  const bandAdjust =
    band === Band.Easy ? -1 : band === Band.Hard ? 2 : band === Band.Showcase ? 3 : 0;
  // Breathers carry MORE cars but a shallower knot — pure goal-gradient candy.
  const breatherBonus = band === Band.Easy && index > 20 ? 3 : 0;

  const capacity = Math.floor((dims.w * dims.h) / 3.2);
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
  // crossing lane. Measured ceiling is ~10, comfortable band 5–8.
  let base: number;
  if (index <= 20) base = lerp(2, 3, (index - 1) / 19);
  else if (index <= 60) base = lerp(3.5, 5, (index - 20) / 40);
  else if (index <= 180) base = lerp(5, 7, (index - 60) / 120);
  else base = lerp(7, 8, (index - 180) / 140);

  const bandAdjust =
    band === Band.Easy ? -1.5 : band === Band.Hard ? 1 : band === Band.Showcase ? 1.5 : 0;
  return Math.max(2, Math.min(vehicles - 1, Math.round(base + bandAdjust)));
}

function distractorRatioFor(index: number, band: Band): number {
  const base = index <= 20 ? 0.2 : Math.min(0.55, lerp(0.25, 0.55, (index - 20) / 160));
  return band === Band.Easy ? Math.min(0.6, base + 0.1) : base;
}

function lengthMixFor(index: number): Record<number, number> {
  if (index < 9) return { 2: 1 };
  if (index < GATES.trailers) return { 2: 6, 3: 2 };
  if (index < 80) return { 2: 6, 3: 3, 4: 1 };
  return { 2: 5, 3: 3, 4: 2 };
}

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
 */
function streetFor(index: number, band: Band, pattern: string): Street {
  if (pattern === 'plug') return { sides: 2, width: 0.5 };
  if (pattern === 'twoDoor') return { sides: 2, width: 0.6 };
  if (index <= 6) return { sides: 1, width: 1 };
  if (index <= 12) return { sides: 2, width: 0.9 };
  if (index <= 20) return { sides: 2, width: 1 };
  if (band === Band.Easy) return { sides: 3, width: 1 };
  if (band === Band.Hard) return { sides: 4, width: 0.8 };
  if (band === Band.Showcase) return { sides: 4, width: 0.9 };
  return { sides: 3, width: 0.8 };
}

/**
 * Modifier load is capped at 2 families until L75 and 3 after (GDD §4), and a
 * brand-new mechanic never shares a lot with another for its first 5 outings.
 */
function modifiersFor(index: number, band: Band, pattern: string, dims: Dimensions): ModifierSpec {
  const cells = dims.w * dims.h;
  const m: ModifierSpec = { ...NO_MODIFIERS };
  const cap = index < 75 ? 2 : 3;

  const intro = patternIntroducedAt(index);
  const isFreshMechanic = (gate: number) => index >= gate && index < gate + 5;
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

export function isMetered(index: number, parSlides: number): boolean {
  return meteredLimit(index, parSlides) !== null;
}

/* ------------------------------------------------------------------ *
 * Specs
 * ------------------------------------------------------------------ */

/** Hand-authored openings — the first three minutes are too important to generate. */
const TUTORIAL_SPECS: Record<number, Partial<LevelSpec>> = {
  1: { w: 4, h: 5, vehicleCount: 4, knotDepth: 2, streetSides: 1, streetWidth: 1, distractorRatio: 0 },
  2: { w: 5, h: 5, vehicleCount: 5, knotDepth: 3, streetSides: 1, streetWidth: 1, distractorRatio: 0 },
  3: { w: 5, h: 6, vehicleCount: 6, knotDepth: 3, streetSides: 2, streetWidth: 0.8, distractorRatio: 0.15 },
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
    seed: hashString(`gridlock:v1:L${index}`),
    band,
    patternTags: [pattern.tag],
    w: dims.w,
    h: dims.h,
    streetSides: street.sides,
    streetWidth: street.width,
    vehicleCount,
    knotDepth: knotDepthFor(index, band, vehicleCount),
    distractorRatio: distractorRatioFor(index, band),
    lengthMix: lengthMixFor(index),
    modifiers: modifiersFor(index, band, pattern.tag, dims),
  };

  const override = TUTORIAL_SPECS[index];
  if (override) {
    Object.assign(spec, override, { modifiers: { ...NO_MODIFIERS }, lengthMix: { 2: 1 } });
    spec.patternTags = ['tutorial'];
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

export function clearLevelCache(): void {
  levelCache.clear();
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
      streetSides: 2,
      streetWidth: 0.55,
      vehicleCount,
      knotDepth: knotDepthFor(120 + i * 6, band, vehicleCount),
      distractorRatio: 0.45,
      lengthMix: { 2: 5, 3: 3, 4: 2, 5: 1 },
      modifiers: modifiersFor(120 + i * 6, band, pattern.tag, dims),
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
    streetSides: 2,
    streetWidth: 0.5,
    vehicleCount: 16,
    knotDepth: 8,
    distractorRatio: 0.45,
    lengthMix: { 2: 5, 3: 3, 4: 2 },
    modifiers: modifiersFor(140, Band.Hard, pattern.tag, dims),
  };
  return generateLevel(spec);
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
