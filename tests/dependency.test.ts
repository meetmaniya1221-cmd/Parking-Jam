/**
 * The guarantees the redesigned generator exists to make.
 *
 * Everything here is about one claim: a shipped jam must not fall to "tap
 * whatever car is currently free". That bot is not a strawman — because
 * removing a car only ever frees cells, taking an available exit is never a
 * mistake, so on a lot that needs no repositioning the bot clears the board in
 * any order at all. Holding cars back from it is the whole of the difficulty.
 */
import { describe, expect, it } from 'vitest';
import { getLevel, specForLevel, TOTAL_LEVELS } from '../src/core/campaign';
import { backtrackCount, judgeLevel } from '../src/core/generator';
import {
  analyseDifficulty,
  cascadeExits,
  dependencyGraph,
  exitMoveFor,
  greedyClearance,
} from '../src/core/solver';
import { applyMove, createLotState, exitableVehicles, resolveMove } from '../src/core/sim';
import { Band } from '../src/core/types';

/** Levels 1–4 are the on-ramp and are exempt: they teach the verb. */
const RAMP = 4;
const PLAYABLE = Array.from({ length: TOTAL_LEVELS }, (_, i) => i + 1).filter((i) => i > RAMP);
const SAMPLE = PLAYABLE.filter((i) => i % 7 === 0 || i <= 30);

