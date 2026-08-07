/**
 * Meridian — the twelve districts of the City Rebuild meta (GDD §10).
 *
 * One clean pipe: jams → Coins → projects → timelapse → income → return trip.
 * Everything here is data; the economy module owns the rules.
 */

export interface ProjectDef {
  id: string;
  name: string;
  cost: number;
}

export interface DistrictDef {
  id: string;
  name: string;
  /** Coins per hour once fully restored (GDD §5: 12, 14, then +2 each). */
  incomeRate: number;
  /** City Radio station unlocked by restoring the district (GDD §13). */
  station: string;
  /** One-line sensory leak shown while the district is still fogged. */
  tease: string;
  /** Base hue for the district's map tile and radio card. */
  hue: number;
  projects: ProjectDef[];
}

/** Seven projects per district; the last two cost ~40% of the total (GDD §5). */
const PROJECT_WEIGHTS = [0.09, 0.1, 0.11, 0.13, 0.17, 0.18, 0.22];

interface DistrictSeed {
  id: string;
  name: string;
  station: string;
  tease: string;
  hue: number;
  /** Overrides for projects 3 and 7 — the district's signature work. */
  signature: string;
  finale: string;
}

const SEEDS: readonly DistrictSeed[] = [
  {
    id: 'oldTown',
    name: 'Old Town',
    station: 'Old Town AM',
    tease: 'A shutter rattling somewhere down the lane.',
    hue: 28,
    signature: 'Reopen the corner bakery',
    finale: 'Relight the clocktower',
  },
  {
    id: 'riverside',
    name: 'Riverside',
    station: 'Riverside FM',
    tease: 'Water slapping stone, and a rowlock creaking.',
    hue: 196,
    signature: 'Rebuild the boathouse ramp',
    finale: 'Turn the fountain back on',
  },
  {
    id: 'marketQuarter',
    name: 'Market Quarter',
    station: 'Market Quarter Funk Hour',
    tease: 'A faint sizzle, and lantern light through the fog.',
    hue: 12,
    signature: 'Restock the spice arcade',
    finale: 'String the night market lanterns',
  },
  {
    id: 'tramwayJunction',
    name: 'Tramway Junction',
    station: 'Junction Bell',
    tease: 'A tram bell, muffled, two streets over.',
    hue: 46,
    signature: 'Re-lay the depot points',
    finale: 'Run the first tram in nine years',
  },
  {
    id: 'harborfront',
    name: 'Harborfront',
    station: 'Harborfront Slow Wave',
    tease: 'A gull, a foghorn, rope knocking on a mast.',
    hue: 205,
    signature: 'Reopen the fish market',
    finale: 'Relight the lighthouse',
  },
  {
    id: 'gasworksRow',
    name: 'Gasworks Row',
    station: 'Gasworks Static',
    tease: 'Something enormous ticking as it cools.',
    hue: 264,
    signature: 'Reopen the foundry canteen',
    finale: 'Raise the gasholder frame',
  },
  {
    id: 'lanternHill',
    name: 'Lantern Hill',
    station: 'Lantern Hill Nocturne',
    tease: 'Paper lanterns knocking together in the dark.',
    hue: 340,
    signature: 'Reopen the hillside teahouse',
    finale: 'Light the lantern stair',
  },
  {
    id: 'theVerge',
    name: 'The Verge',
    station: 'Verge Radio',
    tease: 'Wheels on concrete, a long way off.',
    hue: 150,
    signature: 'Restock the garden centre',
    finale: 'Re-pour the skate bowl',
  },
  {
    id: 'foundryFlats',
    name: 'Foundry Flats',
    station: 'Foundry Shift',
    tease: 'A shift whistle nobody answered.',
    hue: 18,
    signature: "Reopen the welders' café",
    finale: 'Restore the ironworks arch',
  },
  {
    id: 'observatoryHeights',
    name: 'Observatory Heights',
    station: 'Heights Ambient',
    tease: 'A dome turning, slowly, above the fog.',
    hue: 232,
    signature: 'Reopen the planetarium café',
    finale: 'Open the observatory dome',
  },
  {
    id: 'canalGardens',
    name: 'Canal Gardens',
    station: 'Canal Gardens Bossa',
    tease: 'A lock gate filling, and frogs.',
    hue: 128,
    signature: "Repair the lock keeper's hut",
    finale: 'Refill the water gardens',
  },
  {
    id: 'meridianCenter',
    name: 'Meridian Center',
    station: 'Meridian Prime',
    tease: 'The whole city, holding its breath.',
    hue: 280,
    signature: 'Reopen the grand café',
    finale: 'Light the Meridian Spire',
  },
];

