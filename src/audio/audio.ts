/**
 * Audio (GDD §13).
 *
 * Everything is synthesised at runtime — no sample bytes in the bundle. Three
 * buses with independent toggles (Music / Ambience / SFX), and every piece of
 * gameplay information lives on the SFX bus, so a music-off player loses zero
 * feedback. Honk density is capped at three concurrent voices with priority to
 * the car the player just hit.
 */

import { HornShape } from '../meta/garage';
import { Settings } from '../meta/save';

/** Pentatonic scale degrees per district, so each place has its own win melody. */
const DISTRICT_SCALES: readonly number[][] = [
  [0, 2, 4, 7, 9], // major pentatonic — Old Town swing
  [0, 3, 5, 7, 10], // minor pentatonic — Riverside bossa
  [0, 2, 5, 7, 9],
  [0, 2, 4, 7, 11],
  [0, 3, 5, 8, 10],
  [0, 1, 5, 7, 8],
  [0, 2, 3, 7, 9],
  [0, 4, 5, 7, 11],
  [0, 2, 5, 9, 10],
  [0, 3, 7, 10, 12],
  [0, 2, 4, 9, 11],
  [0, 5, 7, 9, 12],
];

const MAX_CONCURRENT_HORNS = 3;

function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Record<'music' | 'ambience' | 'sfx', GainNode> | null = null;
  private noise: AudioBuffer | null = null;

  private tireSource: AudioBufferSourceNode | null = null;
  private tireGain: GainNode | null = null;
  private tireFilter: BiquadFilterNode | null = null;

  private padVoices: Array<{ osc: OscillatorNode; gain: GainNode }> = [];
  private padIntensity = 0;

  private activeHorns: Array<{ at: number; stop: () => void }> = [];
  private melodyStep = 0;
  private district = 0;
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /** Must be called from a user gesture; safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    const makeBus = (value: number) => {
      const g = ctx.createGain();
      g.gain.value = value;
      g.connect(this.master!);
      return g;
    };
    this.buses = { music: makeBus(0.28), ambience: makeBus(0.16), sfx: makeBus(0.6) };

    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Slightly pink-ish noise reads warmer than white for tyre roll.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    this.noise = buffer;

    this.applySettings(this.settings);
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    if (!this.buses) return;
    this.buses.music.gain.value = settings.music ? 0.28 : 0;
    this.buses.ambience.gain.value = settings.ambience ? 0.16 : 0;
    this.buses.sfx.gain.value = settings.sfx ? (settings.calmHonks ? 0.34 : 0.6) : 0;
  }

  setDistrict(district: number): void {
    this.district = Math.max(0, Math.min(DISTRICT_SCALES.length - 1, district));
  }

  resetMelody(): void {
    this.melodyStep = 0;
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private envelope(
    bus: 'music' | 'ambience' | 'sfx',
    attack: number,
    decay: number,
    peak: number,
  ): GainNode | null {
    if (!this.ctx || !this.buses) return null;
    const g = this.ctx.createGain();
    const t = this.now();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.buses[bus]);
    return g;
  }

  private tone(
    freq: number,
    type: OscillatorType,
    attack: number,
    decay: number,
    peak: number,
    bus: 'music' | 'ambience' | 'sfx' = 'sfx',
    detune = 0,
  ): void {
    if (!this.ctx) return;
    const env = this.envelope(bus, attack, decay, peak);
    if (!env) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    osc.connect(env);
    const t = this.now();
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  private burst(
    duration: number,
    peak: number,
    filterHz: number,
    type: BiquadFilterType = 'lowpass',
  ): void {
    if (!this.ctx || !this.noise || !this.buses) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterHz;
    const env = this.envelope('sfx', 0.005, duration, peak);
    if (!env) return;
    src.connect(filter).connect(env);
    const t = this.now();
    src.start(t, Math.random() * 1.5);
    src.stop(t + duration + 0.05);
  }

  /* ---------------------------------------------------------------- *
   * The slide — the core verb, made tactile
   * ---------------------------------------------------------------- */

  /** Start (or keep alive) the tyre-on-asphalt roll while a drag is in progress. */
  startTire(): void {
    if (!this.ctx || !this.noise || !this.buses || this.tireSource) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.9;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.buses.sfx);
    src.start();
    this.tireSource = src;
    this.tireGain = gain;
    this.tireFilter = filter;
  }

  /** Pitch and grain follow drag velocity 1:1 (GDD §13). */
  updateTire(speed: number): void {
    if (!this.tireGain || !this.tireFilter || !this.ctx) return;
    const clamped = Math.max(0, Math.min(1, speed));
    const t = this.now();
    this.tireGain.gain.setTargetAtTime(clamped * 0.32, t, 0.02);
    this.tireFilter.frequency.setTargetAtTime(320 + clamped * 900, t, 0.03);
  }

  stopTire(): void {
    if (!this.tireSource || !this.tireGain || !this.ctx) return;
    const t = this.now();
    this.tireGain.gain.setTargetAtTime(0, t, 0.04);
    const src = this.tireSource;
    setTimeout(() => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }, 200);
    this.tireSource = null;
    this.tireGain = null;
    this.tireFilter = null;
  }

  /** Parking-brake ratchet on cell lock. */
  snap(): void {
    this.burst(0.06, 0.18, 2600, 'highpass');
    this.tone(180, 'sine', 0.004, 0.07, 0.12);
  }

  pickUp(): void {
    this.tone(880, 'sine', 0.004, 0.05, 0.09);
  }

  /* ---------------------------------------------------------------- *
   * Horns — character comedy, and information
   * ---------------------------------------------------------------- */

  horn(shape: HornShape, freq: number, volume = 0.3): void {
    if (!this.ctx) return;
    const t = this.now();
    // Cap concurrency; the newest honk wins because it names the newest blocker.
    this.activeHorns = this.activeHorns.filter((h) => t - h.at < 0.6);
    if (this.activeHorns.length >= MAX_CONCURRENT_HORNS) {
      this.activeHorns.shift()?.stop();
    }
    const vol = volume * (this.settings.calmHonks ? 0.55 : 1);
    const attack = this.settings.calmHonks ? 0.05 : 0.012;
    this.activeHorns.push({ at: t, stop: () => {} });

    switch (shape) {
      case 'double':
        this.tone(freq, 'square', attack, 0.1, vol * 0.5);
        window.setTimeout(() => this.tone(freq * 1.26, 'square', attack, 0.14, vol * 0.5), 110);
        break;
      case 'baritone':
        this.tone(freq, 'sawtooth', attack, 0.34, vol * 0.42);
        this.tone(freq * 1.5, 'sawtooth', attack, 0.3, vol * 0.2);
        break;
      case 'synth':
        this.tone(freq, 'triangle', attack, 0.16, vol * 0.5);
        this.tone(freq * 2, 'sine', attack, 0.12, vol * 0.22);
        break;
      case 'brass':
        this.tone(freq, 'sawtooth', attack, 0.26, vol * 0.34);
        this.tone(freq * 1.25, 'sawtooth', attack, 0.24, vol * 0.26);
        this.tone(freq * 1.5, 'sawtooth', attack, 0.22, vol * 0.18);
        break;
      case 'whoop': {
        if (!this.ctx) break;
        const env = this.envelope('sfx', attack, 0.36, vol * 0.4);
        if (!env) break;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * 0.7, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.3, t + 0.34);
        osc.connect(env);
        osc.start(t);
        osc.stop(t + 0.44);
        break;
      }
      case 'bell':
        this.tone(freq, 'sine', 0.003, 0.5, vol * 0.34);
        this.tone(freq * 2.76, 'sine', 0.003, 0.34, vol * 0.14);
        break;
      default:
        this.tone(freq, 'square', attack, 0.11, vol * 0.42);
        this.tone(freq * 1.5, 'square', attack, 0.09, vol * 0.16);
    }
  }

  /** Soft bump: a honk plus a suspension thud. Never violent. */
  bump(shape: HornShape, freq: number): void {
    this.horn(shape, freq, 0.28);
    this.burst(0.1, 0.16, 220);
  }

  /** Off-axis refusal: no sound. It is not an error, just physics (GDD §12). */
  refuse(): void {
    /* intentionally silent */
  }

  /* ---------------------------------------------------------------- *
   * Exits — each one plays the next note of the district's horn theme
   * ---------------------------------------------------------------- */

  exit(remaining: number, total: number): void {
    if (!this.ctx) return;
    const scale = DISTRICT_SCALES[this.district];
    const degree = scale[this.melodyStep % scale.length];
    const octave = Math.floor(this.melodyStep / scale.length) % 2;
    this.melodyStep++;
    const midi = 60 + degree + octave * 12;
    this.tone(midiToFreq(midi), 'triangle', 0.01, 0.36, 0.24);
    this.tone(midiToFreq(midi + 12), 'sine', 0.01, 0.2, 0.09);
    // Engine swell doppler past the curb cut.
    this.burst(0.26, 0.14, 900);
    // The counter is the metronome: exits brighten as the lot empties.
    const closeness = 1 - remaining / Math.max(1, total);
    if (remaining <= 3 && remaining > 0) {
      this.tone(midiToFreq(72 + degree), 'sine', 0.005, 0.18, 0.08 + closeness * 0.08);
    }
  }

  /** The last car resolves the tune (GDD §13). */
  levelClear(): void {
    if (!this.ctx) return;
    const scale = DISTRICT_SCALES[this.district];
    const root = 60 + scale[0];
    const chord = [root, root + scale[2], root + 12, root + 12 + scale[2]];
    chord.forEach((midi, i) => {
      window.setTimeout(() => {
        this.tone(midiToFreq(midi), 'triangle', 0.02, 0.7, 0.2);
        this.tone(midiToFreq(midi + 7), 'sine', 0.02, 0.5, 0.07);
      }, i * 70);
    });
    this.melodyStep = 0;
  }

  coins(amount: number): void {
    const clinks = Math.min(5, 1 + Math.floor(amount / 60));
    for (let i = 0; i < clinks; i++) {
      window.setTimeout(() => {
        this.tone(1400 + i * 180, 'sine', 0.003, 0.12, 0.1);
        this.tone(2100 + i * 260, 'sine', 0.003, 0.08, 0.05);
      }, i * 55);
    }
  }

  /** Rattle → pop → sting, with brightness rising by rarity. */
  trunk(rarityIndex: number): void {
    for (let i = 0; i < 6; i++) {
      window.setTimeout(() => this.burst(0.05, 0.08, 1800, 'bandpass'), i * 70);
    }
    window.setTimeout(() => {
      this.burst(0.12, 0.24, 700);
      const base = 520 + rarityIndex * 90;
      for (let i = 0; i <= rarityIndex; i++) {
        window.setTimeout(
          () => this.tone(base * (1 + i * 0.26), 'triangle', 0.005, 0.3, 0.16),
          i * 90,
        );
      }
    }, 460);
  }

  /** No buzzer anywhere in the game: a miss resolves, it does not diminish. */
  softMiss(): void {
    this.tone(392, 'sine', 0.02, 0.28, 0.12);
    window.setTimeout(() => this.tone(330, 'sine', 0.02, 0.4, 0.1), 180);
  }

  uiTap(): void {
    this.tone(660, 'sine', 0.003, 0.05, 0.07);
  }

  uiConfirm(): void {
    this.tone(660, 'triangle', 0.005, 0.1, 0.1);
    window.setTimeout(() => this.tone(880, 'triangle', 0.005, 0.16, 0.09), 70);
  }

  /** Ticket hole-punch for a City Pass tier. */
  tierUp(): void {
    this.burst(0.05, 0.2, 3000, 'highpass');
    this.tone(1046, 'square', 0.004, 0.1, 0.08);
  }

  /** The score's only full swell, eight seconds, earned. */
  timelapse(): void {
    if (!this.ctx) return;
    const scale = DISTRICT_SCALES[this.district];
    [0, 2, 4].forEach((step, i) => {
      window.setTimeout(() => {
        const midi = 48 + scale[step % scale.length];
        this.tone(midiToFreq(midi), 'sawtooth', 0.6, 2.4, 0.1, 'music');
        this.tone(midiToFreq(midi + 12), 'triangle', 0.8, 2.2, 0.07, 'music');
        this.tone(midiToFreq(midi + 19), 'sine', 1, 2, 0.05, 'music');
      }, i * 900);
    });
  }

  /* ---------------------------------------------------------------- *
   * In-level bed: adds a layer as the counter falls (Goal Gradient, scored)
   * ---------------------------------------------------------------- */

  startBed(): void {
    if (!this.ctx || !this.buses || this.padVoices.length) return;
    const scale = DISTRICT_SCALES[this.district];
    const roots = [36, 48, 55];
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = i === 0 ? 'sine' : i === 1 ? 'triangle' : 'sawtooth';
      osc.frequency.value = midiToFreq(roots[i] + scale[i % scale.length]);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      osc.connect(filter).connect(gain).connect(this.buses.music);
      osc.start();
      this.padVoices.push({ osc, gain });
    }
    this.setBedIntensity(0.2);
  }

  setBedIntensity(intensity: number): void {
    if (!this.ctx) return;
    this.padIntensity = Math.max(0, Math.min(1, intensity));
    const t = this.now();
    this.padVoices.forEach((voice, i) => {
      const threshold = i * 0.33;
      const target = this.padIntensity > threshold ? 0.09 - i * 0.02 : 0;
      voice.gain.gain.setTargetAtTime(Math.max(0, target), t, 0.6);
    });
  }

  /** Duck the mix during the last-car slow-motion beat. */
  duck(amount: number, seconds: number): void {
    if (!this.master || !this.ctx) return;
    const t = this.now();
    this.master.gain.setTargetAtTime(0.85 * (1 - amount), t, 0.05);
    this.master.gain.setTargetAtTime(0.85, t + seconds, 0.2);
  }

  stopBed(): void {
    const t = this.now();
    for (const voice of this.padVoices) {
      voice.gain.gain.setTargetAtTime(0, t, 0.2);
      try {
        voice.osc.stop(t + 1.2);
      } catch {
        /* already stopped */
      }
    }
    this.padVoices = [];
  }
}

/* ------------------------------------------------------------------ *
 * Haptics — mirrors the audio so silent commuters keep the full loop
 * ------------------------------------------------------------------ */

export function vibrate(settings: Settings, pattern: number | number[], key = false): void {
  if (settings.haptics === 'off') return;
  if (settings.haptics === 'key' && !key) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}
