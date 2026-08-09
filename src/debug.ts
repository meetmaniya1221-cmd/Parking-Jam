/**
 * A small inspection handle on `window.__gridlock`.
 *
 * Automated play-testing needs to see the sim the way the game does — which car
 * can leave, where a cell lands on screen — rather than guessing from pixels.
 * The scripts in `scripts/` drive real pointer events and read this to assert.
 */

import { meteredLimit, getLevel, PATTERNS } from './core/campaign';
import { exitableVehicles, probe, resolveMove } from './core/sim';
import { nextMoveHint } from './core/solver';
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
  /**
   * Play the solver's next move, whatever kind it is.
   *
   * A harness that only taps cars can clear most of the game, but not a lot
   * built around a deadlock ring — those need a car pulled temporarily aside,
   * and a bot that cannot do that would report a solvable jam as a dead end.
   * Returns false only when the lot genuinely cannot be cleared from here.
   */
  playBestMove(): boolean;
  /** Vehicles the Dispatcher Call is currently highlighting. */
  hintedVehicles(): number[];
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
  playBestMove(): boolean {
    const view = handle.lotView;
    if (!view) return false;
    const move = nextMoveHint(view.state);
    if (!move) return false;
    view.applyDebugMove(move);
    return true;
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
