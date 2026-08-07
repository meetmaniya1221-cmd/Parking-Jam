/**
 * The meta screens: City Map, Depot, Garage and Events.
 *
 * All four follow the same one-thumb rules (GDD §14): one primary action per
 * screen, interactive elements in the lower part of the view, numbers always
 * paired with their icon, and never more than one modal deep.
 */

import { AudioEngine } from '../audio/audio';
import {
  firstLevelOfDistrict,
  isUnlocked,
  levelsInDistrict,
  overtimeSet,
  rushHourJam,
  rushHourName,
} from '../core/campaign';
import { analyseDifficulty } from '../core/solver';
import {
  beautificationCount,
  beautify,
  BEAUTIFICATION,
  BEAUTIFICATION_COST,
  BOOSTER_PRICES,
  buildLandmark,
  canBeautify,
  buyBooster,
  canBuildLandmark,
  canClaimCommute,
  claimCommute,
  claimDispatch,
  claimDispatchBonus,
  claimPassTier,
  collectIncome,
  exchangeMedallions,
  fundAllAffordable,
  fundProject,
  incomeRatePerHour,
  isDistrictComplete,
  KEYS_PER_IMPOUND,
  liverySetBonus,
  MILES_PER_TIER,
  MORNING_COMMUTE,
  nextProject,
  openTrunk,
  PASS_TIERS,
  passProgressInTier,
  passRewards,
  passTier,
  pendingIncome,
  advanceDispatch,
} from '../meta/economy';
import { DISTRICTS, LANDMARKS, PROJECTS_PER_DISTRICT } from '../meta/districts';
import { findHorn, findLivery, HORNS, LIVERY_SETS, RIDES } from '../meta/garage';
import { claimMedal, commissionerRank, MedalTier, MEDALS, medalProgress } from '../meta/medals';
import { BoosterId, dayNumber, dayStamp } from '../meta/save';
import { GameStore } from '../meta/store';
import { button, el, formatHours, formatNumber, pill, progressBar } from './dom';
import {
  emptyState,
  rebuild,
  section,
  showRewardedOffer,
  showSheet,
  showTimelapse,
  showTrunk,
  toast,
} from './overlays';

export interface Screen {
  root: HTMLElement;
  refresh(): void;
  mount?(): void;
  unmount?(): void;
}

export interface ScreenHost {
  playLevel(index: number): void;
  playSpecial(kind: 'rush' | 'overtime' | 'night' | 'coldCase', index?: number): void;
  refreshChrome(): void;
}

interface Deps {
  store: GameStore;
  audio: AudioEngine;
  host: ScreenHost;
}

/* ================================================================== *
 * City Map — home
 * ================================================================== */

