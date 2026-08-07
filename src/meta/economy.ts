/**
 * The economy (GDD §5).
 *
 * Two currencies the player thinks in, four instruments with jobs, one season
 * meter, and deliberately no energy. Every function here is a pure-ish mutation
 * of PlayerState with an explicit `now`, so the whole economy is testable
 * without a clock.
 */

import { bandForLevel, chapterPosition, GATES } from '../core/campaign';
import { Rng } from '../core/rng';
import { Band } from '../core/types';
import { DISTRICTS, LANDMARKS, PROJECTS_PER_DISTRICT } from './districts';
import { LIVERY_SETS } from './garage';
import { BoosterId, dayStamp, DispatchTask, PlayerState } from './save';

export const INCOME_CAP_HOURS = 4;
/** Jams L1–L3 are the guided opening (GDD §3 Stage 2). */
export const TUTORIAL_LEVELS = 3;
export const MILES_PER_TIER = 100;
export const PASS_TIERS = 40;
export const CLEAN_RUN_MILESTONE = 5;
export const KEYS_PER_IMPOUND = 3;
export const KEY_CAP = 9;
export const TICKET_CAP = 5;
/** Value of a Key or Ticket banked beyond its cap — caps never destroy value. */
export const OVERFLOW_COINS = 100;

/* ------------------------------------------------------------------ *
 * City Income — the idle-lite drip
 * ------------------------------------------------------------------ */

export function isDistrictComplete(state: PlayerState, district: number): boolean {
  return state.city.districts[district].projectsFunded >= PROJECTS_PER_DISTRICT;
}

export function completedDistricts(state: PlayerState): number {
  return state.city.districts.filter((_, i) => isDistrictComplete(state, i)).length;
}

/** Completed livery sets add +2% each, capped at +10% (GDD §5). */
export function liverySetBonus(state: PlayerState): number {
  let sets = 0;
  for (const set of LIVERY_SETS) {
    if (set.pieces.every((p) => state.garage.liveries.includes(p))) sets++;
  }
  return Math.min(0.1, sets * 0.02);
}

export function incomeRatePerHour(state: PlayerState): number {
  let base = 0;
  for (let i = 0; i < DISTRICTS.length; i++) {
    if (isDistrictComplete(state, i)) base += DISTRICTS[i].incomeRate;
  }
  return base * (1 + liverySetBonus(state));
}

export interface PendingIncome {
  coins: number;
  hours: number;
  capped: boolean;
  ratePerHour: number;
  doublerActive: boolean;
}

export function pendingIncome(state: PlayerState, now: number): PendingIncome {
  const rate = incomeRatePerHour(state);
  const elapsedHours = Math.max(0, (now - state.income.lastCollectAt) / 3_600_000);
  const hours = Math.min(INCOME_CAP_HOURS, elapsedHours);
  const doublerActive = state.income.doublerUntil > state.income.lastCollectAt;
  // The doubler multiplies the *rate*, not the cap window — value without
  // schedule pressure (GDD §8).
  const doubledHours = doublerActive
    ? Math.min(hours, Math.max(0, (state.income.doublerUntil - state.income.lastCollectAt) / 3_600_000))
    : 0;
  const coins = Math.floor(rate * (hours + doubledHours));
  return {
    coins,
    hours,
    capped: elapsedHours >= INCOME_CAP_HOURS,
    ratePerHour: rate,
    doublerActive,
  };
}

export function collectIncome(state: PlayerState, now: number): number {
  const pending = pendingIncome(state, now);
  state.income.lastCollectAt = now;
  if (pending.coins > 0) state.wallet.coins += pending.coins;
  return pending.coins;
}

