/**
 * Gridlock City — deterministic lot simulation.
 *
 * Everything here is a pure function of (state, request). No randomness, no
 * clocks, no DOM. `applyMove` is the single mutation point.
 */

import {
  BlockInfo,
  BlockReason,
  Dir,
  DX,
  DY,
  LevelDef,
  LotState,
  Move,
  MoveKind,
  OPPOSITE,
  Terrain,
  VEHICLE_LENGTH,
  VehicleTag,
  CW,
  CCW,
} from './types';

const NO_BLOCK: BlockInfo = Object.freeze({
  reason: BlockReason.None,
  blockerVi: -1,
  cellX: -1,
  cellY: -1,
});

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export function createLotState(level: LevelDef): LotState {
  const n = level.vehicles.length;
  const state: LotState = {
    level,
    ids: new Int32Array(n),
    x: new Int16Array(n),
    y: new Int16Array(n),
    facing: new Uint8Array(n),
    len: new Uint8Array(n),
    tags: new Uint8Array(n),
    gone: new Uint8Array(n),
    occ: new Int16Array(level.w * level.h).fill(-1),
    remaining: n,
    vipsRemaining: 0,
    slides: 0,
    bumps: 0,
  };
  for (let i = 0; i < n; i++) {
    const v = level.vehicles[i];
    state.ids[i] = v.id;
    state.x[i] = v.x;
    state.y[i] = v.y;
    state.facing[i] = v.facing;
    state.len[i] = VEHICLE_LENGTH[v.kind];
    state.tags[i] = v.tags;
    if (v.tags & VehicleTag.Vip) state.vipsRemaining++;
  }
  rebuildOcc(state);
  return state;
}

export function cloneLotState(s: LotState): LotState {
  return {
    level: s.level,
    ids: s.ids,
    x: s.x.slice(),
    y: s.y.slice(),
    facing: s.facing.slice(),
    len: s.len,
    tags: s.tags,
    gone: s.gone.slice(),
    occ: s.occ.slice(),
    remaining: s.remaining,
    vipsRemaining: s.vipsRemaining,
    slides: s.slides,
    bumps: s.bumps,
  };
}

