/**
 * The jam screen — where the whole game actually happens.
 *
 * Owns one level's lifecycle: HUD, boosters, the optional ambulance window, the
 * Dispatcher pulse, the last-car choreography, and the hand-off into rewards.
 */

import { AudioEngine } from '../audio/audio';
import { setDebugLot } from '../debug';
import {
  bandForLevel,
  chapterPosition,
  GATES,
  getLevel,
  patternIntroducedAt,
  PATTERNS,
  prefetchLevel,
  TOTAL_LEVELS,
} from '../core/campaign';
import { hintFrom, isStillSolvable, nextMoveHint } from '../core/solver';
import { Band, BlockReason, LevelDef, Terrain, VehicleTag } from '../core/types';
import { atCoinPinch, registerClear, TrunkReward } from '../meta/economy';
import { DISTRICTS } from '../meta/districts';
import { BoosterId } from '../meta/save';
import { GameStore } from '../meta/store';
import { LotView, LotViewContext } from '../view/lotView';
import { paletteFor } from '../view/theme';
import { button, el, formatNumber } from '../ui/dom';
import {
  showInterstitial,
  showRewardedOffer,
  showTrunk,
  showWinScreen,
  toast,
} from '../ui/overlays';

export interface PlayHost {
  goHome(): void;
  openMap(): void;
  playLevel(index: number): void;
  refreshChrome(): void;
}

export type PlayMode = 'campaign' | 'rush' | 'overtime' | 'night';

export interface PlayOptions {
  levelIndex: number;
  /** Supply a lot directly for event modes, which are not in the sequence. */
  level?: LevelDef;
  mode?: PlayMode;
  title?: string;
}

/** Night Shift pays 1.5× Miles for the same reads, newly tense (GDD §9). */
const NIGHT_MILE_BONUS = 1.5;

const AMBULANCE_WINDOW_MS = 30_000;
/** Dispatcher pulses after this many bumps inside the window (GDD §17 test #6). */
const PULSE_BUMPS = 6;
const PULSE_WINDOW_MS = 30_000;
const INTERSTITIAL_COOLDOWN_MS = 90_000;
const INTERSTITIAL_SESSION_CAP = 12;

interface BoosterButton {
  id: BoosterId;
  node: HTMLButtonElement;
  count: HTMLElement;
}

/** Cars in the lot above which the dead-end check is deferred to idle time. */
const DEAD_END_INLINE_LIMIT = 12;

export class PlayScreen {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly store: GameStore;
  private readonly audio: AudioEngine;
  private readonly host: PlayHost;

  private view: LotView | null = null;
  private level: LevelDef;
  private levelIndex: number;

  private startedAt = 0;
  private elapsedBeforePause = 0;
  private bumpTimes: number[] = [];
  private ambulanceDeadline = 0;
  private ambulancesRescued = 0;
  private trunksBanked: number[] = [];
  private finished = false;
  private hintTimer = 0;
  private coachTimer = 0;
  private tickTimer = 0;

  private counterValue!: HTMLElement;
  private counterNode!: HTMLElement;
  private bumpNode!: HTMLElement;
  private titleNode!: HTMLElement;
  private patternNode!: HTMLElement;
  private ambulanceNode!: HTMLElement;
  private coachNode!: HTMLElement;
  private boosterButtons: BoosterButton[] = [];
  private undoButton!: HTMLButtonElement;
  private deadEndWarned = false;
  private paused = false;
  private ambulanceRemaining = 0;
  private deadEndTimer = 0;

  private readonly mode: PlayMode;
  private readonly title: string;

  constructor(store: GameStore, audio: AudioEngine, host: PlayHost, options: PlayOptions) {
    this.store = store;
    this.audio = audio;
    this.host = host;
    this.mode = options.mode ?? 'campaign';
    this.levelIndex = Math.max(1, options.levelIndex);
    this.level = options.level ?? getLevel(this.levelIndex);
    this.title = options.title ?? `Jam ${this.levelIndex}`;

    this.canvas = el('canvas', {
      class: 'lot__canvas',
      aria: {
        label:
          'Parking lot. Arrow keys select a car, Enter drives it, R reverses it, Z undoes a move.',
      },
    });
    this.root = el('div', { class: 'play' }, this.buildHeader(), el('div', { class: 'lot' }, this.canvas, this.buildCoach()), this.buildFooter());
  }

