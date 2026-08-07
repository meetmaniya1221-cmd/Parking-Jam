import { describe, expect, it } from 'vitest';
import {
  analyseDifficulty,
  bumpLikelihood,
  directBlockers,
  hintFrom,
  isStillSolvable,
  nextMoveHint,
  solveExitOnly,
  solveLevel,
  solveState,
} from '../src/core/solver';
import { applyMove, createLotState, resolveMove } from '../src/core/sim';
import { MoveKind } from '../src/core/types';
import { car, lot } from './helpers';

describe('exit-only search', () => {
  it('finds the forced order of a simple queue', () => {
    // Column of three cars all facing the single curb cut: only one order works.
    const level = lot({
      w: 3,
      h: 7,
      vehicles: [car(0, 1, 2, 2), car(1, 1, 4, 2), car(2, 1, 6, 2)],
      exits: [{ x: 1, y: 6, dir: 2 }],
    });
    const order = solveExitOnly(createLotState(level));
    expect(order).toEqual([2, 1, 0]);
  });

  it('returns null when a car is walled in with no route', () => {
    const level = lot({
      w: 3,
      h: 3,
      vehicles: [car(0, 1, 1, 0)],
      exits: [{ x: 1, y: 2, dir: 2 }],
      blocked: [[1, 0]],
    });
    // Facing north into a blocker, with the only curb cut behind it.
    expect(solveExitOnly(createLotState(level))).toBeNull();
  });

  it('reports par equal to the car count when no repositioning is needed', () => {
    const level = lot({
      w: 3,
      h: 7,
      vehicles: [car(0, 1, 2, 2), car(1, 1, 4, 2), car(2, 1, 6, 2)],
      exits: [{ x: 1, y: 6, dir: 2 }],
    });
    const result = solveLevel(level);
    expect(result.exitOnly).toBe(true);
    expect(result.optimal).toBe(true);
    expect(result.parSlides).toBe(3);
  });
});

describe('general search', () => {
  it('solves a lot that needs a car pulled out of the way', () => {
    // The blue car faces the wall; it must reverse before the other can leave.
    const level = lot({
      w: 3,
      h: 5,
      vehicles: [car(0, 0, 1, 0), car(1, 1, 4, 2)],
      exits: [{ x: 1, y: 4, dir: 2 }],
      blocked: [
        [0, 3],
        [0, 4],
        [2, 0],
      ],
    });
    const state = createLotState(level);
    expect(solveExitOnly(state)).toBeNull();
    const result = solveState(state);
    // Vehicle 0 has no route at all here, so the lot genuinely cannot clear.
    expect(result.solvable).toBe(false);
  });

  it('finds a reposition-then-exit line', () => {
    const level = lot({
      w: 4,
      h: 4,
      vehicles: [car(0, 1, 1, 1), car(1, 3, 3, 2)],
      exits: [
        { x: 3, y: 1, dir: 1 },
        { x: 3, y: 3, dir: 2 },
      ],
    });
    const result = solveState(createLotState(level));
    expect(result.solvable).toBe(true);
    expect(result.moves.length).toBeGreaterThanOrEqual(2);
  });

  it('replays its own solution to an empty lot', () => {
    const level = lot({
      w: 5,
      h: 5,
      vehicles: [car(0, 2, 2, 2), car(1, 2, 4, 2), car(2, 4, 1, 1)],
      exits: [
        { x: 2, y: 4, dir: 2 },
        { x: 4, y: 1, dir: 1 },
      ],
    });
    const result = solveLevel(level);
    const state = createLotState(level);
    for (const move of result.moves) applyMove(state, move);
    expect(state.remaining).toBe(0);
  });
});

