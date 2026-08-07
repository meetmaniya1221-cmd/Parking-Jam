/**
 * Palette and colour policy (GDD §12).
 *
 * Contrast rule, enforced by construction: vehicles never share a family with
 * the asphalt, and vehicle identity is never colour-only — class silhouettes
 * differ, facing is shown by windshield and light strip, one-ways are
 * shape-coded and slicks carry a texture. The colourblind remaps below shift
 * hues that the three common deficiencies confuse; they are a comfort layer on
 * top of a design that already reads in greyscale.
 */

import { Settings } from '../meta/save';

export interface Palette {
  coral: string;
  coralLight: string;
  coralDeep: string;
  sky: string;
  skyLight: string;
  skyDeep: string;
  mint: string;
  mintLight: string;
  mintDeep: string;
  sand: string;
  cream: string;
  asphalt: string;
  asphaltLight: string;
  asphaltDeep: string;
  lanePaint: string;
  lemon: string;
  ink: string;
  shadow: string;
}

export const BASE_PALETTE: Palette = {
  coral: '#FF6F61',
  coralLight: '#FF8A76',
  coralDeep: '#E85546',
  sky: '#58C7F3',
  skyLight: '#8FDCFA',
  skyDeep: '#2FA8DC',
  mint: '#62D9B2',
  mintLight: '#8FE9CC',
  mintDeep: '#3BB893',
  sand: '#F6E7C8',
  cream: '#FFF6E3',
  asphalt: '#3E4A5A',
  asphaltLight: '#55647A',
  asphaltDeep: '#2C3644',
  lanePaint: '#F9F4E8',
  lemon: '#FFD166',
  ink: '#22303F',
  shadow: 'rgba(20, 30, 44, 0.28)',
};

/* ------------------------------------------------------------------ *
 * Colourblind remapping
 * ------------------------------------------------------------------ */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((1 << 24) | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).slice(1)}`;
}

/**
 * Rotate the red–green axis toward blue–yellow, which the three common
 * deficiencies all discriminate well, and push saturation so hues that would
 * collapse together stay apart.
 */
function remap(hex: string, mode: Settings['colorblind']): string {
  if (mode === 'off') return hex;
  const [r, g, b] = hexToRgb(hex);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  switch (mode) {
    case 'deuteranopia':
      return rgbToHex([r * 0.6 + lum * 0.4, g * 0.5 + lum * 0.5, b * 0.85 + lum * 0.3]);
    case 'protanopia':
      return rgbToHex([r * 0.45 + lum * 0.55, g * 0.7 + lum * 0.3, b * 0.9 + lum * 0.25]);
    case 'tritanopia':
      return rgbToHex([r * 0.95 + lum * 0.1, g * 0.6 + lum * 0.4, b * 0.5 + lum * 0.5]);
    default:
      return hex;
  }
}

export function paletteFor(settings: Settings): Palette {
  const out: Palette = { ...BASE_PALETTE };
  if (settings.colorblind !== 'off') {
    for (const key of Object.keys(out) as Array<keyof Palette>) {
      const value = out[key];
      if (value.startsWith('#')) out[key] = remap(value, settings.colorblind);
    }
  }
  if (settings.highContrast) {
    out.asphalt = '#2A3441';
    out.asphaltLight = '#3E4C5E';
    out.asphaltDeep = '#1B2430';
    out.lanePaint = '#FFFFFF';
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Colour maths shared by the renderer
 * ------------------------------------------------------------------ */

export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  return rgbToHex([r + (t - r) * p, g + (t - g) * p, b + (t - b) * p]);
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
