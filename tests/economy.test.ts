import { beforeEach, describe, expect, it } from 'vitest';
import { bandForLevel } from '../src/core/campaign';
import { Rng } from '../src/core/rng';
import {
  advanceGreenLight,
  atCoinPinch,
  BOOSTER_PRICES,
  buildLandmark,
  buyBooster,
  canClaimCommute,
  claimCommute,
  claimDispatch,
  claimDispatchBonus,
  claimPassTier,
  CLEAN_RUN_MILESTONE,
  collectIncome,
  completedDistricts,
  exchangeMedallions,
  fundAllAffordable,
  fundProject,
  grantKeys,
  grantTickets,
  INCOME_CAP_HOURS,
  incomeRatePerHour,
  isDistrictComplete,
  KEY_CAP,
  levelCoins,
  liverySetBonus,
  MORNING_COMMUTE,
  OVERFLOW_COINS,
  passTier,
  pendingIncome,
  refreshDispatch,
  registerClear,
  rollTrunk,
  TICKET_CAP,
  TRUNK_ODDS,
  useBooster,
} from '../src/meta/economy';
import { DISTRICTS, LANDMARKS, PROJECTS_PER_DISTRICT } from '../src/meta/districts';
import { LIVERY_SETS } from '../src/meta/garage';
import { createPlayerState, PlayerState } from '../src/meta/save';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 7, 7, 12, 0, 0);

let state: PlayerState;

function completeDistrict(s: PlayerState, index: number): void {
  s.city.districts[index].projectsFunded = PROJECTS_PER_DISTRICT;
}

beforeEach(() => {
  state = createPlayerState(T0);
});

describe('city income', () => {
  it('pays nothing until a district is restored', () => {
    expect(incomeRatePerHour(state)).toBe(0);
    expect(pendingIncome(state, T0 + 2 * HOUR).coins).toBe(0);
  });

  it('accrues at the district rate and stops at the four-hour cap', () => {
    completeDistrict(state, 0); // Old Town, 12/h
    expect(incomeRatePerHour(state)).toBe(12);
    expect(pendingIncome(state, T0 + 2 * HOUR).coins).toBe(24);
    expect(pendingIncome(state, T0 + 4 * HOUR).coins).toBe(48);
    // Past the cap the meter stops: this is the habit metronome, not a faucet.
    expect(pendingIncome(state, T0 + 9 * HOUR).coins).toBe(48);
    expect(pendingIncome(state, T0 + 9 * HOUR).capped).toBe(true);
  });

  it('collects into the wallet and resets the clock', () => {
    completeDistrict(state, 0);
    const got = collectIncome(state, T0 + 3 * HOUR);
    expect(got).toBe(36);
    expect(state.wallet.coins).toBe(36);
    expect(pendingIncome(state, T0 + 3 * HOUR).coins).toBe(0);
  });

  it('doubles the rate, not the cap window', () => {
    completeDistrict(state, 0);
    state.income.doublerUntil = T0 + 4 * HOUR;
    const doubled = pendingIncome(state, T0 + 4 * HOUR);
    expect(doubled.coins).toBe(96); // 4 h at 24/h, still four hours of window
    expect(pendingIncome(state, T0 + 12 * HOUR).coins).toBe(96);
  });

  it('only doubles the hours the doubler was actually running', () => {
    completeDistrict(state, 0);
    state.income.doublerUntil = T0 + 1 * HOUR;
    expect(pendingIncome(state, T0 + 4 * HOUR).coins).toBe(48 + 12);
  });

  it('adds the completed-livery-set bonus, capped at ten per cent', () => {
    completeDistrict(state, 0);
    for (const set of LIVERY_SETS) state.garage.liveries.push(...set.pieces);
    expect(liverySetBonus(state)).toBeCloseTo(0.06, 5);
    expect(incomeRatePerHour(state)).toBeCloseTo(12 * 1.06, 5);
  });

  it('reaches the design total with every district restored', () => {
    for (let i = 0; i < DISTRICTS.length; i++) completeDistrict(state, i);
    expect(completedDistricts(state)).toBe(12);
    expect(incomeRatePerHour(state)).toBe(276);
    expect(INCOME_CAP_HOURS).toBe(4);
  });
});

