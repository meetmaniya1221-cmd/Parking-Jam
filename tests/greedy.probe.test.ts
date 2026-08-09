/**
 * Empirical probe of the "greedy always works" hypothesis.
 *
 * HYPOTHESIS: every shipped campaign level is cleared by repeatedly exiting ANY
 * currently-exitable vehicle, in arbitrary order — no repositioning ever needed.
 *
 * This file is a measurement instrument, not a regression guard: it prints a
 * summary and asserts only the things the run actually establishes.
 */

import { describe, expect, it } from 'vitest';

import { getLevel, TOTAL_LEVELS } from '../src/core/campaign';
import { createLotState, applyMove, resolveMove, probe, exitableVehicles } from '../src/core/sim';
import { solveLevel } from '../src/core/solver';
import { Rng } from '../src/core/rng';
import { Dir, LevelDef, LotState, MoveKind, VehicleTag } from '../src/core/types';

/* ------------------------------------------------------------------ *
 * Greedy runner
 * ------------------------------------------------------------------ */

type Picker = (candidates: number[], state: LotState) => number;

interface GreedyRun {
  cleared: boolean;
  exits: number;
  totalCars: number;
  /** Why it stopped, when it did not clear. */
  reason: string;
  /** Vehicles still on the lot when stuck. */
  stuckRemaining: number;
}

/**
 * Repeatedly exit an exitable vehicle until the lot is clear or nothing can
 * leave. The exit itself goes through the real player-facing path:
 * resolveMove(...) -> applyMove(...), so anything the sim would refuse a
 * dragging player is refused here too.
 */
function runGreedy(level: LevelDef, pick: Picker): GreedyRun {
  const s = createLotState(level);
  const totalCars = s.remaining;
  let exits = 0;

  while (s.remaining > 0) {
    const candidates = exitableVehicles(s);
    if (candidates.length === 0) {
      // Diagnose: is anything at all still movable, and are VIPs gating?
      const vipGated = s.vipsRemaining > 0;
      return {
        cleared: false,
        exits,
        totalCars,
        reason: `stuck with ${s.remaining} car(s) on the lot, 0 exitable` +
          (vipGated ? ` (velvet rope active: ${s.vipsRemaining} VIP(s) remaining)` : ''),
        stuckRemaining: s.remaining,
      };
    }

    const vi = pick(candidates, s);
    const f = s.facing[vi] as Dir;
    const p = probe(s, vi, f);
    // requested must be > 0; exitDist can legitimately be 0 when the nose is
    // already parked on the curb cut.
    const requested = Math.max(p.exitDist, 1);
    const mv = resolveMove(s, vi, f, requested);
    if (!mv || mv.kind !== MoveKind.Exit) {
      return {
        cleared: false,
        exits,
        totalCars,
        reason: `exitableVehicles reported vi=${vi} exitable but resolveMove yielded ` +
          `${mv ? mv.kind : 'null'} (exitDist=${p.exitDist})`,
        stuckRemaining: s.remaining,
      };
    }
    applyMove(s, mv);
    exits++;
  }

  return { cleared: true, exits, totalCars, reason: '', stuckRemaining: 0 };
}

const pickFirst: Picker = (c) => c[0];
const pickLast: Picker = (c) => c[c.length - 1];
const pickRandom = (rng: Rng): Picker => (c) => c[rng.int(c.length)];

/** Median of a numeric array (mean of the two middles for even lengths). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/* ------------------------------------------------------------------ *
 * The probe
 * ------------------------------------------------------------------ */