export function createMapScreen({ store, audio, host }: Deps): Screen {
  const list = el('div', { class: 'screen__body' });
  const root = el('div', { class: 'screen screen--map' }, list);

  const refresh = () => {
    const s = store.state;
    rebuild(list, () => {
      const nodes: HTMLElement[] = [];

      nodes.push(
        el(
          'div',
          { class: 'card card--hero' },
          el('p', { class: 'card__eyebrow', text: 'Meridian' }),
          el('h1', { class: 'card__title', text: 'The city, un-jamming.' }),
          el(
            'p',
            { class: 'card__body' },
            `${completed(s)} of ${DISTRICTS.length} districts restored · `,
            `${Math.round(incomeRatePerHour(s))} Coins/h`,
          ),
          button('Next jam', {
            variant: 'primary',
            class: 'card__cta',
            onTap: () => host.playLevel(s.progress.nextLevel),
          }),
        ),
      );

      if (s.resume) {
        nodes.push(
          el(
            'div',
            { class: 'card card--resume' },
            el('p', { class: 'card__eyebrow', text: 'Where you left off' }),
            el('h2', {
              class: 'card__title',
              text: `${countRemaining(s.resume.vehicles)} cars left in Jam ${s.resume.levelIndex}`,
            }),
            el('p', { class: 'card__body', text: 'The engines are still idling.' }),
            button('Resume', {
              variant: 'primary',
              onTap: () => host.playLevel(s.resume!.levelIndex),
            }),
          ),
        );
      }

      const districts = el('div', { class: 'districts' });
      DISTRICTS.forEach((def, i) => {
        const unlockedAt = firstLevelOfDistrict(i);
        const unlocked = s.progress.highest >= unlockedAt;
        districts.appendChild(districtCard(def, i, unlocked, unlockedAt));
      });
      nodes.push(section('Districts', districts));

      const trophy = el('div', { class: 'landmarks' });
      for (const landmark of LANDMARKS) {
        const built = s.city.landmarks.includes(landmark.id);
        const ready = canBuildLandmark(s, landmark.id);
        trophy.appendChild(
          el(
            'div',
            { class: `landmark${built ? ' landmark--built' : ''}` },
            el('div', { class: 'landmark__icon', text: built ? '🏛️' : '🚧' }),
            el(
              'div',
              { class: 'landmark__text' },
              el('div', { class: 'landmark__name', text: landmark.name }),
              el('div', {
                class: 'landmark__note',
                text: built
                  ? landmark.plaque
                  : `${landmark.blueprints} Blueprints · needs ${DISTRICTS[landmark.district].name}`,
              }),
            ),
            built
              ? null
              : button('Build', {
                  variant: ready ? 'primary' : 'ghost',
                  disabled: !ready,
                  onTap: () => {
                    store.update((state) => buildLandmark(state, landmark.id));
                    audio.uiConfirm();
                    toast(`${landmark.name} is standing.`, '🏛️');
                    host.refreshChrome();
                    refresh();
                  },
                }),
          ),
        );
      }
      nodes.push(section(`Trophy case · ${s.city.landmarks.length}/${LANDMARKS.length}`, trophy));
      return nodes;
    });
  };

  function districtCard(
    def: (typeof DISTRICTS)[number],
    index: number,
    unlocked: boolean,
    unlockedAt: number,
  ): HTMLElement {
    const s = store.state;
    const ds = s.city.districts[index];
    const complete = isDistrictComplete(s, index);
    const project = nextProject(s, index);
    const affordable = !!project && s.wallet.coins >= project.cost;

    if (!unlocked) {
      return el(
        'div',
        { class: 'district district--locked', style: { ['--hue' as string]: String(def.hue) } },
        el('div', { class: 'district__head' }, el('h3', { class: 'district__name', text: def.name })),
        el('p', { class: 'district__tease', text: def.tease }),
        el('p', { class: 'district__note', text: `Opens at Jam ${unlockedAt}` }),
      );
    }

    return el(
      'div',
      {
        class: `district${complete ? ' district--complete' : ''}`,
        style: { ['--hue' as string]: String(def.hue) },
      },
      el(
        'div',
        { class: 'district__head' },
        el('h3', { class: 'district__name', text: def.name }),
        pill('🪙', `${def.incomeRate}/h`, complete ? 'pill--mint' : 'pill--muted'),
      ),
      progressBar(ds.projectsFunded / PROJECTS_PER_DISTRICT, 'bar--mint'),
      el('p', {
        class: 'district__note',
        text: complete
          ? `Restored · ${def.station} on air${
              beautificationCount(s, index) > 0
                ? ` · ${beautificationCount(s, index)} pieces placed`
                : ''
            }`
          : `${ds.projectsFunded}/${PROJECTS_PER_DISTRICT} projects · next: ${project?.name ?? ''}`,
      }),
      el(
        'div',
        { class: 'district__actions' },
        project
          ? button(`Fund · ${formatNumber(project.cost)}`, {
              variant: affordable ? 'primary' : 'ghost',
              icon: '🪙',
              disabled: !affordable,
              onTap: () => {
                const result = fundProjectFlow(index);
                if (result) refresh();
              },
            })
          : null,
        project && s.wallet.coins >= project.cost * 2
          ? button('Fund all', {
              variant: 'secondary',
              onTap: () => {
                const count = store.update((state) => {
                  const funded = fundAllAffordable(state, index).length;
                  advanceDispatch(state, 'fund', funded);
                  return funded;
                });
                if (count > 0) {
                  audio.coins(120);
                  toast(`${count} projects funded.`, '🏗️');
                  maybeTimelapse(index);
                }
                host.refreshChrome();
                refresh();
              },
            })
          : null,
        complete
          ? button(`Beautify · ${BEAUTIFICATION_COST}`, {
              variant: canBeautify(s, index) ? 'secondary' : 'ghost',
              icon: nextPiece(s, index).icon,
              disabled: !canBeautify(s, index),
              title: `Place a ${nextPiece(s, index).name.toLowerCase()}`,
              onTap: () => {
                const piece = nextPiece(store.state, index);
                if (!store.update((state) => beautify(state, index))) return;
                audio.coins(60);
                toast(`${piece.name} placed in ${def.name}.`, piece.icon);
                host.refreshChrome();
                refresh();
              },
            })
          : null,
        button('Play', {
          variant: 'secondary',
          onTap: () =>
            host.playLevel(
              Math.max(
                unlockedAt,
                Math.min(s.progress.nextLevel, unlockedAt + levelsInDistrict(index) - 1),
              ),
            ),
        }),
      ),
    );
  }

  /** Cycle through the pieces so a district accumulates variety, not clones. */
  function nextPiece(s: GameStore['state'], index: number) {
    return BEAUTIFICATION[beautificationCount(s, index) % BEAUTIFICATION.length];
  }

  function fundProjectFlow(index: number): boolean {
    const funded = store.update((state) => {
      const result = fundProject(state, index);
      if (result.funded) advanceDispatch(state, 'fund', 1);
      return result.funded;
    });
    if (!funded) return false;
    audio.coins(80);
    maybeTimelapse(index);
    host.refreshChrome();
    return true;
  }

  function maybeTimelapse(index: number): void {
    const s = store.state;
    const ds = s.city.districts[index];
    if (!isDistrictComplete(s, index) || ds.timelapseSeen) return;
    store.update((state) => {
      state.city.districts[index].timelapseSeen = true;
      state.flags.seenTimelapse = true;
    });
    void showTimelapse(
      audio,
      DISTRICTS[index].name,
      DISTRICTS[index].hue,
      s.settings.reducedMotion,
    ).then(() => {
      toast('+20 Medallions · +1 Blueprint', '🏅');
      host.refreshChrome();
      refresh();
    });
  }

  return { root, refresh };
}

