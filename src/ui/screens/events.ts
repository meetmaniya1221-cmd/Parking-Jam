/**
 * Events — the appointments: Rush Hour, the Gauntlet, Cold Cases, Night Shift,
 * the Impound Lot, the City Pass and Overtime Shifts (GDD §9).
 */

import {
  GAUNTLET_CHECKPOINTS,
  GAUNTLET_LENGTH,
  gauntletPeriod,
  isUnlocked,
  overtimeSet,
  rushHourJam,
  rushHourName,
} from '../../core/campaign';
import { analyseDifficulty } from '../../core/solver';
import {
  claimPassTier,
  KEYS_PER_IMPOUND,
  MILES_PER_TIER,
  openTrunk,
  PASS_TIERS,
  passProgressInTier,
  passRewards,
  passTier,
} from '../../meta/economy';
import { dayNumber, dayStamp } from '../../meta/save';
import { button, el, formatNumber, progressBar } from '../dom';
import { emptyState, rebuild, section, showSheet, showTrunk, toast } from '../overlays';
import { boosterName, Deps, Screen } from './shared';

export function createEventsScreen({ store, audio, host }: Deps): Screen {
  const list = el('div', { class: 'screen__body' });
  const root = el('div', { class: 'screen screen--events' }, list);

  const refresh = () => {
    const s = store.state;
    const today = dayStamp(Date.now());
    const day = dayNumber(Date.now());

    rebuild(list, () => {
      const nodes: HTMLElement[] = [];

      if (!isUnlocked('rushHour', s.progress.highest)) {
        nodes.push(
          el(
            'div',
            { class: 'card' },
            el('h2', { class: 'card__title', text: 'Events open at Jam 20.' }),
            el('p', {
              class: 'card__body',
              text: 'One-attempt drama needs earned confidence first.',
            }),
          ),
        );
        return nodes;
      }

      // Rush Hour
      const jam = rushHourJam(day);
      const metrics = analyseDifficulty(jam, jam.parSolution);
      // No server in this build, so this is an honest estimate from the jam's
      // own measured shape, not a community figure dressed up as one. Weighted
      // toward what actually stops people: how much of the lot is still there
      // once tapping runs dry, and how many shunts it takes to release it.
      const estimate = Math.max(
        4,
        Math.round(
          62 - metrics.greedyStallShare * 55 - metrics.repositionMoves * 6 - metrics.knotDepth * 1.2,
        ),
      );
      const played = s.rush.lastAttemptDay === today;
      nodes.push(
        el(
          'div',
          { class: 'card card--rush' },
          el('p', { class: 'card__eyebrow', text: 'Rush Hour · today only' }),
          el('h1', { class: 'card__title', text: rushHourName(day) }),
          el('p', {
            class: 'card__body',
            text: `${jam.vehicles.length} cars · knot depth ${metrics.knotDepth} · ${metrics.repositionMoves} shunts · estimated ${estimate}% clear it. One attempt.`,
          }),
          played
            ? el('p', { class: 'card__body', text: 'Played today. Back tomorrow at 9.' })
            : button('Take the attempt', {
                variant: 'primary',
                onTap: () => {
                  store.update((state) => {
                    state.rush.lastAttemptDay = today;
                    state.rush.attempts++;
                  });
                  host.playSpecial('rush');
                },
              }),
          el('p', {
            class: 'card__note',
            text: `Lifetime: ${s.rush.clears}/${s.rush.attempts} cleared`,
          }),
        ),
      );

      // Gridlock Gauntlet — one continuous path, reset monthly.
      const period = gauntletPeriod(Date.now());
      const run = s.gauntlet.period === period ? s.gauntlet : { index: 0, finished: false };
      const rungs = el('div', { class: 'gauntlet' });
      for (let i = 1; i <= GAUNTLET_LENGTH; i++) {
        rungs.appendChild(
          el('div', {
            class: [
              'gauntlet__rung',
              i <= run.index ? 'gauntlet__rung--done' : '',
              GAUNTLET_CHECKPOINTS.includes(i) ? 'gauntlet__rung--chest' : '',
            ]
              .filter(Boolean)
              .join(' '),
            text: GAUNTLET_CHECKPOINTS.includes(i) ? '🎁' : '',
          }),
        );
      }
      nodes.push(
        section(
          'Gridlock Gauntlet',
          el(
            'div',
            { class: 'card card--gauntlet' },
            el('p', { class: 'card__eyebrow', text: 'Monthly · one continuous path' }),
            el('h2', {
              class: 'card__title',
              text: run.finished
                ? 'The month is yours.'
                : `${run.index} of ${GAUNTLET_LENGTH} rungs cleared`,
            }),
            rungs,
            el('p', {
              class: 'card__body',
              text: 'Twelve escalating jams with three checkpoint chests. Stop whenever — the path waits.',
            }),
            run.finished
              ? null
              : button(run.index > 0 ? 'Continue the path' : 'Start the path', {
                  variant: 'primary',
                  icon: '🏆',
                  onTap: () => host.playSpecial('gauntlet'),
                }),
          ),
        ),
      );

      // Cold Cases — yesterday's Rush Hour and the week before it, untimed.
      if (isUnlocked('goldPlates', s.progress.highest)) {
        const cases = el('div', { class: 'shifts' });
        for (let back = 1; back <= 5; back++) {
          const past = day - back;
          cases.appendChild(
            el(
              'div',
              { class: 'shift' },
              el('div', { class: 'shift__tag', text: rushHourName(past) }),
              el('div', { class: 'shift__note', text: `${back} day${back === 1 ? '' : 's'} ago` }),
              button('Reopen', {
                variant: 'ghost',
                onTap: () => host.playSpecial('coldCase', back),
              }),
            ),
          );
        }
        nodes.push(
          section(
            'Cold Cases',
            el('p', { class: 'empty', text: 'Every retired daily, replayable and untimed.' }),
            cases,
          ),
        );
      }

      // Night Shift — Tuesdays, and previewable any day.
      const isTuesday = new Date().getDay() === 2;
      nodes.push(
        section(
          'Night Shift',
          el(
            'div',
            { class: 'card card--night' },
            el('p', { class: 'card__eyebrow', text: isTuesday ? 'Live now' : 'Tuesdays, 18:00' }),
            el('h2', { class: 'card__title', text: 'Lit only by headlights' }),
            el('p', {
              class: 'card__body',
              text: 'The same reads, newly tense — cones follow your facing, and the lot keeps its secrets. 1.5× Miles.',
            }),
            button(isTuesday ? 'Clock on' : 'Try a night lot', {
              variant: isTuesday ? 'primary' : 'secondary',
              icon: '🌙',
              onTap: () => host.playSpecial('night'),
            }),
          ),
        ),
      );

      // Impound Lot
      const canPick = s.wallet.keys >= KEYS_PER_IMPOUND;
      nodes.push(
        section(
          'Impound Lot',
          el(
            'div',
            { class: 'card' },
            el('p', {
              class: 'card__body',
              text: 'Three locked trunks. Clean play is the only key.',
            }),
            el('div', { class: 'impound' }, ...[0, 1, 2].map((i) => impoundTrunk(i, canPick))),
            el('p', {
              class: 'card__note',
              text: `${s.wallet.keys} Keys · ${KEYS_PER_IMPOUND} opens a pick`,
            }),
          ),
        ),
      );

      // City Pass
      if (isUnlocked('cityPass', s.progress.highest)) {
        const tier = passTier(s.wallet.miles);
        const rows = el('div', { class: 'pass' });
        for (let t = Math.max(1, tier - 1); t <= Math.min(PASS_TIERS, tier + 3); t++) {
          const reward = passRewards(t);
          const claimed = s.pass.claimedTiers.includes(t);
          const ready = t <= tier && !claimed;
          rows.appendChild(
            el(
              'div',
              { class: `pass__tier${claimed ? ' pass__tier--claimed' : ''}` },
              el('div', { class: 'pass__num', text: `T${t}` }),
              el(
                'div',
                { class: 'pass__rewards' },
                el('div', { class: 'pass__free', text: reward.free }),
                el('div', {
                  class: `pass__premium${s.pass.premium ? '' : ' pass__premium--locked'}`,
                  text: reward.premium,
                }),
              ),
              button(claimed ? '✓' : 'Claim', {
                variant: ready ? 'primary' : 'ghost',
                disabled: !ready,
                onTap: () => {
                  store.update((state) => claimPassTier(state, t));
                  audio.tierUp();
                  host.refreshChrome();
                  refresh();
                },
              }),
            ),
          );
        }
        nodes.push(
          section(
            `City Pass · Season ${s.pass.season}`,
            el(
              'div',
              { class: 'card' },
              el('p', {
                class: 'card__body',
                text: `Tier ${tier}/${PASS_TIERS} · ${s.wallet.miles % MILES_PER_TIER}/${MILES_PER_TIER} Miles to the next.`,
              }),
              progressBar(passProgressInTier(s.wallet.miles), 'bar--lemon'),
              rows,
              s.pass.premium
                ? null
                : button('Unlock the paid track', {
                    variant: 'secondary',
                    onTap: () =>
                      showSheet({
                        eyebrow: 'City Pass',
                        title: 'Paid track',
                        body: 'An exclusive Ride, a four-piece livery set and the finale landmark variant. Retro-buy grants every tier you already earned. No countdown, ever.',
                        confirmLabel: 'Unlock (demo)',
                        onConfirm: () => {
                          store.update((state) => {
                            state.pass.premium = true;
                            state.ads.adHolidayUntil = Date.now() + 86_400_000;
                          });
                          toast('Paid track unlocked · 24h ad holiday', '🎟️');
                          host.refreshChrome();
                          refresh();
                        },
                      }),
                  }),
            ),
          ),
        );
      }

      // Overtime Shifts
      if (isUnlocked('overtime', s.progress.highest)) {
        const shifts = el('div', { class: 'shifts' });
        overtimeSet(day, 5).forEach((entry, i) => {
          shifts.appendChild(
            el(
              'div',
              { class: 'shift' },
              el('div', { class: 'shift__tag', text: entry.tag }),
              el('div', { class: 'shift__note', text: `${entry.level.vehicles.length} cars` }),
              button('Run it', { variant: 'ghost', onTap: () => host.playSpecial('overtime', i) }),
            ),
          );
        });
        nodes.push(section('Overtime Shifts', shifts));
      } else {
        nodes.push(
          section('Overtime Shifts', emptyState('Unlimited rated jams open at Jam 80.')),
        );
      }

      return nodes;
    });
  };

  function impoundTrunk(index: number, enabled: boolean): HTMLElement {
    const hints = ['clink', 'clank', 'hum'];
    return el(
      'button',
      {
        class: `trunk${enabled ? '' : ' trunk--locked'}`,
        type: 'button',
        title: `Sounds like a ${hints[index]}`,
        on: {
          pointerenter: () => {
            if (!enabled) return;
            // Each trunk emits a different muffled hint — audio as desire.
            if (index === 0) audio.coins(60);
            else if (index === 1) audio.snap();
            else audio.tierUp();
          },
          click: () => {
            if (!enabled) {
              toast('Clean Runs earn the keys.', '🔑');
              return;
            }
            const got = store.update((state) => {
              state.wallet.keys -= KEYS_PER_IMPOUND;
              return openTrunk(state, Date.now() + index);
            });
            void showTrunk(audio, {
              label: got.label,
              detail: [
                got.coins ? `${formatNumber(got.coins)} Coins` : '',
                got.miles ? `${formatNumber(got.miles)} Miles` : '',
                got.booster ? `1 ${boosterName(got.booster)}` : '',
                got.liveryId ? 'a full livery' : '',
              ]
                .filter(Boolean)
                .join(' + '),
              rarityIndex: ['coins', 'booster', 'miles', 'shard', 'livery'].indexOf(got.rarity),
            }).then(() => {
              host.refreshChrome();
              refresh();
            });
          },
        },
      },
      el('span', { class: 'trunk__icon', text: '🧰' }),
      el('span', { class: 'trunk__hint', text: hints[index] }),
    );
  }

  return { root, refresh };
}