describe('greedy exit-only probe over the shipped campaign', () => {
  it(
    'runs greedy over every campaign level and reports',
    () => {
      const RANDOM_ORDERS_PER_LEVEL = 24;

      const failures: string[] = [];
      const orderFailures: string[] = [];
      const parMismatches: string[] = [];
      const nonOptimal: string[] = [];
      const initialShares: number[] = [];

      let greedySolved = 0;
      let randomOrdersRun = 0;
      let randomOrdersSolved = 0;
      let parEqualsCarCount = 0;
      let solverExitOnly = 0;
      let solverSolvable = 0;
      let levelsWithVips = 0;
      let zeroInitialExitable = 0;
      let totalCarsAll = 0;

      for (let index = 1; index <= TOTAL_LEVELS; index++) {
        const level = getLevel(index);
        const cars = level.vehicles.length;
        totalCarsAll += cars;

        // --- initial exitable share -----------------------------------
        const fresh = createLotState(level);
        const openExits = exitableVehicles(fresh).length;
        const share = cars === 0 ? 0 : openExits / cars;
        initialShares.push(share);
        if (openExits === 0) zeroInitialExitable++;
        if (fresh.vipsRemaining > 0) levelsWithVips++;

        // --- greedy, deterministic first-candidate order ---------------
        const first = runGreedy(level, pickFirst);
        if (first.cleared) {
          greedySolved++;
        } else {
          failures.push(
            `L${index} (${level.id}, band=${level.band}, ${cars} cars, ` +
              `mods=${level.modifierLoad}): ${first.reason} after ${first.exits} exit(s)`,
          );
        }

        // --- order independence: last-candidate + seeded random orders --
        const last = runGreedy(level, pickLast);
        if (!last.cleared) {
          orderFailures.push(`L${index} last-candidate order: ${last.reason}`);
        }
        const rng = new Rng(0x5eed_0000 ^ index);
        for (let t = 0; t < RANDOM_ORDERS_PER_LEVEL; t++) {
          const r = runGreedy(level, pickRandom(rng));
          randomOrdersRun++;
          if (r.cleared) randomOrdersSolved++;
          else if (orderFailures.length < 40) {
            orderFailures.push(`L${index} random order #${t}: ${r.reason}`);
          }
        }

        // --- solver: is the optimum pure-exit? -------------------------
        const solved = solveLevel(level);
        if (solved.solvable) solverSolvable++;
        if (solved.exitOnly) solverExitOnly++;
        if (solved.solvable && solved.parSlides === cars) {
          parEqualsCarCount++;
        } else {
          parMismatches.push(
            `L${index}: par=${solved.parSlides} vs ${cars} cars ` +
              `(solvable=${solved.solvable}, exitOnly=${solved.exitOnly})`,
          );
        }
        if (!solved.optimal) nonOptimal.push(`L${index}`);
      }

      const medianShare = median(initialShares);
      const meanShare = initialShares.reduce((a, b) => a + b, 0) / initialShares.length;
      const minShare = Math.min(...initialShares);
      const maxShare = Math.max(...initialShares);

      const lines: string[] = [];
      lines.push('================ GREEDY PROBE — SHIPPED CAMPAIGN ================');
      lines.push(`levels tested                     : ${TOTAL_LEVELS}`);
      lines.push(`total cars across all levels      : ${totalCarsAll}`);
      lines.push(`greedy (first-candidate) SOLVED   : ${greedySolved} / ${TOTAL_LEVELS}`);
      lines.push(`greedy (last-candidate) SOLVED    : ${TOTAL_LEVELS - orderFailures.filter((s) => s.includes('last-candidate')).length} / ${TOTAL_LEVELS}`);
      lines.push(
        `greedy (seeded random) SOLVED     : ${randomOrdersSolved} / ${randomOrdersRun} ` +
          `runs (${RANDOM_ORDERS_PER_LEVEL} orders x ${TOTAL_LEVELS} levels)`,
      );
      lines.push(`solveLevel solvable               : ${solverSolvable} / ${TOTAL_LEVELS}`);
      lines.push(`solveLevel exitOnly witness       : ${solverExitOnly} / ${TOTAL_LEVELS}`);
      lines.push(`par == car count (pure-exit optimal): ${parEqualsCarCount} / ${TOTAL_LEVELS}`);
      lines.push(`levels containing VIP cars        : ${levelsWithVips}`);
      lines.push(`levels with 0 exitable on move 1  : ${zeroInitialExitable}`);
      lines.push('---------------- initial exitable share ------------------------');
      lines.push(`median : ${medianShare.toFixed(6)}`);
      lines.push(`mean   : ${meanShare.toFixed(6)}`);
      lines.push(`min    : ${minShare.toFixed(6)}`);
      lines.push(`max    : ${maxShare.toFixed(6)}`);
      lines.push('---------------- failures --------------------------------------');
      if (failures.length === 0) {
        lines.push('greedy first-candidate failures : NONE');
      } else {
        lines.push(`greedy first-candidate failures : ${failures.length}`);
        for (const f of failures) lines.push(`  ${f}`);
      }
      if (orderFailures.length === 0) {
        lines.push('order-dependence failures       : NONE');
      } else {
        lines.push(`order-dependence failures       : ${orderFailures.length}`);
        for (const f of orderFailures) lines.push(`  ${f}`);
      }
      if (parMismatches.length === 0) {
        lines.push('par != car count                : NONE');
      } else {
        lines.push(`par != car count                : ${parMismatches.length}`);
        for (const f of parMismatches.slice(0, 20)) lines.push(`  ${f}`);
      }
      lines.push(
        `solver results not proven optimal : ${nonOptimal.length}` +
          (nonOptimal.length ? ` (${nonOptimal.slice(0, 20).join(', ')})` : ''),
      );
      lines.push(
        `HYPOTHESIS HOLDS                  : ${
          failures.length === 0 && orderFailures.length === 0 ? 'YES' : 'NO'
        }`,
      );
      lines.push('================================================================');

      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));

      // Assertions reflect what the run measured, not what we hoped for.
      // This file began life as a diagnostic that PROVED the old generator shipped
      // 320 of 320 levels clearable by thoughtless tapping. It is kept, inverted,
      // as the regression guard for the rewrite: most levels must now resist it.
      expect(greedySolved).toBeLessThan(TOTAL_LEVELS * 0.4);
      
    },
    900_000,
  );

  it(
    'sanity: the monotonicity premise — exiting a car never shrinks the exitable set',
    () => {
      // Spot-check the mechanism the hypothesis rests on across a spread of
      // levels: after exiting any exitable car, every OTHER car that was
      // exitable is still exitable.
      const violations: string[] = [];
      for (let index = 1; index <= TOTAL_LEVELS; index += 7) {
        const level = getLevel(index);
        const s = createLotState(level);
        while (s.remaining > 0) {
          const before = exitableVehicles(s);
          if (before.length === 0) break;
          const vi = before[0];
          const f = s.facing[vi] as Dir;
          const mv = resolveMove(s, vi, f, Math.max(probe(s, vi, f).exitDist, 1));
          if (!mv || mv.kind !== MoveKind.Exit) break;
          const wasVip = (s.tags[vi] & VehicleTag.Vip) !== 0;
          applyMove(s, mv);
          const after = new Set(exitableVehicles(s));
          for (const other of before) {
            if (other === vi) continue;
            if (!after.has(other)) {
              violations.push(
                `L${index}: exiting vi=${vi} (vip=${wasVip}) removed vi=${other} ` +
                  `from the exitable set`,
              );
            }
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `monotonicity spot-check (levels 1,8,15,...,${TOTAL_LEVELS}): ` +
          `${violations.length} violation(s)` +
          (violations.length ? `\n  ${violations.slice(0, 10).join('\n  ')}` : ''),
      );
      expect(violations).toEqual([]);
    },
    900_000,
  );
});
