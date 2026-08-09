/**
 * Modal surfaces: win screen, timelapse, trunk reveal, rewarded-video offers,
 * interstitials, settings and toasts.
 *
 * UX rules from GDD §12/§14 that this file enforces:
 *  - one primary action per screen, and never a modal stack deeper than one,
 *  - celebration never blocks input for more than 1.2 s,
 *  - the timelapse is skippable after 2 s,
 *  - every rewarded offer is opt-in, priced in time, and declines in one tap.
 */

import { AudioEngine } from '../audio/audio';
import { button, clear, el, formatNumber, pill, progressBar } from './dom';
import { icon } from './icons';

let overlayHost: HTMLElement | null = null;
let openCount = 0;
let dialogSeq = 0;

export function initOverlays(host: HTMLElement): void {
  overlayHost = host;
}

export interface OverlayHandle {
  close: () => void;
  root: HTMLElement;
}

export interface OverlayOptions {
  /** Tapping the scrim closes the overlay. */
  dismissible?: boolean;
  className?: string;
  onClose?: () => void;
}

const FOCUSABLE = 'button:not(:disabled), select, input, [href], [tabindex]:not([tabindex="-1"])';

export function openOverlay(content: HTMLElement, options: OverlayOptions = {}): OverlayHandle {
  const host = overlayHost ?? document.body;
  const scrim = el('div', { class: `overlay ${options.className ?? ''}`.trim() });
  const panel = el('div', {
    class: 'overlay__panel',
    aria: { modal: 'true' },
  });
  panel.setAttribute('role', 'dialog');
  panel.appendChild(content);
  // Name the dialog from its own heading. An unnamed modal announces as
  // "dialog" and the player has to hunt for what it is about.
  const heading = content.querySelector<HTMLElement>('.sheet__title, .timelapse__title');
  if (heading) {
    if (!heading.id) heading.id = `dlg${++dialogSeq}`;
    panel.setAttribute('aria-labelledby', heading.id);
  }
  scrim.appendChild(panel);

  const returnFocus = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openCount--;
    window.removeEventListener('keydown', onKey, true);
    scrim.classList.add('overlay--closing');
    window.setTimeout(() => scrim.remove(), 180);
    options.onClose?.();
    // Hand focus back where it came from, so the keyboard does not reset.
    if (returnFocus?.isConnected) returnFocus.focus();
  };

  if (options.dismissible !== false) {
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) close();
    });
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && options.dismissible !== false) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Trap Tab inside the dialog; the page behind it is not reachable.
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  window.addEventListener('keydown', onKey, true);

  openCount++;
  host.appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add('overlay--open'));
  requestAnimationFrame(() => panel.querySelector<HTMLElement>(FOCUSABLE)?.focus());
  return { close, root: panel };
}

export function anyOverlayOpen(): boolean {
  return openCount > 0;
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */

let toastHost: HTMLElement | null = null;

export function toast(message: string, glyph = ''): void {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts' });
    (overlayHost ?? document.body).appendChild(toastHost);
  }
  const node = el(
    'div',
    { class: 'toast', aria: { live: 'polite' } },
    glyph ? el('span', { class: 'toast__icon', text: glyph }) : null,
    el('span', { text: message }),
  );
  toastHost.appendChild(node);
  requestAnimationFrame(() => node.classList.add('toast--in'));
  window.setTimeout(() => {
    node.classList.remove('toast--in');
    window.setTimeout(() => node.remove(), 250);
  }, 2400);
}

/* ------------------------------------------------------------------ *
 * Rewarded video and interstitials
 *
 * There is no ad network in this build. These are honest simulations of the
 * placements the design specifies, so the guardrails around them — the caps,
 * the cooldowns, the one-tap decline — are real and testable.
 * ------------------------------------------------------------------ */

export function showRewardedOffer(
  audio: AudioEngine,
  opts: { title: string; reward: string; note?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      handle.close();
      resolve(accepted);
    };

    const content = el(
      'div',
      { class: 'sheet sheet--offer' },
      el('div', { class: 'sheet__badge', text: 'Simulated ad' }),
      el('h2', { class: 'sheet__title', text: opts.title }),
      el('p', { class: 'sheet__body', text: opts.reward }),
      opts.note ? el('p', { class: 'sheet__note', text: opts.note }) : null,
      el(
        'div',
        { class: 'sheet__actions' },
        button('Watch :30', {
          variant: 'primary',
          onTap: () => {
            audio.uiConfirm();
            playFakeAd(30).then(() => finish(true));
          },
        }),
        button('No thanks', {
          variant: 'ghost',
          onTap: () => {
            audio.uiTap();
            finish(false);
          },
        }),
      ),
    );
    const handle = openOverlay(content, { dismissible: true, onClose: () => finish(false) });
  });
}

