/**
 * The progression contract.
 *
 * `campaign.test.ts` proves every jam is *valid*; this file proves the sequence
 * of them is a *curve* — that the lot grows, fills and knots harder as the level
 * number climbs, that a car really does take up less of the screen at level
 * twenty than at level one, and that none of it stops fitting on a phone.
 *
 * The milestone levels are the ones a player uses to judge the game, so they are
 * asserted individually rather than only in aggregate.
 */

import { describe, expect, it } from 'vitest';
import { getLevel, specForLevel, TOTAL_LEVELS } from '../src/core/campaign';
import { difficultyFor, MAX_BOARD_H, MAX_BOARD_W } from '../src/core/difficulty';
import { auditLevel, gradeLevel } from '../src/core/generator';
import { analyseDifficulty, solveLevel } from '../src/core/solver';
import { applyMove, createLotState, validateLevel } from '../src/core/sim';
import { comfortableCell, fitCamera } from '../src/view/lotRenderer';
import { Band, VEHICLE_LENGTH, VehicleKind } from '../src/core/types';

/** The five levels the brief calls out, and what each is supposed to feel like. */
const MILESTONES = [
  { level: 1, cells: 48, minCars: 4, maxCars: 8, minDepth: 2, minMoves: 4 },
  { level: 5, cells: 63, minCars: 6, maxCars: 12, minDepth: 3, minMoves: 6 },
  { level: 10, cells: 99, minCars: 13, maxCars: 22, minDepth: 7, minMoves: 13 },
  { level: 15, cells: 143, minCars: 18, maxCars: 30, minDepth: 7, minMoves: 18 },
  { level: 20, cells: 180, minCars: 24, maxCars: 40, minDepth: 9, minMoves: 24 },
] as const;

describe('board scaling', () => {
  it('grows the logical grid, and never shrinks it', () => {
    let prevCells = 0;
    for (let i = 1; i <= 40; i++) {
      const level = getLevel(i);
      const cells = level.w * level.h;
      // Bands move density and depth around; they never take the lot away.
      const floor = specForLevel(i).difficulty;
      expect(level.w, `L${i} width`).toBe(floor.boardWidth);
      expect(level.h, `L${i} height`).toBe(floor.boardHeight);
      if (i > 1 && level.band !== Band.Showcase) {
        expect(cells, `L${i} cells vs L${i - 1}`).toBeGreaterThanOrEqual(prevCells);
      }
      if (level.band !== Band.Showcase) prevCells = cells;
    }
  }, 120_000);

  it('reaches the milestone sizes on schedule', () => {
    for (const m of MILESTONES) {
      const level = getLevel(m.level);
      expect(level.w * level.h, `L${m.level} board area`).toBeGreaterThanOrEqual(m.cells);
    }
    // The whole point: level twenty is a different object from level one.
    expect(getLevel(20).w * getLevel(20).h).toBeGreaterThan(getLevel(1).w * getLevel(1).h * 3);
  }, 120_000);

  it('never exceeds the playable ceiling', () => {
    for (let i = 1; i <= TOTAL_LEVELS; i += 7) {
      const level = getLevel(i);
      expect(level.w, `L${i}`).toBeLessThanOrEqual(MAX_BOARD_W);
      expect(level.h, `L${i}`).toBeLessThanOrEqual(MAX_BOARD_H);
    }
  }, 180_000);
});