/** Comeback flow: honour a full extra cap window for a lapsed player (GDD §7). */
export function grantOverflowCrate(state: PlayerState, now: number): number {
  const bonus = Math.floor(incomeRatePerHour(state) * INCOME_CAP_HOURS);
  state.wallet.coins += bonus;
  state.boosters.towHook += 1;
  state.income.lastCollectAt = now;
  return bonus;
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export interface FundResult {
  funded: boolean;
  projectName: string;
  cost: number;
  districtComplete: boolean;
}

export function nextProject(state: PlayerState, district: number) {
  const funded = state.city.districts[district].projectsFunded;
  if (funded >= PROJECTS_PER_DISTRICT) return null;
  return DISTRICTS[district].projects[funded];
}

export function fundProject(state: PlayerState, district: number): FundResult {
  const project = nextProject(state, district);
  if (!project || state.wallet.coins < project.cost) {
    return {
      funded: false,
      projectName: project?.name ?? '',
      cost: project?.cost ?? 0,
      districtComplete: false,
    };
  }
  state.wallet.coins -= project.cost;
  const ds = state.city.districts[district];
  ds.projectsFunded++;

  const complete = ds.projectsFunded >= PROJECTS_PER_DISTRICT;
  if (complete && ds.completedAt === 0) {
    ds.completedAt = Date.now();
    state.wallet.medallions += 20;
    state.wallet.blueprints += 1;
  }
  return { funded: true, projectName: project.name, cost: project.cost, districtComplete: complete };
}

/** One-tap surplus conversion for players who ignore the map (GDD §10). */
export function fundAllAffordable(state: PlayerState, district: number): FundResult[] {
  const out: FundResult[] = [];
  for (;;) {
    const result = fundProject(state, district);
    if (!result.funded) break;
    out.push(result);
  }
  return out;
}

export function districtProgress(state: PlayerState, district: number): number {
  return state.city.districts[district].projectsFunded / PROJECTS_PER_DISTRICT;
}

export function canBuildLandmark(state: PlayerState, landmarkId: string): boolean {
  const def = LANDMARKS.find((l) => l.id === landmarkId);
  if (!def || state.city.landmarks.includes(landmarkId)) return false;
  return isDistrictComplete(state, def.district) && state.wallet.blueprints >= def.blueprints;
}

export function buildLandmark(state: PlayerState, landmarkId: string): boolean {
  if (!canBuildLandmark(state, landmarkId)) return false;
  const def = LANDMARKS.find((l) => l.id === landmarkId)!;
  state.wallet.blueprints -= def.blueprints;
  state.city.landmarks.push(landmarkId);
  return true;
}

/* ------------------------------------------------------------------ *
 * Level rewards
 * ------------------------------------------------------------------ */

/** Base clear payout: 30 Coins early rising to 60 by L100; stretch jams 1.5× (GDD §5). */
export function levelCoins(index: number, band: Band): number {
  const base = 30 + Math.min(30, (index / 100) * 30);
  const multiplier = band === Band.Hard ? 1.5 : band === Band.Showcase ? 1.75 : 1;
  return Math.round((base * multiplier) / 5) * 5;
}

export interface ClearInput {
  levelIndex: number;
  slides: number;
  parSlides: number;
  bumps: number;
  vehicles: number;
  durationMs: number;
  ambulancesRescued: number;
  trunks: number;
  now: number;
}

export interface ClearReward {
  coins: number;
  miles: number;
  blueprints: number;
  cleanExit: boolean;
  goldPlate: boolean;
  newRecord: boolean;
  keysEarned: number;
  trunkRewards: TrunkReward[];
  districtIndex: number;
  /** True on a chapter finale — the showcase jam that closes a district. */
  chapterComplete: boolean;
}

/**
 * Bank a cleared jam. This is the single place a level result turns into
 * currency, streaks, records and unlocks.
 */
export function registerClear(state: PlayerState, input: ClearInput): ClearReward {
  const band = bandForLevel(input.levelIndex);
  const { district, pos, size } = chapterPosition(input.levelIndex);

  const coins = levelCoins(input.levelIndex, band);
  const miles = input.vehicles; // 1 Mile per vehicle exited (GDD §5)
  const cleanExit = input.bumps === 0;
  const goldPlate = input.slides <= input.parSlides;

  const prior = state.progress.records[input.levelIndex];
  const newRecord = !prior || input.slides < prior.bestSlides || input.durationMs < prior.bestTimeMs;
  state.progress.records[input.levelIndex] = {
    bestSlides: Math.min(prior?.bestSlides ?? Infinity, input.slides),
    bestTimeMs: Math.min(prior?.bestTimeMs ?? Infinity, input.durationMs),
    cleanExit: (prior?.cleanExit ?? false) || cleanExit,
    goldPlate: (prior?.goldPlate ?? false) || goldPlate,
    attempts: (prior?.attempts ?? 0) + 1,
  };

  state.wallet.coins += coins;
  state.wallet.miles += miles;

  let blueprints = 0;
  // Showcase finales pay a Blueprint so the landmark cadence is play-driven.
  if (band === Band.Showcase && !prior) {
    blueprints += 1;
    state.wallet.blueprints += 1;
  }

  // Clean Run streak: ≤1 bump keeps it alive (GDD §5).
  let keysEarned = 0;
  if (input.bumps <= 1) {
    state.streaks.cleanRun++;
    state.streaks.cleanRunBest = Math.max(state.streaks.cleanRunBest, state.streaks.cleanRun);
    state.streaks.cleanRunMilestone++;
    if (state.streaks.cleanRunMilestone >= CLEAN_RUN_MILESTONE) {
      state.streaks.cleanRunMilestone = 0;
      keysEarned = 1;
      grantKeys(state, 1);
    }
  } else {
    // Breaking the streak *pauses* progress; it never confiscates (GDD §2).
    state.streaks.cleanRun = 0;
  }

  state.stats.jamsCleared++;
  state.stats.totalExits += input.vehicles;
  state.stats.bumps += input.bumps;
  state.stats.ambulancesRescued += input.ambulancesRescued;
  if (cleanExit) state.stats.cleanExits++;
  state.stats.playMs += input.durationMs;

  const trunkRewards: TrunkReward[] = [];
  for (let i = 0; i < input.trunks; i++) {
    trunkRewards.push(openTrunk(state, input.levelIndex * 1000 + i));
  }

  if (input.levelIndex >= state.progress.nextLevel) {
    state.progress.nextLevel = input.levelIndex + 1;
    state.progress.highest = Math.max(state.progress.highest, state.progress.nextLevel);
  }
  if (input.levelIndex >= TUTORIAL_LEVELS) state.flags.tutorialDone = true;
  state.resume = null;

  advanceDispatch(state, 'clear', 1);
  advanceDispatch(state, 'exits', input.vehicles);
  if (cleanExit) advanceDispatch(state, 'clean', 1);
  if (input.ambulancesRescued > 0) advanceDispatch(state, 'ambulance', input.ambulancesRescued);

  return {
    coins,
    miles,
    blueprints,
    cleanExit,
    goldPlate,
    newRecord,
    keysEarned,
    trunkRewards,
    districtIndex: district,
    chapterComplete: pos === size - 1,
  };
}

/* ------------------------------------------------------------------ *
 * Mystery Trunks — the variance point (GDD §2)
 * ------------------------------------------------------------------ */

export type TrunkRarity = 'coins' | 'booster' | 'miles' | 'shard' | 'livery';

export interface TrunkReward {
  rarity: TrunkRarity;
  label: string;
  coins: number;
  miles: number;
  booster: BoosterId | null;
  liveryId: string | null;
  doubled: boolean;
}

/** Published odds — trunks are play-earned and never purchasable (GDD §8). */
export const TRUNK_ODDS: ReadonlyArray<{ rarity: TrunkRarity; weight: number; label: string }> = [
  { rarity: 'coins', weight: 60, label: 'Coin bundle' },
  { rarity: 'booster', weight: 20, label: 'Booster' },
  { rarity: 'miles', weight: 12, label: 'Pass Miles' },
  { rarity: 'shard', weight: 6, label: 'Livery shard' },
  { rarity: 'livery', weight: 2, label: 'Full livery' },
];

export function rollTrunk(rng: Rng): TrunkReward {
  const entry = rng.weighted(
    TRUNK_ODDS.map((o) => o),
    TRUNK_ODDS.map((o) => o.weight),
  );
  switch (entry.rarity) {
    case 'coins':
      return reward(entry.label, { coins: rng.range(8, 24) * 5 });
    case 'booster':
      return reward(entry.label, {
        booster: rng.pick<BoosterId>(['towHook', 'dispatcher', 'greenWave', 'gripTires']),
      });
    case 'miles':
      return reward(entry.label, { miles: rng.range(4, 12) * 10 });
    case 'shard':
      return reward('Livery shard', { coins: 150, miles: 40 });
    default: {
      const set = rng.pick(LIVERY_SETS);
      return reward('Full livery', { liveryId: rng.pick(set.pieces) });
    }
  }

  function reward(label: string, patch: Partial<TrunkReward>): TrunkReward {
    return {
      rarity: entry.rarity,
      label,
      coins: 0,
      miles: 0,
      booster: null,
      liveryId: null,
      doubled: false,
      ...patch,
    };
  }
}

export function applyTrunk(state: PlayerState, reward: TrunkReward): void {
  const factor = reward.doubled ? 2 : 1;
  state.wallet.coins += reward.coins * factor;
  state.wallet.miles += reward.miles * factor;
  if (reward.booster) state.boosters[reward.booster] += factor;
  if (reward.liveryId && !state.garage.liveries.includes(reward.liveryId)) {
    state.garage.liveries.push(reward.liveryId);
  }
  state.stats.trunksOpened++;
}

export function openTrunk(state: PlayerState, seed: number): TrunkReward {
  const reward = rollTrunk(new Rng(seed ^ state.stats.trunksOpened * 2654435761));
  applyTrunk(state, reward);
  return reward;
}

/* ------------------------------------------------------------------ *
 * Instruments
 * ------------------------------------------------------------------ */

/** Keys above the cap convert to Coins rather than evaporating (GDD §5). */
export function grantKeys(state: PlayerState, n: number): void {
  const room = Math.max(0, KEY_CAP - state.wallet.keys);
  const kept = Math.min(n, room);
  state.wallet.keys += kept;
  state.wallet.coins += (n - kept) * OVERFLOW_COINS;
}

export function grantTickets(state: PlayerState, n: number): void {
  const room = Math.max(0, TICKET_CAP - state.wallet.tickets);
  const kept = Math.min(n, room);
  state.wallet.tickets += kept;
  state.wallet.coins += (n - kept) * OVERFLOW_COINS;
}

export const BOOSTER_PRICES: Readonly<Record<BoosterId, number>> = {
  towHook: 25,
  dispatcher: 15,
  greenWave: 20,
  gripTires: 20,
};

export function buyBooster(state: PlayerState, id: BoosterId): boolean {
  const price = BOOSTER_PRICES[id];
  if (state.wallet.medallions < price) return false;
  state.wallet.medallions -= price;
  state.boosters[id]++;
  return true;
}

export function useBooster(state: PlayerState, id: BoosterId): boolean {
  if (state.boosters[id] <= 0) return false;
  state.boosters[id]--;
  return true;
}

/** One-way faucet for payers; Coins never convert back (GDD §5). */
export function exchangeMedallions(state: PlayerState, medallions: number): boolean {
  if (medallions <= 0 || state.wallet.medallions < medallions) return false;
  state.wallet.medallions -= medallions;
  state.wallet.coins += medallions * 15;
  return true;
}

/* ------------------------------------------------------------------ *
 * Daily systems
 * ------------------------------------------------------------------ */

export interface CommuteDay {
  day: number;
  label: string;
  apply: (state: PlayerState) => void;
}

export const MORNING_COMMUTE: readonly CommuteDay[] = [
  { day: 1, label: '100 Coins', apply: (s) => void (s.wallet.coins += 100) },
  {
    day: 2,
    label: '150 Coins + 2 Medallions',
    apply: (s) => {
      s.wallet.coins += 150;
      s.wallet.medallions += 2;
    },
  },
  { day: 3, label: '1 Dispatcher Call', apply: (s) => void s.boosters.dispatcher++ },
  { day: 4, label: '200 Coins', apply: (s) => void (s.wallet.coins += 200) },
  {
    day: 5,
    label: '3 Medallions + 100 Coins',
    apply: (s) => {
      s.wallet.medallions += 3;
      s.wallet.coins += 100;
    },
  },
  { day: 6, label: '1 Green Wave', apply: (s) => void s.boosters.greenWave++ },
  {
    day: 7,
    label: '1 Tow Hook + 300 Coins + 5 Medallions',
    apply: (s) => {
      s.boosters.towHook++;
      s.wallet.coins += 300;
      s.wallet.medallions += 5;
    },
  },
];

export function canClaimCommute(state: PlayerState, now: number): boolean {
  return state.daily.commuteClaimedOn !== dayStamp(now);
}

export function claimCommute(state: PlayerState, now: number): CommuteDay | null {
  if (!canClaimCommute(state, now)) return null;
  const entry = MORNING_COMMUTE[(state.daily.commuteDay - 1) % MORNING_COMMUTE.length];
  entry.apply(state);
  state.daily.commuteClaimedOn = dayStamp(now);
  state.daily.commuteDay = (state.daily.commuteDay % MORNING_COMMUTE.length) + 1;
  return entry;
}

const DISPATCH_POOL: ReadonlyArray<{ id: string; label: string; goal: number }> = [
  { id: 'clear', label: 'Clear 5 jams', goal: 5 },
  { id: 'clean', label: 'Land 3 Clean Exits', goal: 3 },
  { id: 'ambulance', label: 'Rescue 1 ambulance', goal: 1 },
  { id: 'fund', label: 'Fund a district project', goal: 1 },
  { id: 'exits', label: 'Send 40 cars home', goal: 40 },
  { id: 'clear', label: 'Clear 3 jams', goal: 3 },
  { id: 'clean', label: 'Land 1 Clean Exit', goal: 1 },
  { id: 'fund', label: 'Fund 2 district projects', goal: 2 },
];

/** Three tasks a day, drawn deterministically so a refresh cannot re-roll them. */
export function refreshDispatch(state: PlayerState, now: number): void {
  const stamp = dayStamp(now);
  if (state.daily.dispatchDate === stamp && state.daily.dispatch.length > 0) return;
  const rng = new Rng(hash(stamp) ^ 0x5f3759df);
  const pool = rng.shuffle(DISPATCH_POOL.slice());
  const picked: DispatchTask[] = [];
  const usedIds = new Set<string>();
  for (const task of pool) {
    if (usedIds.has(task.id)) continue;
    usedIds.add(task.id);
    picked.push({ ...task, progress: 0, claimed: false });
    if (picked.length === 3) break;
  }
  state.daily.dispatchDate = stamp;
  state.daily.dispatch = picked;
  state.daily.dispatchBonusClaimed = false;
}

export function advanceDispatch(state: PlayerState, id: string, amount: number): void {
  for (const task of state.daily.dispatch) {
    if (task.id !== id || task.progress >= task.goal) continue;
    task.progress = Math.min(task.goal, task.progress + amount);
  }
}

export function claimDispatch(state: PlayerState, index: number): number {
  const task = state.daily.dispatch[index];
  if (!task || task.claimed || task.progress < task.goal) return 0;
  task.claimed = true;
  state.wallet.coins += 40;
  state.wallet.miles += 10;
  return 40;
}

export function claimDispatchBonus(state: PlayerState): number {
  if (state.daily.dispatchBonusClaimed) return 0;
  if (!state.daily.dispatch.every((t) => t.claimed)) return 0;
  state.daily.dispatchBonusClaimed = true;
  state.wallet.coins += 120;
  state.wallet.miles += 30;
  return 120;
}

/**
 * Green Light Streak with forgiveness (GDD §7): one automatic Snow Day per
 * week absorbs a missed day, and a second miss *pauses* the count rather than
 * resetting it. Nothing earned is ever removed.
 */
export function advanceGreenLight(state: PlayerState, now: number): 'same' | 'lit' | 'snowDay' | 'paused' {
  const today = dayStamp(now);
  if (state.streaks.lastPlayDay === today) return 'same';

  const gapDays = Math.max(
    1,
    Math.round((startOfDay(now) - startOfDayStamp(state.streaks.lastPlayDay)) / 86_400_000),
  );
  state.streaks.lastPlayDay = today;

  if (gapDays === 1) {
    state.streaks.greenLight++;
    state.streaks.greenLightBest = Math.max(state.streaks.greenLightBest, state.streaks.greenLight);
    if (state.streaks.greenLight % 7 === 0) {
      state.wallet.medallions += 10;
      state.boosters.dispatcher++;
      state.streaks.snowDayAvailable = true;
    }
    return 'lit';
  }
  if (gapDays === 2 && state.streaks.snowDayAvailable) {
    state.streaks.snowDayAvailable = false;
    state.streaks.greenLight++;
    state.streaks.greenLightBest = Math.max(state.streaks.greenLightBest, state.streaks.greenLight);
    return 'snowDay';
  }
  return 'paused';
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function startOfDayStamp(stamp: string): number {
  const [y, m, d] = stamp.split('-').map(Number);
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d).getTime();
}

function hash(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------ *
 * City Pass
 * ------------------------------------------------------------------ */

export function passTier(miles: number): number {
  return Math.min(PASS_TIERS, Math.floor(miles / MILES_PER_TIER));
}

export function passProgressInTier(miles: number): number {
  return (miles % MILES_PER_TIER) / MILES_PER_TIER;
}

export interface PassTierReward {
  tier: number;
  free: string;
  premium: string;
}

export function passRewards(tier: number): PassTierReward {
  const free =
    tier % 10 === 0
      ? '25 Medallions'
      : tier % 5 === 0
        ? '1 Booster'
        : tier % 3 === 0
          ? '10 Medallions'
          : '120 Coins';
  const premium =
    tier === PASS_TIERS
      ? 'Season Ride'
      : tier % 10 === 0
        ? 'Livery piece'
        : tier % 4 === 0
          ? 'Horn voice'
          : '250 Coins';
  return { tier, free, premium };
}

export function claimPassTier(state: PlayerState, tier: number): boolean {
  if (tier < 1 || tier > passTier(state.wallet.miles)) return false;
  if (state.pass.claimedTiers.includes(tier)) return false;
  state.pass.claimedTiers.push(tier);
  const reward = passRewards(tier);
  applyPassReward(state, reward.free);
  if (state.pass.premium) applyPassReward(state, reward.premium);
  return true;
}

function applyPassReward(state: PlayerState, label: string): void {
  if (label.endsWith('Coins')) state.wallet.coins += parseInt(label, 10);
  else if (label.endsWith('Medallions')) state.wallet.medallions += parseInt(label, 10);
  else if (label === '1 Booster') state.boosters.towHook++;
  else if (label === 'Livery piece') {
    const owned = new Set(state.garage.liveries);
    const next = LIVERY_SETS.flatMap((s) => s.pieces).find((p) => !owned.has(p));
    if (next) state.garage.liveries.push(next);
    else state.wallet.medallions += 25;
  }
}

/* ------------------------------------------------------------------ *
 * Pinch detection (GDD §5 / §8: relevance beats schedule)
 * ------------------------------------------------------------------ */

/**
 * True when the player is at an end-of-district coin pinch — the moment the
 * Depot Doubler and the starter pack genuinely earn their keep. Bridgeable by
 * play alone within 36 hours, by policy.
 */
export function atCoinPinch(state: PlayerState): boolean {
  if (state.progress.highest < GATES.cityMap) return false;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const funded = state.city.districts[i].projectsFunded;
    if (funded === 0 || funded >= PROJECTS_PER_DISTRICT) continue;
    const remaining = DISTRICTS[i].projects
      .slice(funded)
      .reduce((sum, project) => sum + project.cost, 0);
    if (remaining > state.wallet.coins * 1.4) return true;
  }
  return false;
}
