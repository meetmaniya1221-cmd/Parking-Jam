/**
 * Canvas rendering for the lot (GDD §12 "Visual Direction").
 *
 * A stylised toy diorama in 2D. The camera is very nearly top-down — the tilt
 * is foreshortening only, never enough to hide a cell — so every solid object
 * is built the same way: a base footprint, a lifted top face, and the side
 * faces between them, lit by one warm key from the upper left.
 *
 * A vehicle is not one brick but a stack of volumes: a lower body, then a
 * greenhouse, cargo box or roof sign on top of it. That stack is what gives
 * each class a silhouette you can name at a glance, which matters more here
 * than colour ever can — the player has to count and identify cars in a packed
 * lot, sometimes in a colourblind remap, sometimes by headlight alone.
 *
 * Cost is controlled in two places: the ground is baked to an offscreen canvas
 * and blitted, and a vehicle that is not mid-bump is blitted from a cached
 * sprite. A still frame is therefore one ground image plus one image per car.
 */

import {
  Dir,
  DX,
  DY,
  ExitDef,
  LevelDef,
  Terrain,
  VehicleKind,
  VehicleTag,
} from '../core/types';
import { makeRng, quad, resetSprites, roundRect, sprite, stampGrain } from './paint';
import { Palette, shade, withAlpha } from './theme';

/** Vertical foreshortening — enough parallax to feel dimensional, never enough to hide a cell. */
export const CELL_ASPECT = 0.92;
/**
 * Inset of a vehicle body inside its cells, in cell units. Bumper-to-bumper
 * cars need a visible seam or a column of same-coloured cars reads as one long
 * block, which destroys the count.
 */
const BODY_MARGIN = 0.1;
/** How far a top face is inset from the base it sits on, in cell units — the bevel. */
const BEVEL = 0.07;

/**
 * Total extrusion height in cell units, shared between the body and whatever
 * rides on top of it.
 *
 * Kept deliberately low: a lifted top face is drawn *above* its own cells, so a
 * tall car covers the one parked behind it. Enough height to read as a solid
 * object, not so much that it hides a neighbour.
 */
const VEHICLE_HEIGHT: Record<VehicleKind, number> = {
  [VehicleKind.Sedan]: 0.3,
  [VehicleKind.Taxi]: 0.32,
  [VehicleKind.Coupe]: 0.27,
  [VehicleKind.Van]: 0.38,
  [VehicleKind.BoxTruck]: 0.44,
  [VehicleKind.Trailer]: 0.36,
  [VehicleKind.Bus]: 0.46,
  [VehicleKind.Ambulance]: 0.4,
};

/** Share of the height budget spent on the lower body; the rest is the stack above. */
const BODY_SHARE = 0.58;

/**
 * An upper volume, in body-relative coordinates: `from`/`to` run tail (0) to
 * nose (1), `inset` eats into each side as a fraction of the half-width, and
 * `lift` scales the remaining height budget.
 */
interface Volume {
  from: number;
  to: number;
  inset: number;
  lift: number;
  /** A glass canopy rather than a solid panel. */
  glass: boolean;
}

/**
 * The silhouette table. This is where a bus stops looking like a long sedan:
 * a cab-plus-box truck, a nearly-full-length coach greenhouse and a stubby
 * coupe cabin are different objects even in pure silhouette.
 */
const VOLUMES: Record<VehicleKind, readonly Volume[]> = {
  [VehicleKind.Sedan]: [{ from: 0.24, to: 0.66, inset: 0.34, lift: 1, glass: true }],
  [VehicleKind.Taxi]: [
    { from: 0.24, to: 0.66, inset: 0.34, lift: 1, glass: true },
    // Roof sign: small, tall, unmistakable.
    { from: 0.41, to: 0.55, inset: 0.62, lift: 1.5, glass: false },
  ],
  [VehicleKind.Coupe]: [{ from: 0.2, to: 0.58, inset: 0.36, lift: 0.95, glass: true }],
  [VehicleKind.Van]: [{ from: 0.14, to: 0.8, inset: 0.2, lift: 1, glass: true }],
  [VehicleKind.BoxTruck]: [
    { from: 0.06, to: 0.56, inset: 0.12, lift: 1.2, glass: false },
    { from: 0.6, to: 0.88, inset: 0.28, lift: 0.8, glass: true },
  ],
  [VehicleKind.Trailer]: [
    { from: 0.06, to: 0.6, inset: 0.22, lift: 0.45, glass: false },
    { from: 0.64, to: 0.9, inset: 0.26, lift: 1.05, glass: true },
  ],
  [VehicleKind.Bus]: [{ from: 0.08, to: 0.9, inset: 0.18, lift: 1, glass: true }],
  [VehicleKind.Ambulance]: [
    { from: 0.06, to: 0.54, inset: 0.12, lift: 1.1, glass: false },
    { from: 0.58, to: 0.86, inset: 0.28, lift: 0.85, glass: true },
  ],
};

export interface Camera {
  /** Screen x of the lot's left edge. */
  ox: number;
  /** Screen y of the lot's top edge. */
  oy: number;
  cw: number;
  ch: number;
}

export interface VehicleView {
  vi: number;
  kind: VehicleKind;
  len: number;
  facing: Dir;
  /** Nose position in float cell coordinates. */
  gx: number;
  gy: number;
  color: string;
  tags: number;
  /** 0 = at rest, 1 = fully squashed by a bump. */
  squash: number;
  /** Body tilt in cell units, applied to the lifted top face. */
  leanX: number;
  leanY: number;
  /** Radians of wobble applied after a bump. */
  wobble: number;
  alpha: number;
  /** 0–1 selection glow. */
  highlight: number;
  /** 0–1 dispatcher-hint pulse. */
  hint: number;
  /** 0–1 blocker flash: "this is the car that said no". */
  flash: number;
  /** True for the player's equipped Ride. */
  isRide: boolean;
}

export interface PathPreview {
  cells: Array<{ x: number; y: number }>;
  /** Cell that stops the slide, drawn coral. */
  blocked: { x: number; y: number } | null;
  exits: boolean;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: 'dust' | 'confetti' | 'spark' | 'ring';
}

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

/**
 * Smallest cell the game will draw before it starts panning instead.
 *
 * A car is two cells long, so its *short* axis is one cell wide and that is
 * what a thumb has to land on in a packed lot. Thirty CSS pixels is about the
 * floor for that; below it, picking the right car out of a crowd stops being a
 * puzzle and starts being a dexterity test, which is not the game.
 */
export const MIN_CELL_PX = 30;

/**
 * …tempered by the screen actually in front of the player. On a genuinely small
 * viewport, holding the floor would push most of the lot off-screen and cost
 * more than the small cells did — so the floor gives way rather than the board.
 */
export function comfortableCell(widthPx: number, heightPx: number): number {
  return Math.max(18, Math.min(MIN_CELL_PX, Math.min(widthPx, heightPx) / 9));
}

export interface CameraFit extends Camera {
  /** True when the lot is wider or taller than the viewport at this cell size. */
  overflow: boolean;
  /** Cell width at which the whole lot would be visible at once. */
  fitCw: number;
}

/**
 * Place the lot in the viewport.
 *
 * Cells are sized to fit unless that would take them below `minCell`, in which
 * case the lot is drawn at the floor and the caller pans. Early lots are small
 * enough that this never triggers and the board simply sits centred, exactly as
 * it always has; it is the twelve- and thirteen-column late lots on a phone
 * that need the other branch.
 */