/** A short, skippable stand-in so the placement's timing is honest. */
function playFakeAd(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    // Compressed to 3 s: this is a demonstration of the placement, not an ad.
    const total = 3;
    let remaining = total;
    const counter = el('div', { class: 'ad__counter', text: `${seconds}s` });
    const content = el(
      'div',
      { class: 'ad' },
      el('div', { class: 'ad__label', text: 'Simulated ad break' }),
      el('div', { class: 'ad__art', text: '🚗💨' }),
      counter,
    );
    const handle = openOverlay(content, { dismissible: false, className: 'overlay--ad' });
    const timer = window.setInterval(() => {
      remaining -= 1;
      counter.textContent = `${Math.max(0, Math.round((remaining / total) * seconds))}s`;
      if (remaining <= 0) {
        window.clearInterval(timer);
        handle.close();
        resolve();
      }
    }, 1000);
  });
}

export function showInterstitial(): Promise<void> {
  return playFakeAd(15);
}

/* ------------------------------------------------------------------ *
 * Mystery Trunk
 * ------------------------------------------------------------------ */

export interface TrunkPresentation {
  label: string;
  detail: string;
  rarityIndex: number;
  onDouble?: () => Promise<boolean>;
}

export function showTrunk(audio: AudioEngine, trunk: TrunkPresentation): Promise<void> {
  return new Promise((resolve) => {
    const detail = el('p', { class: 'sheet__body', text: trunk.detail });
    const actions = el('div', { class: 'sheet__actions' });
    const content = el(
      'div',
      { class: 'sheet sheet--trunk' },
      el('div', { class: 'trunk__art', text: '🧰' }),
      el('h2', { class: 'sheet__title', text: 'Mystery Trunk' }),
      el('p', { class: 'sheet__eyebrow', text: trunk.label }),
      detail,
      actions,
    );

    const handle = openOverlay(content, {
      dismissible: false,
      onClose: () => resolve(),
    });

    audio.trunk(trunk.rarityIndex);
    // Anticipation first: the lid rattles, then pops (GDD §2 Reward Prediction).
    window.setTimeout(() => content.classList.add('trunk--open'), 500);

    if (trunk.onDouble) {
      actions.appendChild(
        button('Double it', {
          variant: 'primary',
          onTap: async () => {
            const doubled = await trunk.onDouble!();
            if (doubled) {
              detail.textContent = `${trunk.detail} — doubled.`;
              audio.coins(200);
            }
            handle.close();
          },
        }),
      );
    }
    actions.appendChild(
      button('Nice', { variant: trunk.onDouble ? 'ghost' : 'primary', onTap: () => handle.close() }),
    );
  });
}

/* ------------------------------------------------------------------ *
 * District timelapse — the super-peak
 * ------------------------------------------------------------------ */

export function showTimelapse(
  audio: AudioEngine,
  districtName: string,
  hue: number,
  reducedMotion: boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const stage = el('div', { class: 'timelapse__stage', style: { ['--hue' as string]: String(hue) } });
    const caption = el('div', { class: 'timelapse__caption', text: 'The streets are dark.' });
    const skip = button('Skip', { variant: 'ghost', class: 'timelapse__skip', onTap: () => done() });
    skip.hidden = true;

    const content = el(
      'div',
      { class: `timelapse${reducedMotion ? ' timelapse--reduced' : ''}` },
      el('h2', { class: 'timelapse__title', text: `${districtName} is restored` }),
      stage,
      caption,
      skip,
    );

    for (let i = 0; i < 26; i++) {
      stage.appendChild(
        el('div', {
          class: 'timelapse__window',
          style: { ['--i' as string]: String(i), ['--delay' as string]: `${0.4 + i * 0.16}s` },
        }),
      );
    }

    let finished = false;
    const handle = openOverlay(content, { dismissible: false, className: 'overlay--timelapse' });
    const done = () => {
      if (finished) return;
      finished = true;
      timers.forEach(window.clearTimeout);
      handle.close();
      resolve();
    };

    audio.timelapse();
    const beats: Array<[number, string]> = [
      [1400, 'One streetlight comes on.'],
      [3000, 'Shops unshutter, one by one.'],
      [4800, 'People are back on the pavement.'],
      [6400, 'Traffic flows. All of it.'],
    ];
    const timers = beats.map(([at, text]) =>
      window.setTimeout(() => (caption.textContent = text), reducedMotion ? at * 0.35 : at),
    );
    // Skippable after 2 s, by policy.
    timers.push(window.setTimeout(() => (skip.hidden = false), reducedMotion ? 400 : 2000));
    timers.push(window.setTimeout(done, reducedMotion ? 2600 : 8000));
  });
}

