/**
 * Player state and persistence.
 *
 * The shape mirrors GDD §15's `PlayerState`. Saving is synchronous and
 * debounced; every system writes through `mutate` so a crash mid-session never
 * costs more than the current frame. Loading is defensive: an unknown or
 * corrupt save yields a fresh profile rather than a broken one.
 */

import { DISTRICTS, ENDOWED_PROJECTS, PROJECTS_PER_DISTRICT } from './districts';

export const SAVE_KEY = 'gridlock-city:save:v1';
export const SAVE_VERSION = 1;

export interface LevelRecord {
  /** Fewest slides used on a clear. */
  bestSlides: number;
  bestTimeMs: number;
  /** Cleared with zero bumps at least once. */
  cleanExit: boolean;
  /** Re-cleared at par slides (GDD §3 Stage 7). */
  goldPlate: boolean;
  attempts: number;
}

export interface Wallet {
  coins: number;
  medallions: number;
  keys: number;
  tickets: number;
  blueprints: number;
  miles: number;
}

export interface DistrictState {
  projectsFunded: number;
  /** Timestamp of completion, 0 while unfinished. */
  completedAt: number;
  /** True once the player has watched the restoration timelapse. */
  timelapseSeen: boolean;
}

export interface Boosters {
  towHook: number;
  dispatcher: number;
  greenWave: number;
  gripTires: number;
}

export type BoosterId = keyof Boosters;

export interface Settings {
  music: boolean;
  sfx: boolean;
  ambience: boolean;
  /** 'full' | 'key' | 'off' (GDD §14 accessibility). */
  haptics: 'full' | 'key' | 'off';
  reducedMotion: boolean;
  /** 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia'. */
  colorblind: 'off' | 'deuteranopia' | 'protanopia' | 'tritanopia';
  highContrast: boolean;
  leftHanded: boolean;
  calmHonks: boolean;
  /** Body text scale, 1.0–1.3. */
  textScale: number;
}

export interface DispatchTask {
  id: string;
  label: string;
  goal: number;
  progress: number;
  claimed: boolean;
}

export interface ResumeState {
  levelIndex: number;
  /** Serialised vehicle placements: [x, y, facing, gone] per vehicle. */
  vehicles: number[];
  slides: number;
  bumps: number;
  elapsedMs: number;
}

export interface PlayerState {
  version: number;
  createdAt: number;
  lastSeenAt: number;

  wallet: Wallet;
  boosters: Boosters;

  progress: {
    /** Next jam in the sequence. */
    nextLevel: number;
    /** Highest level ever reached; drives every unlock gate. */
    highest: number;
    records: Record<number, LevelRecord>;
  };

  city: {
    districts: DistrictState[];
    landmarks: string[];
  };

  garage: {
    rides: string[];
    liveries: string[];
    horns: string[];
    equipped: { ride: string; livery: string; horn: string };
  };

  streaks: {
    greenLight: number;
    greenLightBest: number;
    snowDayAvailable: boolean;
    lastPlayDay: string;
    cleanRun: number;
    cleanRunBest: number;
    /** Progress toward the next Impound Key, 0–4. */
    cleanRunMilestone: number;
  };

  income: {
    lastCollectAt: number;
    /** Epoch ms until which the Depot Doubler is active. */
    doublerUntil: number;
  };

  daily: {
    /** 1–7 position on the Morning Commute board. */
    commuteDay: number;
    commuteClaimedOn: string;
    dispatchDate: string;
    dispatch: DispatchTask[];
    dispatchBonusClaimed: boolean;
  };

  rush: {
    lastAttemptDay: string;
    clears: number;
    attempts: number;
  };

  /** Service Medal tiers already collected, keyed by medal id. */
  medals: Record<string, string[]>;

  pass: {
    season: number;
    claimedTiers: number[];
    premium: boolean;
  };

  stats: {
    jamsCleared: number;
    totalExits: number;
    cleanExits: number;
    bumps: number;
    ambulancesRescued: number;
    trunksOpened: number;
    playMs: number;
  };

  ads: {
    noAds: boolean;
    lastInterstitialAt: number;
    sessionInterstitials: number;
    /** Day-stamp of the last free Tow Hook claim (1/day cap). */
    towHookDay: string;
    doublerDay: string;
    doublerUses: number;
    /** Epoch ms until which any interstitial is suppressed (IAP holiday). */
    adHolidayUntil: number;
  };

  resume: ResumeState | null;

  flags: {
    /** True once the three tutorial jams are behind the player. */
    tutorialDone: boolean;
    /** Suppresses the guided-hand prompts once the player moves unprompted. */
    tutorialSelfDriven: boolean;
    /** True once the first district timelapse has played. */
    seenTimelapse: boolean;
  };

  settings: Settings;
}