describe('milestone jams', () => {
  it.each(MILESTONES)(
    'level $level is the right size, density and difficulty',
    (m) => {
      const level = getLevel(m.level);
      const config = specForLevel(m.level).difficulty;
      const audit = auditLevel(level, config);

      expect(validateLevel(level), `L${m.level} structure`).toEqual([]);
      expect(audit.solvable, `L${m.level} solvable`).toBe(true);
      expect(audit.vehicles, `L${m.level} cars`).toBeGreaterThanOrEqual(m.minCars);
      expect(audit.vehicles, `L${m.level} cars`).toBeLessThanOrEqual(m.maxCars);
      expect(audit.knotDepth, `L${m.level} dependency depth`).toBeGreaterThanOrEqual(m.minDepth);
      expect(audit.parSlides, `L${m.level} solution moves`).toBeGreaterThanOrEqual(m.minMoves);
      expect(audit.density, `L${m.level} density`).toBeGreaterThanOrEqual(config.minDensity * 0.9);

      // The solver's line really clears the lot.
      const state = createLotState(level);
      for (const move of solveLevel(level).moves) applyMove(state, move);
      expect(state.remaining, `L${m.level} left cars behind`).toBe(0);
    },
  );

  it('climbs every difficulty axis from level 1 to level 20', () => {
    const at = (i: number) => {
      const level = getLevel(i);
      return { level, metrics: analyseDifficulty(level) };
    };
    const one = at(1);
    const five = at(5);
    const ten = at(10);
    const twenty = at(20);

    const cars = (x: typeof one) => x.metrics.vehicleCount;
    expect(cars(one)).toBeLessThan(cars(five));
    expect(cars(five)).toBeLessThan(cars(ten));
    expect(cars(ten)).toBeLessThan(cars(twenty));

    expect(one.metrics.knotDepth).toBeLessThan(ten.metrics.knotDepth);
    expect(one.metrics.density).toBeLessThan(twenty.metrics.density);
    // Free parking dries up: by level twenty almost nothing clears in isolation.
    expect(twenty.metrics.independentRatio).toBeLessThan(one.metrics.independentRatio);
    // And the lot stops being a handful of separate little problems.
    expect(one.metrics.bottlenecks).toBeLessThan(twenty.metrics.bottlenecks);
  }, 120_000);

  it('refuses a late lot that would play like an early one', () => {
    // The contract is what does the refusing, so assert it has teeth: grade a
    // level-five lot against level fifteen's brief and it must be thrown out.
    const late = difficultyFor(15, Band.Hard);
    const early = getLevel(5);
    const metrics = analyseDifficulty(early);
    const shortfalls = gradeLevel(metrics, late, solveLevel(early));
    const codes = shortfalls.map((s) => s.code);
    expect(codes, 'an early lot passed a late contract').not.toEqual([]);
    expect(codes).toContain('cars');
    expect(codes).toContain('depth');
    expect(codes).toContain('moves');
    expect(codes).toContain('bottlenecks');
  }, 60_000);

  it('asks the late game for a temporary reposition, and proves one exists', () => {
    let demanded = 0;
    let delivered = 0;
    for (let i = 13; i <= 60; i++) {
      const config = specForLevel(i).difficulty;
      if (!config.temporaryMoveRequirement) continue;
      demanded++;
      const solved = solveLevel(getLevel(i));
      expect(solved.solvable, `L${i} unsolvable`).toBe(true);
      if (solved.repositions > 0) delivered++;
    }
    expect(demanded, 'no level asks for a temporary move').toBeGreaterThan(4);
    // Not every lot can host the deadlock that forces one — a pinched frontage
    // has no room for it — but the great majority must, or the mechanic is not
    // really in the game.
    expect(delivered / demanded, 'temporary moves delivered').toBeGreaterThan(0.7);
  }, 240_000);
});

/* ------------------------------------------------------------------ *
 * Fitting on a real screen
 * ------------------------------------------------------------------ */

/** Play-area sizes in CSS pixels — the region between HUD and boosters. */
const VIEWPORTS = [
  { name: 'small phone', w: 320, h: 400 },
  { name: 'phone', w: 390, h: 560 },
  { name: 'large phone', w: 430, h: 640 },
  { name: 'tablet', w: 560, h: 800 },
  { name: 'desktop', w: 560, h: 720 },
] as const;

const PADDING = (w: number, h: number) => Math.max(8, Math.min(w, h) * 0.045);