/* ------------------------------------------------------------------ *
 * Generic confirm / info sheet
 * ------------------------------------------------------------------ */

export function showSheet(opts: {
  title: string;
  body?: string;
  eyebrow?: string;
  rows?: Array<{ icon: string; label: string; value: string }>;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  /** Fired when the sheet closes any way other than confirming. */
  onDismiss?: () => void;
}): OverlayHandle {
  const rows = opts.rows?.length
    ? el(
        'div',
        { class: 'sheet__rows' },
        ...opts.rows.map((r) =>
          el(
            'div',
            { class: 'sheet__row' },
            el('span', { class: 'sheet__rowIcon', text: r.icon }),
            el('span', { class: 'sheet__rowLabel', text: r.label }),
            el('span', { class: 'sheet__rowValue', text: r.value }),
          ),
        ),
      )
    : null;

  const actions = el('div', { class: 'sheet__actions' });
  const content = el(
    'div',
    { class: 'sheet' },
    opts.eyebrow ? el('p', { class: 'sheet__eyebrow', text: opts.eyebrow }) : null,
    el('h2', { class: 'sheet__title', text: opts.title }),
    opts.body ? el('p', { class: 'sheet__body', text: opts.body }) : null,
    rows,
    actions,
  );
  let confirmed = false;
  const handle = openOverlay(content, {
    dismissible: true,
    onClose: () => {
      if (!confirmed) opts.onDismiss?.();
    },
  });

  if (opts.onConfirm) {
    actions.appendChild(
      button(opts.confirmLabel ?? 'Confirm', {
        variant: 'primary',
        onTap: () => {
          confirmed = true;
          opts.onConfirm!();
          handle.close();
        },
      }),
    );
  }
  actions.appendChild(
    button(opts.cancelLabel ?? (opts.onConfirm ? 'Not now' : 'Close'), {
      variant: opts.onConfirm ? 'ghost' : 'primary',
      onTap: () => handle.close(),
    }),
  );
  return handle;
}

/* ------------------------------------------------------------------ *
 * Win screen
 * ------------------------------------------------------------------ */

export interface WinScreenModel {
  levelIndex: number;
  levelLabel: string;
  bandLabel: string;
  slides: number;
  parSlides: number;
  bumps: number;
  durationMs: number;
  coins: number;
  miles: number;
  cleanExit: boolean;
  goldPlate: boolean;
  keysEarned: number;
  districtName: string;
  districtProgress: number;
  chapterPos: number;
  chapterSize: number;
  nextTease: string | null;
  onNext: () => void;
  onMap: () => void;
}

