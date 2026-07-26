import type { BootTheme } from '../../types/chat';

/**
 * The widget's entire palette, derived once from the boot payload.
 *
 * The pre-tenant widget called `color-mix()` inline in about thirty-five places.
 * Every one of those was a colour decision made at render time, in a component,
 * where nobody could see the set of them together — which is how a widget ends
 * up with three slightly different "tinted primary" backgrounds and an
 * unreadable button on a pale brand colour. Here the arithmetic happens exactly
 * once, in this file, and components only ever name a variable.
 *
 * Deliberately NOT Tailwind. The repo's config remaps `blue-*` and `gray-*` onto
 * our own brand ramp; the widget's neutrals belong to the CUSTOMER, so it must
 * not inherit ours. Plain CSS over these variables also keeps the payload small.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse #rgb / #rrggbb. Anything else returns null so callers can fall back. */
export function parseHex(input: string): Rgb | null {
  const hex = input.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Linear blend in sRGB — the same space `color-mix(in srgb, …)` used. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.min(1, Math.max(0, amount));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function channelLuminance(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 17, g: 17, b: 17 };
const FALLBACK_PRIMARY: Rgb = { r: 79, g: 70, b: 229 };

/** Neutral ramps. The customer picks a primary; the greys are ours to get right. */
const LIGHT = {
  surface: { r: 255, g: 255, b: 255 },
  canvas: { r: 250, g: 250, b: 251 },
  border: { r: 228, g: 228, b: 232 },
  text: { r: 24, g: 24, b: 27 },
  muted: { r: 113, g: 113, b: 122 },
};

const DARK = {
  surface: { r: 24, g: 24, b: 27 },
  canvas: { r: 16, g: 16, b: 19 },
  border: { r: 55, g: 55, b: 61 },
  text: { r: 244, g: 244, b: 245 },
  muted: { r: 161, g: 161, b: 170 },
};

const FONT_STACKS: Record<string, string> = {
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  sans: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif',
};

export type Scheme = 'light' | 'dark';

export interface Palette {
  /** CSS custom property name → value. Written verbatim onto documentElement. */
  vars: Record<string, string>;
  /** Non-null when the best available on-primary colour still fails 4.5:1. */
  contrastWarning: string | null;
}

/**
 * Derive every token.
 *
 * On-primary is whichever of white/near-black reads better on the brand colour,
 * rather than an unconditional white — a pale primary with white text is the
 * single most common accessibility failure in an embedded chat widget. If even
 * the better choice misses 4.5:1 we surface it IN THE PANEL: a console warning
 * reaches whoever is debugging the host page, which is never the person who
 * chose the colour.
 */
export function derivePalette(theme: BootTheme | undefined, scheme: Scheme): Palette {
  const primary = (theme && parseHex(theme.primary_color)) || FALLBACK_PRIMARY;
  const n = scheme === 'dark' ? DARK : LIGHT;

  const onWhite = contrast(primary, WHITE);
  const onBlack = contrast(primary, BLACK);
  const onPrimary = onWhite >= onBlack ? WHITE : BLACK;
  const best = Math.max(onWhite, onBlack);

  // Tints are mixed toward the SURFACE, not toward white, so they stay subtle in
  // dark mode instead of turning into glowing patches.
  const soft = mix(n.surface, primary, 0.12);
  const softer = mix(n.surface, primary, 0.07);
  const hover = mix(primary, scheme === 'dark' ? WHITE : BLACK, 0.12);

  const radius = Math.min(28, Math.max(0, theme?.radius_px ?? 16));

  return {
    contrastWarning:
      best < 4.5
        ? `The brand colour ${toHex(primary)} only reaches ${best.toFixed(1)}:1 against its ` +
          'best text colour. Text on buttons and the header may be hard to read.'
        : null,
    vars: {
      '--n-color-primary': toHex(primary),
      '--n-color-primary-hover': toHex(hover),
      '--n-color-primary-soft': toHex(soft),
      '--n-color-primary-softer': toHex(softer),
      '--n-color-primary-ring': `rgba(${Math.round(primary.r)}, ${Math.round(primary.g)}, ${Math.round(primary.b)}, 0.22)`,
      '--n-color-on-primary': toHex(onPrimary),
      '--n-color-surface': toHex(n.surface),
      '--n-color-canvas': toHex(n.canvas),
      '--n-color-raised': toHex(mix(n.surface, n.text, 0.04)),
      '--n-color-border': toHex(n.border),
      '--n-color-text': toHex(n.text),
      '--n-color-text-muted': toHex(n.muted),
      '--n-color-online': scheme === 'dark' ? '#4ade80' : '#16a34a',
      '--n-color-danger': scheme === 'dark' ? '#f87171' : '#dc2626',
      '--n-color-danger-soft': toHex(mix(n.surface, { r: 220, g: 38, b: 38 }, 0.1)),
      '--n-color-scrim': scheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.35)',
      '--n-radius-panel': `${radius}px`,
      '--n-radius-bubble': `${Math.max(4, Math.round(radius * 1.1))}px`,
      '--n-radius-control': `${Math.max(4, Math.round(radius * 0.6))}px`,
      '--n-radius-pill': '999px',
      '--n-font': FONT_STACKS[theme?.font_family ?? 'system'] ?? FONT_STACKS.system,
      '--n-shadow-panel':
        scheme === 'dark' ? '0 12px 48px rgba(0,0,0,0.55)' : '0 12px 48px rgba(0,0,0,0.18)',
      '--n-shadow-raised':
        scheme === 'dark' ? '0 2px 8px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.08)',
    },
  };
}