export function dayStamp(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Days since the epoch — the seed for Rush Hour and Overtime rotations. */
export function dayNumber(now: number): number {
  const d = new Date(now);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

export function defaultSettings(): Settings {
  const prefersReduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    music: true,
    sfx: true,
    ambience: true,
    haptics: 'full',
    reducedMotion: prefersReduced,
    colorblind: 'off',
    highContrast: false,
    leftHanded: false,
    calmHonks: false,
    textScale: 1,
  };
}

export function createPlayerState(now: number = Date.now()): PlayerState {
  return {
    version: SAVE_VERSION,
    createdAt: now,
    lastSeenAt: now,
    wallet: { coins: 0, medallions: 0, keys: 0, tickets: 3, blueprints: 0, miles: 0 },
    boosters: { towHook: 1, dispatcher: 1, greenWave: 0, gripTires: 0 },
    progress: { nextLevel: 1, highest: 1, records: {} },
    city: {
      districts: DISTRICTS.map((_, i) => ({
        projectsFunded: ENDOWED_PROJECTS[i] ?? 0,
        completedAt: 0,
        timelapseSeen: false,
      })),
      landmarks: [],
    },
    garage: {
      // Endowed Progress again: the starter Ride and one livery are already owned.
      rides: ['commuter'],
      liveries: ['factory'],
      horns: ['chirp'],
      equipped: { ride: 'commuter', livery: 'factory', horn: 'chirp' },
    },
    streaks: {
      greenLight: 1,
      greenLightBest: 1,
      snowDayAvailable: true,
      lastPlayDay: dayStamp(now),
      cleanRun: 0,
      cleanRunBest: 0,
      // The tutorial's guided clear counts, so the streak opens at 1/5.
      cleanRunMilestone: 1,
    },
    income: { lastCollectAt: now, doublerUntil: 0 },
    daily: {
      commuteDay: 1,
      commuteClaimedOn: '',
      dispatchDate: '',
      dispatch: [],
      dispatchBonusClaimed: false,
    },
    rush: { lastAttemptDay: '', clears: 0, attempts: 0 },
    medals: {},
    pass: { season: 1, claimedTiers: [], premium: false },
    stats: {
      jamsCleared: 0,
      totalExits: 0,
      cleanExits: 0,
      bumps: 0,
      ambulancesRescued: 0,
      trunksOpened: 0,
      playMs: 0,
    },
    ads: {
      noAds: false,
      lastInterstitialAt: 0,
      sessionInterstitials: 0,
      towHookDay: '',
      doublerDay: '',
      doublerUses: 0,
      adHolidayUntil: 0,
    },
    resume: null,
    flags: {
      tutorialDone: false,
      tutorialSelfDriven: false,
      seenTimelapse: false,
    },
    settings: defaultSettings(),
  };
}

/**
 * Fold a loaded save onto a fresh one so a save written by an older build never
 * arrives missing a field. Nothing owned is ever dropped (GDD §15).
 */
export function migrate(raw: unknown, now: number = Date.now()): PlayerState {
  const base = createPlayerState(now);
  if (!raw || typeof raw !== 'object') return base;
  const saved = raw as Partial<PlayerState>;

  const merged: PlayerState = {
    ...base,
    ...saved,
    version: SAVE_VERSION,
    wallet: { ...base.wallet, ...saved.wallet },
    boosters: { ...base.boosters, ...saved.boosters },
    progress: { ...base.progress, ...saved.progress, records: saved.progress?.records ?? {} },
    city: {
      districts: DISTRICTS.map((_, i) => ({
        ...base.city.districts[i],
        ...saved.city?.districts?.[i],
      })),
      landmarks: saved.city?.landmarks ?? [],
    },
    garage: {
      ...base.garage,
      ...saved.garage,
      equipped: { ...base.garage.equipped, ...saved.garage?.equipped },
    },
    streaks: { ...base.streaks, ...saved.streaks },
    income: { ...base.income, ...saved.income },
    daily: { ...base.daily, ...saved.daily, dispatch: saved.daily?.dispatch ?? [] },
    rush: { ...base.rush, ...saved.rush },
    medals: saved.medals ?? {},
    pass: { ...base.pass, ...saved.pass, claimedTiers: saved.pass?.claimedTiers ?? [] },
    stats: { ...base.stats, ...saved.stats },
    ads: { ...base.ads, ...saved.ads },
    resume: saved.resume ?? null,
    flags: { ...base.flags, ...saved.flags },
    settings: { ...base.settings, ...saved.settings },
  };

  return clamp(merged);
}

/** Defend against hand-edited or truncated saves without ever taking value away. */
function clamp(s: PlayerState): PlayerState {
  const nonNegative = (n: unknown, fallback = 0) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;

  for (const key of Object.keys(s.wallet) as Array<keyof Wallet>) {
    s.wallet[key] = nonNegative(s.wallet[key]);
  }
  for (const key of Object.keys(s.boosters) as Array<keyof Boosters>) {
    s.boosters[key] = nonNegative(s.boosters[key]);
  }
  s.progress.nextLevel = Math.max(1, nonNegative(s.progress.nextLevel, 1));
  s.progress.highest = Math.max(s.progress.nextLevel, nonNegative(s.progress.highest, 1));
  for (const d of s.city.districts) {
    d.projectsFunded = Math.min(PROJECTS_PER_DISTRICT, nonNegative(d.projectsFunded));
  }
  s.settings.textScale = Math.min(1.3, Math.max(1, Number(s.settings.textScale) || 1));
  if (s.resume && (!Array.isArray(s.resume.vehicles) || s.resume.vehicles.length % 4 !== 0)) {
    s.resume = null;
  }
  return s;
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage when available; an in-memory shim otherwise (private mode, SSR, tests). */
export function resolveStorage(): Storage {
  try {
    const probe = '__gridlock_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const map = new Map<string, string>();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  }
}

export function loadPlayerState(storage: Storage, now: number = Date.now()): PlayerState {
  try {
    const raw = storage.getItem(SAVE_KEY);
    if (!raw) return createPlayerState(now);
    return migrate(JSON.parse(raw), now);
  } catch {
    return createPlayerState(now);
  }
}

export function savePlayerState(storage: Storage, state: PlayerState): void {
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked quota must never break play; the session simply
    // continues in memory.
  }
}