export function fitCamera(
  level: LevelDef,
  widthPx: number,
  heightPx: number,
  padding: number,
  minCell = 0,
): CameraFit {
  const availableW = Math.max(32, widthPx - padding * 2);
  const availableH = Math.max(32, heightPx - padding * 2);
  const fitCw = Math.min(availableW / level.w, availableH / (level.h * CELL_ASPECT));
  // Give the floor a little rather than start panning over a few pixels: a lot
  // that *nearly* fits is far better shown whole at slightly tighter cells than
  // shown at the comfort size with one column hanging off the edge.
  const cw = fitCw >= minCell * 0.92 ? fitCw : Math.max(fitCw, minCell);
  const ch = cw * CELL_ASPECT;
  const boardW = level.w * cw;
  const boardH = level.h * ch;
  return {
    ox: (widthPx - boardW) / 2,
    oy: (heightPx - boardH) / 2,
    cw,
    ch,
    overflow: boardW > availableW + 0.5 || boardH > availableH + 0.5,
    fitCw,
  };
}

/** Which cell a screen point falls in; may be outside the lot. */
export function screenToCell(cam: Camera, x: number, y: number): { x: number; y: number } {
  return { x: Math.floor((x - cam.ox) / cam.cw), y: Math.floor((y - cam.oy) / cam.ch) };
}

/** Cell-space bounds of a vehicle body, before any bevel or margin. */
export function vehicleBounds(v: { gx: number; gy: number; facing: Dir; len: number }) {
  const dx = DX[v.facing];
  const dy = DY[v.facing];
  const tailX = v.gx - dx * (v.len - 1);
  const tailY = v.gy - dy * (v.len - 1);
  return {
    x0: Math.min(v.gx, tailX),
    y0: Math.min(v.gy, tailY),
    x1: Math.max(v.gx, tailX) + 1,
    y1: Math.max(v.gy, tailY) + 1,
  };
}

/* ------------------------------------------------------------------ *
 * Ground
 * ------------------------------------------------------------------ */

/** Merge adjacent curb cuts on the same edge into runs, for drawing wide frontages. */
function exitRuns(exits: readonly ExitDef[]): Array<{ dir: Dir; from: number; to: number; fixed: number }> {
  const byDir = new Map<Dir, ExitDef[]>();
  for (const e of exits) {
    const list = byDir.get(e.dir) ?? [];
    list.push(e);
    byDir.set(e.dir, list);
  }
  const runs: Array<{ dir: Dir; from: number; to: number; fixed: number }> = [];
  for (const [dir, list] of byDir) {
    const along = (e: ExitDef) => (dir === 0 || dir === 2 ? e.x : e.y);
    const fixed = (e: ExitDef) => (dir === 0 || dir === 2 ? e.y : e.x);
    list.sort((a, b) => along(a) - along(b));
    let start = along(list[0]);
    let prev = start;
    for (let i = 1; i <= list.length; i++) {
      const current = i < list.length ? along(list[i]) : Number.NaN;
      if (current !== prev + 1) {
        runs.push({ dir, from: start, to: prev, fixed: fixed(list[0]) });
        start = current;
      }
      prev = current;
    }
  }
  return runs;
}

export function drawGround(
  ctx: CanvasRenderingContext2D,
  level: LevelDef,
  cam: Camera,
  palette: Palette,
): void {
  // The ground is only rebaked when the palette or the layout changes, which is
  // exactly when a cached vehicle sprite has also gone stale.
  resetSprites();

  const { cw, ch, ox, oy } = cam;
  const w = level.w * cw;
  const h = level.h * ch;
  const radius = cw * 0.16;
  // Decoration has to land identically on every rebake, or rotating the phone
  // would reshuffle every stain on the lot.
  const rnd = makeRng(level.w * 73856093 + level.h * 19349663 + level.exits.length * 83492791);

  drawKerb(ctx, cam, level, palette);

  // Asphalt slab.
  const slab = ctx.createLinearGradient(ox, oy - ch, ox + w * 0.25, oy + h);
  slab.addColorStop(0, palette.asphaltLight);
  slab.addColorStop(0.55, palette.asphalt);
  slab.addColorStop(1, shade(palette.asphalt, -0.12));
  ctx.fillStyle = slab;
  roundRect(ctx, ox, oy, w, h, radius);
  ctx.fill();

  ctx.save();
  roundRect(ctx, ox, oy, w, h, radius);
  ctx.clip();

  paintGrain(ctx, ox, oy, w, h, cw, 0.38);
  paintStains(ctx, ox, oy, w, h, cw, ch, rnd);
  paintBayLines(ctx, level, cam, palette);
  paintScuffs(ctx, ox, oy, w, h, cw, ch, rnd, palette);
  // Light spilling in from each opening. Inside the clip on purpose: spilling
  // it outward instead tints the kerb, and a lot with frontage on every side
  // ends up wearing a mint halo.
  for (const run of exitRuns(level.exits)) paintExitGlow(ctx, run, cam, palette);

  // Ambient occlusion at the slab edge: concentric strokes falling off inward.
  // Cheaper than a blur and it is what seats the lot into the street.
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = withAlpha(palette.ink, 0.16 * (1 - i / 3));
    ctx.lineWidth = cw * 0.11;
    roundRect(ctx, ox + i * cw * 0.09, oy + i * ch * 0.09, w - i * cw * 0.18, h - i * ch * 0.18, radius);
    ctx.stroke();
  }

  // Vignette — corners a touch heavier than the middle, so the eye lands centre.
  const vignette = ctx.createRadialGradient(
    ox + w / 2,
    oy + h * 0.42,
    Math.min(w, h) * 0.28,
    ox + w / 2,
    oy + h / 2,
    Math.max(w, h) * 0.72,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, withAlpha(palette.ink, 0.3));
  ctx.fillStyle = vignette;
  ctx.fillRect(ox, oy, w, h);
  ctx.restore();

  // Cell furniture.
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const idx = y * level.w + x;
      const cx = ox + x * cw;
      const cy = oy + y * ch;
      const terrain = level.terrain[idx];
      if (terrain === Terrain.Oil) drawOil(ctx, cx, cy, cw, ch, palette);
      else if (terrain === Terrain.Roundabout)
        drawRoundabout(ctx, cx, cy, cw, ch, level.roundaboutSpin[idx], palette);
      const arrow = level.arrows[idx];
      if (arrow >= 0) drawArrow(ctx, cx, cy, cw, ch, arrow as Dir, palette);
    }
  }

  // Curb cuts, drawn as merged runs so a wide frontage reads as one opening.
  for (const run of exitRuns(level.exits)) drawCurbCut(ctx, run, cam, palette);

  // Static blockers sit above the paint.
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const idx = y * level.w + x;
      if (level.terrain[idx] !== Terrain.Blocked) continue;
      drawBlocker(ctx, ox + x * cw, oy + y * ch, cw, ch, level.blockerStyle[idx], palette);
    }
  }
}

/** Street apron and the raised concrete lip the lot sits inside. */
function drawKerb(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  level: LevelDef,
  palette: Palette,
): void {
  const { cw, ch, ox, oy } = cam;
  const w = level.w * cw;
  const h = level.h * ch;
  const lip = cw * 0.2;
  const apron = cw * 0.42;

  // Street beyond the kerb. No grain pass here: the kerb and slab cover all but
  // a few pixels of it, and stamping the pattern over the whole footprint just
  // to have it overdrawn is the single most expensive thing in this bake.
  ctx.fillStyle = shade(palette.asphaltDeep, -0.18);
  roundRect(ctx, ox - apron, oy - apron, w + apron * 2, h + apron * 2, cw * 0.36);
  ctx.fill();

  // The kerb face, dropped down-screen so the lip reads as a solid edge.
  ctx.fillStyle = shade(palette.sand, -0.66);
  roundRect(ctx, ox - lip, oy - lip + ch * 0.08, w + lip * 2, h + lip * 2, cw * 0.2);
  ctx.fill();

  // Kerb top: weathered concrete, not fresh cream. It frames the lot, so it has
  // to stay quieter than every car standing on it.
  const top = ctx.createLinearGradient(ox, oy - lip, ox, oy + h + lip);
  top.addColorStop(0, shade(palette.sand, -0.3));
  top.addColorStop(1, shade(palette.sand, -0.5));
  ctx.fillStyle = top;
  roundRect(ctx, ox - lip, oy - lip, w + lip * 2, h + lip * 2, cw * 0.2);
  ctx.fill();
}

