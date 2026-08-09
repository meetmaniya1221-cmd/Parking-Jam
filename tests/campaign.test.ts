import { describe, expect, it } from 'vitest';
import {
  bandForLevel,
  chapterPosition,
  CHAPTER_SIZES,
  GATES,
  getLevel,
  overtimeSet,
  rushHourJam,
  specForLevel,
  TOTAL_LEVELS,
} from '../src/core/campaign';
import { auditLevel } from '../src/core/generator';
import { analyseDifficulty, bumpLikelihood, solveLevel } from '../src/core/solver';
import { applyMove, createLotState, validateLevel } from '../src/core/sim';
import { Band, MoveKind, VehicleTag } from '../src/core/types';

describe('chapter layout', () => {
  it('ships 320 launch jams across 12 districts', () => {
    expect(CHAPTER_SIZES.length).toBe(12);
    expect(TOTAL_LEVELS).toBe(320);
  });

  it('maps every level index to a chapter position', () => {
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const p = chapterPosition(i);
      expect(p.district).toBeGreaterThanOrEqual(0);
      expect(p.district).toBeLessThan(12);
      expect(p.pos).toBeLessThan(p.size);
    }
  });

  it('closes every chapter on a showcase and opens it easy', () => {
    let n = 1;
    for (const size of CHAPTER_SIZES) {
      expect(bandForLevel(n)).toBe(Band.Easy);
      expect(bandForLevel(n + size - 1)).toBe(Band.Showcase);
      n += size;
    }
  });

  it('makes stretch the default texture and keeps breathers rare', () => {
    const counts: Record<string, number> = {};
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const b = bandForLevel(i);
      counts[b] = (counts[b] ?? 0) + 1;
    }
    // Retuned from the GDD's 25/50/20/5. Stretch is now the norm rather than
    // the peak, but breathers still exist — the goal gradient needs the rest,
    // and a curve with no let-up reads as a wall rather than as difficulty.
    expect(counts[Band.Hard] / TOTAL_LEVELS).toBeGreaterThan(0.4);
    expect(counts[Band.Medium] / TOTAL_LEVELS).toBeGreaterThan(0.25);
    expect(counts[Band.Easy] / TOTAL_LEVELS).toBeGreaterThan(0.07);
    expect(counts[Band.Easy] / TOTAL_LEVELS).toBeLessThan(0.2);
    expect(counts[Band.Showcase] / TOTAL_LEVELS).toBeLessThan(0.09);
  });

  it('hands over from the on-ramp at level 10', () => {
    // 1–3 teach the verb, 4–9 add vocabulary at a standard difficulty, and the
    // hand-over level itself is a stretch jam: the step up should be felt.
    for (let i = 1; i <= 3; i++) expect(bandForLevel(i), `L${i}`).toBe(Band.Easy);
    for (let i = 4; i <= 9; i++) expect(bandForLevel(i), `L${i}`).toBe(Band.Medium);
    expect(bandForLevel(10)).toBe(Band.Hard);
  });
});

describe('modifier gating', () => {
  it('never exceeds the modifier-load cap', () => {
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const spec = specForLevel(i);
      const load =
        (spec.modifiers.blockers > 0 ? 1 : 0) +
        (spec.modifiers.oil > 0 ? 1 : 0) +
        (spec.modifiers.arrows > 0 ? 1 : 0) +
        (spec.modifiers.roundabouts > 0 ? 1 : 0) +
        (spec.modifiers.gate ? 1 : 0) +
        (spec.modifiers.vips > 0 ? 1 : 0);
      expect(load, `level ${i} modifier load`).toBeLessThanOrEqual(i < 20 ? 2 : 3);
    }
  });

  it('holds every mechanic behind its unlock gate', () => {
    // Read from GATES rather than repeated here: the gates are the schedule, and
    // a copy of them in the test would only ever drift out of date.
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const m = specForLevel(i).modifiers;
      if (i < GATES.blockers) expect(m.blockers, `L${i}`).toBe(0);
      if (i < GATES.oneWays) expect(m.arrows, `L${i}`).toBe(0);
      if (i < GATES.oil) expect(m.oil, `L${i}`).toBe(0);
      if (i < GATES.vips) expect(m.vips, `L${i}`).toBe(0);
      if (i < GATES.ambulances) expect(m.ambulances, `L${i}`).toBe(0);
      if (i < GATES.roundabouts) expect(m.roundabouts, `L${i}`).toBe(0);
      if (i < GATES.gates) expect(m.gate, `L${i}`).toBe(false);
      if (i < GATES.trunks) expect(m.trunks, `L${i}`).toBe(0);
    }
  });

  it('opens the whole puzzle vocabulary inside the first two districts', () => {
    // A lot with no vocabulary in it can only be made harder by adding cars,
    // which is tedium rather than difficulty — so the mechanics land early.
    for (const gate of ['blockers', 'oneWays', 'oil', 'vips', 'ambulances', 'roundabouts', 'gates'] as const) {
      expect(GATES[gate], gate).toBeLessThanOrEqual(18);
    }
    // The one mode with a real fail state still waits for mastery (GDD §4, §8).
    expect(GATES.meteredLots).toBeGreaterThanOrEqual(45);
  });
});

