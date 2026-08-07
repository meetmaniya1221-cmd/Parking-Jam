import { describe, expect, it } from 'vitest';
import {
  applyMove,
  capability,
  cloneLotState,
  createLotState,
  exitableVehicles,
  isCleared,
  legalMoves,
  probe,
  resolveMove,
  resolvePivot,
  stateKey,
  validateLevel,
} from '../src/core/sim';
import { BlockReason, MoveKind, VehicleKind, VehicleTag } from '../src/core/types';
import { car, lot } from './helpers';

describe('geometry', () => {
  it('places a vehicle body behind its nose', () => {
    const level = lot({ w: 4, h: 4, vehicles: [car(0, 1, 3, 2)] });
    const s = createLotState(level);
    // Nose at (1,3) facing south; body trails north into (1,2).
    expect(s.occ[3 * 4 + 1]).toBe(0);
    expect(s.occ[2 * 4 + 1]).toBe(0);
    expect(s.occ[1 * 4 + 1]).toBe(-1);
  });

  it('rejects a level whose vehicle hangs off the lot', () => {
    const level = lot({ w: 4, h: 4, vehicles: [car(0, 1, 0, 2)] });
    expect(validateLevel(level).some((i) => i.code === 'vehicleBounds')).toBe(true);
  });

  it('rejects overlapping vehicles', () => {
    const level = lot({ w: 4, h: 4, vehicles: [car(0, 1, 3, 2), car(1, 1, 2, 2)] });
    expect(validateLevel(level).some((i) => i.code === 'overlap')).toBe(true);
  });

  it('rejects an interior exit', () => {
    const level = lot({ w: 4, h: 4, vehicles: [car(0, 1, 3, 2)], exits: [{ x: 1, y: 1, dir: 2 }] });
    expect(validateLevel(level).some((i) => i.code === 'exitInterior')).toBe(true);
  });
});

describe('probe', () => {
  it('finds a clear exit straight ahead', () => {
    const level = lot({
      w: 3,
      h: 4,
      vehicles: [car(0, 1, 1, 2)],
      exits: [{ x: 1, y: 3, dir: 2 }],
    });
    const s = createLotState(level);
    const p = probe(s, 0, 2);
    expect(p.exitDist).toBe(2);
  });

  it('stops at a blocking vehicle and names it', () => {
    const level = lot({
      w: 3,
      h: 5,
      vehicles: [car(0, 1, 1, 2), car(1, 1, 4, 2)],
      exits: [{ x: 1, y: 4, dir: 2 }],
    });
    const s = createLotState(level);
    const p = probe(s, 0, 2);
    expect(p.exitDist).toBe(-1);
    expect(p.block.reason).toBe(BlockReason.Vehicle);
    expect(p.block.blockerVi).toBe(1);
    expect(p.dist).toBe(1); // can advance to y=2, then (1,3) is the blocker's tail
  });

  it('stops at a wall with no curb cut', () => {
    const level = lot({ w: 3, h: 4, vehicles: [car(0, 1, 1, 0)], exits: [{ x: 1, y: 3, dir: 2 }] });
    const s = createLotState(level);
    const p = probe(s, 0, 0);
    expect(p.exitDist).toBe(-1);
    expect(p.block.reason).toBe(BlockReason.Wall);
  });

  it('respects one-way arrows', () => {
    const level = lot({
      w: 3,
      h: 4,
      vehicles: [car(0, 1, 1, 2)],
      exits: [{ x: 1, y: 3, dir: 2 }],
      arrows: [[1, 2, 0]],
    });
    const s = createLotState(level);
    const p = probe(s, 0, 2);
    expect(p.exitDist).toBe(-1);
    expect(p.block.reason).toBe(BlockReason.OneWay);
  });

  it('holds non-VIPs behind the velvet rope', () => {
    const level = lot({
      w: 3,
      h: 5,
      vehicles: [car(0, 1, 4, 2), car(1, 2, 4, 2, VehicleKind.Sedan, VehicleTag.Vip)],
      exits: [
        { x: 1, y: 4, dir: 2 },
        { x: 2, y: 4, dir: 2 },
      ],
    });
    const s = createLotState(level);
    expect(probe(s, 0, 2).block.reason).toBe(BlockReason.VelvetRope);
    expect(probe(s, 1, 2).exitDist).toBe(0);

    applyMove(s, resolveMove(s, 1, 2, 1)!);
    expect(probe(s, 0, 2).exitDist).toBe(0); // rope drops once the VIP is gone
  });
});

