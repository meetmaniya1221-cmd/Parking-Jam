/**
 * JamForge v2 — backward construction with repositioning.
 *
 * ## Why the old forge could only make easy lots
 *
 * v1 inserted each vehicle only at a spot from which it could *drive straight
 * off* given everything already placed, and then rejected any candidate that
 * did not admit a pure exit-only solution. Both halves of that are fatal:
 *
 * - Reversing the insertions yields a solution in which every car leaves in
 *   exactly one slide. No car is ever repositioned, so par always equalled the
 *   car count.
 * - Worse, exits only ever *free* cells. So driving one car off can never take
 *   away another car's ability to leave, which means if an exit-only solution
 *   exists then **tapping cars in any order at all clears the lot**. Every v1
 *   level, however deep its "knot depth" read, fell to no thought whatsoever.
 *
 * ## What v2 does instead
 *
 * Construction still runs backwards from the empty lot, because that is what
 * makes solvability structural rather than hoped-for. But there are now two
 * kinds of backward step, interleaved:
 *
 * - **un-exit**: introduce a car at a spot it could legally drive off from.
 *   Forward, this is that car exiting.
 * - **un-slide**: take a car already on the lot and shift it along its axis.
 *   Forward, this is that car being *repositioned* — a move that clears nothing
 *   and only exists to make room.
 *
 * Each backward step is validated against the real sim at the moment it is
 * taken, and that is exactly the state its forward inverse will run in, so the
 * reversed trace is a valid solution by construction. The trace is replayed
 * end-to-end as a belt-and-braces check before the level ships.
 *
 * Un-slides are chosen adversarially: the generator prefers shifts that park a
 * car across someone else's route, that strand the car it moved, and that cut
 * the number of cars able to leave right now. That is what forces the player to
 * plan a sequence instead of hunting for whatever currently has a clear lane.
 */

import { greedyOutcome, hasBlockingCycle } from './analysis';
import { Rng } from './rng';
import {
  applyMove,
  bodyFits,
  cloneLotState,
  exitableVehicles,
  inBounds,
  isCleared,
  probe,
  resolveMove,
  terrainAt,
} from './sim';
import {
  Dir,
  DX,
  DY,
  LevelDef,
  LotState,
  Move,
  MoveKind,
  OPPOSITE,
  Terrain,
  VehicleTag,
} from './types';

export interface ForgeRequest {
  /** Skeleton with terrain, arrows, exits and placeholder vehicles already set. */
  level: LevelDef;
  /** Lengths to place, in backward order (index 0 exits last). */
  lengths: number[];
  /** How many of the final placements are VIPs — they exit first, so go in last. */
  vips: number;
  /** How many repositioning moves to try to force into the solution. */
  scrambleTarget: number;
  /** Share of placements parked off the critical path. */
  distractorRatio: number;
  /** How many mutual-blocking rings to seed. Each one is a proof of hardness. */
  ringTarget: number;
  /**
   * How many cars may still be able to drive off once the lot is sealed.
   *
   * This is the setting that actually decides whether a jam is hard. A scramble
   * on its own is not enough: shifting a car still leaves it free to leave from
   * its new spot, so the repositioning is *optional* and a player who ignores it
   * clears the lot anyway. Sealing removes that escape hatch by stranding every
   * car that could still leave, until at most this many remain.
   */
  sealTo: number;
}

export const forgeStats = { calls: 0, shortPlacement: 0, replayBroke: 0, notCleared: 0, ok: 0, rings: 0 };

export interface ForgeResult {
  /** Final vehicle placements, in the order the skeleton expects. */
  placements: Array<{ x: number; y: number; facing: Dir; len: number; tags: number }>;
  /** A valid full solution for the built lot. */
  solution: Move[];
  /** Non-exit moves in that solution. */
  repositionMoves: number;
}

interface BackStep {
  kind: 'unexit' | 'unslide';
  vi: number;
  /** The forward move this step inverts. */
  move: Move;
}

/* ------------------------------------------------------------------ *
 * Board helpers
 * ------------------------------------------------------------------ */