  /* ---------------------------------------------------------------- *
   * Chrome
   * ---------------------------------------------------------------- */

  private buildHeader(): HTMLElement {
    this.titleNode = el('span', { class: 'play__level' });
    this.patternNode = el('span', { class: 'play__pattern' });
    this.counterValue = el('span', { class: 'counter__value', text: '0' });
    this.counterNode = el(
      'div',
      { class: 'counter', aria: { live: 'polite' } },
      this.counterValue,
      el('span', { class: 'counter__label', text: 'cars left' }),
    );
    this.bumpNode = el('span', { class: 'play__bumps', text: '0 bumps' });
    this.ambulanceNode = el('div', { class: 'ambulance', hidden: true });

    return el(
      'header',
      { class: 'play__header' },
      el(
        'div',
        { class: 'play__headRow' },
        button('', {
          variant: 'ghost',
          class: 'iconBtn',
          icon: '‹',
          title: 'Back to the city',
          onTap: () => this.leave(),
        }),
        el('div', { class: 'play__ident' }, this.titleNode, this.patternNode),
        button('', {
          variant: 'ghost',
          class: 'iconBtn',
          icon: '↺',
          title: 'Restart this jam',
          onTap: () => this.restart(),
        }),
      ),
      el('div', { class: 'play__meters' }, this.counterNode, this.bumpNode),
      this.ambulanceNode,
    );
  }

  private buildCoach(): HTMLElement {
    this.coachNode = el('div', { class: 'coach', hidden: true });
    return this.coachNode;
  }

