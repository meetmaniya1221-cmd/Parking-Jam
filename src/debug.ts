/**
 * A small inspection handle on `window.__gridlock`.
 *
 * Automated play-testing needs to see the sim the way the game does — which car
 * can leave, where a cell lands on screen — rather than guessing from pixels.
 * The scripts in `scripts/` drive real pointer events and read this to assert.
 */

import { exitableVehicles } from './core/sim';
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