describe('moves', () => {
  it('exits a vehicle with a clear lane', () => {
    const level = lot({
      w: 3,
      h: 4,
      vehicles: [car(0, 1, 1, 2)],
      exits: [{ x: 1, y: 3, dir: 2 }],
    });
    const s = createLotState(level);
    const m = resolveMove(s, 0, 2, 9)!;
    expect(m.kind).toBe(MoveKind.Exit);
    applyMove(s, m);
    expect(isCleared(s)).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.slides).toBe(1);
  });

  it('slides partway when the player drags less than the full lane', () => {
    const level = lot({
      w: 3,
      h: 6,
      vehicles: [car(0, 1, 1, 2)],
      exits: [{ x: 1, y: 5, dir: 2 }],
    });
    const s = createLotState(level);
    const m = resolveMove(s, 0, 2, 2)!;
    expect(m.kind).toBe(MoveKind.Slide);
    expect(m.distance).toBe(2);
    applyMove(s, m);
    expect(s.y[0]).toBe(3);
    expect(s.occ[3 * 3 + 1]).toBe(0);
    expect(s.occ[1 * 3 + 1]).toBe(-1);
  });

  it('reverses along its own axis', () => {
    const level = lot({
      w: 3,
      h: 6,
      vehicles: [car(0, 1, 4, 2)],
      exits: [{ x: 1, y: 5, dir: 2 }],
    });
    const s = createLotState(level);
    const m = resolveMove(s, 0, 0, 2)!;
    expect(m.kind).toBe(MoveKind.Slide);
    applyMove(s, m);
    expect(s.y[0]).toBe(2);
  });

  it('refuses off-axis drags', () => {
    const level = lot({ w: 4, h: 4, vehicles: [car(0, 1, 3, 2)] });
    const s = createLotState(level);
    expect(resolveMove(s, 0, 1, 1)).toBeNull();
    expect(resolveMove(s, 0, 3, 1)).toBeNull();
  });

  it('returns null (a bump) when nothing can move', () => {
    const level = lot({
      w: 3,
      h: 3,
      vehicles: [car(0, 1, 1, 2), car(1, 1, 2, 2)],
      exits: [{ x: 0, y: 2, dir: 2 }],
    });
    const s = createLotState(level);
    // Vehicle 0 is nose-to-tail behind vehicle 1 and boxed in by the top wall.
    expect(resolveMove(s, 0, 2, 3)).toBeNull();
  });

  it('never exits backwards', () => {
    const level = lot({
      w: 3,
      h: 4,
      vehicles: [car(0, 1, 1, 0)],
      exits: [{ x: 1, y: 3, dir: 2 }],
    });
    const s = createLotState(level);
    // Nose (1,1), body trailing to (1,2); reversing south has exactly one cell of room.
    const m = resolveMove(s, 0, 2, 9)!;
    expect(m.kind).toBe(MoveKind.Slide); // reversing toward the curb cut does not exit
    expect(m.distance).toBe(1);
    applyMove(s, m);
    expect(isCleared(s)).toBe(false);
  });
});

describe('oil slicks', () => {
  it('carries a vehicle onward until it leaves the slick', () => {
    const level = lot({
      w: 3,
      h: 7,
      vehicles: [car(0, 1, 1, 2), car(1, 1, 6, 2)],
      exits: [{ x: 0, y: 6, dir: 2 }],
      oil: [
        [1, 2],
        [1, 3],
      ],
    });
    const s = createLotState(level);
    const m = resolveMove(s, 0, 2, 1)!;
    // Asked for one cell; the slick carries the nose to y=4, the first dry cell.
    expect(m.distance).toBe(3);
    expect(m.slidExtra).toBe(2);
    applyMove(s, m);
    expect(s.y[0]).toBe(4);
  });

  it('shoots a vehicle out of the lot when the slick runs to the curb cut', () => {
    const level = lot({
      w: 3,
      h: 5,
      vehicles: [car(0, 1, 1, 2)],
      exits: [{ x: 1, y: 4, dir: 2 }],
      oil: [
        [1, 2],
        [1, 3],
        [1, 4],
      ],
    });
    const s = createLotState(level);
    const m = resolveMove(s, 0, 2, 1)!;
    expect(m.kind).toBe(MoveKind.Exit);
    expect(m.slidExtra).toBe(2);
  });

  it('stops on the first dry cell rather than running all the way out', () => {
    const level = lot({
      w: 3,
      h: 6,
      vehicles: [car(0, 1, 1, 2)],
      exits: [{ x: 1, y: 5, dir: 2 }],
      oil: [
        [1, 2],
        [1, 3],
      ],
    });
    const s = createLotState(level);
    const m = resolveMove(s, 0, 2, 1)!;
    expect(m.kind).toBe(MoveKind.Slide);
    expect(m.distance).toBe(3); // carried to (1,4), the first dry cell
    applyMove(s, m);
    expect(s.y[0]).toBe(4);
  });

  it('stops on the slick when the far side is blocked', () => {
    const level = lot({
      w: 3,
      h: 6,
      vehicles: [car(0, 1, 1, 2), car(1, 1, 4, 2)],
      exits: [{ x: 0, y: 5, dir: 2 }],
      oil: [[1, 2]],
    });
    const s = createLotState(level);
    const m = resolveMove(s, 0, 2, 1)!;
    expect(m.distance).toBe(1);
    applyMove(s, m);
    expect(s.y[0]).toBe(2);
  });
});

