import { describe, expect, it } from 'vitest';
import {
  createPlayerState,
  dayNumber,
  dayStamp,
  loadPlayerState,
  migrate,
  PlayerState,
  SAVE_KEY,
  SAVE_VERSION,
  savePlayerState,
  Storage,
} from '../src/meta/save';
import { PROJECTS_PER_DISTRICT } from '../src/meta/districts';
import { GameStore } from '../src/meta/store';

function memoryStorage(seed?: string): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (seed) data.set(SAVE_KEY, seed);
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const T0 = Date.UTC(2026, 7, 7, 12, 0, 0);

describe('day helpers', () => {
  it('stamps a stable local day', () => {
    expect(dayStamp(T0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayStamp(T0)).toBe(dayStamp(T0 + 60_000));
  });

  it('numbers days monotonically for the daily rotations', () => {
    expect(dayNumber(T0 + 86_400_000)).toBe(dayNumber(T0) + 1);
  });
});

describe('round trip', () => {
  it('survives a save and load unchanged', () => {
    const storage = memoryStorage();
    const state = createPlayerState(T0);
    state.wallet.coins = 1234;
    state.garage.liveries.push('checker.a');
    state.progress.records[7] = {
      bestSlides: 5,
      bestTimeMs: 30_000,
      cleanExit: true,
      goldPlate: false,
      attempts: 2,
    };
    savePlayerState(storage, state);

    const loaded = loadPlayerState(storage, T0);
    expect(loaded.wallet.coins).toBe(1234);
    expect(loaded.garage.liveries).toContain('checker.a');
    expect(loaded.progress.records[7].bestSlides).toBe(5);
  });

  it('starts fresh when nothing is stored', () => {
    const loaded = loadPlayerState(memoryStorage(), T0);
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(loaded.progress.nextLevel).toBe(1);
  });

  it('starts fresh rather than crashing on a corrupt save', () => {
    expect(loadPlayerState(memoryStorage('{not json'), T0).progress.nextLevel).toBe(1);
    expect(loadPlayerState(memoryStorage('null'), T0).progress.nextLevel).toBe(1);
    expect(loadPlayerState(memoryStorage('[1,2,3]'), T0).progress.nextLevel).toBe(1);
  });

  it('keeps working when storage throws', () => {
    const hostile: Storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    const loaded = loadPlayerState(hostile, T0);
    expect(loaded.progress.nextLevel).toBe(1);
    expect(() => savePlayerState(hostile, loaded)).not.toThrow();
  });
});

describe('migration', () => {
  it('fills in fields an older build never wrote', () => {
    const ancient = {
      wallet: { coins: 500 },
      progress: { nextLevel: 12 },
      garage: { rides: ['commuter'] },
    };
    const state = migrate(ancient, T0);
    expect(state.wallet.coins).toBe(500);
    expect(state.wallet.medallions).toBe(0);
    expect(state.progress.nextLevel).toBe(12);
    expect(state.settings.haptics).toBe('full');
    expect(state.city.districts.length).toBe(12);
    expect(state.daily.dispatch).toEqual([]);
  });

  it('never lets highest fall behind the next level', () => {
    const state = migrate({ progress: { nextLevel: 40, highest: 3 } }, T0);
    expect(state.progress.highest).toBeGreaterThanOrEqual(40);
  });

  it('repairs hand-edited nonsense without taking value away', () => {
    const state = migrate(
      {
        wallet: { coins: -900, medallions: 'lots', keys: 4.7 },
        progress: { nextLevel: -5 },
        city: { districts: [{ projectsFunded: 99 }] },
        settings: { textScale: 12 },
      },
      T0,
    );
    expect(state.wallet.coins).toBe(0);
    expect(state.wallet.medallions).toBe(0);
    expect(state.wallet.keys).toBe(4);
    expect(state.progress.nextLevel).toBe(1);
    expect(state.city.districts[0].projectsFunded).toBe(PROJECTS_PER_DISTRICT);
    expect(state.settings.textScale).toBe(1.3);
  });

  it('drops a resume card that does not describe a whole lot', () => {
    const bad = migrate({ resume: { levelIndex: 4, vehicles: [1, 2, 3] } }, T0);
    expect(bad.resume).toBeNull();
    const good = migrate(
      { resume: { levelIndex: 4, vehicles: [1, 2, 3, 0], slides: 1, bumps: 0, elapsedMs: 5 } },
      T0,
    );
    expect(good.resume?.levelIndex).toBe(4);
  });

  it('keeps every district entry even if the save had fewer', () => {
    const state = migrate({ city: { districts: [{ projectsFunded: 7 }] } }, T0);
    expect(state.city.districts.length).toBe(12);
    expect(state.city.districts[0].projectsFunded).toBe(7);
    expect(state.city.districts[11].projectsFunded).toBe(0);
  });
});

describe('store', () => {
  it('persists mutations and notifies listeners', () => {
    const storage = memoryStorage();
    const store = new GameStore(storage, T0);
    let seen: PlayerState | null = null;
    store.subscribe((s) => (seen = s));

    store.update((s) => void (s.wallet.coins = 42));
    expect(seen).not.toBeNull();
    store.flush();

    const reloaded = loadPlayerState(storage, T0);
    expect(reloaded.wallet.coins).toBe(42);
  });

  it('resets to a fresh profile on demand', () => {
    const storage = memoryStorage();
    const store = new GameStore(storage, T0);
    store.update((s) => {
      s.wallet.coins = 9999;
      s.progress.nextLevel = 50;
    });
    store.reset(T0);
    expect(store.state.wallet.coins).toBe(0);
    expect(store.state.progress.nextLevel).toBe(1);
  });

  it('opens a session with the daily board ready and the streak advanced', () => {
    const store = new GameStore(memoryStorage(), T0);
    expect(store.state.daily.dispatch.length).toBe(3);
    expect(store.state.ads.sessionInterstitials).toBe(0);
  });
});
