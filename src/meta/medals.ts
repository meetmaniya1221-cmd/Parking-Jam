/**
 * Service Medals (GDD §7 "Achievements").
 *
 * Ribbon-tiered careers that only ever advance. They are the slow meter for the
 * mastery archetype: something always inching forward behind the daily loop,
 * paying Medallions at each tier and never taking anything back.
 */

import { PlayerState } from './save';

export type MedalTier = 'bronze' | 'silver' | 'gold';

export interface MedalDef {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  /** Bronze, silver and gold thresholds. */
  tiers: readonly [number, number, number];
  /** Current career total for this medal. */
  value: (state: PlayerState) => number;
}

/** Medallions paid for reaching each tier. */
export const MEDAL_PAYOUT: Readonly<Record<MedalTier, number>> = {
  bronze: 5,
  silver: 15,
  gold: 40,
};

export const MEDALS: readonly MedalDef[] = [
  {
    id: 'exits',
    name: 'Cars Sent Home',
    icon: '🚗',
    blurb: 'Every vehicle you have put back on the street.',
    tiers: [100, 1000, 10000],
    value: (s) => s.stats.totalExits,
  },
  {
    id: 'clean',
    name: 'Clean Exits',
    icon: '✨',
    blurb: 'Lots cleared without a single bump.',
    tiers: [10, 100, 500],
    value: (s) => s.stats.cleanExits,
  },
  {
    id: 'jams',
    name: 'Jams Cleared',
    icon: '🧩',
    blurb: 'Knots read and untied.',
    tiers: [25, 200, 1000],
    value: (s) => s.stats.jamsCleared,
  },
  {
    id: 'ambulance',
    name: 'Ambulance Rescues',
    icon: '🚑',
    blurb: 'Rescue windows made, not missed.',
    tiers: [5, 40, 200],
    value: (s) => s.stats.ambulancesRescued,
  },
  {
    id: 'districts',
    name: 'Districts Restored',
    icon: '🏙️',
    blurb: 'Meridian, coming back to life.',
    tiers: [1, 5, 12],
    value: (s) => s.city.districts.filter((d) => d.completedAt > 0).length,
  },
  {
    id: 'landmarks',
    name: 'Landmarks Built',
    icon: '🏛️',
    blurb: 'The trophy case, filling up.',
    tiers: [1, 4, 8],
    value: (s) => s.city.landmarks.length,
  },
  {
    id: 'plates',
    name: 'Gold Plates',
    icon: '🏅',
    blurb: 'Jams re-cleared at par slides.',
    tiers: [5, 50, 200],
    value: (s) => Object.values(s.progress.records).filter((r) => r.goldPlate).length,
  },
  {
    id: 'rush',
    name: 'Rush Hour Clears',
    icon: '⏱️',
    blurb: 'One attempt a day, taken.',
    tiers: [1, 15, 75],
    value: (s) => s.rush.clears,
  },
];

export interface MedalProgress {
  def: MedalDef;
  value: number;
  /** Highest tier reached, or null. */
  tier: MedalTier | null;
  /** Threshold of the next tier, or null when the medal is gold. */
  next: number | null;
  /** 0–1 toward the next tier (1 when gold). */
  fraction: number;
  /** Tiers earned but not yet collected. */
  unclaimed: MedalTier[];
}

const TIER_ORDER: readonly MedalTier[] = ['bronze', 'silver', 'gold'];

export function medalProgress(state: PlayerState, def: MedalDef): MedalProgress {
  const value = def.value(state);
  let tierIndex = -1;
  for (let i = 0; i < def.tiers.length; i++) if (value >= def.tiers[i]) tierIndex = i;

  const next = tierIndex + 1 < def.tiers.length ? def.tiers[tierIndex + 1] : null;
  const floor = tierIndex >= 0 ? def.tiers[tierIndex] : 0;
  const fraction = next === null ? 1 : Math.min(1, (value - floor) / (next - floor));

  const claimed = state.medals[def.id] ?? [];
  const unclaimed = TIER_ORDER.slice(0, tierIndex + 1).filter((t) => !claimed.includes(t));

  return {
    def,
    value,
    tier: tierIndex >= 0 ? TIER_ORDER[tierIndex] : null,
    next,
    fraction,
    unclaimed,
  };
}

/** Collect every tier earned on a medal. Returns the Medallions paid. */
export function claimMedal(state: PlayerState, id: string): number {
  const def = MEDALS.find((m) => m.id === id);
  if (!def) return 0;
  const progress = medalProgress(state, def);
  if (progress.unclaimed.length === 0) return 0;

  const claimed = (state.medals[id] ??= []);
  let paid = 0;
  for (const tier of progress.unclaimed) {
    claimed.push(tier);
    paid += MEDAL_PAYOUT[tier];
  }
  state.wallet.medallions += paid;
  return paid;
}

/** Commissioner rank fills from every ribbon at once (GDD §7). */
export function commissionerRank(state: PlayerState): { rank: number; fraction: number } {
  let earned = 0;
  for (const def of MEDALS) {
    const progress = medalProgress(state, def);
    earned += TIER_ORDER.indexOf(progress.tier ?? ('bronze' as MedalTier)) + (progress.tier ? 1 : 0);
  }
  const total = MEDALS.length * TIER_ORDER.length;
  return { rank: Math.floor((earned / total) * 10), fraction: earned / total };
}