describe('roundabouts', () => {
  it('pivots a nosed vehicle in the plate spin direction', () => {
    const level = lot({
      w: 5,
      h: 5,
      vehicles: [car(0, 2, 2, 2)],
      exits: [{ x: 4, y: 2, dir: 1 }],
      roundabout: [[2, 2, -1]], // counter-clockwise: south → east
    });
    const s = createLotState(level);
    const cap = capability(s, 0);
    expect(cap.canPivot).toBe(true);
    expect(cap.pivotFacing).toBe(1);
    applyMove(s, resolvePivot(s, 0)!);
    expect(s.facing[0]).toBe(1);
    expect(s.occ[2 * 5 + 1]).toBe(0); // tail swung to the west
    expect(probe(s, 0, 1).exitDist).toBe(2);
  });

  it('refuses a pivot when the new lane is occupied', () => {
    const level = lot({
      w: 5,
      h: 5,
      vehicles: [car(0, 2, 2, 2), car(1, 1, 2, 1)],
      exits: [{ x: 4, y: 2, dir: 1 }],
      roundabout: [[2, 2, -1]],
    });
    const s = createLotState(level);
    expect(resolvePivot(s, 0)).toBeNull();
  });

  it('does not pivot off a plain road cell', () => {
    const level = lot({ w: 5, h: 5, vehicles: [car(0, 2, 2, 2)] });
    const s = createLotState(level);
    expect(resolvePivot(s, 0)).toBeNull();
  });
});

describe('state bookkeeping', () => {
  it('keeps occupancy consistent through a long random walk', () => {
    const level = lot({
      w: 6,
      h: 6,
      vehicles: [
        car(0, 1, 5, 2),
        car(1, 3, 5, 2),
        car(2, 5, 1, 1, VehicleKind.Van),
        car(3, 0, 3, 3),
      ],
      exits: [
        { x: 1, y: 5, dir: 2 },
        { x: 5, y: 0, dir: 0 },
      ],
    });
    const s = createLotState(level);
    let steps = 0;
    while (steps++ < 200) {
      const moves = legalMoves(s);
      if (moves.length === 0) break;
      applyMove(s, moves[steps % moves.length]);
      // Occupancy must always match the vehicles that are still on the lot.
      const rebuilt = cloneLotState(s);
      rebuilt.occ.fill(-1);
      for (let vi = 0; vi < s.x.length; vi++) {
        if (s.gone[vi]) continue;
        for (let k = 0; k < s.len[vi]; k++) {
          const dx = [0, 1, 0, -1][s.facing[vi]];
          const dy = [-1, 0, 1, 0][s.facing[vi]];
          rebuilt.occ[(s.y[vi] - dy * k) * level.w + (s.x[vi] - dx * k)] = vi;
        }
      }
      expect(Array.from(s.occ)).toEqual(Array.from(rebuilt.occ));
      if (s.remaining === 0) break;
    }
  });

  it('produces a distinct key per distinct state', () => {
    const level = lot({
      w: 4,
      h: 5,
      vehicles: [car(0, 1, 4, 2), car(1, 2, 4, 2)],
      exits: [{ x: 1, y: 4, dir: 2 }],
    });
    const a = createLotState(level);
    const b = cloneLotState(a);
    expect(stateKey(a)).toBe(stateKey(b));
    applyMove(b, resolveMove(b, 1, 0, 1)!);
    expect(stateKey(a)).not.toBe(stateKey(b));
  });

  it('lists exitable vehicles', () => {
    const level = lot({
      w: 3,
      h: 5,
      vehicles: [car(0, 1, 4, 2), car(1, 1, 2, 2)],
      exits: [{ x: 1, y: 4, dir: 2 }],
    });
    const s = createLotState(level);
    expect(exitableVehicles(s)).toEqual([0]);
  });
});
