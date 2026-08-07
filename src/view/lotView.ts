/**
 * The playable lot: input, animation and the frame loop.
 *
 * Feedback hierarchy (GDD §12), all inside 100 ms:
 *  1. touch-down highlights and lifts the car,
 *  2. the drag tracks the thumb 1:1 along the car's own axis, with a dotted
 *     path preview and a coral tint on the cell that says no,
 *  3. release snaps with a settle bounce, or commits the exit outright,
 *  4. a bump honks, wobbles and flashes the blocker — the player always knows
 *     *which* car refused,
 *  5. an off-axis drag is refused with a small head-shake and no sound, because
 *     that is not an error, just physics.
 */

import {
  applyMove,
  capability,
  createLotState,
  probe,
  rebuildOcc,
  resolveMove,
  resolvePivot,
  terrainAt,
} from '../core/sim';
import {
  BlockReason,
  Dir,
  DX,
  DY,
  LevelDef,
  LotState,
  Move,
  MoveKind,
  Terrain,
  VehicleKind,
  VehicleTag,
  VEHICLE_LENGTH,
} from '../core/types';
import { AudioEngine, vibrate } from '../audio/audio';
import { findHorn, findRide, fleetColor, HornShape } from '../meta/garage';
import { Settings } from '../meta/save';
import {
  Camera,
  drawGround,
  drawNightMask,
  drawParticles,
  drawPreview,
  drawVehicle,
  fitCamera,
  Particle,
  PathPreview,
  screenToCell,
  VehicleView,
  vehicleBounds,
} from './lotRenderer';
import { Palette } from './theme';

export interface LotViewContext {
  palette: Palette;
  settings: Settings;
  liveryId: string;
  rideId: string;
  hornId: string;
  night: boolean;
}

export interface LotViewEvents {
  onPickUp?: (vi: number) => void;
  onSlide?: (vi: number, move: Move) => void;
  onExit?: (vi: number, remaining: number) => void;
  onBump?: (vi: number, blockerVi: number, reason: BlockReason) => void;
  onCleared?: () => void;
  onLastCar?: () => void;
  onStateChanged?: () => void;
}

interface HistoryEntry {
  x: Int16Array;
  y: Int16Array;
  facing: Uint8Array;
  gone: Uint8Array;
  remaining: number;
  vipsRemaining: number;
  slides: number;
  bumps: number;
}

interface Anim {
  gx: number;
  gy: number;
  fromGx: number;
  fromGy: number;
  toGx: number;
  toGy: number;
  t: number;
  duration: number;
  squash: number;
  wobble: number;
  wobbleTime: number;
  alpha: number;
  highlight: number;
  hint: number;
  flash: number;
  exiting: boolean;
  exitDir: Dir;
  exitTime: number;
  leanX: number;
  leanY: number;
}

const SLIDE_BASE_MS = 95;
const SLIDE_PER_CELL_MS = 52;
const EXIT_MS = 460;
const WOBBLE_MS = 300;
const TAP_MS = 260;
const TAP_SLOP_PX = 10;
/** Extra travel a drag may show past a blocker, as a fraction of a cell. */
const RUBBER = 0.24;

/** Furthest back a player can step. Mistakes are free, but memory is not. */
const HISTORY_LIMIT = 64;

const easeInQuad = (t: number) => t * t;

/**
 * Anticipation → action → settle (GDD §12). A short pull-back before the car
 * commits, an eased run, and a two-bounce suspension settle on arrival.
 */
function easeSlide(t: number): number {
  if (t < 0.15) return -0.055 * Math.sin((t / 0.15) * Math.PI);
  const u = (t - 0.15) / 0.85;
  return 1 - (1 - u) ** 3 + Math.sin(u * Math.PI * 2) * 0.03 * (1 - u);
}

export class LotView {
  state: LotState;
  private level: LevelDef;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio: AudioEngine;
  private readonly events: LotViewEvents;
  private view: LotViewContext;

  /** Public so automated play-testing can map cells to screen points. */
  camera: Camera = { ox: 0, oy: 0, cw: 32, ch: 30 };
  private cameraScale = 1;
  private targetCameraScale = 1;
  private ground: HTMLCanvasElement | null = null;
  private groundDirty = true;

  private anims: Anim[] = [];
  private particles: Particle[] = [];
  private raf = 0;
  private lastFrame = 0;
  private timeScale = 1;
  private slowMoRemaining = 0;
  private dpr = 1;

  private dragVi = -1;
  private dragOffset = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartAt = 0;
  private dragMoved = false;
  private lastPointerAt = 0;
  private lastOffset = 0;
  private headShake = 0;
  private pointerId: number | null = null;

