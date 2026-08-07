/**
 * A small inspection handle on `window.__gridlock`.
 *
 * Automated play-testing needs to see the sim the way the game does — which car
 * can leave, where a cell lands on screen — rather than guessing from pixels.
 * The scripts in `scripts/` drive real pointer events and read this to assert.
 */

import { exitableVehicles } from './core/sim';
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
  version: string;
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
  version: '1.0.0',
};

export function installDebugHandle(jumpTo: (index: number) => void): void {
  handle.jumpTo = jumpTo;
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
