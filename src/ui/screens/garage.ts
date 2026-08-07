/**
 * Garage — Rides, Liveries and Horns. Pure identity: nothing here touches the
 * puzzle, so collecting can never corrupt the competence fantasy (GDD §8).
 */

import { isUnlocked } from '../../core/campaign';
import { findHorn, findLivery, HORNS, LIVERY_SETS, RIDES } from '../../meta/garage';
import { button, el, pill } from '../dom';
import { rebuild, toast } from '../overlays';
import { Deps, Screen } from './shared';

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