  private buildFooter(): HTMLElement {
    const boosterRow = el('div', { class: 'boosters' });
    this.undoButton = button('', {
      variant: 'secondary',
      class: 'booster booster--undo',
      title: 'Undo the last slide',
      onTap: () => this.undo(),
    });
    this.undoButton.prepend(el('span', { class: 'booster__icon', text: '↶' }));
    this.undoButton.appendChild(el('span', { class: 'booster__label', text: 'Undo' }));
    boosterRow.appendChild(this.undoButton);

    const defs: Array<{ id: BoosterId; icon: string; label: string }> = [
      { id: 'towHook', icon: '🪝', label: 'Tow Hook' },
      { id: 'dispatcher', icon: '📻', label: 'Dispatcher' },
      { id: 'greenWave', icon: '🟢', label: 'Green Wave' },
      { id: 'gripTires', icon: '🛞', label: 'Grip Tires' },
    ];
    for (const def of defs) {
      const count = el('span', { class: 'booster__count', text: '0' });
      const node = button('', {
        variant: 'secondary',
        class: 'booster',
        title: def.label,
        onTap: () => this.useBooster(def.id),
      });
      node.prepend(el('span', { class: 'booster__icon', text: def.icon }));
      node.appendChild(el('span', { class: 'booster__label', text: def.label }));
      node.appendChild(count);
      boosterRow.appendChild(node);
      this.boosterButtons.push({ id: def.id, node, count });
    }
    return el('footer', { class: 'play__footer' }, boosterRow);
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  mount(): void {
    const state = this.store.state;
    const resume =
      this.mode === 'campaign' && state.resume?.levelIndex === this.levelIndex
        ? state.resume
        : null;

    this.view = new LotView(this.canvas, this.level, this.audio, this.viewContext(), {
      onExit: (vi, remaining) => this.onExit(vi, remaining),
      onBump: (vi, blockerVi, reason) => this.onBump(vi, blockerVi, reason),
      onSlide: () => {
        this.dismissCoach(true);
        this.scheduleDeadEndCheck();
      },
      onCleared: () => void this.onCleared(),
      onLastCar: () => this.onLastCar(),
      onStateChanged: () => this.syncHud(),
    });
    if (resume) this.view.setLevel(this.level, { vehicles: resume.vehicles });

    this.startedAt = performance.now();
    this.elapsedBeforePause = resume?.elapsedMs ?? 0;
    if (resume) {
      this.view.state.slides = resume.slides;
      this.view.state.bumps = resume.bumps;
    }

    const { district } = chapterPosition(this.levelIndex);
    this.audio.setDistrict(district);
    this.audio.resetMelody();
    this.audio.startBed();

    setDebugLot(this.view, this.canvas, this.mode === 'campaign' ? this.levelIndex : 0);
    this.syncHud();
    this.startAmbulanceWindow();
    this.scheduleCoach();
    this.tickTimer = window.setInterval(() => this.tick(), 250);
    if (this.mode === 'campaign') prefetchLevel(this.levelIndex + 1);
  }

  unmount(): void {
    window.clearInterval(this.tickTimer);
    window.clearTimeout(this.hintTimer);
    window.clearTimeout(this.coachTimer);
    window.clearTimeout(this.deadEndTimer);
    this.audio.stopBed();
    setDebugLot(null, null);
    if (this.mode === 'campaign' && this.view && !this.finished && this.view.state.remaining > 0) {
      this.saveResume();
    }
    this.view?.destroy();
    this.view = null;
  }

  /** Re-read the palette and accessibility settings into the running lot. */
  applySettings(): void {
    this.view?.setContext(this.viewContext());
    this.syncHud();
  }

  private viewContext(): LotViewContext {
    const s = this.store.state;
    return {
      palette: paletteFor(s.settings),
      settings: s.settings,
      liveryId: s.garage.equipped.livery,
      rideId: s.garage.equipped.ride,
      hornId: s.garage.equipped.horn,
      night: this.mode === 'night',
    };
  }

  private saveResume(): void {
    if (!this.view) return;
    const view = this.view;
    this.store.update((s) => {
      s.resume = {
        levelIndex: this.levelIndex,
        vehicles: view.snapshot(),
        slides: view.state.slides,
        bumps: view.state.bumps,
        elapsedMs: this.elapsed(),
      };
    });
  }

  private elapsed(): number {
    if (this.paused) return this.elapsedBeforePause;
    return this.elapsedBeforePause + (performance.now() - this.startedAt);
  }

  /**
   * Freeze the level clock and the rescue window while the tab is hidden. A
   * phone call must never cost a best time (GDD §14 "the OS interrupt never
   * costs progress").
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    if (paused) {
      this.elapsedBeforePause += performance.now() - this.startedAt;
      if (this.ambulanceDeadline > 0) {
        this.ambulanceRemaining = Math.max(0, this.ambulanceDeadline - performance.now());
      }
      this.paused = true;
      this.saveResume();
    } else {
      this.paused = false;
      this.startedAt = performance.now();
      if (this.ambulanceRemaining > 0) {
        this.ambulanceDeadline = performance.now() + this.ambulanceRemaining;
        this.ambulanceRemaining = 0;
      }
    }
  }

  private leave(): void {
    this.audio.uiTap();
    this.host.goHome();
  }

  private restart(): void {
    if (!this.view) return;
    this.audio.uiTap();
    this.view.setLevel(this.level);
    this.view.setContext(this.viewContext());
    this.startedAt = performance.now();
    this.elapsedBeforePause = 0;
    this.bumpTimes = [];
    this.trunksBanked = [];
    this.ambulancesRescued = 0;
    this.finished = false;
    this.deadEndWarned = false;
    this.store.update((s) => {
      if (this.mode === 'campaign' && s.resume?.levelIndex === this.levelIndex) s.resume = null;
    });
    this.startAmbulanceWindow();
    this.syncHud();
    this.scheduleCoach();
  }

  /* ---------------------------------------------------------------- *
   * HUD
   * ---------------------------------------------------------------- */

  private syncHud(): void {
    if (!this.view) return;
    const state = this.view.state;
    const total = state.x.length;
    const remaining = state.remaining;

    this.counterValue.textContent = String(remaining);
    // The counter is the loop's metronome: it brightens as the goal nears.
    this.counterNode.classList.toggle('counter--near', remaining <= 5 && remaining > 0);
    this.counterNode.classList.toggle('counter--final', remaining <= 3 && remaining > 0);
    this.bumpNode.textContent = state.bumps === 1 ? '1 bump' : `${state.bumps} bumps`;

    const band = this.level.band;
    this.titleNode.textContent = this.title;
    const pattern = PATTERNS.find((p) => p.tag === this.level.patternTags[0]);
    const place =
      this.mode === 'campaign'
        ? DISTRICTS[chapterPosition(this.levelIndex).district].name
        : this.mode === 'rush'
          ? 'Rush Hour'
          : this.mode === 'night'
            ? 'Night Shift'
            : 'Overtime';
    this.patternNode.textContent = `${place} · ${pattern ? pattern.label : bandLabel(band)}`;

    this.audio.setBedIntensity(total === 0 ? 0 : 1 - remaining / total);

    this.undoButton.disabled = !this.view.canUndo();
    this.undoButton.classList.toggle('booster--empty', !this.view.canUndo());

    const boosters = this.store.state.boosters;
    for (const entry of this.boosterButtons) {
      const count = boosters[entry.id];
      entry.count.textContent = String(count);
      entry.node.classList.toggle('booster--empty', count <= 0);
    }
  }

  private tick(): void {
    if (!this.view || this.finished || this.paused) return;
    if (this.ambulanceDeadline > 0) {
      const left = this.ambulanceDeadline - performance.now();
      if (left <= 0) {
        this.expireAmbulance();
      } else {
        this.ambulanceNode.hidden = false;
        this.ambulanceNode.textContent = `🚑 Rescue window · ${Math.ceil(left / 1000)}s`;
        this.ambulanceNode.classList.toggle('ambulance--urgent', left < 8000);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Ambulance — a bonus window, never a penalty clock
   * ---------------------------------------------------------------- */

  private startAmbulanceWindow(): void {
    const hasAmbulance = this.level.vehicles.some((v) => v.tags & VehicleTag.Ambulance);
    this.ambulanceDeadline = hasAmbulance ? performance.now() + AMBULANCE_WINDOW_MS : 0;
    this.ambulanceNode.hidden = !hasAmbulance;
  }

  private expireAmbulance(): void {
    this.ambulanceDeadline = 0;
    this.ambulanceNode.hidden = true;
    // A soft exhale and a kind two-note "next time" — never a buzzer.
    this.audio.softMiss();
    toast('Window closed. It is a normal car now.', '🚑');
  }

  /* ---------------------------------------------------------------- *
   * Level events
   * ---------------------------------------------------------------- */

  private onExit(vi: number, remaining: number): void {
    this.dismissCoach(true);
    const tags = this.level.vehicles[vi].tags;
    if (tags & VehicleTag.Ambulance && this.ambulanceDeadline > performance.now()) {
      this.ambulancesRescued++;
      this.ambulanceDeadline = 0;
      this.ambulanceNode.hidden = true;
      toast('Ambulance away. Nice window.', '🚑');
      this.audio.uiConfirm();
    }
    if (tags & VehicleTag.Trunk) this.trunksBanked.push(vi);
    if (remaining > 0) this.view?.setHints([]);
  }

  private onBump(vi: number, blockerVi: number, reason: BlockReason): void {
    const now = performance.now();
    this.bumpTimes.push(now);
    this.bumpTimes = this.bumpTimes.filter((t) => now - t < PULSE_WINDOW_MS);

    if (reason === BlockReason.VelvetRope) {
      toast('The VIP leaves first.', '⭐');
    } else if (reason === BlockReason.OneWay) {
      toast('One-way. Not that way.', '⛔');
    }

    // Offer, not interruption: after six bumps in half a minute the Dispatcher
    // button pulses. Help arrives inside the frustration, not after it.
    if (this.bumpTimes.length >= PULSE_BUMPS) {
      const dispatcher = this.boosterButtons.find((b) => b.id === 'dispatcher');
      dispatcher?.node.classList.add('booster--pulse');
      window.setTimeout(() => dispatcher?.node.classList.remove('booster--pulse'), 6000);
      this.bumpTimes = [];
    }
    void vi;
    void blockerVi;
  }

  private onLastCar(): void {
    this.root.classList.add('play--finale');
  }

  private undo(): void {
    if (!this.view?.undo()) return;
    this.deadEndWarned = false;
    this.dismissCoach(false);
    this.syncHud();
  }

  /**
   * One-way arrows and oil slicks make some slides irreversible, so a player
   * really can park a lot into a state that cannot be cleared. The game never
   * fails them for it: when nothing can leave, it checks quietly, and if the
   * knot is genuinely dead it offers the step back.
   */
  private scheduleDeadEndCheck(): void {
    if (!this.view || this.finished || this.deadEndWarned) return;
    if (!this.view.nothingCanLeave()) return;
    window.clearTimeout(this.deadEndTimer);
    const run = () => {
      if (!this.view || this.finished || this.deadEndWarned) return;
      if (!this.view.nothingCanLeave()) return;
      if (isStillSolvable(this.view.state)) return;
      this.deadEndWarned = true;
      toast('Knotted for good — step back a move.', '↶');
      this.undoButton.classList.add('booster--pulse');
      window.setTimeout(() => this.undoButton.classList.remove('booster--pulse'), 6000);
    };
    // A full solve on a packed lot is not frame work; defer it off the drag.
    const delay = this.view.state.remaining > DEAD_END_INLINE_LIMIT ? 260 : 60;
    this.deadEndTimer = window.setTimeout(run, delay);
  }

  /* ---------------------------------------------------------------- *
   * Boosters
   * ---------------------------------------------------------------- */

  private useBooster(id: BoosterId): void {
    if (!this.view || this.finished) return;
    const state = this.store.state;
    if (state.boosters[id] <= 0) {
      this.offerBooster(id);
      return;
    }

    switch (id) {
      case 'towHook':
        toast('Tap the car to tow.', '🪝');
        this.view.setTapTarget((vi) => {
          if (!this.view?.towVehicle(vi)) return;
          this.store.update((s) => void s.boosters.towHook--);
          this.syncHud();
        });
        return;
      case 'dispatcher': {
        let ids = hintFrom(this.view.state, 3);
        if (ids.length === 0) {
          // No car can leave yet: point at the one that has to move first.
          const first = nextMoveHint(this.view.state);
          if (!first) {
            toast('This lot is knotted for good — step back.', '↶');
            return;
          }
          ids = [first.vi];
          toast('That one needs to shift first.', '📻');
        }
        this.view.setHints(ids);
        window.clearTimeout(this.hintTimer);
        this.hintTimer = window.setTimeout(() => this.view?.setHints([]), 6000);
        this.store.update((s) => void s.boosters.dispatcher--);
        this.audio.uiConfirm();
        break;
      }
      case 'greenWave':
        this.view.overrideLevel((level) => ({ ...level, arrows: level.arrows.map(() => -1) }));
        this.store.update((s) => void s.boosters.greenWave--);
        toast('One-ways suspended for this lot.', '🟢');
        this.audio.uiConfirm();
        break;
      case 'gripTires':
        this.view.overrideLevel((level) => ({
          ...level,
          terrain: level.terrain.map((t) => (t === Terrain.Oil ? Terrain.Road : t)),
        }));
        this.store.update((s) => void s.boosters.gripTires--);
        toast('Slicks inert. Grip restored.', '🛞');
        this.audio.uiConfirm();
        break;
    }
    this.syncHud();
  }

  /** Out of stock: the only in-level rewarded offer, and only for the Tow Hook. */
  private async offerBooster(id: BoosterId): Promise<void> {
    const state = this.store.state;
    if (id === 'towHook' && state.ads.towHookDay !== todayStamp()) {
      const accepted = await showRewardedOffer(this.audio, {
        title: 'Free Tow Hook',
        reward: 'A tow truck drives in and removes any one vehicle.',
        note: 'One a day. Same item as the paid version.',
      });
      if (accepted) {
        this.store.update((s) => {
          s.boosters.towHook++;
          s.ads.towHookDay = todayStamp();
        });
        toast('Tow Hook banked.', '🪝');
        this.syncHud();
      }
      return;
    }
    toast('None left. Earn more at the Depot.', '🛒');
  }

  /* ---------------------------------------------------------------- *
   * Tutorial coaching
   * ---------------------------------------------------------------- */

  private scheduleCoach(): void {
    window.clearTimeout(this.coachTimer);
    if (this.levelIndex > 3 || this.store.state.flags.tutorialSelfDriven) return;
    const captions = [
      'Drag a car the way it faces.',
      'Blocked? It just honks. No harm done.',
      'Read the order. Then go.',
    ];
    this.coachNode.textContent = captions[Math.min(2, this.levelIndex - 1)];
    // The hand appears only after 4 s of hesitation, and never before the
    // player has had a chance to work it out unprompted.
    this.coachTimer = window.setTimeout(() => {
      if (!this.view || this.finished) return;
      this.coachNode.hidden = false;
      const ids = hintFrom(this.view.state, 1);
      this.view.setHints(ids);
    }, 4000);
  }

  /** Any correct unprompted move suppresses every remaining prompt. */
  private dismissCoach(permanently: boolean): void {
    window.clearTimeout(this.coachTimer);
    this.coachNode.hidden = true;
    this.view?.setHints([]);
    if (permanently && this.levelIndex <= 3) {
      this.store.update((s) => void (s.flags.tutorialSelfDriven = true));
    }
    if (this.levelIndex <= 3) this.scheduleCoach();
  }

  /* ---------------------------------------------------------------- *
   * Win flow
   * ---------------------------------------------------------------- */

  private async onCleared(): Promise<void> {
    if (this.finished || !this.view) return;
    this.finished = true;
    this.view.setInteractive(false);
    window.clearInterval(this.tickTimer);
    this.ambulanceNode.hidden = true;
    this.audio.levelClear();

    const state = this.view.state;
    const duration = this.elapsed();

    if (this.mode !== 'campaign') {
      await this.finishSpecial(duration);
      return;
    }

    const band = bandForLevel(this.levelIndex);
    const { district, pos, size } = chapterPosition(this.levelIndex);

    const banked = this.store.update((s) =>
      registerClear(s, {
        levelIndex: this.levelIndex,
        slides: state.slides,
        parSlides: this.level.parSlides,
        bumps: state.bumps,
        vehicles: state.x.length,
        durationMs: duration,
        ambulancesRescued: this.ambulancesRescued,
        trunks: this.trunksBanked.length,
        now: Date.now(),
      }),
    );

    this.audio.coins(banked.coins);
    this.host.refreshChrome();

    for (const trunk of banked.trunkRewards) await this.presentTrunk(trunk);

    const nextIndex = Math.min(TOTAL_LEVELS, this.levelIndex + 1);
    const intro = patternIntroducedAt(nextIndex);
    const handle = showWinScreen({
      levelIndex: this.levelIndex,
      levelLabel: `Jam ${this.levelIndex}`,
      bandLabel: bandLabel(band),
      slides: state.slides,
      parSlides: this.level.parSlides,
      bumps: state.bumps,
      durationMs: duration,
      coins: banked.coins,
      miles: banked.miles,
      cleanExit: banked.cleanExit,
      goldPlate: banked.goldPlate,
      keysEarned: banked.keysEarned,
      districtName: DISTRICTS[district].name,
      districtProgress: (pos + 1) / size,
      chapterPos: pos + 1,
      chapterSize: size,
      // Tease the next mechanic one level early — questions, not clickbait.
      nextTease: intro ? `Tomorrow: ${intro.label}. ${intro.blurb}` : null,
      onNext: () => this.leaveWin(handle, () => this.host.playLevel(nextIndex)),
      onMap: () => this.leaveWin(handle, () => this.host.openMap()),
    });
  }

  /**
   * Leaving the win screen is the one place a break is allowed, and it holds to
   * the never-stack rule (GDD §14): at most one surface, and the player-initiated
   * pinch offer takes precedence over an interstitial — never both.
   */
  private async leaveWin(handle: { close: () => void }, go: () => void): Promise<void> {
    handle.close();
    const offered = await this.maybePinchOffer();
    if (!offered) await this.maybeShowInterstitial();
    go();
  }

  /**
   * Event modes pay out but never touch the campaign sequence: Rush Hour is one
   * authored attempt a day, Overtime is endless, and neither should nudge the
   * player's place in the story.
   */
  private async finishSpecial(duration: number): Promise<void> {
    if (!this.view) return;
    const state = this.view.state;
    const coins = this.mode === 'rush' ? 150 : 90;
    const medallions = this.mode === 'rush' ? 5 : 0;
    const miles = Math.round(state.x.length * (this.mode === 'night' ? NIGHT_MILE_BONUS : 1));
    this.store.update((s) => {
      s.wallet.coins += coins;
      s.wallet.medallions += medallions;
      s.wallet.miles += miles;
      s.stats.totalExits += state.x.length;
      s.stats.jamsCleared++;
      if (this.mode === 'rush') s.rush.clears++;
    });
    this.audio.coins(coins);
    this.host.refreshChrome();

    const handle = showWinScreen({
      levelIndex: this.levelIndex,
      levelLabel: this.title,
      bandLabel:
        this.mode === 'rush' ? 'Rush Hour' : this.mode === 'night' ? 'Night Shift' : 'Overtime',
      slides: state.slides,
      parSlides: this.level.parSlides,
      bumps: state.bumps,
      durationMs: duration,
      coins,
      miles,
      cleanExit: state.bumps === 0,
      goldPlate: state.slides <= this.level.parSlides,
      keysEarned: 0,
      districtName:
        this.mode === 'rush'
          ? 'Today’s jam'
          : this.mode === 'night'
            ? 'After hours'
            : 'Overtime shift',
      districtProgress: 1,
      chapterPos: 1,
      chapterSize: 1,
      nextTease:
        this.mode === 'rush' ? 'It retires into Cold Cases tomorrow. A new one lands at 9.' : null,
      onNext: () => {
        handle.close();
        this.host.goHome();
      },
      onMap: () => {
        handle.close();
        this.host.openMap();
      },
    });
  }

  private async presentTrunk(trunk: TrunkReward): Promise<void> {
    const rarityIndex = ['coins', 'booster', 'miles', 'shard', 'livery'].indexOf(trunk.rarity);
    await showTrunk(this.audio, {
      label: trunk.label,
      detail: describeTrunk(trunk),
      rarityIndex: Math.max(0, rarityIndex),
      onDouble: async () => {
        const accepted = await showRewardedOffer(this.audio, {
          title: 'Double this trunk?',
          reward: `Take ${describeTrunk(trunk)} twice over.`,
        });
        if (!accepted) return false;
        this.store.update((s) => {
          s.wallet.coins += trunk.coins;
          s.wallet.miles += trunk.miles;
          if (trunk.booster) s.boosters[trunk.booster]++;
        });
        this.host.refreshChrome();
        return true;
      },
    });
  }

  /**
   * Surfaced by relevance, not schedule: only at a genuine end-of-district coin
   * pinch, at most twice a day, and never while a doubler is already running.
   * Returns true when an offer was shown.
   */
  private async maybePinchOffer(): Promise<boolean> {
    const s = this.store.state;
    if (s.progress.highest < GATES.cityMap) return false;
    if (!atCoinPinch(s)) return false;
    if (Date.now() < s.income.doublerUntil) return false;
    const today = todayStamp();
    if (s.ads.doublerDay === today && s.ads.doublerUses >= 2) return false;

    const accepted = await showRewardedOffer(this.audio, {
      title: 'Double the Depot',
      reward: '2× City Income rate for the next four hours.',
      note: 'Doubles the rate, not the cap window.',
    });
    this.store.update((state) => {
      if (state.ads.doublerDay !== today) {
        state.ads.doublerDay = today;
        state.ads.doublerUses = 0;
      }
      state.ads.doublerUses++;
      if (accepted) state.income.doublerUntil = Date.now() + 4 * 3_600_000;
    });
    if (accepted) {
      toast('Depot doubled for four hours.', '🏭');
      this.host.refreshChrome();
    }
    return true;
  }

  /**
   * Interstitial policy, exactly as specified: never before level 12, only
   * after a win, 90 s cooldown that lengthens after the sixth impression of a
   * session, hard cap 12/day, and any purchase buys a 24-hour holiday.
   */
  private async maybeShowInterstitial(): Promise<void> {
    const s = this.store.state;
    if (s.ads.noAds) return;
    if (s.progress.highest < GATES.interstitials) return;
    if (Date.now() < s.ads.adHolidayUntil) return;
    if (s.ads.sessionInterstitials >= INTERSTITIAL_SESSION_CAP) return;
    const cooldown =
      INTERSTITIAL_COOLDOWN_MS * (s.ads.sessionInterstitials >= 6 ? 1.5 : 1);
    if (Date.now() - s.ads.lastInterstitialAt < cooldown) return;

    this.store.update((state) => {
      state.ads.lastInterstitialAt = Date.now();
      state.ads.sessionInterstitials++;
    });
    await showInterstitial();
  }
}

function bandLabel(band: Band): string {
  switch (band) {
    case Band.Easy:
      return 'Breather';
    case Band.Hard:
      return 'Stretch';
    case Band.Showcase:
      return 'Showcase';
    default:
      return 'Standard';
  }
}

function describeTrunk(trunk: TrunkReward): string {
  const parts: string[] = [];
  if (trunk.coins) parts.push(`${formatNumber(trunk.coins)} Coins`);
  if (trunk.miles) parts.push(`${formatNumber(trunk.miles)} Miles`);
  if (trunk.booster) parts.push(`1 ${boosterName(trunk.booster)}`);
  if (trunk.liveryId) parts.push('a full livery');
  return parts.join(' + ') || 'a little something';
}

function boosterName(id: BoosterId): string {
  return { towHook: 'Tow Hook', dispatcher: 'Dispatcher Call', greenWave: 'Green Wave', gripTires: 'Grip Tires' }[
    id
  ];
}

function todayStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
