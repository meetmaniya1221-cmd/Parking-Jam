/**
 * Canvas rendering for the lot (GDD §12 "Visual Direction").
 *
 * Stylised low-poly toy diorama in 2D: the ground is a foreshortened grid, and
 * every vehicle is a chunky bevelled brick — a base plate, three lit side
 * faces and an inset top — under one warm key light from the upper left. The
 * grid stays readable at all times: the tilt is foreshortening only, never
 * enough to hide a cell.
 *
 * The ground is baked to an offscreen canvas and blitted, so a frame costs one
 * image draw plus the vehicles.
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
import { Palette, shade, withAlpha } from './theme';

/** Vertical foreshortening — enough parallax to feel dimensional, never enough to hide a cell. */
export const CELL_ASPECT = 0.92;
/**
 * Inset of a vehicle body inside its cells, in cell units. Bumper-to-bumper
 * cars need a visible seam or a column of same-coloured cars reads as one long
 * block, which destroys the count.
 */
const BODY_MARGIN = 0.1;
/** How far the top face is inset from the base, in cell units — the bevel. */
const BEVEL = 0.07;

/**
 * Extrusion height in cell units.
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
  /** −1 (nose down) … 1 (nose up) — the anticipation lean. */
  lean: number;
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

export interface RenderModel {
  level: LevelDef;
  camera: Camera;
  vehicles: VehicleView[];
  preview: PathPreview | null;
  particles: Particle[];
  palette: Palette;
  /** 0–1 dimming applied during the last-car slow-motion beat. */
  focus: number;
  /** Headlight-cone mode for Night Shift. */
  night: boolean;
  reducedMotion: boolean;
}

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

export function fitCamera(
  level: LevelDef,
  widthPx: number,
  heightPx: number,
  padding: number,
): Camera {
  const availableW = Math.max(32, widthPx - padding * 2);
  const availableH = Math.max(32, heightPx - padding * 2);
  const cw = Math.min(availableW / level.w, availableH / (level.h * CELL_ASPECT));
  const ch = cw * CELL_ASPECT;
  return {
    ox: (widthPx - level.w * cw) / 2,
    oy: (heightPx - level.h * ch) / 2,
    cw,
    ch,
  };
}

export function cellToScreen(cam: Camera, gx: number, gy: number): { x: number; y: number } {
  return { x: cam.ox + gx * cam.cw, y: cam.oy + gy * cam.ch };
}