/** Stamp a vehicle's cells into `occ`, or clear them. */
function stamp(s: LotState, vi: number, value: number): void {
  const w = s.level.w;
  const f = s.facing[vi] as Dir;
  for (let k = 0; k < s.len[vi]; k++) {
    const cx = s.x[vi] - DX[f] * k;
    const cy = s.y[vi] - DY[f] * k;
    s.occ[cy * w + cx] = value;
  }
}

/** Move an already-placed vehicle, keeping `occ` correct. */
function relocate(s: LotState, vi: number, x: number, y: number, facing: Dir): void {
  stamp(s, vi, -1);
  s.x[vi] = x;
  s.y[vi] = y;
  s.facing[vi] = facing;
  stamp(s, vi, vi);
}

/** Place a vehicle that was not on the lot yet. */
function introduce(s: LotState, vi: number, x: number, y: number, facing: Dir): void {
  s.gone[vi] = 0;
  s.x[vi] = x;
  s.y[vi] = y;
  s.facing[vi] = facing;
  stamp(s, vi, vi);
  s.remaining++;
  if (s.tags[vi] & VehicleTag.Vip) s.vipsRemaining++;
}

function withdraw(s: LotState, vi: number): void {
  stamp(s, vi, -1);
  s.gone[vi] = 1;
  s.remaining--;
  if (s.tags[vi] & VehicleTag.Vip) s.vipsRemaining--;
}

/** The exit move a vehicle would make right now, or null. */
function exitMoveFor(s: LotState, vi: number): Move | null {
  const f = s.facing[vi] as Dir;
  const p = probe(s, vi, f);
  if (p.exitDist < 0) return null;
  // A car already parked on the curb cut has zero on-lot travel, so the request
  // has to be at least one or `resolveMove` reads it as a no-op.
  return resolveMove(s, vi, f, Math.max(1, p.exitDist));
}

/**
 * Which car the previous backward step moved.
 *
 * Shifting the same car twice running reads, once reversed, as a car jiggling
 * back and forth for no reason — and it pads the move count without adding
 * anything to work out.
 */
function lastMoved(trace: readonly BackStep[]): number {
  const last = trace[trace.length - 1];
  return last && last.kind === 'unslide' ? last.vi : -1;
}

/* ------------------------------------------------------------------ *
 * Un-exit: introduce a car that could drive off
 * ------------------------------------------------------------------ */

interface Spot {
  x: number;
  y: number;
  facing: Dir;
  /** Vehicles already placed whose route this spot sits across. */
  blocks: number;
  /** Cells between this spot and its curb cut. */
  rayLen: number;
}

/**
 * Every placement from which a length-`len` vehicle could drive off right now.
 *
 * Sampled rather than exhaustive on large boards: the scramble loop calls this
 * repeatedly and the generator runs on the level-load path, so a full sweep of
 * every cell × facing is more precision than the choice needs.
 */
function exitReadySpots(s: LotState, vi: number, rng: Rng, cap: number): Spot[] {
  const level = s.level;
  const out: Spot[] = [];
  const cells: number[] = [];
  for (let i = 0; i < level.w * level.h; i++) cells.push(i);
  rng.shuffle(cells);

  for (const idx of cells) {
    const x = idx % level.w;
    const y = Math.floor(idx / level.w);
    for (let f = 0 as Dir; f < 4; f = (f + 1) as Dir) {
      if (!bodyFits(s, vi, x, y, f)) continue;
      // Trial-place, then ask the real sim whether it could leave.
      const wasGone = s.gone[vi];
      introduce(s, vi, x, y, f);
      const move = exitMoveFor(s, vi);
      let blocks = 0;
      let rayLen = 0;
      if (move) {
        rayLen = move.distance;
        blocks = countRoutesCrossed(s, vi);
      }
      withdraw(s, vi);
      s.gone[vi] = wasGone;
      if (move) out.push({ x, y, facing: f, blocks, rayLen });
    }
    if (out.length >= cap) break;
  }
  return out;
}