describe('projects and landmarks', () => {
  it('starts the map part-restored, not at zero', () => {
    expect(state.city.districts[0].projectsFunded).toBe(4);
    expect(state.city.districts[1].projectsFunded).toBe(2);
  });

  it('refuses a project the player cannot afford and takes nothing', () => {
    const before = state.wallet.coins;
    const result = fundProject(state, 0);
    expect(result.funded).toBe(false);
    expect(state.wallet.coins).toBe(before);
    expect(state.city.districts[0].projectsFunded).toBe(4);
  });

  it('funds a project and completes the district on the last one', () => {
    state.wallet.coins = 100_000;
    let last = fundProject(state, 0);
    while (!last.districtComplete) last = fundProject(state, 0);
    expect(isDistrictComplete(state, 0)).toBe(true);
    // Completion pays the district reward exactly once.
    expect(state.wallet.medallions).toBe(20);
    expect(state.wallet.blueprints).toBe(1);
  });

  it('funds everything affordable in one tap and stops when broke', () => {
    state.wallet.coins = DISTRICTS[0].projects[4].cost + DISTRICTS[0].projects[5].cost;
    const funded = fundAllAffordable(state, 0);
    expect(funded.length).toBe(2);
    expect(state.city.districts[0].projectsFunded).toBe(6);
    expect(state.wallet.coins).toBe(0);
  });

  it('escalates project costs by district index', () => {
    const total = (i: number) => DISTRICTS[i].projects.reduce((a, p) => a + p.cost, 0);
    expect(total(0)).toBeLessThan(total(5));
    expect(total(5)).toBeLessThan(total(11));
    expect(total(11)).toBeGreaterThan(9000);
    // The last two projects carry ~40% of a district — the designed pinch.
    const d = DISTRICTS[5];
    const tail = d.projects[5].cost + d.projects[6].cost;
    expect(tail / total(5)).toBeGreaterThan(0.35);
    expect(tail / total(5)).toBeLessThan(0.45);
  });

  it('gates landmarks behind their district and blueprint cost', () => {
    const fountain = LANDMARKS[0];
    state.wallet.blueprints = 99;
    expect(buildLandmark(state, fountain.id)).toBe(false);
    completeDistrict(state, fountain.district);
    expect(buildLandmark(state, fountain.id)).toBe(true);
    expect(state.wallet.blueprints).toBe(99 - fountain.blueprints);
    // Never buildable twice.
    expect(buildLandmark(state, fountain.id)).toBe(false);
  });
});

