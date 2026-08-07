/**
 * The Garage — the identity layer (GDD §2 "Collection Psychology").
 *
 * Rides, Liveries and Horns carry zero power. Skins never alter vehicle
 * behaviour, so collecting can never corrupt the puzzle: players pay to *look*
 * clever, having already proven they are.
 */

export interface RideDef {
  id: string;
  name: string;
  blurb: string;
  /** Price in Medallions; 0 for the starter Ride. */
  price: number;
  /** Body colour of the player's hero car. */
  body: string;
  roof: string;
  /** Horn granted alongside the Ride. */
  horn: string;
}

export const RIDES: readonly RideDef[] = [
  {
    id: 'commuter',
    name: 'The Commuter',
    blurb: 'Yours since the first lot. Nothing special. Everything reliable.',
    price: 0,
    body: '#5B7FA8',
    roof: '#8FB3D9',
    horn: 'chirp',
  },
  {
    id: 'checker',
    name: 'Checker No. 9',
    blurb: 'Every city gets the cab it deserves. Meridian got this one.',
    price: 300,
    body: '#FFC93C',
    roof: '#2E3440',
    horn: 'doubleHonk',
  },
  {
    id: 'sunday',
    name: 'Sunday Cream',
    blurb: 'Driven twice a month, waxed four times.',
    price: 450,
    body: '#F6E7C8',
    roof: '#C9A227',
    horn: 'brass',
  },
  {
    id: 'siltVolt',
    name: 'Silt Volt',
    blurb: 'Silent, which makes the horn a design decision.',
    price: 600,
    body: '#62D9B2',
    roof: '#2E4F46',
    horn: 'synthToot',
  },
  {
    id: 'nightPulse',
    name: 'Night Pulse',
    blurb: 'Won on a weekend ladder, worn every day after.',
    price: 750,
    body: '#3A2E5A',
    roof: '#FF6F61',
    horn: 'siren',
  },
  {
    id: 'foreman',
    name: 'The Foreman',
    blurb: 'It built half of Old Town. It would like some credit.',
    price: 900,
    body: '#E85546',
    roof: '#F6E7C8',
    horn: 'baritone',
  },
];

export interface LiveryDef {
  id: string;
  name: string;
  setId: string;
  /** Palette applied fleet-wide; vehicles pick by their stable hue index. */
  colors: readonly string[];
}

export interface LiverySetDef {
  id: string;
  name: string;
  pieces: readonly string[];
  /** Horn granted for completing the set. */
  horn: string;
  price: number;
}

export const LIVERIES: readonly LiveryDef[] = [
  {
    id: 'factory',
    name: 'Factory Fleet',
    setId: 'factory',
    colors: ['#FF6F61', '#58C7F3', '#62D9B2', '#FFD166', '#C58BF2', '#F49AC2', '#7FD1AE', '#FF9F68'],
  },
  {
    id: 'checker.a',
    name: 'Checker — Cab Yellow',
    setId: 'checker',
    colors: ['#FFC93C', '#F5A623', '#FFE08A', '#E4952A', '#FFD166', '#D98324', '#FFB627', '#FFCE6B'],
  },
  {
    id: 'checker.b',
    name: 'Checker — Depot Green',
    setId: 'checker',
    colors: ['#3BB893', '#62D9B2', '#2E8B70', '#8FE9CC', '#48A98A', '#7ED6B4', '#59C39F', '#35997E'],
  },
  {
    id: 'checker.c',
    name: 'Checker — Night Shift',
    setId: 'checker',
    colors: ['#3A4A5F', '#55647A', '#2E3A4B', '#6E7F96', '#46566B', '#5F708A', '#39485C', '#657692'],
  },
  {
    id: 'checker.d',
    name: 'Checker — Dispatch Red',
    setId: 'checker',
    colors: ['#E85546', '#FF6F61', '#C6402F', '#FF8A76', '#D64A3A', '#FF7A69', '#B93A2B', '#FF9683'],
  },
  {
    id: 'sunday.a',
    name: 'Sunday — Cream',
    setId: 'sunday',
    colors: ['#F6E7C8', '#FFF6E3', '#E8D2A6', '#FFEFD0', '#EFDCB6', '#FBEAC6', '#E3CE9E', '#FFF3DC'],
  },
  {
    id: 'sunday.b',
    name: 'Sunday — Racing Stripe',
    setId: 'sunday',
    colors: ['#C9A227', '#E0B93C', '#A8871C', '#F0D264', '#B79523', '#D6AE33', '#8F7317', '#E8C74E'],
  },
  {
    id: 'sunday.c',
    name: 'Sunday — Sea Glass',
    setId: 'sunday',
    colors: ['#7FBFC7', '#A5D8DE', '#5E9EA6', '#BFE6EA', '#6FB0B8', '#94CCD3', '#4E8B93', '#B0DDE3'],
  },
  {
    id: 'sunday.d',
    name: 'Sunday — Burgundy',
    setId: 'sunday',
    colors: ['#8C3B4A', '#A8505F', '#6E2B37', '#C06B79', '#7C3441', '#9A4756', '#5D222D', '#B25E6C'],
  },
  {
    id: 'volt.a',
    name: 'Silent Volt — Mint',
    setId: 'volt',
    colors: ['#62D9B2', '#8FE9CC', '#3BB893', '#A8F0D8', '#4FCFA5', '#7DE2C1', '#33A784', '#98ECD1'],
  },
  {
    id: 'volt.b',
    name: 'Silent Volt — Arctic',
    setId: 'volt',
    colors: ['#D6EEF7', '#B4DFF0', '#8FCDE6', '#E6F5FB', '#C4E6F3', '#A2D6EC', '#7CC1DE', '#DCF0F9'],
  },
  {
    id: 'volt.c',
    name: 'Silent Volt — Graphite',
    setId: 'volt',
    colors: ['#4A5568', '#5F6B80', '#3A4557', '#74809A', '#525E72', '#6A7689', '#323C4C', '#7E8AA4'],
  },
  {
    id: 'volt.d',
    name: 'Silent Volt — Signal',
    setId: 'volt',
    colors: ['#FF6F61', '#58C7F3', '#FFD166', '#62D9B2', '#FF8A76', '#8FDCFA', '#FFE08A', '#8FE9CC'],
  },
];