describe('responsive fit', () => {
  it('never lets a lot overflow a screen it claims to fit', () => {
    for (const vp of VIEWPORTS) {
      for (let i = 1; i <= 24; i++) {
        const level = getLevel(i);
        const cam = fitCamera(level, vp.w, vp.h, PADDING(vp.w, vp.h), comfortableCell(vp.w, vp.h));
        if (cam.overflow) continue;
        expect(level.w * cam.cw, `L${i} on ${vp.name}`).toBeLessThanOrEqual(vp.w + 0.5);
        expect(level.h * cam.ch, `L${i} on ${vp.name}`).toBeLessThanOrEqual(vp.h + 0.5);
        expect(cam.ox, `L${i} on ${vp.name} left edge`).toBeGreaterThanOrEqual(-0.5);
        expect(cam.oy, `L${i} on ${vp.name} top edge`).toBeGreaterThanOrEqual(-0.5);
      }
    }
  }, 120_000);

  it('keeps cars big enough to grab, at every level and every size', () => {
    for (const vp of VIEWPORTS) {
      const floor = comfortableCell(vp.w, vp.h);
      for (let i = 1; i <= 24; i++) {
        const level = getLevel(i);
        const cam = fitCamera(level, vp.w, vp.h, PADDING(vp.w, vp.h), floor);
        // The floor may give up to 8% to avoid panning over a few pixels; past
        // that the view pans instead of shrinking.
        expect(cam.cw, `L${i} cell on ${vp.name}`).toBeGreaterThanOrEqual(floor * 0.92);
        // A car's short axis is one cell, and that is what a thumb lands on.
        expect(cam.cw, `L${i} cell on ${vp.name}`).toBeGreaterThanOrEqual(18);
      }
    }
  }, 120_000);

  it('only ever pans on the big late lots', () => {
    const roomy = VIEWPORTS.find((v) => v.name === 'tablet')!;
    for (let i = 1; i <= 12; i++) {
      const cam = fitCamera(
        getLevel(i),
        roomy.w,
        roomy.h,
        PADDING(roomy.w, roomy.h),
        comfortableCell(roomy.w, roomy.h),
      );
      expect(cam.overflow, `L${i} should fit a tablet whole`).toBe(false);
    }
    // Early lots fit even the smallest supported screen — the on-ramp is never
    // asked to teach panning as well as the game.
    const tiny = VIEWPORTS[0];
    for (let i = 1; i <= 6; i++) {
      const cam = fitCamera(
        getLevel(i),
        tiny.w,
        tiny.h,
        PADDING(tiny.w, tiny.h),
        comfortableCell(tiny.w, tiny.h),
      );
      expect(cam.overflow, `L${i} should fit a small phone whole`).toBe(false);
    }
  }, 120_000);

  it('makes cars visibly smaller relative to the lot as the game grows', () => {
    const vp = VIEWPORTS.find((v) => v.name === 'phone')!;

    /** Screen area of an ordinary two-cell car as a share of the whole lot. */
    const sedanShare = (i: number) => {
      const level = getLevel(i);
      const cam = fitCamera(level, vp.w, vp.h, PADDING(vp.w, vp.h), 0); // fit-to-screen
      return (VEHICLE_LENGTH[VehicleKind.Sedan] * cam.cw * cam.ch) / (level.w * cam.cw * level.h * cam.ch);
    };

    // A sedan covers a twentieth of the lot at level one and well under a
    // hundredth by level twenty: the same car, a much bigger car park.
    expect(sedanShare(1)).toBeGreaterThan(sedanShare(5));
    expect(sedanShare(5)).toBeGreaterThan(sedanShare(10));
    expect(sedanShare(10)).toBeGreaterThan(sedanShare(15));
    expect(sedanShare(15)).toBeGreaterThan(sedanShare(20));
    expect(sedanShare(20)).toBeLessThan(sedanShare(1) * 0.3);

    // Which is only a real change if the lot on screen stayed about the same
    // size — the board gains cells, not pixels.
    const screenArea = (i: number) => {
      const level = getLevel(i);
      const cam = fitCamera(level, vp.w, vp.h, PADDING(vp.w, vp.h), 0);
      return level.w * cam.cw * level.h * cam.ch;
    };
    expect(screenArea(20)).toBeGreaterThan(screenArea(1) * 0.7);
    expect(screenArea(20)).toBeLessThan(vp.w * vp.h);
  }, 120_000);
});