  private preview: PathPreview | null = null;
  private hintIds: number[] = [];
  private interactive = true;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private tapTarget: ((vi: number) => void) | null = null;
  private history: HistoryEntry[] = [];
  private keyboardVi = 0;
  private rideIndex = 0;
  private keyboardFocused = false;

  constructor(
    canvas: HTMLCanvasElement,
    level: LevelDef,
    audio: AudioEngine,
    view: LotViewContext,
    events: LotViewEvents = {},
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.audio = audio;
    this.view = view;
    this.events = events;
    this.level = level;
    this.state = createLotState(level);
    this.anims = this.buildAnims();
    this.rideIndex = this.pickRideIndex();

    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('focus', this.onFocus);
    canvas.addEventListener('blur', this.onBlur);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.resize();
    this.start();
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  private buildAnims(): Anim[] {
    return Array.from({ length: this.state.x.length }, (_, i) => ({
      gx: this.state.x[i],
      gy: this.state.y[i],
      fromGx: this.state.x[i],
      fromGy: this.state.y[i],
      toGx: this.state.x[i],
      toGy: this.state.y[i],
      t: 1,
      duration: 1,
      squash: 0,
      wobble: 0,
      wobbleTime: 0,
      alpha: this.state.gone[i] ? 0 : 1,
      highlight: 0,
      hint: 0,
      flash: 0,
      exiting: false,
      exitDir: 0 as Dir,
      exitTime: 0,
      leanX: 0,
      leanY: 0,
    }));
  }

  setLevel(level: LevelDef, restore?: { vehicles: number[] }): void {
    this.level = level;
    this.state = createLotState(level);
    if (restore) this.applyRestore(restore.vehicles);
    this.anims = this.buildAnims();
    this.rideIndex = this.pickRideIndex();
    this.history = [];
    this.particles.length = 0;
    this.hintIds = [];
    this.preview = null;
    this.dragVi = -1;
    this.cameraScale = 1;
    this.targetCameraScale = 1;
    this.groundDirty = true;
    this.interactive = true;
    this.resize();
  }

  private applyRestore(flat: number[]): void {
    const n = this.state.x.length;
    if (flat.length !== n * 4) return;
    if (!this.restoreFits(flat)) return;
    for (let i = 0; i < n; i++) {
      this.state.x[i] = flat[i * 4];
      this.state.y[i] = flat[i * 4 + 1];
      this.state.facing[i] = flat[i * 4 + 2];
      this.state.gone[i] = flat[i * 4 + 3];
    }
    this.state.remaining = 0;
    this.state.vipsRemaining = 0;
    for (let i = 0; i < n; i++) {
      if (this.state.gone[i]) continue;
      this.state.remaining++;
      if (this.state.tags[i] & VehicleTag.Vip) this.state.vipsRemaining++;
    }
    this.state.occ.fill(-1);
    for (let i = 0; i < n; i++) {
      if (this.state.gone[i]) continue;
      const f = this.state.facing[i] as Dir;
      for (let k = 0; k < this.state.len[i]; k++) {
        const cx = this.state.x[i] - DX[f] * k;
        const cy = this.state.y[i] - DY[f] * k;
        this.state.occ[cy * this.level.w + cx] = i;
      }
    }
  }

  /**
   * A snapshot written by an older build could describe a lot this build no
   * longer generates. Rather than corrupt the grid, check every car lands on
   * free asphalt first and fall back to a fresh lot if not.
   */
  private restoreFits(flat: number[]): boolean {
    const seen = new Set<number>();
    for (let i = 0; i < this.state.x.length; i++) {
      if (flat[i * 4 + 3]) continue;
      const nx = flat[i * 4];
      const ny = flat[i * 4 + 1];
      const f = flat[i * 4 + 2] as Dir;
      if (f < 0 || f > 3) return false;
      for (let k = 0; k < this.state.len[i]; k++) {
        const cx = nx - DX[f] * k;
        const cy = ny - DY[f] * k;
        if (cx < 0 || cy < 0 || cx >= this.level.w || cy >= this.level.h) return false;
        const idx = cy * this.level.w + cx;
        if (this.level.terrain[idx] === Terrain.Blocked) return false;
        if (seen.has(idx)) return false;
        seen.add(idx);
      }
    }
    return true;
  }

  /** Serialise placements so an abandoned lot resumes exactly as left (GDD §14). */
  snapshot(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.state.x.length; i++) {
      out.push(this.state.x[i], this.state.y[i], this.state.facing[i], this.state.gone[i]);
    }
    return out;
  }

  setContext(view: LotViewContext): void {
    const groundChanged =
      view.palette !== this.view.palette || view.settings.highContrast !== this.view.settings.highContrast;
    this.view = view;
    if (groundChanged) this.groundDirty = true;
  }