const BASE_PROJECTS = [
  'Repave the crosswalks',
  'Fix the streetlights',
  '', // signature
  'Replant the median',
  'Restore the bus shelter',
  'Repaint the façades',
  '', // finale
];

/** Project totals scale with district index: D1 ≈ 820 Coins, D12 ≈ 9,500 (GDD §5). */
function districtTotal(index: number): number {
  return Math.round(822 + index * 789);
}

export const DISTRICTS: readonly DistrictDef[] = SEEDS.map((seed, i) => {
  const total = districtTotal(i);
  const names = BASE_PROJECTS.slice();
  names[2] = seed.signature;
  names[6] = seed.finale;
  return {
    id: seed.id,
    name: seed.name,
    incomeRate: i === 0 ? 12 : 14 + (i - 1) * 2,
    station: seed.station,
    tease: seed.tease,
    hue: seed.hue,
    projects: names.map((name, p) => ({
      id: `${seed.id}.p${p}`,
      name,
      cost: Math.max(25, Math.round((total * PROJECT_WEIGHTS[p]) / 5) * 5),
    })),
  };
});

export const PROJECTS_PER_DISTRICT = PROJECT_WEIGHTS.length;

/**
 * Endowed Progress (GDD §2): the map does not start at zero. The previous
 * Commissioner left Old Town and Riverside part-restored — "they quit, you
 * won't" — so the first district completion is reachable on day one.
 */
export const ENDOWED_PROJECTS: Readonly<Record<number, number>> = { 0: 4, 1: 2 };

/* ------------------------------------------------------------------ *
 * Landmarks — the trophy case (GDD §10)
 * ------------------------------------------------------------------ */

export interface LandmarkDef {
  id: string;
  name: string;
  /** District that must be fully restored before construction can start. */
  district: number;
  /** Blueprints required (GDD §5). */
  blueprints: number;
  plaque: string;
}

export const LANDMARKS: readonly LandmarkDef[] = [
  {
    id: 'fountain',
    name: 'The Fountain',
    district: 1,
    blueprints: 2,
    plaque: 'It ran dry the year the lots filled up. It runs again.',
  },
  {
    id: 'nightMarket',
    name: 'The Night Market',
    district: 2,
    blueprints: 2,
    plaque: 'Two hundred lanterns, strung by hand, lit at once.',
  },
  {
    id: 'tramLine',
    name: 'The Tram Line',
    district: 3,
    blueprints: 3,
    plaque: 'Nine years of silence, ended by a bell.',
  },
  {
    id: 'lighthouse',
    name: 'The Lighthouse',
    district: 4,
    blueprints: 3,
    plaque: 'Visible from every district, on a clear night.',
  },
  {
    id: 'gasholder',
    name: 'The Gasholder',
    district: 5,
    blueprints: 4,
    plaque: 'They were going to scrap it. The neighbourhood said no.',
  },
  {
    id: 'lanternStair',
    name: 'The Lantern Stair',
    district: 6,
    blueprints: 4,
    plaque: 'Four hundred steps, and a light on every landing.',
  },
  {
    id: 'observatory',
    name: 'The Observatory',
    district: 9,
    blueprints: 5,
    plaque: 'The dome turns. Someone is looking up again.',
  },
  {
    id: 'meridianSpire',
    name: 'The Meridian Spire',
    district: 11,
    blueprints: 5,
    plaque: 'The city, un-jammed, seen from the top.',
  },
];
