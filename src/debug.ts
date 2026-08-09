/**
 * A small inspection handle on `window.__gridlock`.
 *
 * Automated play-testing needs to see the sim the way the game does — which car
 * can leave, where a cell lands on screen — rather than guessing from pixels.
 * The scripts in `scripts/` drive real pointer events and read this to assert.
 */

import { meteredLimit, getLevel, PATTERNS } from './core/campaign';
import { exitableVehicles, probe, resolveMove } from './core/sim';
import { Dir } from './core/types';
import { Settings } from './meta/save';
import { LotView } from './view/lotView';

export interface GridlockDebug {
  lotView: LotView | null;
  canvas: HTMLCanvasElement | null;
  /** Vehicle indices that can drive off the lot right now. */
  exitable(): number[];
  /** Global index of the lot on screen, or 0 for an event jam. */
  levelIndex: number;
  /** Jump straight to a level. Patching the save from outside races the
   *  store's own flush on unload, so QA goes through the app instead. */
  jumpTo(index: number): void;
  /** Put the profile into a named state so a journey can start mid-game. */
  seed(patch: SeedPatch): void;
  /** The slide cap for a level, or null when it is not a Metered Lot. */
  meteredLimitFor(index: number): number | null;
  /** Burn one slide on a move that clears nothing. False when none is left. */
  wasteAMove(): boolean;
  /** Vehicles the Dispatcher Call is currently highlighting. */
  hintedVehicles(): number[];
  /**
   * The shipped solution as drag gestures, from the level's opening position.
   *
   * A harness cannot clear these lots by tapping any more — that is the whole
   * point of the generator rewrite — so it needs the line the generator proved.
   * Each step is a signed distance along the car's own axis: positive is
   * forward, negative is backing up.
   */
  solutionSteps(): Array<{ vi: number; cells: number; exit: boolean; toX: number; toY: number }>;
  /**
   * The level that introduces a named pattern, or null.
   *
   * Exposed so a harness never has to restate the schedule: a test that hard
   * codes "level 26 teaches the Slick Corridor" goes quietly wrong the moment
   * the curve is retuned, and reports it as a missing coach mark.
   */
  patternIntro(tag: string): number | null;
  version: string;
}

/** The states a scripted play-through needs to reach without grinding to them. */
export interface SeedPatch {
  level?: number;
  coins?: number;
  medallions?: number;
  blueprints?: number;
  /** Pretend the last collect happened this many hours ago. */
  backdateIncomeHours?: number;
  settings?: Partial<Settings>;
}

declare global {
  interface Window {
    __gridlock?: GridlockDebug;
  }
}

const handle: GridlockDebug = {
  lotView: null,
  canvas: null,
  exitable(): number[] {
    return handle.lotView ? exitableVehicles(handle.lotView.state) : [];
  },
  levelIndex: 0,
  jumpTo(): void {
    /* replaced by installDebugHandle */
  },
  seed(): void {
    /* replaced by installDebugHandle */
  },
  meteredLimitFor(index: number): number | null {
    return meteredLimit(index, getLevel(index).parSlides);
  },
  hintedVehicles(): number[] {
    return handle.lotView ? handle.lotView.hintedVehicles() : [];
  },
  patternIntro(tag: string): number | null {
    return PATTERNS.find((p) => p.tag === tag)?.intro ?? null;
  },
  solutionSteps(): Array<{ vi: number; cells: number; exit: boolean; toX: number; toY: number }> {
    const view = handle.lotView;
    const solution = view?.currentLevel().solution;
    if (!view || !solution) return [];
    // Facing has to be tracked, because a roundabout pivot turns a car and every
    // later step for it is expressed relative to the new heading. Only a pivot
    // does that: sliding backwards moves a car without turning it, so updating
    // the heading on every move flips the sign of every subsequent gesture for
    // that car — which is exactly the bug this comment exists to prevent.
    const facing = view.currentLevel().vehicles.map((v) => v.facing as number);
    return solution.map((m) => {
      const exit = m.kind === 'exit';
      const forward = m.dir === facing[m.vi];
      // Overshoot an exit by a cell: a drag of exactly the curb distance sits
      // on the boundary, and anything past it commits unambiguously.
      const magnitude = Math.max(1, m.distance) + (exit ? 1 : 0);
      if (m.kind === 'pivot') facing[m.vi] = m.dir;
      return { vi: m.vi, cells: magnitude * (forward ? 1 : -1), exit, toX: m.toX, toY: m.toY };
    });
  },
  wasteAMove(): boolean {
    const view = handle.lotView;
    if (!view) return false;
    const s = view.state;
    for (let vi = 0; vi < s.x.length; vi++) {
      if (s.gone[vi]) continue;
      for (const dir of [s.facing[vi], (s.facing[vi] + 2) % 4] as Dir[]) {
        const p = probe(s, vi, dir);
        // A slide that stays on the lot burns a slide without clearing a car.
        if (p.exitDist < 0 && p.dist > 0) {
          const move = resolveMove(s, vi, dir, 1);
          if (move && move.kind !== 'exit') {
            view.applyDebugMove(move);
            return true;
          }
        }
      }
    }
    return false;
  },
  version: '1.0.0',
};

export function installDebugHandle(hooks: {
  jumpTo: (index: number) => void;
  seed: (patch: SeedPatch) => void;
}): void {
  handle.jumpTo = hooks.jumpTo;
  handle.seed = hooks.seed;
  if (typeof window !== 'undefined') window.__gridlock = handle;
}

export function setDebugLot(
  lotView: LotView | null,
  canvas: HTMLCanvasElement | null,
  levelIndex = 0,
): void {
  handle.lotView = lotView;
  handle.canvas = canvas;
  handle.levelIndex = levelIndex;
}