  /**
   * Swap in a modified level definition, keeping every car exactly where it is.
   * Used by Green Wave (arrows suspended) and Grip Tires (slicks inert), which
   * change the rules of the lot mid-level but never its layout.
   */
  overrideLevel(transform: (level: LevelDef) => LevelDef): void {
    const next = transform(this.level);
    this.level = next;
    this.state.level = next;
    this.groundDirty = true;
  }

  /** Remove a car outright — the Tow Hook booster. */
  towVehicle(vi: number): boolean {
    if (vi < 0 || vi >= this.state.x.length || this.state.gone[vi]) return false;
    const anim = this.anims[vi];
    const facing = this.state.facing[vi] as Dir;
    this.state.gone[vi] = 1;
    this.state.remaining--;
    if (this.state.tags[vi] & VehicleTag.Vip) this.state.vipsRemaining--;
    const w = this.level.w;
    for (let k = 0; k < this.state.len[vi]; k++) {
      const cx = this.state.x[vi] - DX[facing] * k;
      const cy = this.state.y[vi] - DY[facing] * k;
      this.state.occ[cy * w + cx] = -1;
    }
    anim.exiting = true;
    anim.exitDir = facing;
    anim.exitTime = 0;
    anim.fromGx = anim.gx;
    anim.fromGy = anim.gy;
    anim.toGx = anim.gx;
    anim.toGy = anim.gy - 1.4;
    anim.t = 0;
    anim.duration = this.duration(EXIT_MS);
    this.spawnDust(vi, facing);
    this.audio.exit(this.state.remaining, this.state.x.length);
    this.events.onExit?.(vi, this.state.remaining);
    this.events.onStateChanged?.();
    if (this.state.remaining === 0) {
      window.setTimeout(() => {
        if (!this.destroyed) this.events.onCleared?.();
      }, this.duration(EXIT_MS + 220));
    }
    return true;
  }

  /** Route the next tap to a callback instead of the drag handler. */
  setTapTarget(handler: ((vi: number) => void) | null): void {
    this.tapTarget = handler;
  }

  setInteractive(value: boolean): void {
    this.interactive = value;
    if (!value) this.cancelDrag();
  }

