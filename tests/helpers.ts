import {
  Band,
  BlockerStyle,
  Dir,
  LevelDef,
  Terrain,
  VehicleDef,
  VehicleKind,
} from '../src/core/types';

export interface LotOptions {
  w: number;
  h: number;
  vehicles: VehicleDef[];
  exits?: Array<{ x: number; y: number; dir: Dir }>;
  blocked?: Array<[number, number]>;
  oil?: Array<[number, number]>;
  roundabout?: Array<[number, number, number]>;
  arrows?: Array<[number, number, Dir]>;
}

/** Build a hand-authored lot for a test, with sensible defaults. */
export function lot(o: LotOptions): LevelDef {
  const cells = o.w * o.h;
  const level: LevelDef = {
    id: 'test',
    index: 1,
    w: o.w,
    h: o.h,
    terrain: new Array(cells).fill(Terrain.Road),
    arrows: new Array(cells).fill(-1),
    blockerStyle: new Array(cells).fill(BlockerStyle.Cone),
    roundaboutSpin: new Array(cells).fill(0),
    exits: o.exits ?? [{ x: 0, y: o.h - 1, dir: 2 }],
    vehicles: o.vehicles,
    parSlides: o.vehicles.length,
    band: Band.Easy,
    patternTags: [],
    modifierLoad: 0,
    knotDepth: 1,
    seed: 1,
  };
  for (const [x, y] of o.blocked ?? []) level.terrain[y * o.w + x] = Terrain.Blocked;
  for (const [x, y] of o.oil ?? []) level.terrain[y * o.w + x] = Terrain.Oil;
  for (const [x, y, spin] of o.roundabout ?? []) {
    level.terrain[y * o.w + x] = Terrain.Roundabout;
    level.roundaboutSpin[y * o.w + x] = spin;
  }
  for (const [x, y, dir] of o.arrows ?? []) level.arrows[y * o.w + x] = dir;
  return level;
}

/** A vehicle at a nose cell, facing a direction. */
export function car(
  id: number,
  x: number,
  y: number,
  facing: Dir,
  kind = VehicleKind.Sedan,
  tags = 0,
): VehicleDef {
  return { id, kind, x, y, facing, tags };
}
