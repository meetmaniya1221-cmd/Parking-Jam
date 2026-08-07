/**
 * The app shell: chrome, routing and session-level policy.
 *
 * Navigation model (GDD §14): the City Map is home, the bottom tab bar holds
 * every destination, back is always bottom-left, and no screen is more than two
 * taps from a jam.
 */

import { AudioEngine } from './audio/audio';
import {
  GAUNTLET_LENGTH,
  gauntletJam,
  gauntletPeriod,
  gauntletRungLabel,
  getLevel,
  overtimeSet,
  rushHourJam,
  rushHourName,
  TOTAL_LEVELS,
} from './core/campaign';
import { LevelDef } from './core/types';
import { PlayMode, PlayScreen } from './game/playScreen';
import { grantOverflowCrate, pendingIncome, refreshDispatch, syncGauntlet } from './meta/economy';
import { dayNumber, Settings } from './meta/save';
import { GameStore } from './meta/store';
import { button, el, formatNumber, pill } from './ui/dom';
import { anyOverlayOpen, initOverlays, openOverlay, showSheet, toast } from './ui/overlays';
import {
  createDepotScreen,
  createEventsScreen,
  createGarageScreen,
  createMapScreen,
  Screen,
  ScreenHost,
} from './ui/screens';

type TabId = 'map' | 'depot' | 'play' | 'events' | 'garage';
type SpecialKind = 'rush' | 'overtime' | 'night' | 'coldCase' | 'gauntlet';

function formatPlayTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const TABS: Array<{ id: TabId; icon: string; label: string }> = [
  { id: 'map', icon: '🗺️', label: 'City' },
  { id: 'depot', icon: '🏭', label: 'Depot' },
  { id: 'play', icon: '🚗', label: 'Play' },
  { id: 'events', icon: '📅', label: 'Events' },
  { id: 'garage', icon: '🎨', label: 'Garage' },
];

/** A lapse this long triggers the Depot overflow crate (GDD §7). */
const LAPSE_DAYS_FOR_CRATE = 3;

export class App {
  private readonly root: HTMLElement;
  private readonly store: GameStore;
  private readonly audio: AudioEngine;

  private readonly screenHost: HTMLElement;
  private readonly walletBar: HTMLElement;
  private readonly tabBar: HTMLElement;

  private screens = new Map<TabId, Screen>();
  private current: TabId | null = null;
  private play: PlayScreen | null = null;

