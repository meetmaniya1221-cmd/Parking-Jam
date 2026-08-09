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
  GAUNTLET_CHECKPOINTS,
  GAUNTLET_LENGTH,
  getLevel,
  meteredLimit,
  patternIntroducedAt,
  PATTERNS,
  prefetchLevel,
  TOTAL_LEVELS,
} from '../core/campaign';
import { hintFrom, isStillSolvable, nextMoveHint } from '../core/solver';
import { Band, BlockReason, LevelDef, Terrain, VehicleTag } from '../core/types';
import {
  advanceGauntlet,
  atCoinPinch,
  registerClear,
  TrunkReward,
  TUTORIAL_LEVELS,
} from '../meta/economy';
import { DISTRICTS } from '../meta/districts';
import { BoosterId } from '../meta/save';
import { GameStore } from '../meta/store';
import { LotView, LotViewContext } from '../view/lotView';
import { paletteFor } from '../view/theme';
import { button, el, formatNumber } from '../ui/dom';
import { icon, IconName } from '../ui/icons';
import {
  showFailScreen,
  showInterstitial,
  showRewardedOffer,
  showSheet,
  showTrunk,
  showWinScreen,
  toast,
} from '../ui/overlays';

export interface PlayHost {
  goHome(): void;
  openMap(): void;
  playLevel(index: number): void;
  refreshChrome(): void;
  /** Continue a chained run, or return to the events hub when it is over. */
  advanceRun?(): void;
}

export type PlayMode = 'campaign' | 'rush' | 'overtime' | 'night' | 'gauntlet';

export interface PlayOptions {
  levelIndex: number;
  /** Supply a lot directly for event modes, which are not in the sequence. */
  level?: LevelDef;
  mode?: PlayMode;
  title?: string;
}

/** Night Shift pays 1.5× Miles for the same reads, newly tense (GDD §9). */
const NIGHT_MILE_BONUS = 1.5;

/** Where a non-campaign jam says it is from, under the title. */
const MODE_PLACE: Record<Exclude<PlayMode, 'campaign'>, string> = {
  rush: 'Rush Hour',
  night: 'Night Shift',
  overtime: 'Overtime',
  gauntlet: 'Gauntlet',
};

const AMBULANCE_WINDOW_MS = 30_000;

/**
 * Bumps a jam survives. The third one ends the attempt.
 *
 * This is a real change of contract, and worth being honest about: the original
 * design made bumps free on purpose — a blocked car honks, nothing is lost, and
 * the player is invited to probe the lot rather than plan it. Three strikes
 * turns probing into a cost, which makes the lot something you read before you
 * touch. That is a *different* game feel, tighter and more tense, and it is the
 * one asked for.
 *
 * Two guards keep it from being cruel. The tutorial is exempt (see
 * `bumpLimitApplies`) — level one teaching the verb must not also be the level
 * that punishes you for trying it. And a retry is free and instant: the cost of
 * failing is thirty seconds, never a life or a coin.
 */
export const BUMP_LIMIT = 3;

/** Dispatcher pulses on the last warning, where help is still useful. */
const PULSE_BUMPS = BUMP_LIMIT - 1;
const PULSE_WINDOW_MS = 30_000;
const INTERSTITIAL_COOLDOWN_MS = 90_000;
const INTERSTITIAL_SESSION_CAP = 12;

interface BoosterButton {
  id: BoosterId;
  node: HTMLButtonElement;
  count: HTMLElement;
}

/** Levels that still show the rules strip under the boosters. */
const RULES_STRIP_LEVELS = 8;

/** Cars in the lot above which the dead-end check is deferred to idle time. */
const DEAD_END_INLINE_LIMIT = 12;

/** Slides the save-me grants, and what it costs in Medallions (GDD §5). */
const SAVE_ME_MOVES = 3;
const SAVE_ME_PRICE = 15;

/**
 * Shown once a session, the first time a lot is too big to show at once.
 *
 * Late lots outgrow a phone screen, so they pan — and a control the player has
 * not met yet needs saying once. Once, though: it is a single sentence about
 * dragging, not a mode the game needs to teach.
 */
