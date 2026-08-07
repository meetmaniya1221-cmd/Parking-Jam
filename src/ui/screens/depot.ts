/**
 * Depot — income, the login board, the day's tasks, streaks and Service Medals.
 * This is where a session opens and where it is meant to feel paid.
 */

import { isUnlocked } from '../../core/campaign';
import {
  BOOSTER_PRICES,
  buyBooster,
  canClaimCommute,
  claimCommute,
  claimDispatch,
  claimDispatchBonus,
  collectIncome,
  exchangeMedallions,
  KEYS_PER_IMPOUND,
  liverySetBonus,
  MORNING_COMMUTE,
  pendingIncome,
} from '../../meta/economy';
import { claimMedal, commissionerRank, MedalTier, MEDALS, medalProgress } from '../../meta/medals';
import { BoosterId } from '../../meta/save';
import { button, el, formatHours, formatNumber, pill, progressBar } from '../dom';
import { rebuild, section, showRewardedOffer, toast } from '../overlays';
import { boosterIcon, boosterName, Deps, Screen } from './shared';

export function createDepotScreen({ store, audio, host }: Deps): Screen {
  const list = el('div', { class: 'screen__body' });
  const root = el('div', { class: 'screen screen--depot' }, list);
  let ticker = 0;

  const refresh = () => {
    const s = store.state;
    const income = pendingIncome(s, Date.now());

    rebuild(list, () => {
      const nodes: HTMLElement[] = [];

      nodes.push(
        el(
          'div',
          { class: 'card card--depot' },
          el('p', { class: 'card__eyebrow', text: 'City Income' }),
          el('h1', { class: 'card__title', text: `${formatNumber(income.coins)} Coins waiting` }),
          el('p', {
            class: 'card__body',
            text:
              income.ratePerHour <= 0
                ? 'Restore a district and it starts paying you back.'
                : `${Math.round(income.ratePerHour)}/h${
                    liverySetBonus(s) > 0 ? ` (+${Math.round(liverySetBonus(s) * 100)}% liveries)` : ''
                  } · ${income.capped ? 'capped' : `${formatHours(income.hours)} banked`}`,
          }),
          el(
            'div',
            { class: 'card__actions' },
            button('Collect', {
              variant: 'primary',
              icon: '🪙',
              disabled: income.coins <= 0,
              onTap: () => {
                const got = store.update((state) => collectIncome(state, Date.now()));
                audio.coins(got);
                toast(`+${formatNumber(got)} Coins`, '🪙');
                host.refreshChrome();
                refresh();
              },
            }),
            income.ratePerHour > 0 && Date.now() > s.income.doublerUntil
              ? button('2× for 4h', {
                  variant: 'secondary',
                  icon: '📺',
                  onTap: async () => {
                    const ok = await showRewardedOffer(audio, {
                      title: 'Double the Depot',
                      reward: '2× City Income rate for the next four hours.',
                      note: 'Doubles the rate, not the cap window.',
                    });
                    if (!ok) return;
                    store.update((state) => {
                      state.income.doublerUntil = Date.now() + 4 * 3_600_000;
                    });
                    toast('Depot doubled.', '🏭');
                    refresh();
                  },
                })
              : null,
          ),
        ),
      );

      // Morning Commute
      const board = el('div', { class: 'commute' });
      MORNING_COMMUTE.forEach((day) => {
        const claimedToday = !canClaimCommute(s, Date.now());
        const isToday = day.day === s.daily.commuteDay;
        board.appendChild(
          el(
            'div',
            {
              class: `commute__day${isToday ? ' commute__day--today' : ''}${
                day.day < s.daily.commuteDay ? ' commute__day--done' : ''
              }`,
            },
            el('div', { class: 'commute__num', text: `Day ${day.day}` }),
            el('div', { class: 'commute__reward', text: day.label }),
            isToday && !claimedToday
              ? button('Claim', {
                  variant: 'primary',
                  onTap: () => {
                    const claimed = store.update((state) => claimCommute(state, Date.now()));
                    if (claimed) {
                      audio.coins(150);
                      toast(claimed.label, '🎁');
                    }
                    host.refreshChrome();
                    refresh();
                  },
                })
              : null,
          ),
        );
      });
      nodes.push(section('Morning Commute', board));

      // Dispatch Board
      if (isUnlocked('dispatchBoard', s.progress.highest)) {
        const tasks = el('div', { class: 'tasks' });
        s.daily.dispatch.forEach((task, i) => {
          tasks.appendChild(
            el(
              'div',
              { class: `task${task.claimed ? ' task--claimed' : ''}` },
              el(
                'div',
                { class: 'task__text' },
                el('div', { class: 'task__label', text: task.label }),
                progressBar(task.progress / task.goal, 'bar--sky'),
              ),
              task.claimed
                ? el('span', { class: 'task__done', text: '✓' })
                : button(`${task.progress}/${task.goal}`, {
                    variant: task.progress >= task.goal ? 'primary' : 'ghost',
                    disabled: task.progress < task.goal,
                    onTap: () => {
                      store.update((state) => {
                        claimDispatch(state, i);
                        claimDispatchBonus(state);
                      });
                      audio.uiConfirm();
                      host.refreshChrome();
                      refresh();
                    },
                  }),
            ),
          );
        });
        nodes.push(section('Dispatch Board', tasks));
      }

      // Service Medals
      const rank = commissionerRank(s);
      const ribbons = el('div', { class: 'medals' });
      for (const def of MEDALS) {
        const progress = medalProgress(s, def);
        ribbons.appendChild(
          el(
            'div',
            { class: `medal medal--${progress.tier ?? 'none'}` },
            el('div', { class: 'medal__icon', text: def.icon }),
            el(
              'div',
              { class: 'medal__text' },
              el('div', { class: 'medal__name', text: def.name }),
              progressBar(progress.fraction, 'bar--lemon'),
              el('div', {
                class: 'medal__note',
                text:
                  progress.next === null
                    ? `${formatNumber(progress.value)} · gold`
                    : `${formatNumber(progress.value)} / ${formatNumber(progress.next)}`,
              }),
            ),
            progress.unclaimed.length > 0
              ? button('Collect', {
                  variant: 'primary',
                  onTap: () => {
                    const paid = store.update((state) => claimMedal(state, def.id));
                    audio.uiConfirm();
                    toast(`+${paid} Medallions`, '🎖️');
                    host.refreshChrome();
                    refresh();
                  },
                })
              : el('span', { class: 'medal__tier', text: tierMark(progress.tier) }),
          ),
        );
      }
      nodes.push(
        section(
          `Service Medals · Commissioner rank ${rank.rank}`,
          el('div', { class: 'card' }, progressBar(rank.fraction, 'bar--mint'), ribbons),
        ),
      );

      // Streaks
      const lamps = el('div', { class: 'signal' });
      for (let i = 0; i < 7; i++) {
        const lit = i < s.streaks.greenLight % 7 || (s.streaks.greenLight % 7 === 0 && s.streaks.greenLight > 0);
        lamps.appendChild(el('div', { class: `signal__lamp${lit ? ' signal__lamp--lit' : ''}` }));
      }
      nodes.push(
        section(
          'Streaks',
          el(
            'div',
            { class: 'card' },
            el('div', { class: 'streak__row' }, el('span', { text: 'Green Light' }), lamps),
            el('p', {
              class: 'card__body',
              text: `Day ${s.streaks.greenLight}${
                s.streaks.snowDayAvailable ? ' · a Snow Day is saved for you' : ''
              }`,
            }),
            el(
              'div',
              { class: 'streak__row' },
              el('span', { text: 'Clean Run' }),
              pill('🔑', `${s.wallet.keys}/${KEYS_PER_IMPOUND}`, 'pill--sky'),
            ),
            progressBar(s.streaks.cleanRunMilestone / 5, 'bar--lemon'),
            el('p', {
              class: 'card__body',
              text: `${s.streaks.cleanRunMilestone}/5 toward the next Impound Key. Breaking a run pauses it — nothing is taken.`,
            }),
          ),
        ),
      );

      // Shop
      const shop = el('div', { class: 'shop' });
      (Object.keys(BOOSTER_PRICES) as BoosterId[]).forEach((id) => {
        const price = BOOSTER_PRICES[id];
        shop.appendChild(
          el(
            'div',
            { class: 'shop__item' },
            el('div', { class: 'shop__icon', text: boosterIcon(id) }),
            el(
              'div',
              { class: 'shop__text' },
              el('div', { class: 'shop__name', text: boosterName(id) }),
              el('div', { class: 'shop__note', text: `You have ${s.boosters[id]}` }),
            ),
            button(`${price}`, {
              variant: s.wallet.medallions >= price ? 'primary' : 'ghost',
              icon: '🎖️',
              disabled: s.wallet.medallions < price,
              onTap: () => {
                store.update((state) => buyBooster(state, id));
                audio.uiConfirm();
                host.refreshChrome();
                refresh();
              },
            }),
          ),
        );
      });
      shop.appendChild(
        el(
          'div',
          { class: 'shop__item' },
          el('div', { class: 'shop__icon', text: '💱' }),
          el(
            'div',
            { class: 'shop__text' },
            el('div', { class: 'shop__name', text: 'Trade 10 Medallions' }),
            el('div', { class: 'shop__note', text: 'For 150 Coins. One way only.' }),
          ),
          button('Trade', {
            variant: s.wallet.medallions >= 10 ? 'secondary' : 'ghost',
            disabled: s.wallet.medallions < 10,
            onTap: () => {
              store.update((state) => exchangeMedallions(state, 10));
              audio.coins(150);
              host.refreshChrome();
              refresh();
            },
          }),
        ),
      );
      nodes.push(section('Depot shop', shop));
      return nodes;
    });
  };

  return {
    root,
    refresh,
    mount() {
      ticker = window.setInterval(refresh, 30_000);
    },
    unmount() {
      window.clearInterval(ticker);
    },
  };
}

function tierMark(tier: MedalTier | null): string {
  return tier === 'gold' ? '🥇' : tier === 'silver' ? '🥈' : tier === 'bronze' ? '🥉' : '·';
}