describe('level rewards', () => {
  const clear = (levelIndex: number, over: Partial<Parameters<typeof registerClear>[1]> = {}) =>
    registerClear(state, {
      levelIndex,
      slides: 6,
      parSlides: 6,
      bumps: 0,
      vehicles: 6,
      durationMs: 40_000,
      ambulancesRescued: 0,
      trunks: 0,
      now: T0,
      ...over,
    });

  it('pays more for a stretch jam than a standard one', () => {
    expect(levelCoins(50, bandForLevel(50))).toBeGreaterThan(0);
    expect(levelCoins(100, 'hard' as never)).toBeGreaterThan(levelCoins(100, 'medium' as never));
  });

  it('banks coins, miles and a record', () => {
    const reward = clear(5);
    expect(state.wallet.coins).toBe(reward.coins);
    expect(state.wallet.miles).toBe(6);
    expect(state.progress.records[5].bestSlides).toBe(6);
    expect(state.progress.records[5].cleanExit).toBe(true);
    expect(state.progress.records[5].goldPlate).toBe(true);
  });

  it('advances the sequence but never rewinds it', () => {
    clear(5);
    expect(state.progress.nextLevel).toBe(6);
    clear(2); // replaying an earlier jam
    expect(state.progress.nextLevel).toBe(6);
  });

  it('keeps the best result across attempts', () => {
    clear(5, { slides: 9, durationMs: 80_000, bumps: 3 });
    clear(5, { slides: 6, durationMs: 40_000, bumps: 0 });
    expect(state.progress.records[5].bestSlides).toBe(6);
    expect(state.progress.records[5].bestTimeMs).toBe(40_000);
    expect(state.progress.records[5].cleanExit).toBe(true);
    expect(state.progress.records[5].attempts).toBe(2);
  });

  it('earns an Impound Key every five near-clean clears', () => {
    state.streaks.cleanRunMilestone = 0;
    for (let i = 0; i < CLEAN_RUN_MILESTONE - 1; i++) clear(10 + i, { bumps: 1 });
    expect(state.wallet.keys).toBe(0);
    const reward = clear(20, { bumps: 1 });
    expect(reward.keysEarned).toBe(1);
    expect(state.wallet.keys).toBe(1);
  });

  it('pauses the clean run on a messy clear without confiscating anything', () => {
    state.wallet.keys = 2;
    state.streaks.cleanRun = 4;
    clear(11, { bumps: 5 });
    expect(state.streaks.cleanRun).toBe(0);
    expect(state.wallet.keys).toBe(2); // nothing owned is ever removed
  });

  it('clears the resume card once the lot is finished', () => {
    state.resume = { levelIndex: 5, vehicles: [0, 0, 0, 0], slides: 1, bumps: 0, elapsedMs: 10 };
    clear(5);
    expect(state.resume).toBeNull();
  });
});

describe('mystery trunks', () => {
  it('publishes odds that sum to one hundred', () => {
    expect(TRUNK_ODDS.reduce((a, o) => a + o.weight, 0)).toBe(100);
  });

  it('always yields something of value', () => {
    for (let seed = 0; seed < 400; seed++) {
      const reward = rollTrunk(new Rng(seed));
      const hasValue =
        reward.coins > 0 || reward.miles > 0 || reward.booster !== null || reward.liveryId !== null;
      expect(hasValue, `seed ${seed} gave nothing`).toBe(true);
    }
  });

  it('matches the published distribution over many rolls', () => {
    const counts: Record<string, number> = {};
    for (let seed = 0; seed < 20_000; seed++) {
      const r = rollTrunk(new Rng(seed * 2654435761));
      counts[r.rarity] = (counts[r.rarity] ?? 0) + 1;
    }
    for (const odd of TRUNK_ODDS) {
      const share = ((counts[odd.rarity] ?? 0) / 20_000) * 100;
      expect(Math.abs(share - odd.weight), `${odd.rarity} at ${share.toFixed(1)}%`).toBeLessThan(2);
    }
  });
});

describe('instruments', () => {
  it('converts keys above the cap into coins rather than losing them', () => {
    state.wallet.keys = KEY_CAP;
    grantKeys(state, 3);
    expect(state.wallet.keys).toBe(KEY_CAP);
    expect(state.wallet.coins).toBe(3 * OVERFLOW_COINS);
  });

  it('does the same for transit tickets', () => {
    state.wallet.tickets = TICKET_CAP;
    grantTickets(state, 2);
    expect(state.wallet.tickets).toBe(TICKET_CAP);
    expect(state.wallet.coins).toBe(2 * OVERFLOW_COINS);
  });

  it('buys and spends boosters', () => {
    state.wallet.medallions = BOOSTER_PRICES.towHook;
    expect(buyBooster(state, 'towHook')).toBe(true);
    expect(buyBooster(state, 'towHook')).toBe(false); // out of Medallions
    expect(state.boosters.towHook).toBe(2);
    expect(useBooster(state, 'towHook')).toBe(true);
    expect(state.boosters.towHook).toBe(1);
  });

  it('exchanges Medallions to Coins one way only', () => {
    state.wallet.medallions = 10;
    expect(exchangeMedallions(state, 10)).toBe(true);
    expect(state.wallet.coins).toBe(150);
    expect(state.wallet.medallions).toBe(0);
    expect(exchangeMedallions(state, 1)).toBe(false);
  });
});

