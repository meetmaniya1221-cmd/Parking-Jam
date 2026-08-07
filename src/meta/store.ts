/**
 * The game store: owns PlayerState, persists it, and tells the UI when to redraw.
 *
 * Every mutation goes through `update`, which saves (debounced) and notifies.
 * There is exactly one store per session, created in main.ts.
 */

import { advanceGreenLight, refreshDispatch } from './economy';
import {
  loadPlayerState,
  PlayerState,
  resolveStorage,
  savePlayerState,
  Storage,
} from './save';

type Listener = (state: PlayerState) => void;

const SAVE_DEBOUNCE_MS = 400;

export class GameStore {
  readonly state: PlayerState;
  private readonly storage: Storage;
  private readonly listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(storage: Storage = resolveStorage(), now: number = Date.now()) {
    this.storage = storage;
    this.state = loadPlayerState(storage, now);
    this.state.lastSeenAt = now;
    this.state.ads.sessionInterstitials = 0;
    refreshDispatch(this.state, now);
    advanceGreenLight(this.state, now);
    this.flush();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * Mutate the player state, then persist and notify. Whatever the mutator
   * returns is handed straight back, so a caller can take the result of a grant
   * or a purchase without smuggling it out through a closure.
   */
  update<T>(mutator: (state: PlayerState) => T): T {
    const result = mutator(this.state);
    this.notify();
    this.scheduleSave();
    return result;
  }

  /** Notify listeners without a mutation — used after external state changes. */
  notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Write immediately — called on visibility change and before unload. */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    savePlayerState(this.storage, this.state);
  }

  reset(now: number = Date.now()): void {
    this.storage.removeItem('gridlock-city:save:v1');
    const fresh = loadPlayerState(this.storage, now);
    Object.assign(this.state, fresh);
    this.notify();
    this.flush();
  }
}