function completed(s: GameStore['state']): number {
  return s.city.districts.filter((_, i) => isDistrictComplete(s, i)).length;
}

function countRemaining(flat: number[]): number {
  let n = 0;
  for (let i = 3; i < flat.length; i += 4) if (!flat[i]) n++;
  return n;
}

/* ================================================================== *
 * Depot — income, login, dailies, streaks
 * ================================================================== */

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

function boosterIcon(id: BoosterId): string {
  return { towHook: '🪝', dispatcher: '📻', greenWave: '🟢', gripTires: '🛞' }[id];
}

function boosterName(id: BoosterId): string {
  return {
    towHook: 'Tow Hook',
    dispatcher: 'Dispatcher Call',
    greenWave: 'Green Wave',
    gripTires: 'Grip Tires',
  }[id];
}

/* ================================================================== *
 * Garage
 * ================================================================== */

export function createGarageScreen({ store, audio, host }: Deps): Screen {
  const list = el('div', { class: 'screen__body' });
  const root = el('div', { class: 'screen screen--garage' }, list);
  let tab: 'rides' | 'liveries' | 'horns' = 'rides';

  const refresh = () => {
    const s = store.state;
    rebuild(list, () => {
      const nodes: HTMLElement[] = [];
      if (!isUnlocked('garage', s.progress.highest)) {
        nodes.push(
          el(
            'div',
            { class: 'card' },
            el('h2', { class: 'card__title', text: 'The Garage opens at Jam 10.' }),
            el('p', {
              class: 'card__body',
              text: 'Identity is a day-one capstone, not day-one noise.',
            }),
          ),
        );
        return nodes;
      }

      const tabs = el('div', { class: 'tabs' });
      (['rides', 'liveries', 'horns'] as const).forEach((id) => {
        if (id === 'horns' && !isUnlocked('hornLibrary', s.progress.highest)) return;
        tabs.appendChild(
          button(id[0].toUpperCase() + id.slice(1), {
            variant: tab === id ? 'primary' : 'ghost',
            onTap: () => {
              tab = id;
              audio.uiTap();
              refresh();
            },
          }),
        );
      });
      nodes.push(tabs);

      const grid = el('div', { class: 'grid' });
      if (tab === 'rides') {
        for (const ride of RIDES) {
          const owned = s.garage.rides.includes(ride.id);
          const equipped = s.garage.equipped.ride === ride.id;
          grid.appendChild(
            itemCard({
              swatch: ride.body,
              accent: ride.roof,
              name: ride.name,
              note: ride.blurb,
              owned,
              equipped,
              price: ride.price,
              onEquip: () => {
                store.update((state) => {
                  state.garage.equipped.ride = ride.id;
                  if (!state.garage.horns.includes(ride.horn)) state.garage.horns.push(ride.horn);
                });
                audio.horn(findHorn(ride.horn).shape, findHorn(ride.horn).freq);
                refresh();
              },
              onBuy: () => buy(ride.price, () => {
                store.update((state) => {
                  state.garage.rides.push(ride.id);
                  if (!state.garage.horns.includes(ride.horn)) state.garage.horns.push(ride.horn);
                });
              }),
            }),
          );
        }
      } else if (tab === 'liveries') {
        for (const set of LIVERY_SETS) {
          const ownedPieces = set.pieces.filter((p) => s.garage.liveries.includes(p)).length;
          grid.appendChild(
            el(
              'div',
              { class: 'setHead' },
              el('span', { text: set.name }),
              pill('🎨', `${ownedPieces}/${set.pieces.length}`, ownedPieces === set.pieces.length ? 'pill--mint' : 'pill--muted'),
            ),
          );
          for (const id of set.pieces) {
            const livery = findLivery(id);
            const owned = s.garage.liveries.includes(id);
            grid.appendChild(
              itemCard({
                swatch: livery.colors[0],
                accent: livery.colors[2],
                name: livery.name,
                note: `Fleet-wide paint · ${set.name}`,
                owned,
                equipped: s.garage.equipped.livery === id,
                price: Math.round(set.price / set.pieces.length),
                onEquip: () => {
                  store.update((state) => void (state.garage.equipped.livery = id));
                  audio.uiConfirm();
                  refresh();
                },
                onBuy: () =>
                  buy(Math.round(set.price / set.pieces.length), () => {
                    store.update((state) => {
                      state.garage.liveries.push(id);
                      if (
                        set.pieces.every((p) => state.garage.liveries.includes(p)) &&
                        !state.garage.horns.includes(set.horn)
                      ) {
                        state.garage.horns.push(set.horn);
                        toast(`${set.name} complete · +2% City Income`, '🏆');
                      }
                    });
                  }),
              }),
            );
          }
        }
        grid.appendChild(
          el('p', {
            class: 'empty',
            text: 'Completed sets add +2% City Income each, up to +10%. Small enough that collecting stays about looks.',
          }),
        );
      } else {
        for (const horn of HORNS) {
          const owned = s.garage.horns.includes(horn.id);
          grid.appendChild(
            itemCard({
              swatch: '#FFD166',
              accent: '#58C7F3',
              name: horn.name,
              note: 'Plays in your lots and in the win melody.',
              owned,
              equipped: s.garage.equipped.horn === horn.id,
              price: horn.price,
              extra: button('Hear it', {
                variant: 'ghost',
                onTap: () => audio.horn(horn.shape, horn.freq, 0.4),
              }),
              onEquip: () => {
                store.update((state) => void (state.garage.equipped.horn = horn.id));
                audio.horn(horn.shape, horn.freq, 0.4);
                refresh();
              },
              onBuy: () =>
                buy(horn.price, () => {
                  store.update((state) => void state.garage.horns.push(horn.id));
                }),
            }),
          );
        }
      }
      nodes.push(grid);
      return nodes;
    });
  };

  function buy(price: number, grant: () => void): void {
    if (store.state.wallet.medallions < price) {
      toast('Not enough Medallions yet.', '🎖️');
      return;
    }
    store.update((state) => void (state.wallet.medallions -= price));
    grant();
    audio.uiConfirm();
    host.refreshChrome();
    refresh();
  }

  return { root, refresh };
}

