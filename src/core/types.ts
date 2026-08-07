/**
 * Gridlock City — deterministic simulation types.
 *
 * This module is DOM-free and side-effect-free on purpose: the exact same code
 * runs in the client, in the solver, in the level generator and in the tests
 * (GDD §15 "Client Architecture" — one sim, three consumers).
 */

/** Cardinal direction. 0=N (−y), 1=E (+x), 2=S (+y), 3=W (−x). */
export type Dir = 0 | 1 | 2 | 3;

export const DIR_N: Dir = 0;
export const DIR_E: Dir = 1;
export const DIR_S: Dir = 2;
export const DIR_W: Dir = 3;

/** dx per direction, indexed by Dir. */
export const DX: readonly number[] = [0, 1, 0, -1];
/** dy per direction, indexed by Dir. */
export const DY: readonly number[] = [-1, 0, 1, 0];

export const OPPOSITE: readonly Dir[] = [2, 3, 0, 1];
/** Rotate a direction clockwise (N→E→S→W). */
export const CW: readonly Dir[] = [1, 2, 3, 0];
/** Rotate a direction counter-clockwise (N→W→S→E). */
export const CCW: readonly Dir[] = [3, 0, 1, 2];

/** True when two directions share an axis (both horizontal or both vertical). */
export function sameAxis(a: Dir, b: Dir): boolean {
  return (a & 1) === (b & 1);
}

/** Terrain of a single lot cell. */
export enum Terrain {
  /** Normal asphalt. */
  Road = 0,
  /** Static obstacle — cone, dumpster, planter, or an internal lot wall. */
  Blocked = 1,
  /** Oil slick: a vehicle whose nose lands here keeps sliding (GDD §6 "Slick Corridor"). */
  Oil = 2,
  /** Roundabout plate: a vehicle nosed here may pivot 90° (GDD §6 "Carousel"). */
  Roundabout = 3,
}

/** Sub-kind of a Terrain.Blocked cell, purely cosmetic. */
export enum BlockerStyle {
  Cone = 0,
  Dumpster = 1,
  Planter = 2,
  Wall = 3,
}

export enum VehicleKind {
  Sedan = 'sedan',
  Taxi = 'taxi',
  Coupe = 'coupe',
  Van = 'van',
  BoxTruck = 'boxTruck',
  Trailer = 'trailer',
  Bus = 'bus',
  Ambulance = 'ambulance',
}

/** Cell length of each vehicle kind. */
export const VEHICLE_LENGTH: Record<VehicleKind, number> = {
  [VehicleKind.Sedan]: 2,
  [VehicleKind.Taxi]: 2,
  [VehicleKind.Coupe]: 2,
  [VehicleKind.Van]: 3,
  [VehicleKind.BoxTruck]: 3,
  [VehicleKind.Trailer]: 4,
  [VehicleKind.Bus]: 5,
  [VehicleKind.Ambulance]: 3,
};

/** Vehicle tag bitmask. */
export enum VehicleTag {
  None = 0,
  /** Velvet Rope: every VIP must exit before any non-VIP may leave (GDD §6). */
  Vip = 1 << 0,
  /** Optional 30 s rescue bonus (GDD §2 "Pressure only by invitation"). */
  Ambulance = 1 << 1,
  /** Mystery Trunk: pops a variable reward on exit (GDD §2 "Variable Rewards"). */
  Trunk = 1 << 2,
}

/** A vehicle's authored definition. `x`,`y` is the NOSE cell; the body trails behind it. */
export interface VehicleDef {
  id: number;
  kind: VehicleKind;
  x: number;
  y: number;
  facing: Dir;
  tags: number;
  /** Livery/paint index — cosmetic only, never affects the sim. */
  hue?: number;
}

/** A street opening: cell (x,y) has a curb cut on side `dir`. */
export interface ExitDef {
  x: number;
  y: number;
  dir: Dir;
}

export enum Band {
  Easy = 'easy',
  Medium = 'medium',
  Hard = 'hard',
  Showcase = 'showcase',
}

/** Fully authored, immutable level definition (GDD §15 `LevelDef`). */
export interface LevelDef {
  id: string;
  /** 1-based position in the global jam sequence. */
  index: number;
  w: number;
  h: number;
  /** Row-major terrain, length w*h. */
  terrain: Terrain[];
  /** Row-major one-way arrow direction per cell, −1 for none. */
  arrows: number[];
  /** Row-major cosmetic blocker style, only meaningful on Terrain.Blocked cells. */
  blockerStyle: number[];
  /** Row-major roundabout turn direction: +1 clockwise, −1 counter-clockwise. */
  roundaboutSpin: number[];
  exits: ExitDef[];
  vehicles: VehicleDef[];
  parSlides: number;
  band: Band;
  patternTags: string[];
  /** Number of distinct modifier families in play (GDD §4 "modifier load"). */
  modifierLoad: number;
  /** Longest chain of forced single-option moves found by the generator. */
  knotDepth: number;
  /** Seed that produced the level, for reproducible regeneration. */
  seed: number;
}

/** Mutable per-attempt state. Vehicles are stored parallel-array style for cheap cloning. */
export interface LotState {
  level: LevelDef;
  /** Vehicle ids, in stable order. */
  ids: Int32Array;
  x: Int16Array;
  y: Int16Array;
  facing: Uint8Array;
  len: Uint8Array;
  tags: Uint8Array;
  /** 1 when the vehicle has driven off the lot. */
  gone: Uint8Array;
  /** Row-major occupancy: vehicle array index, or −1 when free. Derived, kept in sync. */
  occ: Int16Array;
  /** Count of vehicles still on the lot. */
  remaining: number;
  /** Count of VIP vehicles still on the lot — gates the Velvet Rope rule. */
  vipsRemaining: number;
  /** Slides performed (a slide = one committed drag, GDD §6 "par slides"). */
  slides: number;
  /** Blocked attempts — comedic, free, and diagnostic (GDD §2). */
  bumps: number;
}

export enum MoveKind {
  Slide = 'slide',
  Exit = 'exit',
  Pivot = 'pivot',
}

/** A legal, fully-resolved move. */
export interface Move {
  kind: MoveKind;
  /** Index into the LotState parallel arrays (not the vehicle id). */
  vi: number;
  /** Travel direction for Slide/Exit. For Pivot this is the resulting facing. */
  dir: Dir;
  /** Cells travelled. 0 for Pivot. */
  distance: number;
  /** Final nose x after the move (unchanged for Pivot). */
  toX: number;
  /** Final nose y after the move. */
  toY: number;
  /** Extra cells travelled because the nose landed on oil. */
  slidExtra: number;
}

export enum BlockReason {
  None = 'none',
  Vehicle = 'vehicle',
  Static = 'static',
  OneWay = 'oneWay',
  VelvetRope = 'velvetRope',
  Wall = 'wall',
}

/** Why a drag could not go as far as the player asked. */
export interface BlockInfo {
  reason: BlockReason;
  /** Vehicle array index of the blocker when reason === Vehicle, else −1. */
  blockerVi: number;
  /** Cell that stopped the slide. */
  cellX: number;
  cellY: number;
}