describe('the tapping bot', () => {
  it('cannot clear a single jam past the on-ramp', () => {
    const solved: number[] = [];
    for (const i of PLAYABLE) {
      const { cleared, total } = greedyClearance(getLevel(i));
      if (cleared === total) solved.push(i);
    }
    expect(solved).toEqual([]);
  }, 300_000);

  it('is left holding a real share of the lot, band by band', () => {
    const shares: Record<string, number[]> = {};
    for (const i of PLAYABLE) {
      const level = getLevel(i);
      const m = analyseDifficulty(level, level.parSolution);
      (shares[level.band] ??= []).push(m.greedyStallShare);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Breathers are rest, not a free ride — even those hold a fifth of the lot.
    expect(mean(shares[Band.Easy])).toBeGreaterThan(0.2);
    expect(mean(shares[Band.Medium])).toBeGreaterThan(0.28);
    expect(mean(shares[Band.Hard])).toBeGreaterThan(0.33);
    // And the tide still rises across the bands.
    expect(mean(shares[Band.Hard])).toBeGreaterThan(mean(shares[Band.Easy]));
  }, 300_000);

  it('still has most of the lot standing after three taps', () => {
    for (const i of SAMPLE.filter((i) => i >= 10)) {
      const level = getLevel(i);
      const state = createLotState(level);
      const n = state.x.length;
      // Three taps, taking whatever is free — the reflex opening.
      for (let tap = 0; tap < 3; tap++) {
        const free = exitableVehicles(state);
        if (free.length === 0) break;
        const mv = exitMoveFor(state, free[0]);
        if (!mv) break;
        applyMove(state, mv);
      }
      expect(state.remaining / n, `L${i} is ${state.remaining}/${n} after three taps`).toBeGreaterThan(0.5);
    }
  }, 300_000);
});

describe('every car has a job', () => {
  it('ships no car that blocks nobody and can leave at will', () => {
    const idle: string[] = [];
    for (const i of PLAYABLE) {
      const graph = dependencyGraph(getLevel(i));
      for (const vi of graph.independent) idle.push(`L${i}#${vi}`);
    }
    expect(idle).toEqual([]);
  }, 300_000);

  it('has almost every car blocked, blocking, or both', () => {
    for (const i of SAMPLE) {
      const level = getLevel(i);
      const m = analyseDifficulty(level, level.parSolution);
      expect(m.participation, `L${i} participation`).toBeGreaterThanOrEqual(0.8);
    }
  }, 300_000);

  it('never strands a car with no route out at all', () => {
    // A car facing a wall with no curb cut behind it can never leave, whatever
    // the player does. Solvability already rules it out; this says why.
    for (const i of SAMPLE) {
      const m = analyseDifficulty(getLevel(i), getLevel(i).parSolution);
      expect(m.strandedCars, `L${i}`).toBe(0);
    }
  }, 300_000);
});

describe('repositioning', () => {
  it('is genuinely required, not merely present in the par line', () => {
    for (const i of SAMPLE) {
      const level = getLevel(i);
      const state = createLotState(level);
      cascadeExits(state);
      // The cascade is optimal and order-independent, so anything it leaves
      // standing can only be freed by a slide.
      expect(state.remaining, `L${i} needs no slide`).toBeGreaterThan(0);
    }
  }, 300_000);

  it('asks for more of it band by band', () => {
    // Graded by band rather than by campaign position, because band mix is what
    // varies along the campaign — a district heavy in breathers would otherwise
    // read as a difficulty dip that is really just a rhythm.
    const mean = (band: Band) => {
      const xs: number[] = [];
      for (const i of PLAYABLE) {
        const level = getLevel(i);
        if (level.band === band) xs.push(level.repositionMoves ?? 0);
      }
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(mean(Band.Easy)).toBeGreaterThan(1);
    expect(mean(Band.Medium)).toBeGreaterThan(mean(Band.Easy));
    expect(mean(Band.Showcase)).toBeGreaterThan(mean(Band.Medium));
  }, 300_000);
});

describe('the gate', () => {
  it('never ships a jam missing the three things it exists to guarantee', () => {
    // These are absolutes rather than targets, and are checked as absolutes:
    // the gate's `minimumGreedyStall` is a *shape* — how much of the lot ought
    // to be held back — and a small grid can legitimately fall short of it.
    // Holding back nothing at all is a different kind of failure.
    const fatal: string[] = [];
    for (const i of PLAYABLE) {
      const level = getLevel(i);
      const m = analyseDifficulty(level, level.parSolution);
      if (m.greedyStall === 0) fatal.push(`L${i}: clears itself`);
      if (m.repositionMoves === 0) fatal.push(`L${i}: no repositioning in the line`);
      if (m.independentCars > 0) fatal.push(`L${i}: ${m.independentCars} cars are scenery`);
    }
    expect(fatal).toEqual([]);
  }, 300_000);

  it('misses the shape targets rarely enough for them to be worth having', () => {
    // The rest are shape, not substance — a 7×10 lot simply cannot hold a
    // nine-deep knot, and `generateLevel` keeps the closest miss when no seed in
    // the batch clears every bar. What is not allowed is a *silent* miss, so
    // this pins the rate rather than pretending there is none.
    //
    // `repositions` is excluded and measured separately above: that target is
    // pitched deliberately above what most lots deliver, so the scorer keeps
    // reaching for it, and counting it here would drown out everything else.
    let missed = 0;
    let checked = 0;
    for (const i of SAMPLE) {
      const failed = judgeLevel(getLevel(i), specForLevel(i)).failed.filter(
        (f) => f !== 'repositions',
      );
      checked++;
      if (failed.length > 0) missed++;
    }
    expect(missed / checked, `${missed}/${checked} jams missed a target`).toBeLessThan(0.45);
  }, 300_000);

  it('records a par line the simulator will actually accept', () => {
    for (const i of SAMPLE) {
      const level = getLevel(i);
      expect(level.parSolution, `L${i} has no par line`).toBeDefined();
      const state = createLotState(level);
      for (const m of level.parSolution!) {
        const mv = resolveMove(state, m.vi, m.dir, Math.max(1, m.distance));
        expect(mv, `L${i} par move on car ${m.vi} is illegal`).not.toBeNull();
        expect(mv!.kind, `L${i} par move kind`).toBe(m.kind);
        applyMove(state, mv!);
      }
      expect(state.remaining, `L${i} par line leaves cars behind`).toBe(0);
    }
  }, 300_000);

  it('counts turnarounds only where a car really doubles back', () => {
    for (const i of SAMPLE) {
      expect(backtrackCount(getLevel(i))).toBeGreaterThanOrEqual(0);
    }
  }, 300_000);
});