  setHints(ids: number[]): void {
    this.hintIds = ids;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    this.canvas.removeEventListener('focus', this.onFocus);
    this.canvas.removeEventListener('blur', this.onBlur);
    this.resizeObserver?.disconnect();
    this.audio.stopTire();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const pixelW = Math.round(width * this.dpr);
    const pixelH = Math.round(height * this.dpr);
    if (this.canvas.width !== pixelW || this.canvas.height !== pixelH) {
      this.canvas.width = pixelW;
      this.canvas.height = pixelH;
      this.groundDirty = true;
    }
    const padding = Math.max(10, Math.min(width, height) * 0.05);
    this.camera = fitCamera(this.level, width, height, padding);
    this.groundDirty = true;
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private vehicleAt(x: number, y: number): number {
    const cell = screenToCell(this.camera, x, y);
    if (cell.x < 0 || cell.y < 0 || cell.x >= this.level.w || cell.y >= this.level.h) return -1;
    return this.state.occ[cell.y * this.level.w + cell.x];
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.interactive) return;
    const point = this.localPoint(e);
    const vi = this.vehicleAt(point.x, point.y);
    if (vi < 0) return;
    e.preventDefault();
    if (this.tapTarget) {
      const handler = this.tapTarget;
      this.tapTarget = null;
      handler(vi);
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.pointerId = e.pointerId;
    this.dragVi = vi;
    this.dragOffset = 0;
    this.lastOffset = 0;
    this.dragStartX = point.x;
    this.dragStartY = point.y;
    this.dragStartAt = performance.now();
    this.lastPointerAt = this.dragStartAt;
    this.dragMoved = false;
    this.anims[vi].highlight = 1;
    this.audio.pickUp();
    this.audio.startTire();
    vibrate(this.view.settings, 8);
    this.events.onPickUp?.(vi);
    this.updatePreview();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragVi < 0 || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const point = this.localPoint(e);
    const dx = point.x - this.dragStartX;
    const dy = point.y - this.dragStartY;
    if (!this.dragMoved && Math.hypot(dx, dy) > TAP_SLOP_PX) this.dragMoved = true;

    const facing = this.state.facing[this.dragVi] as Dir;
    const horizontal = facing === 1 || facing === 3;
    const alongPx = horizontal ? dx : dy;
    const acrossPx = horizontal ? dy : dx;

    // Off-axis: refuse with a head-shake and deliberately no sound. It is not
    // an error, just physics (GDD §12).
    if (Math.abs(acrossPx) > Math.abs(alongPx) * 1.8 && Math.abs(acrossPx) > TAP_SLOP_PX * 2) {
      this.headShake = Math.min(1, this.headShake + 0.25);
    }

    const cellSize = horizontal ? this.camera.cw : this.camera.ch;
    let cells = alongPx / Math.max(1, cellSize);
    // Convert screen delta to travel along the car's own facing.
    const sign = facing === 1 || facing === 2 ? 1 : -1;
    cells *= sign;

    const cap = capability(this.state, this.dragVi);
    const maxForward = cap.forward.exitDist >= 0 ? cap.forward.exitDist + 1 : cap.forward.dist;
    const maxBackward = cap.backward.dist;

    const clamped =
      cells > 0
        ? Math.min(cells, maxForward + RUBBER * rubber(cells - maxForward))
        : Math.max(cells, -(maxBackward + RUBBER * rubber(-cells - maxBackward)));

    const now = performance.now();
    const dt = Math.max(1, now - this.lastPointerAt);
    const speed = Math.abs(clamped - this.lastOffset) / (dt / 1000) / 6;
    this.audio.updateTire(Math.min(1, speed));
    this.lastPointerAt = now;
    this.lastOffset = clamped;
    this.dragOffset = clamped;

    // Dragging past the curb cut commits the exit immediately — no second tap.
    if (cap.forward.exitDist >= 0 && clamped >= cap.forward.exitDist + 0.35) {
      const move = resolveMove(this.state, this.dragVi, facing, cap.forward.exitDist);
      this.cancelDrag();
      if (move) this.commit(move);
      return;
    }

    this.updatePreview();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.dragVi < 0 || e.pointerId !== this.pointerId) return;
    const vi = this.dragVi;
    const elapsed = performance.now() - this.dragStartAt;
    const offset = this.dragOffset;
    this.cancelDrag();

    // A quick tap drives the car as far forward as it can go — the one-thumb
    // path through the whole game.
    if (!this.dragMoved && elapsed < TAP_MS) {
      this.tapDrive(vi);
      return;
    }

    const facing = this.state.facing[vi] as Dir;
    const forward = offset >= 0;
    const dir = forward ? facing : (((facing + 2) % 4) as Dir);
    const requested = Math.round(Math.abs(offset));
    if (requested <= 0) {
      // The player pushed and nothing gave: that is a bump, and it is free.
      if (Math.abs(offset) > 0.12) this.bump(vi, dir);
      else this.settle(vi);
      return;
    }
    const move = resolveMove(this.state, vi, dir, requested);
    if (move) this.commit(move);
    else this.bump(vi, dir);
  };

  private onPointerCancel = (): void => {
    const vi = this.dragVi;
    this.cancelDrag();
    if (vi >= 0) this.settle(vi);
  };

  /**
   * Keyboard play. The lot is a grid of discrete objects, so it maps cleanly to
   * a cursor: step through the cars still on the lot, drive the selected one,
   * reverse it, or step back a move. Without this the game needs a pointer,
   * which is not a reasonable thing to require.
   */
  private onFocus = (): void => {
    this.keyboardFocused = true;
  };

  private onBlur = (): void => {
    this.keyboardFocused = false;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.interactive) return;
    const live: number[] = [];
    for (let i = 0; i < this.state.x.length; i++) if (!this.state.gone[i]) live.push(i);
    if (live.length === 0) return;

