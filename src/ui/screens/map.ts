/**
 * City Map — home. Districts as chapters, projects as a punch list, and the
 * landmark trophy case (GDD §10 "City Rebuild").
 */

import { firstLevelOfDistrict, levelsInDistrict } from '../../core/campaign';
import {
  advanceDispatch,
  BEAUTIFICATION,
  BEAUTIFICATION_COST,
  beautificationCount,
  beautify,
  buildLandmark,
  canBeautify,
  canBuildLandmark,
  fundAllAffordable,
  fundProject,
  incomeRatePerHour,
  isDistrictComplete,
  nextProject,
} from '../../meta/economy';
import { DISTRICTS, LANDMARKS, PROJECTS_PER_DISTRICT } from '../../meta/districts';
import { GameStore } from '../../meta/store';
import { button, el, formatNumber, pill, progressBar } from '../dom';
import { rebuild, section, showTimelapse, toast } from '../overlays';
import { Deps, Screen } from './shared';

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
