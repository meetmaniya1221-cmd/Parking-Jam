/**
 * Low-level painting primitives for the lot renderer.
 *
 * Two ideas carry the whole visual upgrade:
 *
 * 1. **Bake what does not move.** Asphalt grain, stains and tyre scuff are
 *    expensive per-pixel work, so they are generated once into a repeatable
 *    tile and stamped as a pattern. The ground is already blitted from an
 *    offscreen canvas, so the cost is paid on resize, not per frame.
 *
 * 2. **Cache what repeats.** A parked vehicle is the same picture frame after
 *    frame, so it is rendered once into its own small canvas and blitted. That
 *    is what makes a multi-volume body with glass, gloss and contact shadow
 *    affordable at twenty-odd cars — the per-frame cost of a still car drops to
 *    a single `drawImage`. Anything mid-bump falls back to painting live, which
 *    is at most a car or two at a time.
 *
 * Nothing here uses `ctx.shadowBlur`. It is the slowest thing in Canvas 2D and
 * every soft edge in this game is cheaper to draw as a stack of shapes.
 */

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export function roundRect(
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

export function quad(
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

/* ------------------------------------------------------------------ *
 * Deterministic noise
 * ------------------------------------------------------------------ */

/**
 * A tiny LCG. Ground decoration has to land in the same place every time the
 * ground is baked, or rotating the phone would reshuffle every stain.
 */
export function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Asphalt grain
 * ------------------------------------------------------------------ */

let grainCanvas: HTMLCanvasElement | null = null;

/**
 * A tileable asphalt aggregate: fine salt-and-pepper for the chip, plus softer
 * clumps so it does not read as television static. Alpha-only, so it tints any
 * surface it is stamped over.
 */
export function grainTile(): HTMLCanvasElement | null {
  if (grainCanvas) return grainCanvas;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;

  const img = g.createImageData(size, size);
  const data = img.data;
  const rnd = makeRng(0x5eed1234);
  for (let i = 0; i < size * size; i++) {
    const n = rnd();
    // Push the distribution to the tails: mostly clear, occasional bright chip
    // and dark pit. A linear ramp here looks like fog rather than aggregate.
    const bias = (n - 0.5) * 2;
    const a = Math.pow(Math.abs(bias), 3) * 150;
    const v = bias > 0 ? 255 : 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = a;
  }
  g.putImageData(img, 0, 0);

  // Clumps, drawn wrapped so the tile still repeats seamlessly.
  const rnd2 = makeRng(0xa11ce);
  for (let i = 0; i < 90; i++) {
    const x = rnd2() * size;
    const y = rnd2() * size;
    const r = 1.5 + rnd2() * 5;
    const dark = rnd2() < 0.55;
    g.fillStyle = dark ? `rgba(0,0,0,${0.05 + rnd2() * 0.08})` : `rgba(255,255,255,${0.03 + rnd2() * 0.05})`;
    for (const [wx, wy] of [
      [0, 0],
      [size, 0],
      [-size, 0],
      [0, size],
      [0, -size],
    ]) {
      g.beginPath();
      g.arc(x + wx, y + wy, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  grainCanvas = c;
  return c;
}

let grainScratch: HTMLCanvasElement | null = null;

/**
 * Stamp the aggregate over a rect.
 *
 * The pattern is filled into a **CSS-resolution** scratch and blitted up rather
 * than filled straight onto the device-resolution target. A pattern fill costs
 * per destination pixel, so doing it at 1× and letting the scaled blit do the
 * rest is four times less work at dpr 2 and nine times less at dpr 3 — and
 * grain is noise, so the softening the upscale adds is no loss at all.
 */
export function stampGrain(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  alpha: number,
): void {
  const tile = grainTile();
  if (!tile || w <= 0 || h <= 0) return;
  const gw = Math.max(1, Math.ceil(w));
  const gh = Math.max(1, Math.ceil(h));
  if (!grainScratch) grainScratch = document.createElement('canvas');
  const scratch = grainScratch;
  if (scratch.width !== gw || scratch.height !== gh) {
    scratch.width = gw;
    scratch.height = gh;
  }
  const g = scratch.getContext('2d');
  if (!g) return;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, gw, gh);
  const pattern = g.createPattern(tile, 'repeat');
  if (!pattern) return;
  if (typeof DOMMatrix !== 'undefined' && pattern.setTransform) {
    pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, 0, 0]));
  }
  g.fillStyle = pattern;
  g.fillRect(0, 0, gw, gh);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(scratch, x, y, w, h);
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Sprite cache
 * ------------------------------------------------------------------ */

interface Sprite {
  canvas: HTMLCanvasElement;
  /** CSS-pixel size, so callers blit at the right scale. */
  w: number;
  h: number;
}

const sprites = new Map<string, Sprite>();
/** Bounded so a long session cannot grow the cache without limit. */
const SPRITE_BUDGET = 64;

/**
 * Render `paint` once into its own canvas and reuse it thereafter.
 *
 * `paint` draws in CSS pixels with the sprite's top-left at the origin; the
 * device-pixel scaling is handled here so callers never think about dpr.
 */
export function sprite(
  key: string,
  w: number,
  h: number,
  dpr: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): Sprite | null {
  const hit = sprites.get(key);
  if (hit) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this entry to the young end and keeps eviction honest.
    sprites.delete(key);
    sprites.set(key, hit);
    return hit;
  }
  if (w <= 0 || h <= 0 || !Number.isFinite(w) || !Number.isFinite(h)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w * dpr));
  canvas.height = Math.max(1, Math.ceil(h * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint(ctx);

  const made: Sprite = { canvas, w, h };
  sprites.set(key, made);
  while (sprites.size > SPRITE_BUDGET) {
    const oldest = sprites.keys().next();
    if (oldest.done) break;
    sprites.delete(oldest.value);
  }
  return made;
}

/**
 * Drop every cached sprite. Called whenever something global to the look
 * changes — palette, contrast mode, cell size — since the key deliberately
 * does not encode the palette itself.
 */
export function resetSprites(): void {
  sprites.clear();
}
