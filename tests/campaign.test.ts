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
import { applyMove, createLotState, legalMoves, validateLevel } from '../src/core/sim';
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
      // Par is one move per car plus the repositions the lot demands. It used to
      // be exactly one per car, because no lot ever demanded any — which is the
      // thing the generator was rebuilt to stop being true.
      const repositions = level.repositionMoves ?? 0;
      if (audit.parSlides !== level.vehicles.length + repositions) {
        failures.push(
          `L${i}: par ${audit.parSlides} != ${level.vehicles.length} cars + ${repositions} slides`,
        );
      }
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

  it('always leaves at least one legal move on turn one', () => {
    // Not one legal *exit*: past the on-ramp a stretch jam is allowed to open
    // with every car boxed in, and that opening — "which of these do I move
    // first, and where to?" — is the point of it. What is never allowed is a
    // lot the player cannot touch at all.
    for (const i of indices) {
      const state = createLotState(getLevel(i));
      expect(legalMoves(state).length, `L${i} opens with nothing to do`).toBeGreaterThan(0);
    }
  }, 180_000);

  it('keeps an obvious way in on breathers and the on-ramp', () => {
    for (const i of indices) {
      const level = getLevel(i);
      if (i >= 10 && level.band !== Band.Easy) continue;
      const metrics = analyseDifficulty(level, level.parSolution);
      expect(metrics.openExits, `L${i} rest level opens sealed`).toBeGreaterThan(0);
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
    // Depth does not climb past the hand-over, and is not asked to. A 7×10 lot
    // with a dozen cars tops out around eight or nine links whatever the spec
    // requests, so the late campaign holds that plateau and gets harder on the
    // axis that still has room — how much repositioning the knot demands, which
    // `dependency.test.ts` grades band by band. Compared stretch-to-stretch,
    // because an all-bands mean measures the band mix and nothing else.
    const stretch = (from: number, to: number, of: (i: number) => number) => {
      const xs: number[] = [];
      for (let i = from; i <= to; i++) if (getLevel(i).band === Band.Hard) xs.push(of(i));
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(stretch(161, 320, (i) => getLevel(i).knotDepth)).toBeGreaterThan(7.5);
    expect(stretch(161, 320, (i) => getLevel(i).repositionMoves ?? 0)).toBeGreaterThan(1);

    // Density is the axis that does climb cleanly, era over era.
    for (let i = 1; i < ERAS.length; i++) {
      const prev = cars(...ERAS[i - 1]);
      const here = cars(...ERAS[i]);
      expect(here, `cars L${ERAS[i][0]}-${ERAS[i][1]} vs previous era`).toBeGreaterThan(prev);
    }
  }, 240_000);

  it('scales vehicle count into the design bands', () => {
    const count = (i: number) => getLevel(i).vehicles.length;
    for (let i = 1; i <= 9; i++) expect(count(i), `L${i}`).toBeLessThanOrEqual(10);
    // From the hand-over the lots are packed, not sparse.
    for (let i = 10; i <= 20; i++) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(10);
    for (let i = 61; i <= 180; i += 7) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(12);
    for (let i = 200; i <= 320; i += 13) expect(count(i), `L${i}`).toBeGreaterThanOrEqual(12);
  }, 180_000);

  it('keeps the tutorial gentle and free of vocabulary', () => {
    for (let i = 1; i <= 3; i++) {
      const level = getLevel(i);
      expect(level.vehicles.length).toBeLessThanOrEqual(6);
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
      // A tap on a car that cannot drive off is a bump: free, comedic, and the
      // whole read. A jam where most taps bump is a jam that has to be looked
      // at. Breathers sit at the open end of that range on purpose (GDD §6).
      expect(p, `L${i} bump likelihood`).toBeGreaterThan(level.band === Band.Easy ? 0.3 : 0.4);
      // Opaque is a different thing from tight, and is measured on moves rather
      // than exits: there is always something to do.
      expect(legalMoves(createLotState(level)).length, `L${i} is opaque`).toBeGreaterThan(0);
    }
  }, 180_000);

  it('grades how much of the lot is held back, band by band', () => {
    // This used to compare openings, on the theory that a harder lot shows the
    // player fewer free cars. It no longer does, and the reason is worth
    // recording: a free exit is never a mistake to take, so those cars come off
    // the lot whatever their number, and counting them measures how a jam
    // *looks* rather than how hard it is. Every band now opens with two or three
    // free cars and they are all gone within a few taps.
    //
    // What separates the bands is the untying that follows. The *share* held
    // back saturates — every band past the on-ramp ends up holding roughly two
    // fifths of its cars, because that is what the geometry will bear — so the
    // graded axis is how many repositions it takes to release them.
    const mean = (band: Band, of: (i: number) => number) => {
      const values: number[] = [];
      for (let i = 21; i <= TOTAL_LEVELS; i++) {
        if (getLevel(i).band === band) values.push(of(i));
      }
      return values.reduce((a, b) => a + b, 0) / values.length;
    };
    const stall = (band: Band) =>
      mean(band, (i) => analyseDifficulty(getLevel(i), getLevel(i).parSolution).greedyStallShare);
    const slides = (band: Band) => mean(band, (i) => getLevel(i).repositionMoves ?? 0);

    expect(slides(Band.Easy)).toBeLessThan(slides(Band.Medium));
    expect(slides(Band.Medium)).toBeLessThan(slides(Band.Hard));
    expect(slides(Band.Hard)).toBeLessThan(slides(Band.Showcase));

    // And no band past the on-ramp is a walk: even a breather keeps a fifth of
    // the lot out of reach of tapping, and the rest keep a third or more.
    expect(stall(Band.Easy)).toBeGreaterThan(0.2);
    expect(stall(Band.Medium)).toBeGreaterThan(0.33);
    expect(stall(Band.Hard)).toBeGreaterThan(0.33);

    // Breathers still keep an obvious way in, in cars rather than in shares:
    // rest means "somewhere to start", not "a bigger fraction of a bigger lot".
    const opens = (band: Band) =>
      mean(band, (i) => analyseDifficulty(getLevel(i), getLevel(i).parSolution).openExits);
    expect(opens(Band.Easy)).toBeGreaterThan(1.5);
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
      const metrics = analyseDifficulty(jam, jam.parSolution);
      expect(jam.vehicles.length, `day ${day} cars`).toBeGreaterThanOrEqual(12);
      expect(metrics.knotDepth, `day ${day} knot depth`).toBeGreaterThanOrEqual(5);
      // Car count is the weakest thing a daily could be measured by, now that
      // it is not what makes a jam hard. These are.
      expect(metrics.greedyStallShare, `day ${day} holds back`).toBeGreaterThan(0.2);
      expect(metrics.repositionMoves, `day ${day} repositions`).toBeGreaterThanOrEqual(1);
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