  constructor(root: HTMLElement, store: GameStore, audio: AudioEngine) {
    this.root = root;
    this.store = store;
    this.audio = audio;

    this.walletBar = el('div', { class: 'wallet' });
    this.screenHost = el('main', { class: 'app__screen' });
    this.tabBar = el('nav', { class: 'tabbar', aria: { label: 'Main navigation' } });

    const overlayHost = el('div', { class: 'app__overlays' });
    initOverlays(overlayHost);

    root.appendChild(
      el(
        'div',
        { class: 'app' },
        el(
          'header',
          { class: 'app__bar' },
          this.walletBar,
          button('', {
            variant: 'ghost',
            class: 'iconBtn',
            icon: '⚙',
            title: 'Settings',
            onTap: () => this.openSettings(),
          }),
        ),
        this.screenHost,
        this.tabBar,
        overlayHost,
      ),
    );

    this.buildTabs();
    this.applySettings(store.state.settings);
    store.subscribe(() => this.refreshChrome());
    this.refreshChrome();
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  start(): void {
    const s = this.store.state;

    // Cold boot goes straight to a touchable lot: no menu, no logo parade.
    if (!s.flags.tutorialDone && s.progress.highest <= 3) {
      this.playLevel(s.progress.nextLevel);
      return;
    }
    this.handleComeback();
    const income = pendingIncome(s, Date.now());
    this.navigate(income.coins > 0 ? 'depot' : 'map');
  }

  /** Comeback flows never take anything; they hand something back (GDD §7). */
  private handleComeback(): void {
    const s = this.store.state;
    const lapseDays = Math.floor((Date.now() - s.lastSeenAt) / 86_400_000);
    if (lapseDays < LAPSE_DAYS_FOR_CRATE) return;

    let bonus = 0;
    this.store.update((state) => {
      bonus = grantOverflowCrate(state, Date.now());
      if (lapseDays >= 7) {
        state.wallet.coins += 300;
        state.wallet.medallions += 10;
      }
      refreshDispatch(state, Date.now());
    });
    showSheet({
      eyebrow: lapseDays >= 7 ? 'The city held your spot' : 'Depot overflow',
      title: `${formatNumber(bonus + (lapseDays >= 7 ? 300 : 0))} Coins, banked for you`,
      body:
        lapseDays >= 7
          ? 'Streaks are where you left them, and nothing was taken. Your next jam is set to an easy one.'
          : 'Income kept accruing past the cap while you were away, and there is a Tow Hook in the crate.',
    });
  }

  /* ---------------------------------------------------------------- *
   * Chrome
   * ---------------------------------------------------------------- */

  private buildTabs(): void {
    for (const tab of TABS) {
      const node = el(
        'button',
        {
          class: `tab tab--${tab.id}`,
          type: 'button',
          aria: { label: tab.label },
          on: { click: () => this.navigate(tab.id) },
        },
        el('span', { class: 'tab__icon', text: tab.icon }),
        el('span', { class: 'tab__label', text: tab.label }),
      );
      this.tabBar.appendChild(node);
    }
  }

  refreshChrome(): void {
    const w = this.store.state.wallet;
    this.walletBar.replaceChildren(
      pill('🪙', formatNumber(w.coins), 'pill--lemon'),
      pill('🎖️', formatNumber(w.medallions), 'pill--sky'),
      w.blueprints > 0 ? pill('📐', formatNumber(w.blueprints), 'pill--mint') : el('span'),
      w.keys > 0 ? pill('🔑', formatNumber(w.keys), 'pill--muted') : el('span'),
    );
    for (const node of Array.from(this.tabBar.children)) {
      const tab = node as HTMLElement;
      const active = tab.classList.contains(`tab--${this.current}`);
      tab.classList.toggle('tab--active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
  }

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  private screenDeps(): { store: GameStore; audio: AudioEngine; host: ScreenHost } {
    return {
      store: this.store,
      audio: this.audio,
      host: {
        playLevel: (index) => this.playLevel(index),
        playSpecial: (kind, index) => this.playSpecial(kind, index),
        refreshChrome: () => this.refreshChrome(),
      },
    };
  }

  navigate(tab: TabId): void {
    if (tab === 'play') {
      this.playLevel(this.store.state.resume?.levelIndex ?? this.store.state.progress.nextLevel);
      return;
    }
    this.audio.uiTap();
    this.teardownCurrent();
    this.current = tab;

    let screen = this.screens.get(tab);
    if (!screen) {
      const deps = this.screenDeps();
      screen =
        tab === 'map'
          ? createMapScreen(deps)
          : tab === 'depot'
            ? createDepotScreen(deps)
            : tab === 'events'
              ? createEventsScreen(deps)
              : createGarageScreen(deps);
      this.screens.set(tab, screen);
    }
    screen.refresh();
    screen.mount?.();
    this.screenHost.replaceChildren(screen.root);
    this.root.classList.remove('is-playing');
    this.refreshChrome();
  }

  /** Rebuild every cached screen — used after an out-of-band state change. */
  refreshAll(): void {
    this.play?.applySettings();
    this.screens.forEach((screen) => screen.refresh());
    this.refreshChrome();
  }

  private teardownCurrent(): void {
    if (this.play) {
      this.play.unmount();
      this.play = null;
    }
    if (this.current) this.screens.get(this.current)?.unmount?.();
  }

  playLevel(index: number): void {
    const clamped = Math.max(1, Math.min(TOTAL_LEVELS, index));
    this.openPlay({ levelIndex: clamped, level: getLevel(clamped) });
  }

  playSpecial(kind: SpecialKind, index = 0): void {
    const day = dayNumber(Date.now());
    if (kind === 'gauntlet') {
      this.openGauntletRung();
      return;
    }
    if (kind === 'coldCase') {
      const past = day - Math.max(1, index);
      this.openPlay({
        levelIndex: 0,
        level: rushHourJam(past),
        mode: 'overtime',
        title: `${rushHourName(past)} · cold case`,
      });
      return;
    }
    if (kind === 'rush') {
      this.openPlay({
        levelIndex: 0,
        level: rushHourJam(day),
        mode: 'rush',
        title: rushHourName(day),
      });
      return;
    }
    const set = overtimeSet(day, 5);
    const entry = set[Math.max(0, Math.min(set.length - 1, index))];
    this.openPlay({
      levelIndex: 0,
      level: entry.level,
      mode: kind,
      title: kind === 'night' ? 'Night Shift' : `${entry.tag} shift`,
    });
  }

  /** Open whichever rung of the month's Gauntlet the player is standing on. */
  private openGauntletRung(): void {
    const period = gauntletPeriod(Date.now());
    this.store.update((s) => syncGauntlet(s, period));
    const rung = this.store.state.gauntlet.index;
    if (rung >= GAUNTLET_LENGTH) {
      this.navigate('events');
      return;
    }
    this.openPlay({
      levelIndex: 0,
      level: gauntletJam(period, rung),
      mode: 'gauntlet',
      title: gauntletRungLabel(rung),
    });
  }

  private openPlay(options: {
    levelIndex: number;
    level: LevelDef;
    mode?: PlayMode;
    title?: string;
  }): void {
    this.teardownCurrent();
    this.current = 'play';
    this.play = new PlayScreen(this.store, this.audio, this.playHost(), options);
    this.screenHost.replaceChildren(this.play.root);
    this.root.classList.add('is-playing');
    this.play.mount();
    this.refreshChrome();
  }

  private playHost() {
    return {
      goHome: () => this.navigate('map'),
      openMap: () => this.navigate('map'),
      playLevel: (index: number) => this.playLevel(index),
      refreshChrome: () => this.refreshChrome(),
      advanceRun: () => this.openGauntletRung(),
    };
  }

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  applySettings(settings: Settings): void {
    document.documentElement.style.setProperty('--text-scale', String(settings.textScale));
    document.documentElement.classList.toggle('reduced-motion', settings.reducedMotion);
    document.documentElement.classList.toggle('left-handed', settings.leftHanded);
    document.documentElement.classList.toggle('high-contrast', settings.highContrast);
    this.audio.applySettings(settings);
  }

  private openSettings(): void {
    const s = this.store.state.settings;
    const body = el('div', { class: 'settings' });

    const toggle = (label: string, note: string, get: () => boolean, set: (v: boolean) => void) => {
      const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = get();
      input.addEventListener('change', () => {
        this.store.update(() => set(input.checked));
        this.applySettings(this.store.state.settings);
        this.audio.uiTap();
        this.play?.applySettings();
        this.screens.forEach((screen) => screen.refresh());
      });
      return el(
        'label',
        { class: 'setting' },
        el(
          'span',
          { class: 'setting__text' },
          el('span', { class: 'setting__label', text: label }),
          el('span', { class: 'setting__note', text: note }),
        ),
        input,
      );
    };

    const select = <T extends string>(
      label: string,
      note: string,
      options: Array<{ value: T; label: string }>,
      get: () => T,
      set: (v: T) => void,
    ) => {
      const node = el('select', { class: 'setting__select' }) as HTMLSelectElement;
      for (const option of options) {
        const opt = el('option', { value: option.value, text: option.label });
        node.appendChild(opt);
      }
      node.value = get();
      node.addEventListener('change', () => {
        this.store.update(() => set(node.value as T));
        this.applySettings(this.store.state.settings);
        this.play?.applySettings();
        this.screens.forEach((screen) => screen.refresh());
      });
      return el(
        'label',
        { class: 'setting' },
        el(
          'span',
          { class: 'setting__text' },
          el('span', { class: 'setting__label', text: label }),
          el('span', { class: 'setting__note', text: note }),
        ),
        node,
      );
    };

    body.append(
      toggle('Music', 'The district radio bed.', () => s.music, (v) => (s.music = v)),
      toggle('Sound effects', 'All gameplay information lives here.', () => s.sfx, (v) => (s.sfx = v)),
      toggle('Ambience', 'The living-city bed.', () => s.ambience, (v) => (s.ambience = v)),
      toggle('Calm honks', 'Softer attack, 6 dB down.', () => s.calmHonks, (v) => (s.calmHonks = v)),
      toggle(
        'Reduced motion',
        'Cross-fades instead of slow-mo and pull-backs; no confetti.',
        () => s.reducedMotion,
        (v) => (s.reducedMotion = v),
      ),
      toggle(
        'High contrast',
        'Darker asphalt and brighter lane paint.',
        () => s.highContrast,
        (v) => (s.highContrast = v),
      ),
      toggle(
        'Left-handed layout',
        'Mirrors the thumb-zone controls.',
        () => s.leftHanded,
        (v) => (s.leftHanded = v),
      ),
      select(
        'Haptics',
        'Mirrors the audio, so silence keeps the full loop.',
        [
          { value: 'full', label: 'Full' },
          { value: 'key', label: 'Key moments' },
          { value: 'off', label: 'Off' },
        ],
        () => s.haptics,
        (v) => (s.haptics = v),
      ),
      select(
        'Colourblind palette',
        'Identity is never colour-only; this is comfort on top.',
        [
          { value: 'off', label: 'Off' },
          { value: 'deuteranopia', label: 'Deuteranopia' },
          { value: 'protanopia', label: 'Protanopia' },
          { value: 'tritanopia', label: 'Tritanopia' },
        ],
        () => s.colorblind,
        (v) => (s.colorblind = v),
      ),
      select(
        'Text size',
        'Layouts hold to 130%.',
        [
          { value: '1', label: '100%' },
          { value: '1.15', label: '115%' },
          { value: '1.3', label: '130%' },
        ],
        () => String(s.textScale) as '1',
        (v) => (s.textScale = Number(v)),
      ),
    );

    body.appendChild(
      el(
        'div',
        { class: 'settings__stats' },
        el('p', { class: 'setting__label', text: 'Controls' }),
        el('p', {
          text: 'Tap a car to drive it out. Drag along the way it faces to park it short. Tap again on a roundabout plate to turn.',
        }),
        el('p', {
          text: 'Keyboard: arrows select, Enter drives, R reverses one cell, Z undoes.',
        }),
      ),
    );

    const stats = this.store.state.stats;
    body.appendChild(
      el(
        'div',
        { class: 'settings__stats' },
        el('p', {
          text:
            `${stats.jamsCleared} jams cleared · ${stats.totalExits} cars sent home · ` +
            `${stats.cleanExits} clean exits · ${formatPlayTime(stats.playMs)} at the wheel`,
        }),
        el('p', {
          class: 'settings__fine',
          text: 'Trunk odds: 60% coins, 20% booster, 12% Miles, 6% shard, 2% full livery. Published, because they should be.',
        }),
      ),
    );

    body.appendChild(
      button('Reset progress', {
        variant: 'danger',
        onTap: () =>
          showSheet({
            title: 'Reset everything?',
            body: 'Every district, plate and skin goes back to zero. This cannot be undone.',
            confirmLabel: 'Reset',
            onConfirm: () => {
              this.store.reset();
              this.screens.clear();
              toast('Fresh city.', '🧹');
              this.navigate('map');
            },
          }),
      }),
    );

    const panel = el(
      'div',
      { class: 'sheet sheet--settings' },
      el('p', { class: 'sheet__eyebrow', text: 'Gridlock City' }),
      el('h2', { class: 'sheet__title', text: 'Settings' }),
      body,
    );
    const handle = openOverlay(panel, { dismissible: true });
    panel.appendChild(
      el('div', { class: 'sheet__actions' }, button('Done', { variant: 'primary', onTap: () => handle.close() })),
    );
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle hooks
   * ---------------------------------------------------------------- */

  onVisibilityChange(hidden: boolean): void {
    this.play?.setPaused(hidden);
    if (hidden) {
      this.store.update((s) => void (s.lastSeenAt = Date.now()));
      this.store.flush();
      this.audio.suspend();
    } else {
      this.audio.resume();
      if (!anyOverlayOpen() && this.current && this.current !== 'play') {
        this.screens.get(this.current)?.refresh();
      }
    }
  }
}