interface ItemCardModel {
  swatch: string;
  accent: string;
  name: string;
  note: string;
  owned: boolean;
  equipped: boolean;
  price: number;
  extra?: HTMLElement;
  onEquip: () => void;
  onBuy: () => void;
}

function itemCard(model: ItemCardModel): HTMLElement {
  return el(
    'div',
    { class: `item${model.equipped ? ' item--equipped' : ''}` },
    el('div', {
      class: 'item__swatch',
      style: { background: `linear-gradient(135deg, ${model.swatch}, ${model.accent})` },
    }),
    el(
      'div',
      { class: 'item__text' },
      el('div', { class: 'item__name', text: model.name }),
      el('div', { class: 'item__note', text: model.note }),
    ),
    el(
      'div',
      { class: 'item__actions' },
      model.extra ?? null,
      model.owned
        ? button(model.equipped ? 'Equipped' : 'Equip', {
            variant: model.equipped ? 'ghost' : 'primary',
            disabled: model.equipped,
            onTap: model.onEquip,
          })
        : button(`${model.price}`, { variant: 'secondary', icon: '🎖️', onTap: model.onBuy }),
    ),
  );
}

/* ================================================================== *
 * Events
 * ================================================================== */

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
      const metrics = analyseDifficulty(jam);
      // No server in this build, so this is an honest estimate from the jam's
      // own measured shape, not a community figure dressed up as one.
      const estimate = Math.max(4, Math.round(46 - metrics.knotDepth * 3.5 - metrics.vehicleCount * 0.6));
      const played = s.rush.lastAttemptDay === today;
      nodes.push(
        el(
          'div',
          { class: 'card card--rush' },
          el('p', { class: 'card__eyebrow', text: 'Rush Hour · today only' }),
          el('h1', { class: 'card__title', text: rushHourName(day) }),
          el('p', {
            class: 'card__body',
            text: `${jam.vehicles.length} cars · knot depth ${metrics.knotDepth} · estimated ${estimate}% clear it. One attempt.`,
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
