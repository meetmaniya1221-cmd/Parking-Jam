/** Tiny DOM helpers. No framework: the UI is a handful of screens. */

type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  id?: string;
  text?: string;
  html?: string;
  title?: string;
  type?: string;
  value?: string;
  disabled?: boolean;
  hidden?: boolean;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  aria?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: never) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.html !== undefined) node.innerHTML = props.html;
  if (props.title) node.title = props.title;
  if (props.type && 'type' in node) (node as HTMLInputElement).type = props.type;
  if (props.value !== undefined && 'value' in node) (node as HTMLInputElement).value = props.value;
  if (props.disabled !== undefined && 'disabled' in node) {
    (node as HTMLButtonElement).disabled = props.disabled;
  }
  if (props.hidden) node.hidden = true;
  if (props.style) Object.assign(node.style, props.style);
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.aria) for (const [k, v] of Object.entries(props.aria)) node.setAttribute(`aria-${k}`, v);
  if (props.on) {
    for (const [name, handler] of Object.entries(props.on)) {
      node.addEventListener(name, handler as EventListener);
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export interface ButtonOptions extends ElProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: string;
  onTap?: () => void;
}

export function button(label: string, options: ButtonOptions = {}): HTMLButtonElement {
  const { variant = 'secondary', icon, onTap, class: extra, ...rest } = options;
  const node = el(
    'button',
    { ...rest, class: `btn btn--${variant}${extra ? ` ${extra}` : ''}`, type: 'button' },
    icon ? el('span', { class: 'btn__icon', text: icon }) : null,
    el('span', { class: 'btn__label', text: label }),
  );
  if (onTap) node.addEventListener('click', onTap);
  return node;
}

/**
 * A number with its icon — GDD §12: numbers never appear without their icon.
 *
 * Takes either a glyph or a rendered icon element, so a caller can hand it one
 * of the baked 3D icons without this module having to import the icon set and
 * drag every PNG into every screen that only wanted a chip.
 */
export function pill(icon: string | HTMLElement, value: string, className = ''): HTMLElement {
  return el(
    'span',
    { class: `pill ${className}`.trim() },
    typeof icon === 'string' ? el('span', { class: 'pill__icon', text: icon }) : icon,
    el('span', { class: 'pill__value', text: value }),
  );
}

export function progressBar(fraction: number, className = '', label = 'Progress'): HTMLElement {
  const clamped = Math.max(0, Math.min(1, fraction));
  // `aria-value*` is only meaningful with a role that declares them; on a bare
  // div they are silently discarded and the bar conveys nothing at all.
  const node = el(
    'div',
    {
      class: `bar ${className}`.trim(),
      aria: {
        valuenow: String(Math.round(clamped * 100)),
        valuemin: '0',
        valuemax: '100',
        label,
      },
    },
    el('div', { class: 'bar__fill', style: { width: `${clamped * 100}%` } }),
  );
  node.setAttribute('role', 'progressbar');
  return node;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return Math.round(n).toLocaleString();
}

export function formatHours(hours: number): string {
  if (hours >= 1) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
  return `${Math.round(hours * 60)}m`;
}