/** Stamp the asphalt aggregate over a rect, tied to cell size so it holds density at any zoom. */
function paintGrain(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cw: number,
  alpha: number,
): void {
  // Aggregate should grow with the lot but not track it one-for-one: scaled
  // linearly with the cell it turns into visible static on a small grid.
  stampGrain(ctx, x, y, w, h, Math.max(0.5, Math.min(1.15, cw / 78)), alpha);
}

/** Weathering: old spills and patched repairs, kept far below the paint in contrast. */
function paintStains(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  w: number,
  h: number,
  cw: number,
  ch: number,
  rnd: () => number,
): void {
  for (let i = 0; i < 7; i++) {
    const cx = ox + rnd() * w;
    const cy = oy + rnd() * h;
    const r = cw * (0.4 + rnd() * 1.1);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const dark = rnd() < 0.65;
    g.addColorStop(0, dark ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.05)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * (ch / cw) * (0.7 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Tyre scuff: shallow arcs where cars have swung out of a bay for years. */
function paintScuffs(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  w: number,
  h: number,
  cw: number,
  ch: number,
  rnd: () => number,
  palette: Palette,
): void {
  ctx.save();
  ctx.strokeStyle = withAlpha(palette.ink, 0.09);
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const cx = ox + rnd() * w;
    const cy = oy + rnd() * h;
    const r = cw * (0.8 + rnd() * 1.6);
    const from = rnd() * Math.PI * 2;
    ctx.lineWidth = cw * (0.05 + rnd() * 0.05);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, ch / cw);
    ctx.beginPath();
    ctx.arc(0, 0, r, from, from + 0.7 + rnd() * 0.9);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** Bay markings: worn stall paint, drawn twice so the edges read as chipped. */
function paintBayLines(
  ctx: CanvasRenderingContext2D,
  level: LevelDef,
  cam: Camera,
  palette: Palette,
): void {
  const { cw, ch, ox, oy } = cam;
  const h = level.h * ch;

  ctx.save();
  ctx.lineCap = 'round';

  // Stall separators between columns.
  for (let x = 1; x < level.w; x++) {
    const px = ox + x * cw;
    ctx.strokeStyle = withAlpha(palette.ink, 0.2);
    ctx.lineWidth = Math.max(1, cw * 0.05);
    ctx.setLineDash([ch * 0.34, ch * 0.26]);
    ctx.beginPath();
    ctx.moveTo(px + cw * 0.02, oy + ch * 0.14);
    ctx.lineTo(px + cw * 0.02, oy + h - ch * 0.1);
    ctx.stroke();

    ctx.strokeStyle = withAlpha(palette.lanePaint, 0.34);
    ctx.lineWidth = Math.max(1, cw * 0.04);
    ctx.beginPath();
    ctx.moveTo(px, oy + ch * 0.14);
    ctx.lineTo(px, oy + h - ch * 0.1);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Bay-end ticks: short stubs at each row line, which is what makes the grid
  // read as parking bays rather than as graph paper.
  ctx.strokeStyle = withAlpha(palette.lanePaint, 0.16);
  ctx.lineWidth = Math.max(1, cw * 0.035);
  for (let y = 1; y < level.h; y++) {
    const py = oy + y * ch;
    for (let x = 0; x < level.w; x++) {
      const px = ox + x * cw;
      ctx.beginPath();
      ctx.moveTo(px + cw * 0.3, py);
      ctx.lineTo(px + cw * 0.7, py);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Light spilling from an opening onto the asphalt just inside it. */
function paintExitGlow(
  ctx: CanvasRenderingContext2D,
  run: { dir: Dir; from: number; to: number; fixed: number },
  cam: Camera,
  palette: Palette,
): void {
  const { cw, ch, ox, oy } = cam;
  const horizontal = run.dir === 0 || run.dir === 2;
  // Inward is away from the edge the opening sits on.
  const inward = run.dir === 0 || run.dir === 3 ? 1 : -1;
  const reach = (horizontal ? ch : cw) * 0.6;
  const edge = horizontal
    ? oy + (run.dir === 2 ? run.fixed + 1 : run.fixed) * ch
    : ox + (run.dir === 1 ? run.fixed + 1 : run.fixed) * cw;

  const glow = horizontal
    ? ctx.createLinearGradient(0, edge, 0, edge + reach * inward)
    : ctx.createLinearGradient(edge, 0, edge + reach * inward, 0);
  glow.addColorStop(0, withAlpha(palette.mintLight, 0.22));
  glow.addColorStop(1, withAlpha(palette.mintLight, 0));
  ctx.fillStyle = glow;

  if (horizontal) {
    ctx.fillRect(ox + run.from * cw, inward > 0 ? edge : edge - reach, (run.to - run.from + 1) * cw, reach);
  } else {
    ctx.fillRect(inward > 0 ? edge : edge - reach, oy + run.from * ch, reach, (run.to - run.from + 1) * ch);
  }
}

function drawCurbCut(
  ctx: CanvasRenderingContext2D,
  run: { dir: Dir; from: number; to: number; fixed: number },
  cam: Camera,
  palette: Palette,
): void {
  const { cw, ch, ox, oy } = cam;
  const horizontal = run.dir === 0 || run.dir === 2;
  const thickness = ch * 0.3;

  let x: number;
  let y: number;
  let width: number;
  let height: number;
  if (horizontal) {
    x = ox + run.from * cw;
    width = (run.to - run.from + 1) * cw;
    height = thickness;
    y = run.dir === 2 ? oy + (run.fixed + 1) * ch - thickness : oy + run.fixed * ch;
  } else {
    y = oy + run.from * ch;
    height = (run.to - run.from + 1) * ch;
    width = thickness;
    x = run.dir === 1 ? ox + (run.fixed + 1) * cw - thickness : ox + run.fixed * cw;
  }

  // Hazard stripes on a concrete apron.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = withAlpha(palette.lemon, 0.92);
  ctx.fillRect(x, y, width, height);
  // Stripes have to lean across the *narrow* axis of the opening. Marching them
  // along the long axis for both orientations makes a vertical curb cut's
  // "diagonals" almost parallel to it, and it reads as a solid yellow wall.
  ctx.strokeStyle = withAlpha(palette.ink, 0.55);
  ctx.lineWidth = thickness * 0.42;
  const step = thickness * 1.05;
  const span = Math.max(width, height) + thickness * 2;
  for (let i = -span; i < span; i += step) {
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(x + i, y - thickness);
      ctx.lineTo(x + i + thickness * 2, y + height + thickness);
    } else {
      ctx.moveTo(x - thickness, y + i);
      ctx.lineTo(x + width + thickness, y + i + thickness * 2);
    }
    ctx.stroke();
  }
  // A lit top edge so the apron reads as a raised threshold, not a decal.
  ctx.fillStyle = withAlpha(palette.cream, 0.3);
  ctx.fillRect(x, y, horizontal ? width : thickness * 0.22, horizontal ? thickness * 0.22 : height);
  ctx.restore();
}

function drawOil(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cw: number,
  ch: number,
  palette: Palette,
): void {
  const cx = x + cw / 2;
  const cy = y + ch / 2;
  const g = ctx.createRadialGradient(cx, cy, cw * 0.06, cx, cy, cw * 0.46);
  g.addColorStop(0, 'rgba(28, 18, 46, 0.92)');
  g.addColorStop(0.55, 'rgba(52, 34, 78, 0.8)');
  g.addColorStop(1, 'rgba(52, 34, 78, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, cw * 0.44, ch * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Iridescent sheen — texture, so the slick reads without relying on colour.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const sheen = [palette.sky, palette.mint, palette.coral];
  ctx.lineWidth = Math.max(1, cw * 0.03);
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = withAlpha(sheen[i], 0.22);
    ctx.beginPath();
    ctx.ellipse(cx, cy, cw * (0.12 + i * 0.11), ch * (0.09 + i * 0.1), 0.6, 0, Math.PI * 1.5);
    ctx.stroke();
  }
  ctx.restore();

  // A wet highlight sells the surface as slippery rather than merely dark.
  ctx.fillStyle = withAlpha(palette.skyLight, 0.3);
  ctx.beginPath();
  ctx.ellipse(cx - cw * 0.12, cy - ch * 0.13, cw * 0.11, ch * 0.06, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawRoundabout(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cw: number,
  ch: number,
  spin: number,
  palette: Palette,
): void {
  const cx = x + cw / 2;
  const cy = y + ch / 2;
  const r = Math.min(cw, ch) * 0.4;

  // A raised turntable plate, not a smudge: it has to read as a thing you use.
  ctx.fillStyle = withAlpha(palette.ink, 0.3);
  ctx.beginPath();
  ctx.ellipse(cx, cy + ch * 0.06, r, r * CELL_ASPECT, 0, 0, Math.PI * 2);
  ctx.fill();

  // Rim wall, then the plate proper inset on top of it.
  ctx.fillStyle = shade(palette.sand, -0.42);
  ctx.beginPath();
  ctx.ellipse(cx, cy + ch * 0.03, r, r * CELL_ASPECT, 0, 0, Math.PI * 2);
  ctx.fill();

  const plate = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.1, cx, cy, r);
  plate.addColorStop(0, shade(palette.sand, 0.1));
  plate.addColorStop(1, shade(palette.sand, -0.3));
  ctx.fillStyle = plate;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * CELL_ASPECT, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = withAlpha(palette.ink, 0.4);
  ctx.lineWidth = Math.max(1, cw * 0.02);
  ctx.stroke();

  // Rotation arrow, drawn thick enough to read at a glance and shape-coded by
  // direction so the plate never depends on colour alone.
  const clockwise = spin >= 0;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, CELL_ASPECT);
  ctx.strokeStyle = withAlpha(palette.ink, 0.72);
  ctx.lineWidth = Math.max(2, cw * 0.075);
  ctx.lineCap = 'round';
  const from = clockwise ? -0.45 * Math.PI : 1.45 * Math.PI;
  const to = clockwise ? 1.05 * Math.PI : -0.05 * Math.PI;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.56, from, to, !clockwise);
  ctx.stroke();

  // Arrowhead on the leading end of the sweep.
  const head = to;
  const hx = Math.cos(head) * r * 0.56;
  const hy = Math.sin(head) * r * 0.56;
  const tangent = head + (clockwise ? Math.PI / 2 : -Math.PI / 2);
  ctx.fillStyle = withAlpha(palette.ink, 0.72);
  ctx.beginPath();
  ctx.moveTo(hx + Math.cos(tangent) * r * 0.26, hy + Math.sin(tangent) * r * 0.26);
  ctx.lineTo(hx + Math.cos(tangent + 2.4) * r * 0.22, hy + Math.sin(tangent + 2.4) * r * 0.22);
  ctx.lineTo(hx + Math.cos(tangent - 2.4) * r * 0.22, hy + Math.sin(tangent - 2.4) * r * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cw: number,
  ch: number,
  dir: Dir,
  palette: Palette,
): void {
  const cx = x + cw / 2;
  const cy = y + ch / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(DY[dir], DX[dir]) + Math.PI / 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Two chevrons: shape-coded, so one-ways never depend on colour alone. The
  // dark pass underneath keeps them legible over a pale slick or plate.
  for (const [colour, alpha, width, dy] of [
    [palette.ink, 0.32, 0.115, ch * 0.02],
    [palette.mintLight, 0.92, 0.075, 0],
  ] as const) {
    ctx.strokeStyle = withAlpha(colour, alpha);
    ctx.lineWidth = Math.max(2, cw * width);
    for (let i = 0; i < 2; i++) {
      const oy = (i - 0.5) * ch * 0.24 + dy;
      ctx.beginPath();
      ctx.moveTo(-cw * 0.18, oy + ch * 0.1);
      ctx.lineTo(0, oy - ch * 0.1);
      ctx.lineTo(cw * 0.18, oy + ch * 0.1);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawBlocker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cw: number,
  ch: number,
  style: number,
  palette: Palette,
): void {
  const cx = x + cw / 2;
  const cy = y + ch / 2;
  // Contact shadow, stacked rather than blurred.
  for (const [grow, alpha] of [
    [1.35, 0.1],
    [1.1, 0.13],
    [0.9, 0.16],
  ] as const) {
    ctx.fillStyle = withAlpha(palette.ink, alpha);
    ctx.beginPath();
    ctx.ellipse(cx + cw * 0.06, cy + ch * 0.2, cw * 0.3 * grow, ch * 0.16 * grow, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  switch (style) {
    case 1: {
      // Dumpster: a squat box with a lid, extruded like everything else.
      const w = cw * 0.66;
      const h = ch * 0.46;
      const lift = ch * 0.24;
      ctx.fillStyle = shade(palette.mintDeep, -0.42);
      roundRect(ctx, cx - w / 2, cy - h / 2, w, h, cw * 0.05);
      ctx.fill();
      ctx.fillStyle = shade(palette.mintDeep, -0.22);
      quad(
        ctx,
        cx - w / 2,
        cy + h / 2,
        cx + w / 2,
        cy + h / 2,
        cx + w / 2 - cw * 0.03,
        cy + h / 2 - lift,
        cx - w / 2 + cw * 0.03,
        cy + h / 2 - lift,
      );
      ctx.fill();
      const lid = ctx.createLinearGradient(cx - w / 2, cy - h, cx + w / 2, cy);
      lid.addColorStop(0, shade(palette.mintDeep, 0.14));
      lid.addColorStop(1, shade(palette.mintDeep, -0.08));
      ctx.fillStyle = lid;
      roundRect(ctx, cx - w / 2 + cw * 0.03, cy - h / 2 - lift, w - cw * 0.06, h, cw * 0.05);
      ctx.fill();
      ctx.strokeStyle = withAlpha(palette.ink, 0.35);
      ctx.lineWidth = Math.max(1, cw * 0.02);
      ctx.beginPath();
      ctx.moveTo(cx - w / 2 + cw * 0.03, cy - lift);
      ctx.lineTo(cx + w / 2 - cw * 0.03, cy - lift);
      ctx.stroke();
      break;
    }
    case 2: {
      // Planter: a stone tub with a clipped shrub.
      ctx.fillStyle = shade(palette.sand, -0.34);
      roundRect(ctx, cx - cw * 0.27, cy - ch * 0.04, cw * 0.54, ch * 0.32, cw * 0.06);
      ctx.fill();
      const tub = ctx.createLinearGradient(cx - cw * 0.25, cy - ch * 0.12, cx + cw * 0.25, cy + ch * 0.1);
      tub.addColorStop(0, shade(palette.sand, 0.08));
      tub.addColorStop(1, shade(palette.sand, -0.16));
      ctx.fillStyle = tub;
      roundRect(ctx, cx - cw * 0.25, cy - ch * 0.12, cw * 0.5, ch * 0.22, cw * 0.05);
      ctx.fill();
      ctx.fillStyle = shade(palette.mintDeep, -0.26);
      ctx.beginPath();
      ctx.ellipse(cx, cy - ch * 0.2, cw * 0.25, ch * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette.mintDeep;
      ctx.beginPath();
      ctx.ellipse(cx - cw * 0.04, cy - ch * 0.25, cw * 0.19, ch * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = shade(palette.mintDeep, 0.24);
      ctx.beginPath();
      ctx.ellipse(cx - cw * 0.09, cy - ch * 0.29, cw * 0.09, ch * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 3: {
      // Lot wall: a low block with a lit cap.
      ctx.fillStyle = shade(palette.asphaltDeep, -0.2);
      roundRect(ctx, x + cw * 0.04, y + ch * 0.04, cw * 0.92, ch * 0.92, cw * 0.08);
      ctx.fill();
      const cap = ctx.createLinearGradient(x, y, x + cw, y + ch);
      cap.addColorStop(0, withAlpha(palette.sand, 0.42));
      cap.addColorStop(1, withAlpha(palette.sand, 0.18));
      ctx.fillStyle = cap;
      roundRect(ctx, x + cw * 0.1, y + ch * 0.06, cw * 0.8, ch * 0.36, cw * 0.06);
      ctx.fill();
      // Course lines, so a wall reads as masonry at any zoom.
      ctx.strokeStyle = withAlpha(palette.ink, 0.22);
      ctx.lineWidth = Math.max(1, cw * 0.015);
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(x + cw * 0.08, y + ch * (0.42 + i * 0.18));
        ctx.lineTo(x + cw * 0.92, y + ch * (0.42 + i * 0.18));
        ctx.stroke();
      }
      break;
    }
    default: {
      // Traffic cone.
      ctx.fillStyle = shade(palette.coralDeep, -0.28);
      roundRect(ctx, cx - cw * 0.28, cy + ch * 0.14, cw * 0.56, ch * 0.12, cw * 0.03);
      ctx.fill();
      const cone = ctx.createLinearGradient(cx - cw * 0.22, cy, cx + cw * 0.22, cy);
      cone.addColorStop(0, shade(palette.coralDeep, 0.2));
      cone.addColorStop(0.55, palette.coralDeep);
      cone.addColorStop(1, shade(palette.coralDeep, -0.26));
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(cx, cy - ch * 0.38);
      ctx.lineTo(cx + cw * 0.22, cy + ch * 0.2);
      ctx.lineTo(cx - cw * 0.22, cy + ch * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = palette.cream;
      ctx.beginPath();
      ctx.moveTo(cx - cw * 0.145, cy - ch * 0.01);
      ctx.lineTo(cx + cw * 0.145, cy - ch * 0.01);
      ctx.lineTo(cx + cw * 0.175, cy + ch * 0.08);
      ctx.lineTo(cx - cw * 0.175, cy + ch * 0.08);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

/**
 * Screen-space rect of an upper volume on a body box.
 *
 * `from`/`to` are tail-to-nose fractions, so they flip with the facing; the
 * inset always eats the across-axis.
 */
function volumeRect(
  vol: Volume,
  x0: number,
  y0: number,
  bw: number,
  bh: number,
  facing: Dir,
): { x: number; y: number; w: number; h: number } {
  const horizontal = facing === 1 || facing === 3;
  const forwardPositive = facing === 1 || facing === 2;
  const span = vol.to - vol.from;
  const start = forwardPositive ? vol.from : 1 - vol.to;
  if (horizontal) {
    const inset = (bh * vol.inset) / 2;
    return { x: x0 + start * bw, y: y0 + inset, w: span * bw, h: bh - inset * 2 };
  }
  const inset = (bw * vol.inset) / 2;
  return { x: x0 + inset, y: y0 + start * bh, w: bw - inset * 2, h: span * bh };
}

/**
 * Everything about a vehicle that decides its picture, independent of position.
 *
 * Built by concatenation rather than `join`: this runs once per car per frame,
 * and the intermediate array is garbage worth not making.
 */
function spriteKey(v: VehicleView, bw: number, bh: number, hpx: number): string {
  return (
    v.kind +
    '|' +
    v.facing +
    '|' +
    v.color +
    '|' +
    v.tags +
    '|' +
    (v.isRide ? 1 : 0) +
    '|' +
    Math.round(bw * 2) +
    '|' +
    Math.round(bh * 2) +
    '|' +
    Math.round(hpx * 2)
  );
}

export function drawVehicle(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  cam: Camera,
  palette: Palette,
  dpr = 2,
): void {
  const { cw, ch, ox, oy } = cam;
  const bounds = vehicleBounds(v);
  const along = v.facing === 1 || v.facing === 3 ? 'x' : 'y';

  // Squash preserves volume: a bump compresses along the axis and bulges across.
  const squashAlong = 1 - v.squash * 0.1;
  const squashAcross = 1 + v.squash * 0.06;
  const marginAlong = BODY_MARGIN + (1 - squashAlong) * 0.5;
  const marginAcross = BODY_MARGIN - (squashAcross - 1) * 0.4;
  const mx = along === 'x' ? marginAlong : marginAcross;
  const my = along === 'x' ? marginAcross : marginAlong;

  const x0 = ox + (bounds.x0 + mx) * cw;
  const y0 = oy + (bounds.y0 + my) * ch;
  const bw = (bounds.x1 - bounds.x0 - mx * 2) * cw;
  const bh = (bounds.y1 - bounds.y0 - my * 2) * ch;

  const hpx = VEHICLE_HEIGHT[v.kind] * (1 - v.squash * 0.22) * cw;
  const leanPx = Math.max(-0.09, Math.min(0.09, v.leanX)) * cw;
  const leanPy = Math.max(-0.09, Math.min(0.09, v.leanY)) * ch;

  ctx.save();
  ctx.globalAlpha = v.alpha;

  if (v.wobble !== 0) {
    const pivotX = x0 + bw / 2;
    const pivotY = y0 + bh / 2;
    ctx.translate(pivotX, pivotY);
    ctx.rotate(v.wobble);
    ctx.translate(-pivotX, -pivotY);
  }

  // A car that is not mid-bump draws the same picture every frame, so it is
  // worth caching. Lean decays asymptotically, hence a threshold rather than
  // an equality test.
  const still = v.squash < 0.002 && Math.abs(leanPx) < 0.15 && Math.abs(leanPy) < 0.15;
  const padL = cw * 0.2;
  const padT = hpx + ch * 0.34;
  const padR = cw * 0.3;
  const padB = ch * 0.36;

  if (still) {
    const cached = sprite(spriteKey(v, bw, bh, hpx), bw + padL + padR, bh + padT + padB, dpr, (sctx) => {
      paintVehicle(sctx, v, padL, padT, bw, bh, hpx, 0, 0, palette);
    });
    if (cached) ctx.drawImage(cached.canvas, x0 - padL, y0 - padT, cached.w, cached.h);
    else paintVehicle(ctx, v, x0, y0, bw, bh, hpx, 0, 0, palette);
  } else {
    paintVehicle(ctx, v, x0, y0, bw, bh, hpx, leanPx, leanPy, palette);
  }

  drawStateRing(ctx, v, x0, y0, bw, bh, hpx, leanPx, leanPy, cw, palette);
  ctx.restore();
}

/**
 * Paint a whole vehicle with its body box at (`x0`,`y0`,`bw`,`bh`).
 *
 * Shared by the cached and the live path so there is exactly one description of
 * what a car looks like.
 */
function paintVehicle(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x0: number,
  y0: number,
  bw: number,
  bh: number,
  hpx: number,
  leanPx: number,
  leanPy: number,
  palette: Palette,
): void {
  const unit = Math.min(bw, bh);
  const bevelX = BEVEL * unit;
  const bevelY = BEVEL * unit * CELL_ASPECT;
  const radius = Math.min(bw, bh) * 0.26;

  // An ambulance is identifiable at a glance whatever livery is equipped —
  // vehicle identity is never colour-only, and this one carries information.
  const body = v.kind === VehicleKind.Ambulance ? palette.cream : v.color;
  const bodyH = hpx * BODY_SHARE;
  const stackBudget = hpx - bodyH;

  paintContactShadow(ctx, x0, y0, bw, bh, radius, unit, palette);

  // Wheels sit under the body, so they are laid down first and peek out.
  paintWheels(ctx, v, x0, y0, bw, bh, palette);

  // Base plate — the underside of the brick, always darkest.
  ctx.fillStyle = shade(body, -0.46);
  roundRect(ctx, x0, y0, bw, bh, radius);
  ctx.fill();

  // Body top face, inset and lifted.
  const tx = x0 + bevelX + leanPx;
  const ty = y0 + bevelY - bodyH + leanPy;
  const tw = bw - bevelX * 2;
  const th = bh - bevelY * 2;

  paintSides(ctx, x0, y0, bw, bh, tx, ty, tw, th, body);

  const panel = ctx.createLinearGradient(tx, ty, tx + tw * 0.45, ty + th);
  panel.addColorStop(0, shade(body, 0.12));
  panel.addColorStop(0.5, body);
  panel.addColorStop(1, shade(body, -0.1));
  ctx.fillStyle = panel;
  roundRect(ctx, tx, ty, tw, th, radius);
  ctx.fill();

  paintBodyDetail(ctx, v, tx, ty, tw, th, radius, palette);

  // Upper volumes: cabin, cargo box, roof sign. Painter's order by screen
  // bottom edge, so a volume nearer the viewer covers one behind it.
  const volumes = VOLUMES[v.kind];
  const stack = volumes
    .map((vol) => ({ vol, r: volumeRect(vol, tx, ty, tw, th, v.facing) }))
    .sort((a, b) => a.r.y + a.r.h - (b.r.y + b.r.h));
  for (const { vol, r } of stack) {
    paintVolume(ctx, v, vol, r, stackBudget * vol.lift, unit, palette, body, leanPx, leanPy);
  }

  // A dark rim keeps bumper-to-bumper cars of the same colour distinct, and a
  // light one along the key side sells the bevel.
  ctx.strokeStyle = withAlpha(palette.ink, 0.36);
  ctx.lineWidth = Math.max(1, unit * 0.035);
  roundRect(ctx, tx, ty, tw, th, radius);
  ctx.stroke();

  const rim = ctx.createLinearGradient(tx, ty, tx + tw * 0.6, ty + th * 0.6);
  rim.addColorStop(0, withAlpha(palette.cream, 0.28));
  rim.addColorStop(1, withAlpha(palette.cream, 0));
  ctx.strokeStyle = rim;
  ctx.lineWidth = Math.max(1, unit * 0.022);
  roundRect(ctx, tx + unit * 0.012, ty + unit * 0.012, tw - unit * 0.024, th - unit * 0.024, radius);
  ctx.stroke();
}

/** Soft contact shadow, stacked from wide-and-faint to tight-and-dark. */
function paintContactShadow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  bw: number,
  bh: number,
  radius: number,
  unit: number,
  palette: Palette,
): void {
  const offX = unit * 0.09;
  const offY = unit * 0.14;
  for (const [grow, alpha] of [
    [unit * 0.11, 0.09],
    [unit * 0.055, 0.12],
    [0, 0.15],
  ] as const) {
    ctx.fillStyle = withAlpha(palette.ink, alpha);
    roundRect(ctx, x0 + offX - grow, y0 + offY - grow, bw + grow * 2, bh + grow * 2, radius + grow);
    ctx.fill();
  }
}

/** The three lit side faces between a base rect and its lifted top. */
function paintSides(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  bw: number,
  bh: number,
  tx: number,
  ty: number,
  tw: number,
  th: number,
  body: string,
): void {
  // South face — furthest from the key light.
  ctx.fillStyle = shade(body, -0.24);
  quad(ctx, x0, y0 + bh, x0 + bw, y0 + bh, tx + tw, ty + th, tx, ty + th);
  ctx.fill();
  // East face.
  ctx.fillStyle = shade(body, -0.33);
  quad(ctx, x0 + bw, y0, x0 + bw, y0 + bh, tx + tw, ty + th, tx + tw, ty);
  ctx.fill();
  // West face — catches the key.
  ctx.fillStyle = shade(body, -0.06);
  quad(ctx, x0, y0, x0, y0 + bh, tx, ty + th, tx, ty);
  ctx.fill();
}

/** A cabin, cargo box or roof sign standing on the body's top face. */
function paintVolume(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  vol: Volume,
  r: { x: number; y: number; w: number; h: number },
  lift: number,
  unit: number,
  palette: Palette,
  body: string,
  leanPx: number,
  leanPy: number,
): void {
  if (r.w <= 0 || r.h <= 0 || lift <= 0) return;
  const bevel = BEVEL * unit * 0.6;
  const radius = Math.min(r.w, r.h) * 0.24;
  const tx = r.x + bevel + leanPx * 0.5;
  const ty = r.y + bevel * CELL_ASPECT - lift + leanPy * 0.5;
  const tw = r.w - bevel * 2;
  const th = r.h - bevel * 2 * CELL_ASPECT;
  if (tw <= 0 || th <= 0) return;

  // The taxi's roof sign is the one volume that is not body-coloured.
  const isSign = v.kind === VehicleKind.Taxi && vol.inset > 0.4;
  const shell = isSign ? palette.lemon : body;

  // Ambient occlusion where the volume meets the body — the join that makes it
  // read as a separate object rather than a decal.
  ctx.fillStyle = withAlpha(palette.ink, 0.16);
  roundRect(ctx, r.x - bevel * 0.5, r.y - bevel * 0.5, r.w + bevel, r.h + bevel, radius);
  ctx.fill();

  paintSides(ctx, r.x, r.y, r.w, r.h, tx, ty, tw, th, shell);

  const top = ctx.createLinearGradient(tx, ty, tx + tw * 0.5, ty + th);
  top.addColorStop(0, shade(shell, 0.16));
  top.addColorStop(1, shade(shell, -0.08));
  ctx.fillStyle = top;
  roundRect(ctx, tx, ty, tw, th, radius);
  ctx.fill();

  if (vol.glass) paintGlass(ctx, v, tx, ty, tw, th, radius, palette);
  else if (!isSign) paintPanelLines(ctx, v, tx, ty, tw, th, radius, palette);
  else {
    ctx.fillStyle = withAlpha(palette.ink, 0.75);
    roundRect(ctx, tx + tw * 0.16, ty + th * 0.3, tw * 0.68, th * 0.4, radius * 0.4);
    ctx.fill();
  }

  ctx.strokeStyle = withAlpha(palette.ink, 0.34);
  ctx.lineWidth = Math.max(1, unit * 0.026);
  roundRect(ctx, tx, ty, tw, th, radius);
  ctx.stroke();
}

/** Glass canopy: dark laminate, a roof panel down the spine and one sun streak. */
function paintGlass(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  palette: Palette,
): void {
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();

  // Deliberately dark laminate. Glass that is lighter than the paint turns
  // every car into a window with a car around it, and the lot loses the colour
  // it needs for the player to tell one vehicle from the next.
  const glass = ctx.createLinearGradient(x, y, x + w * 0.7, y + h);
  glass.addColorStop(0, withAlpha(palette.skyDeep, 0.78));
  glass.addColorStop(0.5, withAlpha(palette.asphaltDeep, 0.88));
  glass.addColorStop(1, withAlpha(palette.ink, 0.92));
  ctx.fillStyle = glass;
  ctx.fillRect(x, y, w, h);

  // Roof panel: a body-coloured band across the travel axis, so the greenhouse
  // splits into a windscreen and a rear window.
  const horizontal = v.facing === 1 || v.facing === 3;
  ctx.fillStyle = withAlpha(palette.cream, 0.1);
  if (horizontal) ctx.fillRect(x + w * 0.42, y - h, w * 0.16, h * 3);
  else ctx.fillRect(x - w, y + h * 0.42, w * 3, h * 0.16);

  // A single specular streak across the glass, angled against the key light.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(x + w * 0.3, y + h * 0.28);
  ctx.rotate(-0.6);
  const streak = ctx.createLinearGradient(0, -h * 0.4, 0, h * 0.4);
  streak.addColorStop(0, 'rgba(255,255,255,0)');
  streak.addColorStop(0.5, 'rgba(255,255,255,0.17)');
  streak.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = streak;
  ctx.fillRect(-w, -h * 0.28, w * 2, h * 0.56);
  ctx.restore();
  ctx.restore();
}

/** Cargo shell: roller-door ribs, which is what makes a box read as a box. */
function paintPanelLines(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  palette: Palette,
): void {
  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  const horizontal = v.facing === 1 || v.facing === 3;
  const span = horizontal ? w : h;
  const step = Math.max(4, span / 6);
  ctx.strokeStyle = withAlpha(palette.ink, 0.14);
  ctx.lineWidth = Math.max(1, span * 0.014);
  for (let d = step * 0.5; d < span; d += step) {
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + d, y + h);
    } else {
      ctx.moveTo(x, y + d);
      ctx.lineTo(x + w, y + d);
    }
    ctx.stroke();
  }

  // Ambulance livery rides on the cargo shell, not the body, so it survives any
  // equipped colour scheme.
  if (v.kind === VehicleKind.Ambulance) {
    const bar = Math.min(w, h) * 0.42;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.fillStyle = palette.coralDeep;
    ctx.fillRect(cx - bar / 2, cy - bar * 0.18, bar, bar * 0.36);
    ctx.fillRect(cx - bar * 0.18, cy - bar / 2, bar * 0.36, bar);
  }
  ctx.restore();
}

function paintWheels(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x: number,
  y: number,
  w: number,
  h: number,
  palette: Palette,
): void {
  const horizontal = v.facing === 1 || v.facing === 3;
  const axles = v.len >= 4 ? 3 : 2;
  const tyre = withAlpha(palette.ink, 0.85);
  const hub = withAlpha(palette.asphaltLight, 0.9);

  for (let i = 0; i < axles; i++) {
    const t = axles === 2 ? 0.24 + i * 0.52 : 0.18 + i * 0.32;
    if (horizontal) {
      const wx = x + w * t - w * 0.055;
      const ww = w * 0.11;
      const wh = h * 0.13;
      for (const wy of [y - h * 0.055, y + h * 0.925]) {
        ctx.fillStyle = tyre;
        roundRect(ctx, wx, wy, ww, wh, ww * 0.32);
        ctx.fill();
        ctx.fillStyle = hub;
        roundRect(ctx, wx + ww * 0.28, wy + wh * 0.34, ww * 0.44, wh * 0.32, ww * 0.16);
        ctx.fill();
      }
    } else {
      const wy = y + h * t - h * 0.055;
      const ww = w * 0.13;
      const wh = h * 0.11;
      for (const wx of [x - w * 0.055, x + w * 0.925]) {
        ctx.fillStyle = tyre;
        roundRect(ctx, wx, wy, ww, wh, wh * 0.32);
        ctx.fill();
        ctx.fillStyle = hub;
        roundRect(ctx, wx + ww * 0.34, wy + wh * 0.28, ww * 0.32, wh * 0.44, wh * 0.16);
        ctx.fill();
      }
    }
  }
}

/**
 * Detail on the body's top face: lights, badges and tags.
 *
 * Drawn in a frame where +u runs tail to nose, so "at the nose" is one sign
 * rather than four cases.
 */
function paintBodyDetail(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  palette: Palette,
): void {
  const horizontal = v.facing === 1 || v.facing === 3;
  const forwardPositive = v.facing === 1 || v.facing === 2;

  ctx.save();
  roundRect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  if (horizontal) ctx.rotate(forwardPositive ? 0 : Math.PI);
  else ctx.rotate(forwardPositive ? Math.PI / 2 : -Math.PI / 2);

  const length = horizontal ? w : h;
  const width = horizontal ? h : w;
  const halfL = length / 2;
  const halfW = width / 2;

  // Bonnet shading: the nose reads as a separate plane from the cabin.
  ctx.fillStyle = withAlpha(palette.cream, 0.07);
  roundRect(ctx, halfL - length * 0.3, -halfW * 0.92, length * 0.3, halfW * 1.84, radius * 0.4);
  ctx.fill();

  // Headlights: a warm lens with a glow, so facing reads even at a glance.
  // Two distinct lamps, not a light bar: they have to stay separated or the
  // nose reads as a white bumper and the facing cue is lost.
  const lensL = length * 0.045;
  const lensW = halfW * 0.26;
  for (const side of [-1, 1]) {
    const ly = side * halfW * 0.62;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(halfL - lensL, ly, 0, halfL - lensL, ly, length * 0.09);
    glow.addColorStop(0, withAlpha(palette.lemon, 0.28));
    glow.addColorStop(1, withAlpha(palette.lemon, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(halfL - lensL, ly, length * 0.09, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = palette.cream;
    roundRect(ctx, halfL - lensL * 2.2, ly - lensW / 2, lensL * 1.6, lensW, lensW * 0.35);
    ctx.fill();
  }

  // Tail lights.
  for (const side of [-1, 1]) {
    ctx.fillStyle = withAlpha(palette.coralDeep, 0.92);
    roundRect(
      ctx,
      -halfL + length * 0.02,
      side * halfW * 0.55 - halfW * 0.2,
      length * 0.05,
      halfW * 0.4,
      halfW * 0.14,
    );
    ctx.fill();
  }

  // Grille shadow under the nose lip.
  ctx.fillStyle = withAlpha(palette.ink, 0.18);
  roundRect(ctx, halfL - length * 0.035, -halfW * 0.78, length * 0.03, halfW * 1.56, radius * 0.2);
  ctx.fill();

  if (v.tags & VehicleTag.Vip) {
    // A gold coachline, drawn on the paint rather than as a ring, so it does
    // not compete with the selection and hint rings.
    ctx.strokeStyle = withAlpha(palette.lemon, 0.95);
    ctx.lineWidth = Math.max(1.5, width * 0.07);
    ctx.beginPath();
    ctx.moveTo(-halfL + length * 0.08, -halfW * 0.72);
    ctx.lineTo(halfL - length * 0.12, -halfW * 0.72);
    ctx.moveTo(-halfL + length * 0.08, halfW * 0.72);
    ctx.lineTo(halfL - length * 0.12, halfW * 0.72);
    ctx.stroke();
  }
  if (v.tags & VehicleTag.Trunk) {
    // A strapped crate on the boot lid.
    ctx.fillStyle = shade(palette.lemon, -0.1);
    roundRect(ctx, -halfL + length * 0.06, -halfW * 0.46, length * 0.22, halfW * 0.92, radius * 0.3);
    ctx.fill();
    ctx.strokeStyle = withAlpha(palette.ink, 0.6);
    ctx.lineWidth = Math.max(1, width * 0.05);
    ctx.beginPath();
    ctx.moveTo(-halfL + length * 0.17, -halfW * 0.46);
    ctx.lineTo(-halfL + length * 0.17, halfW * 0.46);
    ctx.stroke();
  }
  if (v.isRide) {
    // Your Ride wears twin racing stripes so it is findable in a packed lot.
    ctx.fillStyle = withAlpha(palette.cream, 0.55);
    for (const side of [-1, 1]) {
      ctx.fillRect(-halfL, side * halfW * 0.2 - halfW * 0.05, length, halfW * 0.1);
    }
  }
  if (v.kind === VehicleKind.Ambulance) {
    // Light bar across the nose of the cab.
    ctx.fillStyle = palette.sky;
    roundRect(ctx, halfL - length * 0.2, -halfW * 0.5, length * 0.05, halfW, radius * 0.2);
    ctx.fill();
    ctx.fillStyle = palette.coral;
    roundRect(ctx, halfL - length * 0.2, -halfW * 0.5, length * 0.05, halfW * 0.45, radius * 0.2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Selection, hint and blocker-flash speak through one ring, at volumes that
 * match what they cost: a hint is paid for, so it shouts.
 */
function drawStateRing(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x0: number,
  y0: number,
  bw: number,
  bh: number,
  hpx: number,
  leanPx: number,
  leanPy: number,
  cw: number,
  palette: Palette,
): void {
  if (v.highlight <= 0.02 && v.hint <= 0.02 && v.flash <= 0.02) return;

  const unit = Math.min(bw, bh);
  const bevelX = BEVEL * unit;
  const bevelY = BEVEL * unit * CELL_ASPECT;
  const radius = unit * 0.26;
  const tx = x0 + bevelX + leanPx;
  const ty = y0 + bevelY - hpx * BODY_SHARE + leanPy;
  const tw = bw - bevelX * 2;
  const th = bh - bevelY * 2;

  const strength = Math.max(v.highlight, v.hint, v.flash);
  const colour = v.flash > 0.02 ? palette.coral : v.hint > 0.02 ? palette.lemon : palette.cream;

  if (v.hint > 0.02 || v.flash > 0.02) {
    ctx.strokeStyle = withAlpha(colour, strength * 0.35);
    ctx.lineWidth = Math.max(4, cw * 0.16) * strength;
    roundRect(ctx, tx, ty, tw, th, radius);
    ctx.stroke();
  }

  ctx.strokeStyle = withAlpha(colour, v.flash > 0.02 ? v.flash : v.hint > 0.02 ? 1 : strength * 0.9);
  ctx.lineWidth = Math.max(2.5, cw * 0.06) * (1 + strength * 0.4);
  roundRect(ctx, tx, ty, tw, th, radius);
  ctx.stroke();
}

/* ------------------------------------------------------------------ *
 * Overlays
 * ------------------------------------------------------------------ */

export function drawPreview(
  ctx: CanvasRenderingContext2D,
  preview: PathPreview,
  cam: Camera,
  palette: Palette,
): void {
  const { cw, ch, ox, oy } = cam;
  ctx.save();

  // A soft trail under the dashes: the route reads as a lane, not as confetti.
  ctx.fillStyle = withAlpha(preview.exits ? palette.mintLight : palette.cream, 0.1);
  for (const cell of preview.cells) {
    roundRect(ctx, ox + (cell.x + 0.1) * cw, oy + (cell.y + 0.1) * ch, cw * 0.8, ch * 0.8, cw * 0.2);
    ctx.fill();
  }

  ctx.lineWidth = Math.max(2, cw * 0.05);
  ctx.setLineDash([cw * 0.16, cw * 0.14]);
  ctx.strokeStyle = withAlpha(preview.exits ? palette.mintLight : palette.cream, 0.75);
  for (const cell of preview.cells) {
    roundRect(ctx, ox + (cell.x + 0.2) * cw, oy + (cell.y + 0.2) * ch, cw * 0.6, ch * 0.6, cw * 0.14);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  if (preview.blocked) {
    const bx = ox + (preview.blocked.x + 0.5) * cw;
    const by = oy + (preview.blocked.y + 0.5) * ch;
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, cw * 0.6);
    g.addColorStop(0, withAlpha(palette.coral, 0.42));
    g.addColorStop(1, withAlpha(palette.coral, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, by, cw * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawParticles(ctx: CanvasRenderingContext2D, particles: readonly Particle[]): void {
  ctx.save();
  for (const p of particles) {
    const t = p.life / p.maxLife;
    ctx.globalAlpha = Math.max(0, Math.min(1, t));
    ctx.fillStyle = p.color;
    if (p.kind === 'ring') {
      ctx.globalAlpha *= 0.5;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size * 0.3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (2 - t), 0, Math.PI * 2);
      ctx.stroke();
    } else if (p.kind === 'confetti') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.life * 6);
      // Foreshortened as it tumbles, so the shower has depth.
      ctx.scale(1, Math.abs(Math.cos(p.life * 6)) * 0.8 + 0.2);
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    } else if (p.kind === 'spark') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (2 - t), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Night Shift: the lot is lit only by headlight pools that follow each car's
 * facing (GDD §9).
 *
 * The darkness is built on a scratch layer and the light is *punched out* of
 * it, which gives soft-edged pools instead of the hard wedges a straight
 * additive pass produces. A little ambient light survives on purpose — the
 * grid has to stay readable even in the dark.
 */
let nightScratch: HTMLCanvasElement | null = null;

export function drawNightMask(
  ctx: CanvasRenderingContext2D,
  vehicles: readonly VehicleView[],
  cam: Camera,
  width: number,
  height: number,
): void {
  if (width <= 0 || height <= 0) return;
  if (!nightScratch) nightScratch = document.createElement('canvas');
  const scratch = nightScratch;
  if (scratch.width !== Math.ceil(width) || scratch.height !== Math.ceil(height)) {
    scratch.width = Math.ceil(width);
    scratch.height = Math.ceil(height);
  }
  const sctx = scratch.getContext('2d');
  if (!sctx) return;

  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, width, height);
  sctx.fillStyle = 'rgba(9, 13, 24, 0.86)';
  sctx.fillRect(0, 0, width, height);

  sctx.globalCompositeOperation = 'destination-out';
  const reach = cam.cw * 2.3;
  for (const v of vehicles) {
    if (v.alpha <= 0.05) continue;
    const nx = cam.ox + (v.gx + 0.5 + DX[v.facing] * 0.45) * cam.cw;
    const ny = cam.oy + (v.gy + 0.5 + DY[v.facing] * 0.45) * cam.ch;
    const angle = Math.atan2(DY[v.facing], DX[v.facing]);

    sctx.save();
    sctx.translate(nx, ny);
    sctx.rotate(angle);
    // Elongated forward, narrow across: a headlight pool, not a spotlight.
    sctx.scale(1.5, 0.62);
    const pool = sctx.createRadialGradient(reach * 0.35, 0, 0, reach * 0.35, 0, reach);
    pool.addColorStop(0, 'rgba(0, 0, 0, 1)');
    pool.addColorStop(0.55, 'rgba(0, 0, 0, 0.55)');
    pool.addColorStop(1, 'rgba(0, 0, 0, 0)');
    sctx.fillStyle = pool;
    sctx.beginPath();
    sctx.arc(reach * 0.35, 0, reach, 0, Math.PI * 2);
    sctx.fill();
    sctx.restore();
  }
  sctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(scratch, 0, 0, width, height);

  // A warm wash over the lit pools, so headlights read as tungsten.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const v of vehicles) {
    if (v.alpha <= 0.05) continue;
    const nx = cam.ox + (v.gx + 0.5 + DX[v.facing] * 0.5) * cam.cw;
    const ny = cam.oy + (v.gy + 0.5 + DY[v.facing] * 0.5) * cam.ch;
    const glow = ctx.createRadialGradient(nx, ny, 0, nx, ny, cam.cw * 0.9);
    glow.addColorStop(0, 'rgba(255, 226, 170, 0.22)');
    glow.addColorStop(1, 'rgba(255, 226, 170, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(nx, ny, cam.cw * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