/** Which cell a screen point falls in; may be outside the lot. */
export function screenToCell(cam: Camera, x: number, y: number): { x: number; y: number } {
  return { x: Math.floor((x - cam.ox) / cam.cw), y: Math.floor((y - cam.oy) / cam.ch) };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function quad(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): void {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.lineTo(dx, dy);
  ctx.closePath();
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
  const { cw, ch, ox, oy } = cam;
  const w = level.w * cw;
  const h = level.h * ch;

  // Kerb apron: the street the lot opens onto.
  ctx.fillStyle = palette.asphaltDeep;
  roundRect(ctx, ox - cw * 0.42, oy - ch * 0.42, w + cw * 0.84, h + ch * 0.84, cw * 0.3);
  ctx.fill();

  // Asphalt slab.
  const slab = ctx.createLinearGradient(ox, oy, ox, oy + h);
  slab.addColorStop(0, palette.asphaltLight);
  slab.addColorStop(1, palette.asphalt);
  ctx.fillStyle = slab;
  roundRect(ctx, ox, oy, w, h, cw * 0.16);
  ctx.fill();

  // Bay markings: a dashed line between every pair of columns.
  ctx.strokeStyle = withAlpha(palette.lanePaint, 0.3);
  ctx.lineWidth = Math.max(1, cw * 0.035);
  ctx.setLineDash([ch * 0.34, ch * 0.26]);
  for (let x = 1; x < level.w; x++) {
    ctx.beginPath();
    ctx.moveTo(ox + x * cw, oy + ch * 0.12);
    ctx.lineTo(ox + x * cw, oy + h - ch * 0.12);
    ctx.stroke();
  }
  ctx.setLineDash([]);

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

  // Soft glow marking the way out.
  ctx.fillStyle = withAlpha(palette.mintLight, 0.22);
  ctx.fillRect(
    x - (horizontal ? 0 : cw * 0.2),
    y - (horizontal ? ch * 0.2 : 0),
    width + (horizontal ? 0 : cw * 0.4),
    height + (horizontal ? ch * 0.4 : 0),
  );

  // Hazard stripes.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = withAlpha(palette.lemon, 0.9);
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = withAlpha(palette.ink, 0.55);
  ctx.lineWidth = thickness * 0.42;
  const step = thickness * 1.05;
  const span = Math.max(width, height) + thickness * 2;
  for (let i = -span; i < span; i += step) {
    ctx.beginPath();
    ctx.moveTo(x + i, y - thickness);
    ctx.lineTo(x + i + thickness * 2, y + height + thickness);
    ctx.stroke();
  }
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
  ctx.strokeStyle = withAlpha(palette.skyLight, 0.5);
  ctx.lineWidth = Math.max(1, cw * 0.03);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, cw * (0.12 + i * 0.11), ch * (0.09 + i * 0.1), 0.6, 0, Math.PI * 1.5);
    ctx.stroke();
  }
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
  const r = Math.min(cw, ch) * 0.38;
  ctx.fillStyle = withAlpha(palette.sand, 0.28);
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, r * CELL_ASPECT, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = withAlpha(palette.lanePaint, 0.8);
  ctx.lineWidth = Math.max(1.5, cw * 0.05);
  const from = spin >= 0 ? 0.2 : 1.2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.66, r * 0.66 * CELL_ASPECT, 0, from * Math.PI, (from + 1.2) * Math.PI);
  ctx.stroke();
  // Arrowhead showing which way the plate turns.
  const end = (from + 1.2) * Math.PI;
  const ax = cx + Math.cos(end) * r * 0.66;
  const ay = cy + Math.sin(end) * r * 0.66 * CELL_ASPECT;
  ctx.fillStyle = withAlpha(palette.lanePaint, 0.9);
  ctx.beginPath();
  ctx.arc(ax, ay, cw * 0.07, 0, Math.PI * 2);
  ctx.fill();
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
  const dx = DX[dir];
  const dy = DY[dir];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(dy, dx) + Math.PI / 2);
  ctx.strokeStyle = withAlpha(palette.mintLight, 0.85);
  ctx.lineWidth = Math.max(2, cw * 0.075);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Two chevrons: shape-coded, so one-ways never depend on colour alone.
  for (let i = 0; i < 2; i++) {
    const oy = (i - 0.5) * ch * 0.24;
    ctx.beginPath();
    ctx.moveTo(-cw * 0.18, oy + ch * 0.1);
    ctx.lineTo(0, oy - ch * 0.1);
    ctx.lineTo(cw * 0.18, oy + ch * 0.1);
    ctx.stroke();
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
  ctx.fillStyle = withAlpha(palette.ink, 0.22);
  ctx.beginPath();
  ctx.ellipse(cx + cw * 0.06, cy + ch * 0.2, cw * 0.3, ch * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  switch (style) {
    case 1: {
      // Dumpster: a squat box with a lid, extruded like everything else.
      const w = cw * 0.66;
      const h = ch * 0.46;
      const lift = ch * 0.22;
      ctx.fillStyle = shade(palette.mintDeep, -0.4);
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
      ctx.fillStyle = palette.mintDeep;
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
      ctx.fillStyle = shade(palette.sand, -0.3);
      roundRect(ctx, cx - cw * 0.27, cy - ch * 0.04, cw * 0.54, ch * 0.32, cw * 0.06);
      ctx.fill();
      ctx.fillStyle = palette.sand;
      roundRect(ctx, cx - cw * 0.25, cy - ch * 0.12, cw * 0.5, ch * 0.22, cw * 0.05);
      ctx.fill();
      ctx.fillStyle = shade(palette.mintDeep, -0.2);
      ctx.beginPath();
      ctx.ellipse(cx, cy - ch * 0.2, cw * 0.25, ch * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = palette.mintDeep;
      ctx.beginPath();
      ctx.ellipse(cx - cw * 0.05, cy - ch * 0.26, cw * 0.17, ch * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 3: {
      // Lot wall.
      ctx.fillStyle = shade(palette.asphaltDeep, -0.15);
      roundRect(ctx, x + cw * 0.04, y + ch * 0.04, cw * 0.92, ch * 0.92, cw * 0.08);
      ctx.fill();
      ctx.fillStyle = withAlpha(palette.sand, 0.35);
      roundRect(ctx, x + cw * 0.1, y + ch * 0.06, cw * 0.8, ch * 0.34, cw * 0.06);
      ctx.fill();
      break;
    }
    default: {
      // Traffic cone.
      ctx.fillStyle = palette.coralDeep;
      ctx.beginPath();
      ctx.moveTo(cx, cy - ch * 0.36);
      ctx.lineTo(cx + cw * 0.22, cy + ch * 0.2);
      ctx.lineTo(cx - cw * 0.22, cy + ch * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = palette.cream;
      ctx.fillRect(cx - cw * 0.14, cy - ch * 0.08, cw * 0.28, ch * 0.09);
      ctx.fillStyle = shade(palette.coralDeep, -0.3);
      roundRect(ctx, cx - cw * 0.28, cy + ch * 0.16, cw * 0.56, ch * 0.1, cw * 0.03);
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

export function drawVehicle(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  cam: Camera,
  palette: Palette,
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

  const heightUnits = VEHICLE_HEIGHT[v.kind] * (1 - v.squash * 0.22);
  const hpx = heightUnits * cw;
  const bevelX = BEVEL * cw;
  const bevelY = BEVEL * ch;
  const radius = Math.min(bw, bh) * 0.26;

  // An ambulance is identifiable at a glance whatever livery is equipped —
  // vehicle identity is never colour-only, and this one carries information.
  const body = v.kind === VehicleKind.Ambulance ? palette.cream : v.color;

  ctx.save();
  ctx.globalAlpha = v.alpha;

  if (v.wobble !== 0) {
    const pivotX = x0 + bw / 2;
    const pivotY = y0 + bh / 2;
    ctx.translate(pivotX, pivotY);
    ctx.rotate(v.wobble);
    ctx.translate(-pivotX, -pivotY);
  }

  // Ground shadow, thrown down-right by the warm key light.
  ctx.fillStyle = palette.shadow;
  roundRect(
    ctx,
    x0 + cw * 0.07,
    y0 + ch * 0.12,
    bw,
    bh,
    radius,
  );
  ctx.fill();

  // Base plate — the underside of the brick, always darkest.
  ctx.fillStyle = shade(body, -0.42);
  roundRect(ctx, x0, y0, bw, bh, radius);
  ctx.fill();

  // Top face, inset and lifted.
  const tx = x0 + bevelX;
  const ty = y0 + bevelY - hpx;
  const tw = bw - bevelX * 2;
  const th = bh - bevelY * 2;

  // Three lit side faces. The north face is behind the top and never shows.
  ctx.fillStyle = shade(body, -0.2);
  quad(ctx, x0, y0 + bh, x0 + bw, y0 + bh, tx + tw, ty + th, tx, ty + th);
  ctx.fill();
  ctx.fillStyle = shade(body, -0.3);
  quad(ctx, x0 + bw, y0, x0 + bw, y0 + bh, tx + tw, ty + th, tx + tw, ty);
  ctx.fill();
  ctx.fillStyle = shade(body, -0.08);
  quad(ctx, x0, y0, x0, y0 + bh, tx, ty + th, tx, ty);
  ctx.fill();

  // Wheels peek out at the base, which sells the object and marks the axis.
  drawWheels(ctx, v, x0, y0, bw, bh, palette);

  ctx.fillStyle = body;
  roundRect(ctx, tx, ty, tw, th, radius);
  ctx.fill();

  // A dark rim keeps bumper-to-bumper cars of the same colour distinct.
  ctx.strokeStyle = withAlpha(palette.ink, 0.34);
  ctx.lineWidth = Math.max(1, cw * 0.018);
  roundRect(ctx, tx, ty, tw, th, radius);
  ctx.stroke();

  drawVehicleDetail(ctx, v, tx, ty, tw, th, radius, palette, body);

  if (v.highlight > 0 || v.hint > 0 || v.flash > 0) {
    const strength = Math.max(v.highlight, v.hint, v.flash);
    ctx.strokeStyle =
      v.flash > 0
        ? withAlpha(palette.coral, v.flash)
        : v.hint > 0
          ? withAlpha(palette.lemon, v.hint)
          : withAlpha(palette.cream, v.highlight * 0.9);
    ctx.lineWidth = Math.max(2, cw * 0.055) * (1 + strength * 0.5);
    roundRect(ctx, tx, ty, tw, th, radius);
    ctx.stroke();
  }

  ctx.restore();
}

function drawWheels(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x: number,
  y: number,
  w: number,
  h: number,
  palette: Palette,
): void {
  const horizontal = v.facing === 1 || v.facing === 3;
  ctx.fillStyle = withAlpha(palette.ink, 0.72);
  const axles = v.len >= 4 ? 3 : 2;
  for (let i = 0; i < axles; i++) {
    const t = axles === 2 ? 0.24 + i * 0.52 : 0.18 + i * 0.32;
    if (horizontal) {
      const wx = x + w * t - w * 0.06;
      ctx.fillRect(wx, y - h * 0.04, w * 0.12, h * 0.1);
      ctx.fillRect(wx, y + h * 0.94, w * 0.12, h * 0.1);
    } else {
      const wy = y + h * t - h * 0.06;
      ctx.fillRect(x - w * 0.04, wy, w * 0.1, h * 0.12);
      ctx.fillRect(x + w * 0.94, wy, w * 0.1, h * 0.12);
    }
  }
}

function drawVehicleDetail(
  ctx: CanvasRenderingContext2D,
  v: VehicleView,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  palette: Palette,
  body: string,
): void {
  const horizontal = v.facing === 1 || v.facing === 3;
  const forwardPositive = v.facing === 1 || v.facing === 2;
  const length = horizontal ? w : h;
  const width = horizontal ? h : w;

  // Work in a frame where +u runs from tail to nose and +t is across the body.
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  if (horizontal) ctx.rotate(forwardPositive ? 0 : Math.PI);
  else ctx.rotate(forwardPositive ? Math.PI / 2 : -Math.PI / 2);

  const halfL = length / 2;
  const halfW = width / 2;
  const isBig =
    v.kind === VehicleKind.BoxTruck ||
    v.kind === VehicleKind.Trailer ||
    v.kind === VehicleKind.Bus ||
    v.kind === VehicleKind.Van ||
    v.kind === VehicleKind.Ambulance;

  // Cargo body / roof panel — the silhouette cue that separates the classes.
  if (isBig) {
    ctx.fillStyle =
      v.kind === VehicleKind.Ambulance ? withAlpha(palette.coral, 0.16) : shade(body, 0.16);
    roundRect(ctx, -halfL + length * 0.06, -halfW * 0.82, length * 0.56, halfW * 1.64, radius * 0.5);
    ctx.fill();
    if (v.kind === VehicleKind.Ambulance) {
      ctx.fillStyle = palette.coralDeep;
      const bar = Math.min(length * 0.09, halfW * 0.3);
      const cx = -length * 0.14;
      ctx.fillRect(cx - bar / 2, -halfW * 0.42, bar, halfW * 0.84);
      ctx.fillRect(cx - halfW * 0.42, -bar / 2, halfW * 0.84, bar);
      // Light bar on the roof, so the class reads even at a glance.
      ctx.fillStyle = palette.sky;
      roundRect(ctx, halfL - length * 0.46, -halfW * 0.5, length * 0.05, halfW, radius * 0.2);
      ctx.fill();
    }
  }

  // Windscreen, always at the nose end: this is how facing reads.
  ctx.fillStyle = withAlpha(palette.skyLight, 0.9);
  roundRect(
    ctx,
    halfL - length * (isBig ? 0.3 : 0.4),
    -halfW * 0.68,
    length * (isBig ? 0.16 : 0.26),
    halfW * 1.36,
    radius * 0.4,
  );
  ctx.fill();

  // Light strip — the "grin".
  ctx.fillStyle = palette.cream;
  roundRect(ctx, halfL - length * 0.09, -halfW * 0.74, length * 0.05, halfW * 1.48, radius * 0.3);
  ctx.fill();

  // Tail lights.
  ctx.fillStyle = withAlpha(palette.coralDeep, 0.85);
  roundRect(ctx, -halfL + length * 0.03, -halfW * 0.66, length * 0.035, halfW * 1.32, radius * 0.25);
  ctx.fill();

  if (v.kind === VehicleKind.Taxi) {
    ctx.fillStyle = palette.ink;
    roundRect(ctx, -length * 0.06, -halfW * 0.34, length * 0.12, halfW * 0.68, radius * 0.3);
    ctx.fill();
  }

  if (v.tags & VehicleTag.Vip) {
    ctx.strokeStyle = palette.lemon;
    ctx.lineWidth = Math.max(1.5, width * 0.08);
    roundRect(ctx, -halfL + length * 0.1, -halfW * 0.55, length * 0.8, halfW * 1.1, radius * 0.4);
    ctx.stroke();
  }
  if (v.tags & VehicleTag.Trunk) {
    ctx.fillStyle = palette.lemon;
    roundRect(ctx, -halfL + length * 0.08, -halfW * 0.42, length * 0.2, halfW * 0.84, radius * 0.3);
    ctx.fill();
    ctx.fillStyle = palette.ink;
    ctx.beginPath();
    ctx.arc(-halfL + length * 0.18, 0, width * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
  if (v.isRide) {
    // Your Ride wears a roof stripe so it is findable in a packed lot.
    ctx.fillStyle = withAlpha(palette.cream, 0.6);
    roundRect(ctx, -length * 0.02, -halfW * 0.8, length * 0.04, halfW * 1.6, radius * 0.2);
    ctx.fill();
  }

  ctx.restore();
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
  ctx.lineWidth = Math.max(2, cw * 0.05);
  ctx.setLineDash([cw * 0.16, cw * 0.14]);
  ctx.strokeStyle = withAlpha(preview.exits ? palette.mintLight : palette.cream, 0.75);
  for (const cell of preview.cells) {
    roundRect(ctx, ox + (cell.x + 0.2) * cw, oy + (cell.y + 0.2) * ch, cw * 0.6, ch * 0.6, cw * 0.14);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (preview.blocked) {
    ctx.fillStyle = withAlpha(palette.coral, 0.3);
    roundRect(
      ctx,
      ox + (preview.blocked.x + 0.08) * cw,
      oy + (preview.blocked.y + 0.08) * ch,
      cw * 0.84,
      ch * 0.84,
      cw * 0.18,
    );
    ctx.fill();
  }
  ctx.restore();
}

export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: readonly Particle[],
): void {
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
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (p.kind === 'dust' ? 2 - t : 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Night Shift: the lot is lit only by headlight cones that follow facing. */
export function drawNightMask(
  ctx: CanvasRenderingContext2D,
  vehicles: readonly VehicleView[],
  cam: Camera,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(18, 24, 40, 0.82)';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';
  for (const v of vehicles) {
    if (v.alpha <= 0) continue;
    const bounds = vehicleBounds(v);
    const cx = cam.ox + ((bounds.x0 + bounds.x1) / 2) * cam.cw;
    const cy = cam.oy + ((bounds.y0 + bounds.y1) / 2) * cam.ch;
    const nx = cam.ox + (v.gx + 0.5 + DX[v.facing] * 0.5) * cam.cw;
    const ny = cam.oy + (v.gy + 0.5 + DY[v.facing] * 0.5) * cam.ch;
    const angle = Math.atan2(ny - cy, nx - cx);
    const reach = cam.cw * 3.2;
    const cone = ctx.createRadialGradient(nx, ny, 0, nx, ny, reach);
    cone.addColorStop(0, 'rgba(255, 240, 200, 0.5)');
    cone.addColorStop(1, 'rgba(255, 240, 200, 0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(nx, ny);
    ctx.arc(nx, ny, reach, angle - 0.5, angle + 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