describe('daily systems', () => {
  it('claims the commute once a day and walks the board', () => {
    expect(canClaimCommute(state, T0)).toBe(true);
    const day1 = claimCommute(state, T0);
    expect(day1).toBe(MORNING_COMMUTE[0]);
    expect(state.wallet.coins).toBe(100);
    expect(claimCommute(state, T0)).toBeNull(); // same day
    const day2 = claimCommute(state, T0 + 26 * HOUR);
    expect(day2?.day).toBe(2);
  });

  it('wraps the seven-day board', () => {
    let now = T0;
    for (let i = 0; i < 7; i++) {
      claimCommute(state, now);
      now += 26 * HOUR;
    }
    expect(state.daily.commuteDay).toBe(1);
  });

  it('draws three distinct daily tasks and pays the completion bonus', () => {
    refreshDispatch(state, T0);
    expect(state.daily.dispatch.length).toBe(3);
    expect(new Set(state.daily.dispatch.map((t) => t.id)).size).toBe(3);

    for (const task of state.daily.dispatch) task.progress = task.goal;
    const before = state.wallet.coins;
    state.daily.dispatch.forEach((_, i) => claimDispatch(state, i));
    expect(claimDispatchBonus(state)).toBe(120);
    expect(state.wallet.coins).toBe(before + 40 * 3 + 120);
    expect(claimDispatchBonus(state)).toBe(0); // never twice
  });

  it('keeps the same three tasks across a refresh on the same day', () => {
    refreshDispatch(state, T0);
    const first = state.daily.dispatch.map((t) => t.label);
    refreshDispatch(state, T0 + 60_000);
    expect(state.daily.dispatch.map((t) => t.label)).toEqual(first);
  });
});

describe('green light streak', () => {
  it('lights a lamp for a consecutive day', () => {
    expect(advanceGreenLight(state, T0)).toBe('same');
    expect(advanceGreenLight(state, T0 + 25 * HOUR)).toBe('lit');
    expect(state.streaks.greenLight).toBe(2);
  });

  it('spends the weekly snow day on a single missed day', () => {
    expect(advanceGreenLight(state, T0 + 49 * HOUR)).toBe('snowDay');
    expect(state.streaks.snowDayAvailable).toBe(false);
    expect(state.streaks.greenLight).toBe(2);
  });

  it('pauses rather than resets after a longer lapse', () => {
    state.streaks.greenLight = 9;
    state.streaks.snowDayAvailable = false;
    expect(advanceGreenLight(state, T0 + 120 * HOUR)).toBe('paused');
    expect(state.streaks.greenLight).toBe(9); // paused, never zeroed
  });
});

describe('city pass', () => {
  it('tracks tiers at a hundred Miles each', () => {
    expect(passTier(0)).toBe(0);
    expect(passTier(250)).toBe(2);
    expect(passTier(999_999)).toBe(40);
  });

  it('claims each tier once and only when earned', () => {
    state.wallet.miles = 250;
    expect(claimPassTier(state, 3)).toBe(false); // not reached
    expect(claimPassTier(state, 2)).toBe(true);
    expect(claimPassTier(state, 2)).toBe(false); // already claimed
  });
});

describe('coin pinch', () => {
  it('flags the end-of-district deficit and clears once the player can afford it', () => {
    state.progress.highest = 40;
    state.city.districts[0].projectsFunded = 5;
    state.wallet.coins = 0;
    expect(atCoinPinch(state)).toBe(true);
    state.wallet.coins = 100_000;
    expect(atCoinPinch(state)).toBe(false);
  });

  it('never flags before the map exists', () => {
    state.progress.highest = 2;
    state.wallet.coins = 0;
    expect(atCoinPinch(state)).toBe(false);
  });
});
