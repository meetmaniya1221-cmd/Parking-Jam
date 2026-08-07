/**
 * Shared contracts for the meta screens.
 *
 * All four follow the same one-thumb rules (GDD §14): one primary action per
 * screen, interactive elements in the lower part of the view, numbers always
 * paired with their icon, and never more than one modal deep.
 */

import { AudioEngine } from '../../audio/audio';
import { BoosterId } from '../../meta/save';
import { GameStore } from '../../meta/store';

export interface Screen {
  root: HTMLElement;
  refresh(): void;
  mount?(): void;
  unmount?(): void;
}

export interface ScreenHost {
  playLevel(index: number): void;
  playSpecial(
    kind: 'rush' | 'overtime' | 'night' | 'coldCase' | 'gauntlet',
    index?: number,
  ): void;
  refreshChrome(): void;
}

export interface Deps {
  store: GameStore;
  audio: AudioEngine;
  host: ScreenHost;
}

export function boosterIcon(id: BoosterId): string {
  return { towHook: '\u{1FA9D}', dispatcher: '\u{1F4FB}', greenWave: '\u{1F7E2}', gripTires: '\u{1F6DE}' }[id];
}

export function boosterName(id: BoosterId): string {
  return {
    towHook: 'Tow Hook',
    dispatcher: 'Dispatcher Call',
    greenWave: 'Green Wave',
    gripTires: 'Grip Tires',
  }[id];
}