export function showWinScreen(model: WinScreenModel): OverlayHandle {
  const badges = el('div', { class: 'win__badges' });
  if (model.cleanExit) badges.appendChild(pill(icon('star', 'icon--sm'), 'Clean Exit', 'pill--mint'));
  if (model.goldPlate) badges.appendChild(pill(icon('crown', 'icon--sm'), 'Gold Plate', 'pill--lemon'));
  if (model.keysEarned > 0) badges.appendChild(pill('🔑', `+${model.keysEarned} Impound Key`, 'pill--sky'));

  const content = el(
    'div',
    { class: 'sheet sheet--win' },
    // The trophy is the reward beat: one object, centred, before any number.
    // Numbers are the *record* of the win; this is the win.
    el('div', { class: 'result__crest result__crest--win' }, icon('trophy', 'icon--xl')),
    el('p', { class: 'sheet__eyebrow', text: `${model.levelLabel} · ${model.bandLabel}` }),
    el('h2', { class: 'sheet__title', text: 'Lot cleared.' }),
    badges,
    el(
      'div',
      { class: 'win__stats' },
      statBlock('Slides', `${model.slides}`, `par ${model.parSlides}`),
      statBlock('Bumps', `${model.bumps}`, model.bumps === 0 ? 'spotless' : 'survived'),
      statBlock('Time', formatClock(model.durationMs), ''),
    ),
    el(
      'div',
      { class: 'win__rewards' },
      pill(icon('coin', 'icon--sm'), `+${formatNumber(model.coins)}`, 'pill--lemon'),
      pill(icon('ticket', 'icon--sm'), `+${formatNumber(model.miles)} Miles`, 'pill--sky'),
    ),
    el(
      'div',
      { class: 'win__district' },
      el(
        'div',
        { class: 'win__districtHead' },
        el('span', { text: model.districtName }),
        el('span', { text: `${model.chapterPos}/${model.chapterSize} jams` }),
      ),
      progressBar(model.districtProgress, 'bar--mint', 'District progress'),
    ),
    model.nextTease ? el('p', { class: 'win__tease', text: model.nextTease }) : null,
    el(
      'div',
      { class: 'sheet__actions' },
      button('Next jam', { variant: 'primary', onTap: () => model.onNext() }),
      button('City map', { variant: 'ghost', onTap: () => model.onMap() }),
    ),
  );

  return openOverlay(content, { dismissible: false, className: 'overlay--win' });
}

/* ------------------------------------------------------------------ *
 * Fail screen
 * ------------------------------------------------------------------ */

export interface FailScreenModel {
  levelLabel: string;
  /** The headline cause, e.g. "3 bumps". */
  reason: string;
  detail: string;
  /** Cars driven off before it ended, and how many there were. */
  cleared: number;
  total: number;
  onRetry: () => void;
  onQuit: () => void;
}

/**
 * The failure screen, written to be *survivable*.
 *
 * Three things make the difference between a fail screen that makes a player
 * quit and one that makes them tap Retry. It has to say plainly what happened —
 * a player who does not know why they lost cannot play better. It has to show
 * the progress they did make, because "eighteen of twenty-four cleared" is the
 * argument for one more go. And Retry has to be the biggest, warmest thing on
 * the screen, with no ad, no cost and no confirmation between the tap and the
 * fresh lot.
 */
export function showFailScreen(model: FailScreenModel): OverlayHandle {
  const share = model.total === 0 ? 0 : model.cleared / model.total;
  const content = el(
    'div',
    { class: 'sheet sheet--fail' },
    el('div', { class: 'result__crest result__crest--fail' }, icon('shield', 'icon--xl')),
    el('p', { class: 'sheet__eyebrow', text: model.levelLabel }),
    el('h2', { class: 'sheet__title', text: 'Jam not cleared' }),
    el('p', { class: 'fail__reason', text: model.reason }),
    el('p', { class: 'sheet__body', text: model.detail }),
    el(
      'div',
      { class: 'fail__progress' },
      el(
        'div',
        { class: 'win__districtHead' },
        el('span', { text: 'Cleared before it ended' }),
        el('span', { text: `${model.cleared}/${model.total} cars` }),
      ),
      progressBar(share, 'bar--gold', 'Cars cleared before the jam ended'),
    ),
    el(
      'div',
      { class: 'sheet__actions' },
      button('Retry', { variant: 'primary', onTap: () => model.onRetry() }),
      button('City map', { variant: 'ghost', onTap: () => model.onQuit() }),
    ),
  );

  const handle = openOverlay(content, { dismissible: false, className: 'overlay--fail' });
  // Both routes leave this level, so neither wants the sheet still on screen.
  for (const btn of content.querySelectorAll('button')) {
    btn.addEventListener('click', () => handle.close());
  }
  return handle;
}

function statBlock(label: string, value: string, note: string): HTMLElement {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'stat__value', text: value }),
    el('div', { class: 'stat__label', text: label }),
    note ? el('div', { class: 'stat__note', text: note }) : null,
  );
}

function formatClock(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Reusable list container used by the meta screens
 * ------------------------------------------------------------------ */

export function section(title: string, ...children: Array<Node | null>): HTMLElement {
  const node = el('section', { class: 'section' }, el('h2', { class: 'section__title', text: title }));
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

export function emptyState(message: string): HTMLElement {
  return el('p', { class: 'empty', text: message });
}

export function rebuild(host: HTMLElement, build: () => Node[]): void {
  clear(host);
  for (const node of build()) host.appendChild(node);
}