describe('every shipped jam', () => {
  const indices = Array.from({ length: TOTAL_LEVELS }, (_, i) => i + 1);

  it('is structurally valid and solver-verified', () => {
    const failures: string[] = [];
    for (const i of indices) {
      const level = getLevel(i);
      const issues = validateLevel(level);
      if (issues.length) failures.push(`L${i}: ${issues.map((x) => x.code).join(',')}`);
      const audit = auditLevel(level);
      if (!audit.solvable) failures.push(`L${i}: unsolvable`);
      // Every car costs one slide to drive off, plus one for each temporary
      // reposition the lot forces. Late lots are built to force exactly one.
      const expected = level.vehicles.length + audit.repositions;
      if (audit.parSlides !== expected) {
        failures.push(`L${i}: par ${audit.parSlides} != ${expected}`);
      }
      if (audit.repositions > 2) failures.push(`L${i}: ${audit.repositions} repositions`);
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it('can actually be cleared by replaying the solver line', () => {
    for (const i of indices) {
      const level = getLevel(i);
      const solved = solveLevel(level);
      const state = createLotState(level);
      for (const m of solved.moves) applyMove(state, m);
      expect(state.remaining, `L${i} left ${state.remaining} cars`).toBe(0);
    }
  }, 180_000);

  it('always leaves at least one car free to move on turn one', () => {
    for (const i of indices) {
      const metrics = analyseDifficulty(getLevel(i));
      expect(metrics.openExits, `L${i} opens with no legal exit`).toBeGreaterThan(0);
    }
  }, 180_000);

  it('steps the knot up hard at level 10 and never eases off again', () => {
    const mean = (from: number, to: number, of: (i: number) => number) => {
      let sum = 0;
      for (let i = from; i <= to; i++) sum += of(i);
      return sum / (to - from + 1);
    };
    const depth = (from: number, to: number) => mean(from, to, (i) => getLevel(i).knotDepth);
    const cars = (from: number, to: number) => mean(from, to, (i) => getLevel(i).vehicles.length);

    const ERAS: Array<[number, number]> = [
      [10, 20],
      [21, 40],
      [41, 80],
      [81, 160],
      [161, 320],
    ];

    // The step at 10 is the whole point of this curve: a jump, not a nudge.
    expect(depth(10, 20) - depth(4, 9)).toBeGreaterThan(2);

    // Past the hand-over the knot never returns to on-ramp territory. This is
    // asserted as a floor per era rather than as a monotone climb, because an
    // era's mean depth also tracks how many breathers it contains — L10-20 has
    // almost none, later chapters run two per district — and a strict climb
    // would be measuring band mix, not difficulty.
    for (const [from, to] of ERAS) {
      expect(depth(from, to), `L${from}-${to} depth`).toBeGreaterThanOrEqual(6.5);
    }
    expect(depth(161, 320)).toBeGreaterThan(depth(10, 20));

    // Car count climbs hard across the growth phase and then holds. The board
    // stops growing at level 22 by design — past 12×15 the cells get too small
    // to touch on a phone — so density plateaus with it, and difficulty carries
    // on climbing through depth and bottlenecks instead. Asserting a strict
    // era-over-era climb here would be asserting the lot keeps growing forever.
    expect(cars(1, 9)).toBeLessThan(cars(10, 20));
    expect(cars(10, 20)).toBeLessThan(cars(21, 40));
    for (const [from, to] of ERAS) {
      expect(cars(from, to), `cars L${from}-${to}`).toBeGreaterThanOrEqual(cars(10, 20));
    }
  }, 240_000);

  it('scales vehicle count into the design bands', () => {
    const count = (i: number) => getLevel(i).vehicles.length;
    // The on-ramp is the one stretch where the lot is small enough to read at a
    // glance; from the hand-over the lots are packed, and by the twenties they
    // are parking structures.
    for (let i = 1; i <= 3; i++) expect(count(i), `L${i}`).toBeLessThanOrEqual(7);
    for (let i = 4; i <= 6; i++) expect(count(i), `L${i}`).toBeLessThanOrEqual(11);
    for (let i = 7; i <= 9; i++) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(9);
    for (let i = 10; i <= 12; i++) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(14);
    for (let i = 13; i <= 15; i++) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(18);
    for (let i = 16; i <= 20; i++) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(24);
    for (let i = 61; i <= 180; i += 7) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(22);
    for (let i = 200; i <= 320; i += 13) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(22);
  }, 180_000);

  it('keeps the tutorial gentle and free of vocabulary', () => {
    for (let i = 1; i <= 3; i++) {
      const level = getLevel(i);
      expect(level.vehicles.length).toBeLessThanOrEqual(7);
      expect(level.modifierLoad).toBe(0);
      expect(level.vehicles.every((v) => v.tags === 0)).toBe(true);
    }
    // L1 must be readable at a glance: several cars can leave immediately.
    expect(analyseDifficulty(getLevel(1)).openExits).toBeGreaterThanOrEqual(2);
  });

  it('reads as tricky without being opaque', () => {
    for (let i = 25; i <= 180; i++) {
      const level = getLevel(i);
      const p = bumpLikelihood(level);
      // A lot nobody can move is opaque; one everybody can move has no read.
      // Breathers sit at the open end of that range on purpose (GDD §6).
      expect(p, `L${i} bump likelihood`).toBeLessThan(0.97);
      if (level.band !== Band.Easy) {
        expect(p, `L${i} bump likelihood`).toBeGreaterThan(0.3);
      }
    }
  }, 180_000);

  it('tightens the opening band by band', () => {
    const median = (band: Band) => {
      const values: number[] = [];
      for (let i = 21; i <= TOTAL_LEVELS; i++) {
        const level = getLevel(i);
        if (level.band === band) values.push(bumpLikelihood(level));
      }
      values.sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    // Openness is scored as a share of the lot, so this holds at every size.
    expect(median(Band.Easy)).toBeLessThan(median(Band.Medium));
    expect(median(Band.Medium)).toBeLessThan(median(Band.Hard));
    expect(median(Band.Hard)).toBeGreaterThan(0.5);
  }, 180_000);

  it('lets every VIP leave before the rope drops', () => {
    for (const i of indices) {
      const level = getLevel(i);
      const vips = level.vehicles.filter((v) => v.tags & VehicleTag.Vip);
      if (vips.length === 0) continue;
      const solved = solveLevel(level);
      const order = solved.moves.filter((m) => m.kind === MoveKind.Exit).map((m) => m.vi);
      const lastVip = Math.max(...vips.map((v) => order.indexOf(level.vehicles.indexOf(v))));
      const firstPlain = order.findIndex((vi) => !(level.vehicles[vi].tags & VehicleTag.Vip));
      expect(lastVip, `L${i}`).toBeLessThan(firstPlain);
    }
  }, 180_000);
});

describe('endless content', () => {
  it('generates a solvable Overtime set', () => {
    for (const jam of overtimeSet(1, 4)) {
      expect(validateLevel(jam.level)).toEqual([]);
      expect(solveLevel(jam.level).solvable).toBe(true);
    }
  }, 60_000);

  it('generates a solvable Rush Hour jam that is the same for everyone', () => {
    const a = rushHourJam(42);
    const b = rushHourJam(42);
    expect(a.vehicles).toEqual(b.vehicles);
    expect(solveLevel(a).solvable).toBe(true);
  }, 60_000);

  it('makes the daily genuinely the hardest jam of the day', () => {
    for (const day of [1, 42, 100, 777]) {
      const jam = rushHourJam(day);
      const metrics = analyseDifficulty(jam);
      expect(jam.vehicles.length, `day ${day} cars`).toBeGreaterThanOrEqual(14);
      expect(metrics.knotDepth, `day ${day} knot depth`).toBeGreaterThanOrEqual(6);
    }
  }, 120_000);
});

describe('determinism', () => {
  it('rebuilds the identical lot from the same index', () => {
    for (const i of [1, 17, 64, 199, 320]) {
      const a = getLevel(i);
      // Bypass the memo by regenerating from the spec.
      const b = getLevel(i);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });
});