export function rebuildOcc(s: LotState): void {
  s.occ.fill(-1);
  const w = s.level.w;
  for (let i = 0; i < s.x.length; i++) {
    if (s.gone[i]) continue;
    const f = s.facing[i] as Dir;
    const dx = DX[f];
    const dy = DY[f];
    for (let k = 0; k < s.len[i]; k++) {
      const cx = s.x[i] - dx * k;
      const cy = s.y[i] - dy * k;
      s.occ[cy * w + cx] = i;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Cell queries
 * ------------------------------------------------------------------ */

export function inBounds(level: LevelDef, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < level.w && y < level.h;
}

export function terrainAt(level: LevelDef, x: number, y: number): Terrain {
  return level.terrain[y * level.w + x];
}

export function arrowAt(level: LevelDef, x: number, y: number): number {
  return level.arrows[y * level.w + x];
}

/** Index of a matching curb cut, or −1. Exits are pre-validated to sit on the border. */
export function exitIndexAt(level: LevelDef, x: number, y: number, dir: Dir): number {
  for (let i = 0; i < level.exits.length; i++) {
    const e = level.exits[i];
    if (e.x === x && e.y === y && e.dir === dir) return i;
  }
  return -1;
}

/**
 * Curb cuts as a per-cell direction bitmask, built once per LevelDef.
 *
 * A frontage on all four sides of a 12×15 lot is ~50 curb cuts, and `probe` asks
 * "is there one here?" every time a ray reaches the border — which the solver
 * does tens of thousands of times per generated level. A linear scan over the
 * exit list made that the hottest loop in generation; this makes it O(1).
 *
 * Keyed weakly on the level object, so a level rebuilt by `overrideLevel`
 * (Green Wave, Grip Tires) simply gets a fresh mask.
 */
const exitMasks = new WeakMap<LevelDef, Uint8Array>();

export function exitMaskFor(level: LevelDef): Uint8Array {
  let mask = exitMasks.get(level);
  if (mask) return mask;
  mask = new Uint8Array(level.w * level.h);
  for (const e of level.exits) {
    if (e.x < 0 || e.y < 0 || e.x >= level.w || e.y >= level.h) continue;
    mask[e.y * level.w + e.x] |= 1 << e.dir;
  }
  exitMasks.set(level, mask);
  return mask;
}

/** True when cell (x,y) has a curb cut on side `dir`. */
export function hasExitAt(level: LevelDef, x: number, y: number, dir: Dir): boolean {
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return false;
  return (exitMaskFor(level)[y * level.w + x] & (1 << dir)) !== 0;
}

/** Nose cell when travelling `dir`; the tail leads when reversing. */
export function leadCell(s: LotState, vi: number, dir: Dir): { x: number; y: number } {
  const f = s.facing[vi] as Dir;
  if (dir === f) return { x: s.x[vi], y: s.y[vi] };
  const k = s.len[vi] - 1;
  return { x: s.x[vi] - DX[f] * k, y: s.y[vi] - DY[f] * k };
}

/** Velvet Rope: while a VIP is on the lot, only VIPs may leave (GDD §6). */
export function exitPermitted(s: LotState, vi: number): boolean {
  if (s.vipsRemaining === 0) return true;
  return (s.tags[vi] & VehicleTag.Vip) !== 0;
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

export interface Probe {
  /** Greatest travel distance that keeps the whole vehicle on the lot. */
  dist: number;
  /** Nose travel needed to reach the curb cut, or −1 when no exit is reachable. */
  exitDist: number;
  /** Why travel stopped. */
  block: BlockInfo;
}

/**
 * Walk a vehicle in `dir` until something stops it.
 *
 * `dir` must be the vehicle's facing (forward) or its opposite (reverse);
 * off-axis travel is rejected by the caller.
 */
export function probe(s: LotState, vi: number, dir: Dir): Probe {
  const level = s.level;
  const forward = dir === (s.facing[vi] as Dir);
  const lead = leadCell(s, vi, dir);
  const dx = DX[dir];
  const dy = DY[dir];
  const limit = level.w + level.h; // travel can never exceed the lot's span

  let dist = 0;
  let block: BlockInfo = NO_BLOCK;

  for (let k = 1; k <= limit; k++) {
    const cx = lead.x + dx * k;
    const cy = lead.y + dy * k;

    if (!inBounds(level, cx, cy)) {
      // Reaching the border: the previous cell may hold a curb cut.
      const px = lead.x + dx * (k - 1);
      const py = lead.y + dy * (k - 1);
      const hasCurbCut = forward && hasExitAt(level, px, py, dir);
      if (hasCurbCut) {
        if (exitPermitted(s, vi)) return { dist, exitDist: k - 1, block: NO_BLOCK };
        return {
          dist,
          exitDist: -1,
          block: { reason: BlockReason.VelvetRope, blockerVi: -1, cellX: px, cellY: py },
        };
      }
      block = { reason: BlockReason.Wall, blockerVi: -1, cellX: px, cellY: py };
      break;
    }

    const t = terrainAt(level, cx, cy);
    if (t === Terrain.Blocked) {
      block = { reason: BlockReason.Static, blockerVi: -1, cellX: cx, cellY: cy };
      break;
    }
    const occupant = s.occ[cy * level.w + cx];
    if (occupant >= 0) {
      block = { reason: BlockReason.Vehicle, blockerVi: occupant, cellX: cx, cellY: cy };
      break;
    }
    const arrow = arrowAt(level, cx, cy);
    if (arrow >= 0 && arrow !== dir) {
      block = { reason: BlockReason.OneWay, blockerVi: -1, cellX: cx, cellY: cy };
      break;
    }
    dist = k;
  }

  return { dist, exitDist: -1, block };
}

export interface SlideCapability {
  forward: Probe;
  backward: Probe;
  /** True when the vehicle may pivot on a roundabout plate right now. */
  canPivot: boolean;
  pivotFacing: Dir;
}

export function capability(s: LotState, vi: number): SlideCapability {
  const f = s.facing[vi] as Dir;
  const b = OPPOSITE[f];
  const pivot = pivotTarget(s, vi);
  return {
    forward: probe(s, vi, f),
    backward: probe(s, vi, b),
    canPivot: pivot >= 0,
    pivotFacing: (pivot >= 0 ? pivot : f) as Dir,
  };
}

/**
 * Roundabout pivot (GDD §6 "Carousel"): a vehicle nosed onto a plate may turn
 * 90° in the plate's spin direction, provided its body fits in the new lane.
 * Returns the resulting facing, or −1.
 */
export function pivotTarget(s: LotState, vi: number): number {
  const level = s.level;
  const nx = s.x[vi];
  const ny = s.y[vi];
  if (!inBounds(level, nx, ny)) return -1;
  if (terrainAt(level, nx, ny) !== Terrain.Roundabout) return -1;

  const f = s.facing[vi] as Dir;
  const spin = level.roundaboutSpin[ny * level.w + nx];
  const candidates: Dir[] = spin > 0 ? [CW[f]] : spin < 0 ? [CCW[f]] : [CW[f], CCW[f]];

  for (const nf of candidates) {
    if (bodyFits(s, vi, nx, ny, nf)) return nf;
  }
  return -1;
}

/** Can vehicle `vi` occupy the lane with nose (nx,ny) and facing `nf`? Ignores itself. */
export function bodyFits(s: LotState, vi: number, nx: number, ny: number, nf: Dir): boolean {
  const level = s.level;
  for (let k = 0; k < s.len[vi]; k++) {
    const cx = nx - DX[nf] * k;
    const cy = ny - DY[nf] * k;
    if (!inBounds(level, cx, cy)) return false;
    if (terrainAt(level, cx, cy) === Terrain.Blocked) return false;
    const occupant = s.occ[cy * level.w + cx];
    if (occupant >= 0 && occupant !== vi) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Move resolution
 * ------------------------------------------------------------------ */

/**
 * Resolve a drag request into a concrete move, or null when the vehicle cannot
 * budge (a bump — free and diagnostic, GDD §2).
 *
 * `requested` is how many cells the player dragged; it is clamped, and oil
 * slicks may carry the vehicle further than asked.
 */
export function resolveMove(s: LotState, vi: number, dir: Dir, requested: number): Move | null {
  if (s.gone[vi]) return null;
  if (requested <= 0) return null;

  const f = s.facing[vi] as Dir;
  const forward = dir === f;
  if (!forward && dir !== OPPOSITE[f]) return null; // off-axis drags are refused

  const p = probe(s, vi, dir);

  // Dragging at least as far as the curb cut commits the exit. This also covers
  // a vehicle already parked on the curb cut, where on-lot travel is zero.
  if (forward && p.exitDist >= 0 && requested >= p.exitDist) {
    return {
      kind: MoveKind.Exit,
      vi,
      dir,
      distance: p.exitDist,
      toX: s.x[vi] + DX[dir] * p.exitDist,
      toY: s.y[vi] + DY[dir] * p.exitDist,
      slidExtra: 0,
    };
  }

  const asked = Math.min(requested, p.dist);
  if (asked <= 0) return null;

  // Oil slick: once the leading cell stops on a slick the vehicle keeps going
  // until it finds dry asphalt, a blocker, or the street.
  const level = s.level;
  const lead = leadCell(s, vi, dir);
  let d = asked;
  while (d < p.dist) {
    const lx = lead.x + DX[dir] * d;
    const ly = lead.y + DY[dir] * d;
    if (terrainAt(level, lx, ly) !== Terrain.Oil) break;
    d++;
  }
  const extra = d - asked;

  // The slick itself can carry a vehicle onto the curb cut — that exits too.
  if (forward && p.exitDist >= 0 && d >= p.exitDist) {
    return {
      kind: MoveKind.Exit,
      vi,
      dir,
      distance: p.exitDist,
      toX: s.x[vi] + DX[dir] * p.exitDist,
      toY: s.y[vi] + DY[dir] * p.exitDist,
      slidExtra: Math.max(0, p.exitDist - asked),
    };
  }

  return {
    kind: MoveKind.Slide,
    vi,
    dir,
    distance: d,
    toX: s.x[vi] + DX[dir] * d,
    toY: s.y[vi] + DY[dir] * d,
    slidExtra: extra,
  };
}

/** Build a pivot move, or null when the vehicle is not on a usable plate. */
export function resolvePivot(s: LotState, vi: number): Move | null {
  if (s.gone[vi]) return null;
  const nf = pivotTarget(s, vi);
  if (nf < 0) return null;
  return {
    kind: MoveKind.Pivot,
    vi,
    dir: nf as Dir,
    distance: 0,
    toX: s.x[vi],
    toY: s.y[vi],
    slidExtra: 0,
  };
}

/** Apply a resolved move in place. Returns the state for chaining. */
export function applyMove(s: LotState, m: Move): LotState {
  const vi = m.vi;
  clearOcc(s, vi);

  if (m.kind === MoveKind.Pivot) {
    s.facing[vi] = m.dir;
  } else {
    s.x[vi] = m.toX;
    s.y[vi] = m.toY;
  }

  if (m.kind === MoveKind.Exit) {
    s.gone[vi] = 1;
    s.remaining--;
    if (s.tags[vi] & VehicleTag.Vip) s.vipsRemaining--;
  } else {
    writeOcc(s, vi);
  }

  s.slides++;
  return s;
}

function clearOcc(s: LotState, vi: number): void {
  const w = s.level.w;
  const f = s.facing[vi] as Dir;
  for (let k = 0; k < s.len[vi]; k++) {
    const cx = s.x[vi] - DX[f] * k;
    const cy = s.y[vi] - DY[f] * k;
    if (cx >= 0 && cy >= 0 && cx < w && cy < s.level.h) s.occ[cy * w + cx] = -1;
  }
}

function writeOcc(s: LotState, vi: number): void {
  const w = s.level.w;
  const f = s.facing[vi] as Dir;
  for (let k = 0; k < s.len[vi]; k++) {
    const cx = s.x[vi] - DX[f] * k;
    const cy = s.y[vi] - DY[f] * k;
    s.occ[cy * w + cx] = vi;
  }
}

export function isCleared(s: LotState): boolean {
  return s.remaining === 0;
}

/* ------------------------------------------------------------------ *
 * Enumeration & hashing (solver / generator support)
 * ------------------------------------------------------------------ */

/** Every distinct move available from `s`, exits first (cheapest for search). */
export function legalMoves(s: LotState): Move[] {
  const out: Move[] = [];
  const slides: Move[] = [];
  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    const f = s.facing[vi] as Dir;
    const fwd = probe(s, vi, f);
    if (fwd.exitDist >= 0) {
      out.push({
        kind: MoveKind.Exit,
        vi,
        dir: f,
        distance: fwd.exitDist,
        toX: s.x[vi] + DX[f] * fwd.exitDist,
        toY: s.y[vi] + DY[f] * fwd.exitDist,
        slidExtra: 0,
      });
    }
    for (let d = 1; d <= fwd.dist; d++) {
      const m = resolveMove(s, vi, f, d);
      if (m && m.kind === MoveKind.Slide && m.distance === d + m.slidExtra) slides.push(m);
    }
    const b = OPPOSITE[f];
    const back = probe(s, vi, b);
    for (let d = 1; d <= back.dist; d++) {
      const m = resolveMove(s, vi, b, d);
      if (m && m.kind === MoveKind.Slide && m.distance === d + m.slidExtra) slides.push(m);
    }
    const pv = resolvePivot(s, vi);
    if (pv) slides.push(pv);
  }
  return out.concat(dedupeMoves(slides));
}

function dedupeMoves(moves: Move[]): Move[] {
  const seen = new Set<string>();
  const out: Move[] = [];
  for (const m of moves) {
    const key = `${m.vi}:${m.kind}:${m.toX},${m.toY},${m.kind === MoveKind.Pivot ? m.dir : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Every vehicle that can drive off the lot right now. */
export function exitableVehicles(s: LotState): number[] {
  const out: number[] = [];
  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    const f = s.facing[vi] as Dir;
    if (probe(s, vi, f).exitDist >= 0) out.push(vi);
  }
  return out;
}

/**
 * Collision-free state key. One UTF-16 code unit per vehicle:
 * gone → 0xFFFF, else (cellIndex * 4 + facing) + 1, which stays under 0xFFFF
 * for any lot up to 16k cells.
 */
export function stateKey(s: LotState): string {
  const w = s.level.w;
  const n = s.x.length;
  const codes = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    codes[i] = s.gone[i] ? 0xffff : (s.y[i] * w + s.x[i]) * 4 + s.facing[i] + 1;
  }
  return String.fromCharCode.apply(null, codes);
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export interface ValidationIssue {
  code: string;
  detail: string;
}

/** Structural checks a LevelDef must pass before it can be shipped or played. */
export function validateLevel(level: LevelDef): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const cells = level.w * level.h;
  if (level.w < 3 || level.h < 3) issues.push({ code: 'grid', detail: 'lot smaller than 3×3' });
  if (level.terrain.length !== cells)
    issues.push({ code: 'terrain', detail: `expected ${cells} terrain cells` });
  if (level.arrows.length !== cells)
    issues.push({ code: 'arrows', detail: `expected ${cells} arrow cells` });
  if (level.exits.length === 0) issues.push({ code: 'exits', detail: 'no curb cuts' });

  for (const e of level.exits) {
    if (!inBounds(level, e.x, e.y)) {
      issues.push({ code: 'exitBounds', detail: `exit ${e.x},${e.y} off lot` });
      continue;
    }
    const ox = e.x + DX[e.dir];
    const oy = e.y + DY[e.dir];
    if (inBounds(level, ox, oy)) {
      issues.push({ code: 'exitInterior', detail: `exit ${e.x},${e.y} does not face the street` });
    }
    if (terrainAt(level, e.x, e.y) === Terrain.Blocked) {
      issues.push({ code: 'exitBlocked', detail: `exit ${e.x},${e.y} sits on a blocker` });
    }
  }

  const seen = new Int16Array(cells).fill(-1);
  const ids = new Set<number>();
  for (const v of level.vehicles) {
    if (ids.has(v.id)) issues.push({ code: 'dupId', detail: `duplicate vehicle id ${v.id}` });
    ids.add(v.id);
    const len = VEHICLE_LENGTH[v.kind];
    for (let k = 0; k < len; k++) {
      const cx = v.x - DX[v.facing] * k;
      const cy = v.y - DY[v.facing] * k;
      if (!inBounds(level, cx, cy)) {
        issues.push({ code: 'vehicleBounds', detail: `vehicle ${v.id} hangs off the lot` });
        break;
      }
      const idx = cy * level.w + cx;
      if (level.terrain[idx] === Terrain.Blocked) {
        issues.push({ code: 'vehicleOnBlocker', detail: `vehicle ${v.id} overlaps a blocker` });
      }
      if (seen[idx] >= 0) {
        issues.push({ code: 'overlap', detail: `vehicles ${seen[idx]} and ${v.id} overlap` });
      }
      seen[idx] = v.id;
    }
  }
  return issues;
}