let bigLotHintShown = false;

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
  private bumpValue!: HTMLElement;
  private titleNode!: HTMLElement;
  private patternNode!: HTMLElement;
  private ambulanceNode!: HTMLElement;
  private ambulanceValue!: HTMLElement;
  private meterNode!: HTMLElement;
  private meterValue!: HTMLElement;
  private coachNode!: HTMLElement;
  private lotNode!: HTMLElement;
  private flashNode!: HTMLElement;
  private rulesNode!: HTMLElement;
  private rulesLimitItem!: HTMLElement;
  private rulesLimitHead!: HTMLElement;
  private rulesLimitBody!: Text;
  private failed = false;
  private boosterButtons: BoosterButton[] = [];
  private undoButton!: HTMLButtonElement;
  private deadEndWarned = false;
  private paused = false;
  private ambulanceRemaining = 0;
  private moveLimit: number | null = null;
  private bonusMoves = 0;
  private outOfMoves = false;
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
    this.lotNode = el('div', { class: 'lot' }, this.canvas, this.buildFlash(), this.buildCoach());
    this.root = el('div', { class: 'play' }, this.buildHeader(), this.lotNode, this.buildFooter());
  }

  /* ---------------------------------------------------------------- *
   * Chrome
   * ---------------------------------------------------------------- */

  /**
   * Two rows, and the split is deliberate: the top row is *identity* — where am
   * I, and how do I get out of here — and the second is *state*, everything
   * that changes while you play. Mixing them put the level name next to a
   * ticking clock, and the eye could never find either.
   */
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

    this.bumpValue = el('span', { class: 'bumps__value', text: '0' });
    this.bumpNode = el(
      'div',
      { class: 'chip bumps', title: `Three bumps and the jam resets`, aria: { live: 'polite' } },
      icon('shield', 'icon--sm'),
      el(
        'span',
        { class: 'bumps__pair' },
        this.bumpValue,
        el('span', { class: 'bumps__limit', text: `/${BUMP_LIMIT}` }),
      ),
    );

    this.ambulanceValue = el('span', {});
    this.ambulanceNode = el(
      'div',
      { class: 'chip ambulance', hidden: true },
      icon('rescue', 'icon--sm'),
      this.ambulanceValue,
    );

    this.meterValue = el('span', {});
    this.meterNode = el('div', { class: 'chip meter', hidden: true }, this.meterValue);

    const restart = button('', {
      variant: 'ghost',
      class: 'iconBtn',
      title: 'Restart this jam',
      aria: { label: 'Restart this jam' },
      onTap: () => this.restart(),
    });
    restart.prepend(icon('retry'));

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
          aria: { label: 'Back to the city' },
          onTap: () => this.leave(),
        }),
        el('div', { class: 'play__ident' }, this.titleNode, this.patternNode),
        restart,
      ),
      el('div', { class: 'play__meters' }, this.counterNode, this.bumpNode, this.ambulanceNode, this.meterNode),
    );
  }

  private buildFlash(): HTMLElement {
    this.flashNode = el('div', { class: 'lot__flash' });
    return this.flashNode;
  }

  /**
   * Show-don't-tell has a limit: the first time a mechanic appears it gets one
   * line, once. The win screen teased it a level earlier; this is the arrival.
   */
  private announcePattern(): void {
    if (this.mode !== 'campaign') return;
    const intro = patternIntroducedAt(this.levelIndex);
    if (!intro) return;
    this.coachNode.hidden = false;
    this.coachNode.textContent = `${intro.label} — ${intro.blurb}`;
    window.setTimeout(() => {
      if (this.levelIndex > TUTORIAL_LEVELS) this.coachNode.hidden = true;
    }, 4200);
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
    this.undoButton.prepend(icon('undo'));
    this.undoButton.appendChild(el('span', { class: 'booster__label', text: 'Undo' }));
    boosterRow.appendChild(this.undoButton);

    const defs: Array<{ id: BoosterId; art: IconName; label: string }> = [
      { id: 'towHook', art: 'tow', label: 'Tow Hook' },
      { id: 'dispatcher', art: 'dispatch', label: 'Dispatcher' },
      { id: 'greenWave', art: 'greenwave', label: 'Green Wave' },
      { id: 'gripTires', art: 'grip', label: 'Grip Tires' },
    ];
    for (const def of defs) {
      const count = el('span', { class: 'booster__count', text: '0' });
      const node = button('', {
        variant: 'secondary',
        class: 'booster',
        title: def.label,
        onTap: () => this.useBooster(def.id),
      });
      node.prepend(icon(def.art));
      node.appendChild(el('span', { class: 'booster__label', text: def.label }));
      node.appendChild(count);
      boosterRow.appendChild(node);
      this.boosterButtons.push({ id: def.id, node, count });
    }

    this.rulesNode = this.buildRules();
    return el('footer', { class: 'play__footer' }, boosterRow, this.rulesNode);
  }

  /**
   * The three facts that decide whether a bump feels unfair.
   *
   * A player who does not know a bump is survivable reads the first honk as a
   * mistake they cannot undo; one who does not know three ends the jam is
   * ambushed by the third. Both are cheap to prevent and expensive to explain
   * afterwards, so the rules live on the screen rather than in a menu — and
   * then get out of the way once they have been read.
   */
  private buildRules(): HTMLElement {
    const item = (art: IconName, head: HTMLElement, body: Text) =>
      el('div', { class: 'rules__item' }, icon(art), el('span', {}, head, body));

    this.rulesLimitHead = el('span', { class: 'rules__head' });
    this.rulesLimitBody = document.createTextNode('');
    this.rulesLimitItem = item('shield', this.rulesLimitHead, this.rulesLimitBody);

    return el(
      'div',
      { class: 'rules' },
      item('dispatch', el('span', { class: 'rules__head', text: 'Bump' }), document.createTextNode('a car just honks')),
      this.rulesLimitItem,
      item('retry', el('span', { class: 'rules__head', text: 'Retry' }), document.createTextNode('is always free')),
    );
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
      onExit: (vi) => this.onExit(vi),
      onBump: (_vi, _blockerVi, reason) => this.onBump(reason),
      onSlide: () => {
        this.dismissCoach(true);
        this.scheduleDeadEndCheck();
        if (this.movesLeft() <= 0 && this.view && this.view.state.remaining > 0) {
          void this.onOutOfMoves();
        }
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
    this.moveLimit =
      this.mode === 'campaign' ? meteredLimit(this.levelIndex, this.level.parSlides) : null;
    this.bonusMoves = 0;
    this.outOfMoves = false;

    this.syncHud();
    this.startAmbulanceWindow();
    this.scheduleCoach();
    this.announcePattern();
    this.announceBigLot();
    this.tickTimer = window.setInterval(() => this.tick(), 250);
    if (this.mode === 'campaign') prefetchLevel(this.levelIndex + 1);
  }

  /** One line, the first time a jam is larger than the screen it is played on. */
  private announceBigLot(): void {
    if (bigLotHintShown || !this.view?.canPan) return;
    if (patternIntroducedAt(this.levelIndex)) return; // never two coach lines at once
    bigLotHintShown = true;
    this.coachNode.hidden = false;
    this.coachNode.textContent = 'Big lot — drag the asphalt to look round, double-tap to fit.';
    window.setTimeout(() => {
      if (this.levelIndex > TUTORIAL_LEVELS) this.coachNode.hidden = true;
    }, 5200);
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
    this.failed = false;
    this.deadEndWarned = false;
    this.bonusMoves = 0;
    this.outOfMoves = false;
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

    // The bump gauge escalates a step ahead of the consequence: amber on the
    // first, red and breathing on the last one that is still survivable.
    const limited = this.bumpLimitApplies();
    const bumps = Math.min(state.bumps, BUMP_LIMIT);
    this.bumpValue.textContent = String(bumps);
    this.bumpNode.classList.toggle('bumps--warn', limited && bumps === 1);
    this.bumpNode.classList.toggle('bumps--danger', limited && bumps >= BUMP_LIMIT - 1);
    this.bumpNode.title = limited
      ? `${BUMP_LIMIT - bumps} bump${BUMP_LIMIT - bumps === 1 ? '' : 's'} left before the jam resets`
      : 'Bumps are free while you are learning';

    const band = this.level.band;
    this.titleNode.textContent = this.title;
    const pattern = PATTERNS.find((p) => p.tag === this.level.patternTags[0]);
    const place =
      this.mode === 'campaign'
        ? DISTRICTS[chapterPosition(this.levelIndex).district].name
        : MODE_PLACE[this.mode];
    this.patternNode.textContent = `${place} · ${pattern ? pattern.label : bandLabel(band)}`;

    this.audio.setBedIntensity(total === 0 ? 0 : 1 - remaining / total);

    if (this.moveLimit === null) {
      this.meterNode.hidden = true;
    } else {
      const left = this.movesLeft();
      this.meterNode.hidden = false;
      this.meterValue.textContent = `${left} ${left === 1 ? 'slide' : 'slides'} left`;
      this.meterNode.classList.toggle('meter--low', left <= 2);
    }

    // The rules strip is for the first jams, when the bump economy is still
    // news. Past that it is thirty pixels the lot wants back.
    //
    // It has to tell the truth on both sides of the tutorial line: while bumps
    // are free it says so, and the level the limit switches on is the level the
    // strip changes under the player — which is the clearest possible warning.
    this.rulesNode.hidden = this.levelIndex > RULES_STRIP_LEVELS;
    if (limited) {
      this.rulesLimitHead.textContent = `${BUMP_LIMIT} bumps`;
      this.rulesLimitBody.textContent = 'and it resets';
    } else {
      this.rulesLimitHead.textContent = 'Free';
      this.rulesLimitBody.textContent = 'while you learn';
    }
    this.rulesLimitItem.classList.toggle('rules__item--danger', limited);

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
        this.ambulanceValue.textContent = `Rescue · ${Math.ceil(left / 1000)}s`;
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

  private onExit(vi: number): void {
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
  }

  /**
   * Does this jam count bumps against the player?
   *
   * The tutorial does not. Levels one to three exist to teach that a blocked
   * car honks and nothing breaks; ending them on the third honk would teach the
   * opposite, in the three levels where the lesson matters most.
   */
  private bumpLimitApplies(): boolean {
    return this.levelIndex > TUTORIAL_LEVELS || this.mode !== 'campaign';
  }

  private onBump(reason: BlockReason): void {
    const now = performance.now();
    this.bumpTimes.push(now);
    this.bumpTimes = this.bumpTimes.filter((t) => now - t < PULSE_WINDOW_MS);

    if (reason === BlockReason.VelvetRope) {
      toast('The VIP leaves first.', '⭐');
    } else if (reason === BlockReason.OneWay) {
      toast('One-way. Not that way.', '⛔');
    }

    // The lot itself reacts, not the whole screen: a red bloom at the edges and
    // a short shake, so the feedback lands where the player is looking.
    this.flashLot();

    if (this.bumpLimitApplies() && this.view && this.view.state.bumps >= BUMP_LIMIT) {
      void this.onBumpedOut();
      return;
    }

    // Offer, not interruption: on the last warning the Dispatcher button pulses.
    // Help arrives inside the frustration, not after it.
    if (this.bumpTimes.length >= PULSE_BUMPS) {
      const dispatcher = this.boosterButtons.find((b) => b.id === 'dispatcher');
      dispatcher?.node.classList.add('booster--pulse');
      window.setTimeout(() => dispatcher?.node.classList.remove('booster--pulse'), 6000);
      this.bumpTimes = [];
    }
  }

  private flashLot(): void {
    if (this.store.state.settings.reducedMotion) return;
    this.flashNode.classList.remove('lot__flash--on');
    this.lotNode.classList.remove('lot--shake');
    // Force a reflow so the animation restarts on a rapid second bump.
    void this.flashNode.offsetWidth;
    this.flashNode.classList.add('lot__flash--on');
    this.lotNode.classList.add('lot--shake');
  }

  /**
   * Third bump. Freeze the lot, then hand over to the fail screen.
   *
   * The pause before the overlay is not decoration — it lets the bump's own
   * honk, shake and flash land first. An overlay that appears on the same frame
   * as the collision reads as a bug rather than as a consequence.
   */
  private async onBumpedOut(): Promise<void> {
    if (!this.view || this.finished || this.failed) return;
    this.failed = true;
    this.view.setInteractive(false);
    window.clearInterval(this.tickTimer);
    window.clearTimeout(this.hintTimer);
    window.clearTimeout(this.coachTimer);
    window.clearTimeout(this.deadEndTimer);
    this.ambulanceNode.hidden = true;
    this.audio.softMiss();
    this.syncHud();

    const cars = this.view.state.remaining;
    const total = this.view.state.x.length;
    await new Promise((resolve) => window.setTimeout(resolve, 620));
    if (this.failed) {
      showFailScreen({
        levelLabel: this.title,
        reason: `${BUMP_LIMIT} bumps`,
        detail: 'Three cars refused to move. The lot resets — it costs nothing but the time.',
        cleared: total - cars,
        total,
        onRetry: () => this.restart(),
        onQuit: () => this.leave(),
      });
    }
  }

  private onLastCar(): void {
    this.root.classList.add('play--finale');
  }

  private movesLeft(): number {
    if (this.moveLimit === null || !this.view) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.moveLimit + this.bonusMoves - this.view.state.slides);
  }

  /**
   * The meter ran out. This is the only fail state in the game, and one the
   * player opted into by reaching a Metered Lot — so the offer is a rescue at
   * peak motivation, and declining it never ends the session on a loss.
   */
  private async onOutOfMoves(): Promise<void> {
    if (!this.view || this.finished || this.outOfMoves) return;
    this.outOfMoves = true;
    this.view.setInteractive(false);
    this.audio.softMiss();

    const canPay = this.store.state.wallet.medallions >= SAVE_ME_PRICE;
    const accepted = await showRewardedOffer(this.audio, {
      title: 'Out of slides',
      reward: `+${SAVE_ME_MOVES} slides, and the knot is almost open.`,
      note: canPay
        ? `Or spend ${SAVE_ME_PRICE} Medallions from the Depot.`
        : 'Only in Metered Lots. Never in the base game.',
    });

    if (accepted) {
      this.grantSaveMe();
      return;
    }
    this.endMeteredAttempt();
  }

  private grantSaveMe(): void {
    this.bonusMoves += SAVE_ME_MOVES;
    this.outOfMoves = false;
    this.view?.setInteractive(true);
    this.syncHud();
    toast(`+${SAVE_ME_MOVES} slides.`, '🅿️');
  }

  /**
   * Never end a session on a failure (GDD §2 Peak-End): the way out of a lost
   * Metered attempt is a guaranteed-solvable breather, offered as the one tap.
   */
  private endMeteredAttempt(): void {
    showSheet({
      eyebrow: 'Metered Lot',
      title: 'The meter ran out.',
      body: 'Nothing was taken and the jam keeps its record. One for the road?',
      confirmLabel: 'One for the road',
      cancelLabel: 'Try again',
      onConfirm: () => this.host.playLevel(this.nearbyEasyLevel()),
    });
    // Dismissing the sheet leaves the player on a fresh attempt at this lot.
    this.restart();
  }

  /** The nearest breather behind the current jam — always solvable, always kind. */
  private nearbyEasyLevel(): number {
    for (let i = this.levelIndex - 1; i > Math.max(1, this.levelIndex - 12); i--) {
      if (bandForLevel(i) === Band.Easy) return i;
    }
    return Math.max(1, this.levelIndex - 1);
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
    if (this.levelIndex > TUTORIAL_LEVELS || this.store.state.flags.tutorialSelfDriven) return;
    const captions = [
      'Tap a car to drive it out.',
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

  /**
   * Any correct unprompted move suppresses every remaining prompt. Only the
   * tutorial's own highlight is cleared — a Dispatcher Call the player paid for
   * shows three cars and must survive the first of them moving.
   */
  private dismissCoach(permanently: boolean): void {
    if (this.levelIndex > TUTORIAL_LEVELS) return;
    window.clearTimeout(this.coachTimer);
    this.coachNode.hidden = true;
    this.view?.setHints([]);
    if (permanently) {
      this.store.update((s) => void (s.flags.tutorialSelfDriven = true));
    }
    this.scheduleCoach();
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

    if (this.mode === 'gauntlet') {
      await this.finishGauntletRung(duration);
      return;
    }

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

  /** One rung of the Gauntlet: bank it, pay any chest, and carry straight on. */
  private async finishGauntletRung(duration: number): Promise<void> {
    if (!this.view) return;
    const state = this.view.state;
    const chest = this.store.update((s) => {
      s.wallet.miles += state.x.length;
      s.stats.totalExits += state.x.length;
      s.stats.jamsCleared++;
      return advanceGauntlet(s, GAUNTLET_CHECKPOINTS, GAUNTLET_LENGTH);
    });
    this.host.refreshChrome();

    if (chest) {
      this.audio.coins(chest.coins);
      // The path waits: a checkpoint is a place to stop, not only to carry on.
      const carryOn = await new Promise<boolean>((resolve) => {
        showSheet({
          eyebrow: chest.label,
          title: chest.rung >= GAUNTLET_LENGTH ? 'Gauntlet cleared.' : `Rung ${chest.rung} banked.`,
          rows: [
            { icon: '🪙', label: 'Coins', value: `+${formatNumber(chest.coins)}` },
            { icon: '🎖️', label: 'Medallions', value: `+${chest.medallions}` },
          ],
          confirmLabel: 'Onward',
          cancelLabel: 'Stop here',
          onConfirm: () => resolve(true),
          onDismiss: () => resolve(false),
        });
      });
      if (!carryOn) {
        this.host.goHome();
        return;
      }
    } else {
      this.audio.levelClear();
    }

    if (this.store.state.gauntlet.finished) {
      toast('The month is yours.', '🏆');
      this.host.goHome();
      return;
    }
    void duration;
    this.host.advanceRun?.();
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
