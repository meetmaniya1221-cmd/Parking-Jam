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

/** A number with its icon — GDD §12: numbers never appear without their icon. */
export function pill(icon: string, value: string, className = ''): HTMLElement {
  return el(
    'span',
    { class: `pill ${className}`.trim() },
    el('span', { class: 'pill__icon', text: icon }),
    el('span', { class: 'pill__value', text: value }),
  );
}

export function progressBar(fraction: number, className = ''): HTMLElement {
  const clamped = Math.max(0, Math.min(1, fraction));
  return el(
    'div',
    {
      class: `bar ${className}`.trim(),
      aria: { valuenow: String(Math.round(clamped * 100)), valuemin: '0', valuemax: '100' },
    },
    el('div', { class: 'bar__fill', style: { width: `${clamped * 100}%` } }),
  );
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return Math.round(n).toLocaleString();
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export function formatHours(hours: number): string {
  if (hours >= 1) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
  return `${Math.round(hours * 60)}m`;
}

/** Animate a counter so rewards land as motion, not a jump cut. */
export function countUp(node: HTMLElement, from: number, to: number, ms = 600): void {
  if (from === to) {
    node.textContent = formatNumber(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    node.textContent = formatNumber(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