export const LIVERY_SETS: readonly LiverySetDef[] = [
  {
    id: 'checker',
    name: 'Checker Cab Co.',
    pieces: ['checker.a', 'checker.b', 'checker.c', 'checker.d'],
    horn: 'doubleHonk',
    price: 500,
  },
  {
    id: 'sunday',
    name: 'Sunday Classics',
    pieces: ['sunday.a', 'sunday.b', 'sunday.c', 'sunday.d'],
    horn: 'brass',
    price: 800,
  },
  {
    id: 'volt',
    name: 'Silent Volt EV',
    pieces: ['volt.a', 'volt.b', 'volt.c', 'volt.d'],
    horn: 'synthToot',
    price: 1200,
  },
];

export type HornShape = 'chirp' | 'double' | 'baritone' | 'synth' | 'brass' | 'whoop' | 'bell';

export interface HornDef {
  id: string;
  name: string;
  shape: HornShape;
  /** Fundamental in Hz. */
  freq: number;
  price: number;
}

/** The Horn Library — audible cosmetics, the rarest kind (GDD §8). */
export const HORNS: readonly HornDef[] = [
  { id: 'chirp', name: 'Commuter Chirp', shape: 'chirp', freq: 520, price: 0 },
  { id: 'doubleHonk', name: 'Checker Double', shape: 'double', freq: 440, price: 120 },
  { id: 'baritone', name: 'Freight Baritone', shape: 'baritone', freq: 174, price: 150 },
  { id: 'synthToot', name: 'Volt Toot', shape: 'synth', freq: 660, price: 150 },
  { id: 'brass', name: 'Sunday Brass', shape: 'brass', freq: 392, price: 180 },
  { id: 'siren', name: 'Night Pulse', shape: 'whoop', freq: 700, price: 220 },
  { id: 'tram', name: 'Junction Bell', shape: 'bell', freq: 880, price: 200 },
];

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function findRide(id: string): RideDef {
  return RIDES.find((r) => r.id === id) ?? RIDES[0];
}

export function findLivery(id: string): LiveryDef {
  return LIVERIES.find((l) => l.id === id) ?? LIVERIES[0];
}

export function findHorn(id: string): HornDef {
  return HORNS.find((h) => h.id === id) ?? HORNS[0];
}

export function setOf(liveryId: string): LiverySetDef | null {
  const livery = findLivery(liveryId);
  return LIVERY_SETS.find((s) => s.id === livery.setId) ?? null;
}

/** Fleet colour for a vehicle, given the equipped livery and the car's hue index. */
export function fleetColor(liveryId: string, hue: number): string {
  const livery = findLivery(liveryId);
  return livery.colors[Math.abs(hue) % livery.colors.length];
}