    const step = (delta: number) => {
      const at = live.indexOf(this.keyboardVi);
      this.keyboardVi = live[(at + delta + live.length) % live.length];
      this.anims[this.keyboardVi].highlight = 1;
      this.audio.pickUp();
    };

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'Tab':
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        step(-1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        if (!live.includes(this.keyboardVi)) this.keyboardVi = live[0];
        this.tapDrive(this.keyboardVi);
        break;
      }
      case 'Backspace':
      case 'z':
      case 'Z':
        e.preventDefault();
        this.undo();
        break;
      case 'r':
      case 'R': {
        // Reverse the selected car one cell.
        e.preventDefault();
        if (!live.includes(this.keyboardVi)) this.keyboardVi = live[0];
        const back = ((this.state.facing[this.keyboardVi] + 2) % 4) as Dir;
        const move = resolveMove(this.state, this.keyboardVi, back, 1);
        if (move) this.commit(move);
        else this.bump(this.keyboardVi, back);
        break;
      }
      default:
        return;
    }
    this.events.onStateChanged?.();
  };

  /** The car the keyboard cursor is on, or −1. */
  get selectedVehicle(): number {
    return this.keyboardVi;
  }

  private cancelDrag(): void {
    if (this.dragVi >= 0) this.anims[this.dragVi].highlight = 0;
    if (this.pointerId !== null) {
      try {
        this.canvas.releasePointerCapture(this.pointerId);
      } catch {
        /* pointer already released */
      }
    }
    this.pointerId = null;
    this.dragVi = -1;
    this.dragOffset = 0;
    this.preview = null;
    this.audio.stopTire();
  }

  /** Tap: exit if the street is reachable, otherwise pull forward, otherwise honk. */
  private tapDrive(vi: number): void {
    const facing = this.state.facing[vi] as Dir;
    const cap = capability(this.state, vi);
    if (cap.forward.exitDist >= 0) {
      // A car already parked on the curb cut has an exit distance of zero, and
      // resolveMove only acts on a positive request — so ask for at least one.
      const move = resolveMove(this.state, vi, facing, Math.max(1, cap.forward.exitDist));
      if (move) {
        this.commit(move);
        return;
      }
    }
    if (cap.forward.dist > 0) {
      const move = resolveMove(this.state, vi, facing, cap.forward.dist);
      if (move) {
        this.commit(move);
        return;
      }
    }
    // A car nosed onto a roundabout plate turns instead of honking.
    if (cap.canPivot) {
      const pivot = resolvePivot(this.state, vi);
      if (pivot) {
        this.commit(pivot);
        return;
      }
    }
    this.bump(vi, facing);
  }

  /* ---------------------------------------------------------------- *
   * Move application
   * ---------------------------------------------------------------- */

  private pushHistory(): void {
    this.history.push({
      x: this.state.x.slice(),
      y: this.state.y.slice(),
      facing: this.state.facing.slice(),
      gone: this.state.gone.slice(),
      remaining: this.state.remaining,
      vipsRemaining: this.state.vipsRemaining,
      slides: this.state.slides,
      bumps: this.state.bumps,
    });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  /**
   * Step back one move. One-way arrows and oil slicks make some moves
   * irreversible, so without this a player could park themselves into a lot
   * that can no longer be cleared — which would break the promise that a
   * mistake costs nothing.
   */
  undo(): boolean {
    const entry = this.history.pop();
    if (!entry) return false;
    this.cancelDrag();
    this.state.x.set(entry.x);
    this.state.y.set(entry.y);
    this.state.facing.set(entry.facing);
    this.state.gone.set(entry.gone);
    this.state.remaining = entry.remaining;
    this.state.vipsRemaining = entry.vipsRemaining;
    this.state.slides = entry.slides;
    this.state.bumps = entry.bumps;
    rebuildOcc(this.state);

    for (let i = 0; i < this.anims.length; i++) {
      const a = this.anims[i];
      a.fromGx = a.gx;
      a.fromGy = a.gy;
      a.toGx = this.state.x[i];
      a.toGy = this.state.y[i];
      a.t = 0;
      a.duration = this.duration(180);
      a.exiting = false;
      a.exitTime = 0;
      a.alpha = this.state.gone[i] ? 0 : 1;
      a.squash = 0;
      a.wobbleTime = 0;
    }
    this.audio.snap();
    vibrate(this.view.settings, 8);
    this.events.onStateChanged?.();
    return true;
  }

  private commit(move: Move): void {
    this.pushHistory();
    const vi = move.vi;
    const anim = this.anims[vi];
    const total = this.state.x.length;

    anim.fromGx = anim.gx;
    anim.fromGy = anim.gy;
    anim.t = 0;

    if (move.kind === MoveKind.Pivot) {
      applyMove(this.state, move);
      anim.toGx = anim.gx;
      anim.toGy = anim.gy;
      anim.duration = this.duration(160);
      this.audio.snap();
      vibrate(this.view.settings, 10);
      this.events.onSlide?.(vi, move);
      this.events.onStateChanged?.();
      return;
    }

    const travel = move.kind === MoveKind.Exit ? move.distance + this.level.w + this.level.h : move.distance;
    anim.toGx = this.state.x[vi] + DX[move.dir] * (move.kind === MoveKind.Exit ? travel : move.distance);
    anim.toGy = this.state.y[vi] + DY[move.dir] * (move.kind === MoveKind.Exit ? travel : move.distance);
    anim.duration = this.duration(
      move.kind === MoveKind.Exit ? EXIT_MS : SLIDE_BASE_MS + SLIDE_PER_CELL_MS * move.distance,
    );

    const isLast = move.kind === MoveKind.Exit && this.state.remaining === 1;
    applyMove(this.state, move);

    if (move.kind === MoveKind.Exit) {
      anim.exiting = true;
      anim.exitDir = move.dir;
      anim.exitTime = 0;
      this.spawnDust(vi, move.dir);
      this.audio.exit(this.state.remaining, total);
      vibrate(this.view.settings, [12, 30, 18], true);
      this.events.onExit?.(vi, this.state.remaining);
      if (this.state.remaining <= 3 && this.state.remaining > 0) this.spawnConfetti(vi);
      if (isLast) {
        // 0.4 s of slow motion before the final glide — the engineered peak.
        if (!this.view.settings.reducedMotion) {
          this.slowMoRemaining = 0.4;
          this.timeScale = 0.35;
        }
        this.targetCameraScale = this.view.settings.reducedMotion ? 1 : 0.86;
        this.audio.duck(0.4, 0.6);
        this.events.onLastCar?.();
      }
    } else {
      this.audio.snap();
      vibrate(this.view.settings, 10);
      this.events.onSlide?.(vi, move);
      if (move.slidExtra > 0) this.spawnDust(vi, move.dir);
    }

    this.events.onStateChanged?.();
    if (this.state.remaining === 0) {
      window.setTimeout(
        () => {
          if (!this.destroyed) this.events.onCleared?.();
        },
        this.duration(EXIT_MS + 220),
      );
    }
  }

  private bump(vi: number, dir: Dir): void {
    const p = probe(this.state, vi, dir);
    const anim = this.anims[vi];
    anim.squash = 1;
    anim.wobbleTime = WOBBLE_MS;
    this.state.bumps++;

    const shape = this.hornFor(vi);
    this.audio.bump(shape.shape, shape.freq);
    vibrate(this.view.settings, 22, true);

    if (p.block.blockerVi >= 0) this.anims[p.block.blockerVi].flash = 1;
    this.spawnRing(vi);
    this.events.onBump?.(vi, p.block.blockerVi, p.block.reason);
    this.events.onStateChanged?.();
  }

  private settle(vi: number): void {
    this.anims[vi].squash = 0.35;
  }

  private hornFor(vi: number): { shape: HornShape; freq: number } {
    const kind = this.level.vehicles[vi].kind;
    // The player's equipped horn plays for their own Ride; everyone else keeps
    // their class voice, which is what makes a bump diagnostic.
    if (vi === this.rideIndex) {
      const horn = findHorn(this.view.hornId);
      return { shape: horn.shape, freq: horn.freq };
    }
    switch (kind) {
      case 'taxi':
        return { shape: 'double', freq: 440 };
      case 'boxTruck':
      case 'trailer':
      case 'bus':
        return { shape: 'baritone', freq: 168 };
      case 'ambulance':
        return { shape: 'whoop', freq: 700 };
      case 'van':
        return { shape: 'brass', freq: 330 };
      case 'coupe':
        return { shape: 'synth', freq: 620 };
      default:
        return { shape: 'chirp', freq: 520 };
    }
  }

  /**
   * The equipped Ride always appears in the lot and stars in the final exit, so
   * it has to be the *same* car all level — recomputing it each frame made it
   * hop between vehicles as the lot emptied.
   */
  private pickRideIndex(): number {
    for (let i = 0; i < this.state.x.length; i++) {
      if (this.level.vehicles[i].kind === VehicleKind.Sedan) return i;
    }
    return 0;
  }

  /* ---------------------------------------------------------------- *
   * Particles
   * ---------------------------------------------------------------- */

  private vehicleCenter(vi: number): { x: number; y: number } {
    const anim = this.anims[vi];
    const bounds = vehicleBounds({
      gx: anim.gx,
      gy: anim.gy,
      facing: this.state.facing[vi] as Dir,
      len: this.state.len[vi],
    });
    return {
      x: this.camera.ox + ((bounds.x0 + bounds.x1) / 2) * this.camera.cw,
      y: this.camera.oy + ((bounds.y0 + bounds.y1) / 2) * this.camera.ch,
    };
  }

  private spawnDust(vi: number, dir: Dir): void {
    if (this.view.settings.reducedMotion) return;
    const c = this.vehicleCenter(vi);
    for (let i = 0; i < 7; i++) {
      this.particles.push({
        x: c.x - DX[dir] * this.camera.cw * 0.4,
        y: c.y - DY[dir] * this.camera.ch * 0.4,
        vx: (Math.random() - 0.5) * 40 - DX[dir] * 30,
        vy: (Math.random() - 0.5) * 40 - DY[dir] * 30,
        life: 0.5,
        maxLife: 0.5,
        size: this.camera.cw * 0.06,
        color: 'rgba(246, 231, 200, 0.75)',
        kind: 'dust',
      });
    }
  }

  private spawnConfetti(vi: number): void {
    if (this.view.settings.reducedMotion) return;
    const c = this.vehicleCenter(vi);
    const colors = [this.view.palette.lemon, this.view.palette.mint, this.view.palette.sky];
    for (let i = 0; i < 12; i++) {
      this.particles.push({
        x: c.x,
        y: c.y,
        vx: (Math.random() - 0.5) * 180,
        vy: -60 - Math.random() * 140,
        life: 0.9,
        maxLife: 0.9,
        size: this.camera.cw * 0.12,
        color: colors[i % colors.length],
        kind: 'confetti',
      });
    }
  }

  private spawnRing(vi: number): void {
    if (this.view.settings.reducedMotion) return;
    const c = this.vehicleCenter(vi);
    this.particles.push({
      x: c.x,
      y: c.y,
      vx: 0,
      vy: 0,
      life: 0.4,
      maxLife: 0.4,
      size: this.camera.cw * 0.34,
      color: this.view.palette.coral,
      kind: 'ring',
    });
  }

  /* ---------------------------------------------------------------- *
   * Preview
   * ---------------------------------------------------------------- */

  private updatePreview(): void {
    if (this.dragVi < 0) {
      this.preview = null;
      return;
    }
    const vi = this.dragVi;
    const facing = this.state.facing[vi] as Dir;
    const forward = this.dragOffset >= 0;
    const dir = forward ? facing : (((facing + 2) % 4) as Dir);
    const p = probe(this.state, vi, dir);

    const cells: Array<{ x: number; y: number }> = [];
    const lead = forward
      ? { x: this.state.x[vi], y: this.state.y[vi] }
      : {
          x: this.state.x[vi] - DX[facing] * (this.state.len[vi] - 1),
          y: this.state.y[vi] - DY[facing] * (this.state.len[vi] - 1),
        };
    for (let k = 1; k <= p.dist; k++) {
      cells.push({ x: lead.x + DX[dir] * k, y: lead.y + DY[dir] * k });
    }
    this.preview = {
      cells,
      blocked:
        p.block.reason === BlockReason.Vehicle ||
        p.block.reason === BlockReason.Static ||
        p.block.reason === BlockReason.OneWay
          ? { x: p.block.cellX, y: p.block.cellY }
          : null,
      exits: forward && p.exitDist >= 0,
    };
  }

  /* ---------------------------------------------------------------- *
   * Frame loop
   * ---------------------------------------------------------------- */

  private duration(ms: number): number {
    return this.view.settings.reducedMotion ? ms * 0.45 : ms;
  }

  private start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      if (this.destroyed) return;
      const rawDt = Math.min(0.05, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.step(rawDt);
      this.render();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private step(rawDt: number): void {
    if (this.slowMoRemaining > 0) {
      this.slowMoRemaining -= rawDt;
      if (this.slowMoRemaining <= 0) this.timeScale = 1;
    }
    const dt = rawDt * this.timeScale;

    this.cameraScale += (this.targetCameraScale - this.cameraScale) * Math.min(1, dt * 4);
    this.headShake = Math.max(0, this.headShake - rawDt * 4);

    for (let i = 0; i < this.anims.length; i++) {
      const a = this.anims[i];

      if (a.t < 1) {
        const prevX = a.gx;
        const prevY = a.gy;
        a.t = Math.min(1, a.t + (dt * 1000) / a.duration);
        const eased = a.exiting ? easeInQuad(a.t) : easeSlide(a.t);
        a.gx = a.fromGx + (a.toGx - a.fromGx) * eased;
        a.gy = a.fromGy + (a.toGy - a.fromGy) * eased;
        // The body leans against its own acceleration — a leather-creak tilt.
        const speed = dt > 0 ? Math.hypot(a.gx - prevX, a.gy - prevY) / dt : 0;
        const towardX = a.toGx === a.fromGx ? 0 : Math.sign(a.toGx - a.fromGx);
        const towardY = a.toGy === a.fromGy ? 0 : Math.sign(a.toGy - a.fromGy);
        const tilt = Math.min(1, speed / 9) * (a.t < 0.35 ? 1 : -0.4);
        a.leanX = -towardX * tilt;
        a.leanY = -towardY * tilt;
      } else {
        a.leanX += (0 - a.leanX) * Math.min(1, dt * 12);
        a.leanY += (0 - a.leanY) * Math.min(1, dt * 12);
      }
      if (a.exiting) {
        a.exitTime += dt * 1000;
        a.alpha = Math.max(0, 1 - a.exitTime / (this.duration(EXIT_MS) * 0.85));
      }

      a.squash = Math.max(0, a.squash - dt * 4);
      if (a.wobbleTime > 0) {
        a.wobbleTime -= dt * 1000;
        const phase = a.wobbleTime / WOBBLE_MS;
        a.wobble = Math.sin(phase * Math.PI * 6) * 0.07 * phase;
      } else {
        a.wobble = 0;
      }
      a.flash = Math.max(0, a.flash - dt * 3);
      const wantHighlight = i === this.dragVi || (this.dragVi < 0 && i === this.keyboardVi && this.keyboardFocused) ? 1 : 0;
      a.highlight += (wantHighlight - a.highlight) * Math.min(1, dt * 14);
      const wantHint = this.hintIds.includes(i) ? 0.55 + Math.sin(performance.now() / 260) * 0.45 : 0;
      a.hint += (wantHint - a.hint) * Math.min(1, dt * 10);
    }

    // Head-shake on the refused car.
    if (this.dragVi >= 0 && this.headShake > 0) {
      this.anims[this.dragVi].wobble = Math.sin(performance.now() / 40) * 0.07 * this.headShake;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'confetti') p.vy += 420 * dt;
      if (p.kind === 'dust') {
        p.vx *= 0.92;
        p.vy *= 0.92;
      }
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  private bakeGround(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;
    if (!this.ground) this.ground = document.createElement('canvas');
    this.ground.width = w;
    this.ground.height = h;
    const gctx = this.ground.getContext('2d');
    if (!gctx) return;
    gctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    gctx.clearRect(0, 0, w, h);
    drawGround(gctx, this.level, this.camera, this.view.palette);
    this.groundDirty = false;
  }

  private render(): void {
    const ctx = this.ctx;
    const cssW = this.canvas.width / this.dpr;
    const cssH = this.canvas.height / this.dpr;
    if (this.groundDirty) this.bakeGround();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    ctx.save();
    if (this.cameraScale !== 1) {
      ctx.translate(cssW / 2, cssH / 2);
      ctx.scale(this.cameraScale, this.cameraScale);
      ctx.translate(-cssW / 2, -cssH / 2);
    }

    if (this.ground) ctx.drawImage(this.ground, 0, 0, cssW, cssH);
    if (this.preview) drawPreview(ctx, this.preview, this.camera, this.view.palette);

    const views = this.collectVehicleViews();
    // Painter's order: nearer to the bottom of the screen draws last.
    views.sort((a, b) => a.gy + a.gx * 0.001 - (b.gy + b.gx * 0.001));
    for (const v of views) drawVehicle(ctx, v, this.camera, this.view.palette);

    if (this.view.night) drawNightMask(ctx, views, this.camera, cssW, cssH);
    drawParticles(ctx, this.particles);
    ctx.restore();
  }

  private collectVehicleViews(): VehicleView[] {
    const out: VehicleView[] = [];
    const rideIdx = this.rideIndex;
    for (let i = 0; i < this.state.x.length; i++) {
      const a = this.anims[i];
      if (a.alpha <= 0.001 && this.state.gone[i]) continue;
      const def = this.level.vehicles[i];

      let gx = a.gx;
      let gy = a.gy;
      if (i === this.dragVi && this.dragOffset !== 0) {
        const facing = this.state.facing[i] as Dir;
        gx = this.state.x[i] + DX[facing] * this.dragOffset;
        gy = this.state.y[i] + DY[facing] * this.dragOffset;
      }

      out.push({
        vi: i,
        kind: def.kind,
        len: VEHICLE_LENGTH[def.kind],
        facing: this.state.facing[i] as Dir,
        gx,
        gy,
        // The equipped Ride wears its own paint; the rest of the lot wears the
        // fleet livery, so the player's car is findable at a glance.
        color:
          i === rideIdx
            ? findRide(this.view.rideId).body
            : fleetColor(this.view.liveryId, def.hue ?? i),
        tags: this.state.tags[i],
        squash: a.squash,
        leanX: a.leanX,
        leanY: a.leanY,
        wobble: a.wobble,
        alpha: a.alpha,
        highlight: a.highlight,
        hint: a.hint,
        flash: a.flash,
        isRide: i === rideIdx,
      });
    }
    return out;
  }

  /** True when no car can drive off the lot right now. */
  nothingCanLeave(): boolean {
    for (let vi = 0; vi < this.state.x.length; vi++) {
      if (this.state.gone[vi]) continue;
      if (probe(this.state, vi, this.state.facing[vi] as Dir).exitDist >= 0) return false;
    }
    return this.state.remaining > 0;
  }

  /** True when the nose of `vi` sits on a roundabout plate. */
  isOnPlate(vi: number): boolean {
    return terrainAt(this.level, this.state.x[vi], this.state.y[vi]) === Terrain.Roundabout;
  }
}

/** Soft resistance past a blocker: pushes back harder the further you shove. */
function rubber(overshoot: number): number {
  return overshoot <= 0 ? 0 : Math.tanh(overshoot);
}
