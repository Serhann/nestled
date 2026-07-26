import type { BootTheme } from '../../types/chat';
import { derivePalette, type Scheme } from './tokens';

/**
 * Write the derived palette onto `documentElement` and keep it current.
 *
 * The widget owns its whole document (it is iframed), so the root element is the
 * right place: every rule in widget.css reads these variables, and nothing needs
 * a provider or a re-render to pick up a scheme change.
 *
 * `color_mode: 'auto'` subscribes to the OS preference. The subscription lives
 * here rather than in a hook because it must survive React re-renders and there
 * is exactly one of it.
 */

export interface ThemeState {
  scheme: Scheme;
  contrastWarning: string | null;
}

const MEDIA = '(prefers-color-scheme: dark)';

function preferredScheme(): Scheme {
  return typeof matchMedia === 'function' && matchMedia(MEDIA).matches ? 'dark' : 'light';
}

function write(theme: BootTheme | undefined, scheme: Scheme): ThemeState {
  const { vars, contrastWarning } = derivePalette(theme, scheme);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.setAttribute('data-theme', scheme);
  // Tells the browser to render form controls and scrollbars to match, which is
  // the one bit of theming we cannot express as a custom property.
  root.style.colorScheme = scheme;
  return { scheme, contrastWarning };
}

/**
 * Apply `theme` and report the resolved state. Returns a disposer; call it
 * before applying a different theme so the media listener does not accumulate.
 */
export function applyTheme(
  theme: BootTheme | undefined,
  onChange: (state: ThemeState) => void,
): () => void {
  const mode = theme?.color_mode ?? 'light';
  const resolve = (): Scheme => (mode === 'auto' ? preferredScheme() : mode === 'dark' ? 'dark' : 'light');

  onChange(write(theme, resolve()));

  if (mode !== 'auto' || typeof matchMedia !== 'function') return () => undefined;

  const mq = matchMedia(MEDIA);
  const listener = () => onChange(write(theme, resolve()));
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}
