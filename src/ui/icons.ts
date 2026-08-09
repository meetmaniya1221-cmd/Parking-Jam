/**
 * The icon set.
 *
 * Everything else in this game is drawn procedurally, and for the lot that is
 * the right call — it has to scale from a 63 px cell to a 29 px one and remap
 * for three kinds of colour blindness. Chrome icons are the opposite case: they
 * render at one small size, they never need remapping, and a glyph with real
 * material on it ("a gold tow hook", "a red shield") communicates faster than
 * any flat pictogram. So these are baked images, and the *chip* they sit on is
 * CSS, which keeps them themeable where it matters.
 *
 * They replaced a row of emoji, which is the single loudest way a game says
 * "prototype": emoji render differently on every platform, carry someone else's
 * art direction, and cannot be lit to match anything around them.
 */

import car from '../assets/icons/car.webp';
import city from '../assets/icons/city.webp';
import coin from '../assets/icons/coin.webp';
import crown from '../assets/icons/crown.webp';
import depot from '../assets/icons/depot.webp';
import dispatch from '../assets/icons/dispatch.webp';
import events from '../assets/icons/events.webp';
import garage from '../assets/icons/garage.webp';
import greenwave from '../assets/icons/greenwave.webp';
import grip from '../assets/icons/grip.webp';
import hint from '../assets/icons/hint.webp';
import medal from '../assets/icons/medal.webp';
import rescue from '../assets/icons/rescue.webp';
import retry from '../assets/icons/retry.webp';
import shield from '../assets/icons/shield.webp';
import star from '../assets/icons/star.webp';
import ticket from '../assets/icons/ticket.webp';
import tow from '../assets/icons/tow.webp';
import trophy from '../assets/icons/trophy.webp';
import undo from '../assets/icons/undo.webp';

import { el } from './dom';

export const ICONS = {
  car,
  city,
  coin,
  crown,
  depot,
  events,
  garage,
  medal,
  ticket,
  dispatch,
  greenwave,
  grip,
  hint,
  rescue,
  retry,
  shield,
  star,
  tow,
  trophy,
  undo,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * An icon as an `<img>`.
 *
 * Always decorative: every control that carries one also carries a text label
 * or a `title`, so the icon is marked `aria-hidden` rather than given a
 * duplicate alt text a screen reader would read twice.
 */
export function icon(name: IconName, className = ''): HTMLImageElement {
  const node = el('img', {
    class: `icon${className ? ` ${className}` : ''}`,
    aria: { hidden: 'true' },
  }) as HTMLImageElement;
  node.src = ICONS[name];
  node.alt = '';
  node.draggable = false;
  // Chrome icons are tiny and always on screen the moment their surface is; a
  // lazy load would pop them in a frame late.
  node.decoding = 'sync';
  return node;
}