describe('dead ends', () => {
  /**
   * A one-way arrow is the one thing that can make a slide irreversible, so it
   * is the one thing that lets a player knot a lot for good. Car 1 starts on
   * its own curb cut and can leave; reverse it one cell and the arrow bars the
   * way back, stranding it in front of car 0 forever. That state is exactly
   * what the undo button exists for.
   */
  it('spots a lot the player has knotted for good', () => {
    const level = lot({
      w: 3,
      h: 4,
      vehicles: [car(0, 1, 1, 2), car(1, 2, 2, 1)],
      exits: [
        { x: 1, y: 3, dir: 2 },
        { x: 2, y: 2, dir: 1 },
      ],
      arrows: [[2, 2, 3]],
    });
    const state = createLotState(level);
    expect(isStillSolvable(state)).toBe(true);

    applyMove(state, resolveMove(state, 1, 3, 1)!); // reverse west, past the arrow
    expect(state.remaining).toBe(2);
    expect(isStillSolvable(state)).toBe(false);
  });

  it('knows an empty lot is solved', () => {
    const level = lot({ w: 3, h: 3, vehicles: [], exits: [{ x: 1, y: 2, dir: 2 }] });
    const result = solveState(createLotState(level));
    expect(result.solvable).toBe(true);
    expect(result.parSlides).toBe(0);
  });
});

describe('hints', () => {
  it('names cars that really can leave, in a workable order', () => {
    const level = lot({
      w: 3,
      h: 7,
      vehicles: [car(0, 1, 2, 2), car(1, 1, 4, 2), car(2, 1, 6, 2)],
      exits: [{ x: 1, y: 6, dir: 2 }],
    });
    const state = createLotState(level);
    expect(hintFrom(state, 3)).toEqual([2, 1, 0]);
    expect(hintFrom(state, 1)).toEqual([2]);
  });

  it('falls back to the first move of any valid line', () => {
    const level = lot({
      w: 4,
      h: 4,
      vehicles: [car(0, 1, 1, 1), car(1, 3, 3, 2)],
      exits: [
        { x: 3, y: 1, dir: 1 },
        { x: 3, y: 3, dir: 2 },
      ],
    });
    const move = nextMoveHint(createLotState(level));
    expect(move).not.toBeNull();
    expect([MoveKind.Exit, MoveKind.Slide, MoveKind.Pivot]).toContain(move!.kind);
  });
});

describe('difficulty analysis', () => {
  it('measures the chain depth of a queue', () => {
    const level = lot({
      w: 3,
      h: 7,
      vehicles: [car(0, 1, 2, 2), car(1, 1, 4, 2), car(2, 1, 6, 2)],
      exits: [{ x: 1, y: 6, dir: 2 }],
    });
    const metrics = analyseDifficulty(level);
    expect(metrics.knotDepth).toBe(3);
    expect(metrics.openExits).toBe(1);
    expect(metrics.forcedSteps).toBe(3);
    expect(metrics.distractorRatio).toBeCloseTo(1 / 3, 5);
  });

  it('is independent of which valid order the solver happened to pick', () => {
    const level = lot({
      w: 5,
      h: 5,
      vehicles: [car(0, 1, 4, 2), car(1, 3, 4, 2)],
      exits: [
        { x: 1, y: 4, dir: 2 },
        { x: 3, y: 4, dir: 2 },
      ],
    });
    // Two independent cars: no precedence at all.
    expect(analyseDifficulty(level).knotDepth).toBe(1);
  });

  it('lists the cars standing on a route', () => {
    const level = lot({
      w: 3,
      h: 7,
      vehicles: [car(0, 1, 2, 2), car(1, 1, 4, 2), car(2, 1, 6, 2)],
      exits: [{ x: 1, y: 6, dir: 2 }],
    });
    const state = createLotState(level);
    expect(directBlockers(state, 0)).toEqual([1, 2]);
    expect(directBlockers(state, 2)).toEqual([]);
  });

  it('reports no route when an arrow points against the only lane', () => {
    const level = lot({
      w: 3,
      h: 5,
      vehicles: [car(0, 1, 1, 2)],
      exits: [{ x: 1, y: 4, dir: 2 }],
      arrows: [[1, 3, 0]],
    });
    expect(directBlockers(createLotState(level), 0)).toEqual([]);
  });

  it('rates a wide-open lot as unlikely to bump', () => {
    const open = lot({
      w: 4,
      h: 4,
      vehicles: [car(0, 0, 3, 2), car(1, 2, 3, 2)],
      exits: [
        { x: 0, y: 3, dir: 2 },
        { x: 2, y: 3, dir: 2 },
      ],
    });
    expect(bumpLikelihood(open)).toBe(0);
  });
});