/** How many other vehicles' straight routes to the curb this vehicle sits on. */
function countRoutesCrossed(s: LotState, vi: number): number {
  let count = 0;
  for (let other = 0; other < s.x.length; other++) {
    if (other === vi || s.gone[other]) continue;
    const f = s.facing[other] as Dir;
    const limit = s.level.w + s.level.h;
    for (let step = 1; step <= limit; step++) {
      const cx = s.x[other] + DX[f] * step;
      const cy = s.y[other] + DY[f] * step;
      if (!inBounds(s.level, cx, cy)) break;
      if (terrainAt(s.level, cx, cy) === Terrain.Blocked) break;
      const occupant = s.occ[cy * s.level.w + cx];
      if (occupant === vi) {
        count++;
        break;
      }
      if (occupant !== -1) break;
    }
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Un-slide: strand a car that was ready to leave
 * ------------------------------------------------------------------ */

interface Shift {
  vi: number;
  x: number;
  y: number;
  /** The forward move that would undo this shift. */
  move: Move;
  score: number;
  /** True when the car cannot drive off from where this shift puts it. */
  strands: boolean;
  /** How many other cars' lanes this shift lands the car across. */
  crossings: number;
}

/**
 * Find shifts of already-placed cars whose forward inverse is a legal slide.
 *
 * Reversibility is *verified*, never assumed: an oil slick carries a car past
 * where it was aimed and a one-way refuses travel against it, so the only way
 * to know the return trip is legal is to make the sim resolve it.
 */
/**
 * Positions each car has already occupied during this build.
 *
 * Without this the forge produces solutions where two cars shuffle back and
 * forth past each other — A down, B up, A up, B down — because each shift looks
 * locally useful and the "not the same car twice running" guard only catches a
 * car repeating itself. Reversed into a solution that reads as pointless
 * jiggling, and worse, it inflates the repositioning count with moves that
 * accomplish nothing. A car may pass through a cell again, but the forge will
 * not *park* it somewhere it has already been.
 */
let visited = new Set<string>();

const seen = (vi: number, x: number, y: number) => `${vi}:${x}:${y}`;

function collectShifts(s: LotState, rng: Rng, sampleCap: number, only = -1): Shift[] {
  const out: Shift[] = [];
  const order: number[] = [];
  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    if (only >= 0 && vi !== only) continue;
    order.push(vi);
  }
  rng.shuffle(order);

  for (const vi of order) {
    const home = { x: s.x[vi], y: s.y[vi] };
    const facing = s.facing[vi] as Dir;

    for (const dir of [facing, OPPOSITE[facing]] as Dir[]) {
      const reach = probe(s, vi, dir);
      for (let d = 1; d <= reach.dist; d++) {
        const nx = home.x + DX[dir] * d;
        const ny = home.y + DY[dir] * d;
        relocate(s, vi, nx, ny, facing);

        // The forward inverse: slide back the way we came, landing exactly home.
        const back = OPPOSITE[dir];
        const move = resolveMove(s, vi, back, d);
        const lands = move && move.kind === MoveKind.Slide && move.toX === home.x && move.toY === home.y;

        // Only the two cheap facts are computed for every candidate. The
        // score needs a full exitable-set scan, and at hundreds of candidates
        // per shift that scan was the single most expensive thing in
        // generation — so it is deferred to the handful that get ranked.
        let strands = false;
        let crossings = 0;
        if (lands) {
          strands = probe(s, vi, facing).exitDist < 0;
          crossings = countRoutesCrossed(s, vi);
        }
        relocate(s, vi, home.x, home.y, facing);

        if (lands && move && !visited.has(seen(vi, nx, ny))) {
          out.push({ vi, x: nx, y: ny, move, score: 0, strands, crossings });
        }
      }
    }
    if (out.length >= sampleCap) break;
  }
  return out;
}

/**
 * How much harder this shift makes the lot.
 *
 * Three things earn points, and they are exactly the three complaints about v1
 * levels: too many cars can leave immediately, cars sit in nobody's way, and no
 * car ever has to move without leaving.
 */
function shiftScore(s: LotState, vi: number, baselineExits: number): number {
  const nowExits = exitableVehicles(s).length;
  const stranded = probe(s, vi, s.facing[vi] as Dir).exitDist < 0 ? 6 : 0;
  const crossings = countRoutesCrossed(s, vi);
  // Fewer cars able to leave is the single best proxy for "the player has to
  // work out what to do first".
  return (baselineExits - nowExits) * 8 + stranded + crossings * 3;
}

/* ------------------------------------------------------------------ *
 * The forge
 * ------------------------------------------------------------------ */

/**
 * Build a lot backwards, interleaving un-exits and un-slides.
 *
 * Returns null when the board could not take the requested shape — the caller
 * simply tries another seed.
 */
export function forgeScrambled(req: ForgeRequest, rng: Rng): ForgeResult | null {
  const total = req.lengths.length;
  if (total < 2) return null;

  const s = bareState(req.level, req.lengths);
  const trace: BackStep[] = [];
  visited = new Set<string>();
  const vipFrom = total - req.vips;

  // ---- 1. Placement -------------------------------------------------------
  //
  // Fill the lot the reliable way: every car goes somewhere it could drive
  // straight off from. Scrambling *during* this phase was the mistake in the
  // first cut — a shifted car consumes exactly the open lane the next
  // placement needs to be exit-ready, so the board would run dry and whole
  // levels fell back to a stub. Placement first, always; rearranging after.
  // Placement happens in blocks with rearranging in between, rather than all at
  // once. Both orders build the same kind of lot, but the *solution* differs:
  // do every shift after every placement and the player gets a run of
  // repositioning followed by a run of exits, which reads as two chores rather
  // than one puzzle. Interleaving produces what the game is actually about —
  // shift a car, clear a couple, find the next thing in the way.
  //
  // Placement always leads within a block. Scrambling first was the original
  // mistake: a shifted car consumes exactly the open lane the next placement
  // needs to be exit-ready, the board runs dry, and whole levels fall back to
  // a stub.
  const BLOCKS = 3;
  let placed = 0;
  let rings = 0;
  let scrambles = 0;
  const ringsPerBlock = Math.ceil(req.ringTarget / BLOCKS);
  const shiftsPerBlock = Math.ceil(req.scrambleTarget / BLOCKS);

  for (let block = 0; block < BLOCKS; block++) {
    const upTo = Math.round((total * (block + 1)) / BLOCKS);
    while (placed < upTo) {
      if (!tryPlace(s, rng, trace, placed, req, vipFrom)) break;
      placed++;
    }
    if (placed < 2) continue;

    // Rings are the one structure that makes a lot un-tappable — see `seedRing`.
    // Retry with fresh sampling: collectShifts samples rather than enumerating,
    // so a failure often means "these candidates did not close a loop", not
    // "this board cannot host one".
    for (let i = 0; i < ringsPerBlock && rings < req.ringTarget; i++) {
      if (!seedRingRetrying(s, rng, trace, 3)) break;
      rings++;
    }

    // Extra repositioning depth on top, so untangling takes a sequence rather
    // than one clever move.
    let made = 0;
    for (let guard = 0; guard < shiftsPerBlock * 3 && made < shiftsPerBlock; guard++) {
      if (!tryShift(s, rng, trace)) break;
      made++;
      scrambles++;
    }
  }
  if (placed < 2) return null;
  void scrambles;

  // The board has moved since the ring phase, so it is worth one more look —
  // shifts that were blocked before may have opened up.
  if (rings === 0 && req.ringTarget > 0 && seedRingRetrying(s, rng, trace, 3)) rings++;

  // ---- 4. Lock ------------------------------------------------------------
  lockUp(s, rng, trace, req.sealTo);

  // The forward solution is the trace read backwards.
  const solution = trace
    .slice()
    .reverse()
    .map((step) => step.move);

  // Belt and braces: replay through the real sim. Construction should make this
  // impossible to fail, which is exactly why it is worth checking.
  forgeStats.calls++;
  const replay = cloneLotState(s);
  for (const m of solution) {
    const before = replay.remaining;
    applyMove(replay, m);
    if (m.kind === MoveKind.Exit && replay.remaining !== before - 1) {
      forgeStats.replayBroke++;
      return null;
    }
  }
  if (!isCleared(replay)) {
    forgeStats.notCleared++;
    return null;
  }
  forgeStats.ok++;
  if (rings > 0) forgeStats.rings++;

  const placements = [];
  for (let vi = 0; vi < placed; vi++) {
    placements.push({
      x: s.x[vi],
      y: s.y[vi],
      facing: s.facing[vi] as Dir,
      len: s.len[vi],
      tags: s.tags[vi],
    });
  }

  return {
    placements,
    solution,
    repositionMoves: solution.filter((m) => m.kind !== MoveKind.Exit).length,
  };
}

function tryPlace(
  s: LotState,
  rng: Rng,
  trace: BackStep[],
  placed: number,
  req: ForgeRequest,
  vipFrom: number,
): boolean {
  const vi = placed;
  const spots = exitReadySpots(s, vi, rng, 40);
  if (spots.length === 0) return false;

  // Distractors park where they consume the least lane; everything else wants
  // to stand in somebody's way.
  const distractor = rng.next() < req.distractorRatio;
  const score = (sp: Spot) => (distractor ? -sp.rayLen : sp.blocks * 10 + sp.rayLen);
  let best = spots[0];
  let bestScore = -Infinity;
  for (const sp of spots) {
    const value = score(sp) + rng.next();
    if (value > bestScore) {
      bestScore = value;
      best = sp;
    }
  }

  if (placed >= vipFrom && req.vips > 0) s.tags[vi] |= VehicleTag.Vip;
  introduce(s, vi, best.x, best.y, best.facing);
  const move = exitMoveFor(s, vi);
  if (!move) {
    withdraw(s, vi);
    return false;
  }
  visited.add(seen(vi, best.x, best.y));
  trace.push({ kind: 'unexit', vi, move });
  return true;
}

/**
 * Keep shifting until the lot can no longer be cleared by exits alone.
 *
 * This is the step that decides whether a jam is actually hard, and it is worth
 * stating exactly why it has to exist.
 *
 * A car's route to the curb is a *fixed* line of cells — a car only ever leaves
 * straight along its facing, so "A is parked in B's way" is a static relation.
 * A lot can therefore be cleared by exits alone precisely when that relation is
 * **acyclic** and every car's lane is terrain-passable: repeatedly drive off
 * whichever car has nobody left in front of it.
 *
 * That has a sharp consequence, and it is the one the first attempt at this
 * missed. Scrambling the board is not enough, and neither is leaving only one
 * car able to move at the start — greedy just *cascades*: clear that one, which
 * frees the next, and so on to the end. What actually defeats it is a **cycle**:
 * A parked across B's lane while B is parked across A's. Neither can ever leave
 * until one of them is shifted aside, and no amount of tapping will do it.
 *
 * So this pass hunts for shifts that break the ordering — creating a cycle, or
 * stranding a car against a wall, which is the degenerate one-car version — and
 * keeps going until a greedy run genuinely fails. Being the last backward
 * steps, they become the first forward moves: the player opens on a lot that
 * has to be untangled rather than drained.
 *
 * Best-effort. A board with no room left keeps whatever it has, and the caller
 * rejects the candidate if that misses its tier.
 */
function lockUp(s: LotState, rng: Rng, trace: BackStep[], sealTo: number): void {
  const budget = Math.max(6, s.x.length);

  for (let guard = 0; guard < budget; guard++) {
    const before = greedyOutcome(s);
    const openNow = exitableVehicles(s).length;
    // Done once tapping alone cannot finish the lot and the opening is as tight
    // as the tier asked for.
    if (!before.solves && openNow <= sealTo) return;

    const shifts = collectShifts(s, rng, 90)
      .filter((sh) => sh.vi !== lastMoved(trace))
      .filter((sh) => sh.strands || sh.crossings > 0)
      .slice(0, 24);
    let best: Shift | null = null;
    let bestCleared = before.cleared;
    let bestOpen = openNow;
    let bestRing = false;

    for (const sh of shifts) {
      // Only shifts that could plausibly break the ordering are worth scoring:
      // one that neither strands its car nor parks it across somebody's lane
      // cannot introduce a ring.
      if (!sh.strands && sh.crossings === 0) continue;

      const home = { x: s.x[sh.vi], y: s.y[sh.vi] };
      const facing = s.facing[sh.vi] as Dir;
      relocate(s, sh.vi, sh.x, sh.y, facing);
      const ring = hasBlockingCycle(s);
      const after = greedyOutcome(s);
      const afterOpen = exitableVehicles(s).length;
      relocate(s, sh.vi, home.x, home.y, facing);

      // A ring beats everything: it is a proof the lot cannot be tapped out.
      // Otherwise prefer whichever shift leaves greedy stuck earliest, then a
      // tighter opening.
      const better = bestRing
        ? ring && after.cleared < bestCleared
        : ring ||
          after.cleared < bestCleared ||
          (after.cleared === bestCleared && afterOpen < bestOpen);
      if (better) {
        best = sh;
        bestCleared = after.cleared;
        bestOpen = afterOpen;
        bestRing = bestRing || ring;
      }
    }

    if (!best) {
      // No single shift helps. A ring usually needs two coordinated moves — A
      // across B's lane *and* B across A's — and neither half looks like an
      // improvement on its own, so a one-step hill climb never finds one.
      if (forceRing(s, rng, trace, shifts)) continue;
      return;
    }
    visited.add(seen(best.vi, s.x[best.vi], s.y[best.vi]));
    relocate(s, best.vi, best.x, best.y, s.facing[best.vi] as Dir);
    trace.push({ kind: 'unslide', vi: best.vi, move: best.move });
  }
}


/** Try `tries` times with fresh sampling before concluding the board cannot host a ring. */
function seedRingRetrying(s: LotState, rng: Rng, trace: BackStep[], tries: number): boolean {
  for (let i = 0; i < tries; i++) if (seedRing(s, rng, trace)) return true;
  return false;
}

/**
 * Deliberately park two cars across each other's lanes.
 *
 * Tries every shift of every car, and for each one that lands across somebody's
 * lane, looks for a second shift that closes the loop. Neither half is an
 * improvement on its own — which is precisely why a one-step search never finds
 * a ring — so both are committed together or not at all.
 *
 * Cheap here because it runs while few cars are placed; the same search on a
 * full board is both slower and nearly always fruitless.
 */
function seedRing(s: LotState, rng: Rng, trace: BackStep[]): boolean {
  if (hasBlockingCycle(s)) return true;
  const first = collectShifts(s, rng, 400).filter((sh) => sh.vi !== lastMoved(trace));

  for (const a of first) {
    const homeA = { x: s.x[a.vi], y: s.y[a.vi] };
    const fa = s.facing[a.vi] as Dir;
    relocate(s, a.vi, a.x, a.y, fa);

    if (hasBlockingCycle(s)) {
      visited.add(seen(a.vi, homeA.x, homeA.y));
      trace.push({ kind: 'unslide', vi: a.vi, move: a.move });
      return true;
    }

    for (const b of collectShifts(s, rng, 200)) {
      if (b.vi === a.vi) continue;
      const homeB = { x: s.x[b.vi], y: s.y[b.vi] };
      const fb = s.facing[b.vi] as Dir;
      relocate(s, b.vi, b.x, b.y, fb);
      if (hasBlockingCycle(s)) {
        visited.add(seen(a.vi, homeA.x, homeA.y));
        visited.add(seen(b.vi, homeB.x, homeB.y));
        trace.push({ kind: 'unslide', vi: a.vi, move: a.move });
        trace.push({ kind: 'unslide', vi: b.vi, move: b.move });
        return true;
      }
      relocate(s, b.vi, homeB.x, homeB.y, fb);
    }

    relocate(s, a.vi, homeA.x, homeA.y, fa);
  }
  return false;
}

/**
 * Build a ring out of two shifts that are each useless alone.
 *
 * Takes any shift that parks a car across somebody's lane, commits it, and then
 * looks for a second shift that closes the loop. Both are recorded, so the
 * player has to undo both — in the right order.
 */
function forceRing(s: LotState, rng: Rng, trace: BackStep[], shifts: readonly Shift[]): boolean {
  for (const first of shifts) {
    if (first.crossings === 0) continue;
    const home = { x: s.x[first.vi], y: s.y[first.vi] };
    const facing = s.facing[first.vi] as Dir;
    relocate(s, first.vi, first.x, first.y, facing);

    for (const second of collectShifts(s, rng, 50)) {
      if (second.vi === first.vi) continue;
      if (second.crossings === 0) continue;
      const h2 = { x: s.x[second.vi], y: s.y[second.vi] };
      const f2 = s.facing[second.vi] as Dir;
      relocate(s, second.vi, second.x, second.y, f2);
      if (hasBlockingCycle(s)) {
        trace.push({ kind: 'unslide', vi: first.vi, move: first.move });
        trace.push({ kind: 'unslide', vi: second.vi, move: second.move });
        return true;
      }
      relocate(s, second.vi, h2.x, h2.y, f2);
    }

    relocate(s, first.vi, home.x, home.y, facing);
  }
  return false;
}

function tryShift(s: LotState, rng: Rng, trace: BackStep[]): boolean {
  const shifts = collectShifts(s, rng, 30).filter((sh) => sh.vi !== lastMoved(trace));
  if (shifts.length === 0) return false;

  // Never trade away a ring for a better-scoring shift. This phase runs after
  // the rings are seeded and picks on score alone, so without the guard it
  // happily dismantles the one structure that makes the lot un-tappable — and
  // it gets a dozen chances to do so.
  const hadRing = hasBlockingCycle(s);

  // Rank only a shortlist, cheapest signal first.
  const shortlist = shifts
    .slice()
    .sort((a, b) => b.crossings + (b.strands ? 3 : 0) - (a.crossings + (a.strands ? 3 : 0)))
    .slice(0, 12);
  const baselineExits = exitableVehicles(s).length;
  for (const sh of shortlist) {
    const home0 = { x: s.x[sh.vi], y: s.y[sh.vi] };
    const f0 = s.facing[sh.vi] as Dir;
    relocate(s, sh.vi, sh.x, sh.y, f0);
    sh.score = shiftScore(s, sh.vi, baselineExits);
    relocate(s, sh.vi, home0.x, home0.y, f0);
  }

  let best: Shift | null = null;
  for (const sh of shortlist) {
    if (hadRing) {
      const home = { x: s.x[sh.vi], y: s.y[sh.vi] };
      const facing = s.facing[sh.vi] as Dir;
      relocate(s, sh.vi, sh.x, sh.y, facing);
      const keeps = hasBlockingCycle(s);
      relocate(s, sh.vi, home.x, home.y, facing);
      if (!keeps) continue;
    }
    if (!best || sh.score > best.score) best = sh;
  }
  if (!best) return false;

  visited.add(seen(best.vi, s.x[best.vi], s.y[best.vi]));
  relocate(s, best.vi, best.x, best.y, s.facing[best.vi] as Dir);
  trace.push({ kind: 'unslide', vi: best.vi, move: best.move });
  return true;
}

/** A LotState over the skeleton, with nothing placed yet. */
function bareState(level: LevelDef, lengths: readonly number[]): LotState {
  const n = lengths.length;
  const s: LotState = {
    level,
    ids: new Int32Array(n),
    x: new Int16Array(n),
    y: new Int16Array(n),
    facing: new Uint8Array(n),
    len: new Uint8Array(n),
    tags: new Uint8Array(n),
    gone: new Uint8Array(n),
    occ: new Int16Array(level.w * level.h).fill(-1),
    remaining: 0,
    vipsRemaining: 0,
    slides: 0,
    bumps: 0,
  };
  for (let i = 0; i < n; i++) {
    s.ids[i] = i;
    s.len[i] = lengths[i];
    s.gone[i] = 1;
  }
  return s;
}
