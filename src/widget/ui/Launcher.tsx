import { forwardRef } from 'react';
import type { BootTheme } from '../../types/chat';
import { LAUNCHER_ICONS } from './icons';

/**
 * The closed state.
 *
 * Centred in its own box rather than anchored: when embedded, the host iframe is
 * only a little larger than the button (see embed.js), so centring is what keeps
 * the drop shadow from being clipped into a square. Anchoring happens on the
 * host side, where the iframe itself is positioned.
 */
/**
 * A ref, because the host frame is sized from this element's measured box — a pill
 * launcher is as wide as the label the customer wrote, and no constant fits that.
 */
export const Launcher = forwardRef<
  HTMLButtonElement,
  {
    theme: BootTheme | undefined;
    label: string;
    unread: number;
    onOpen(): void;
  }
>(function Launcher({ theme, label, unread, onOpen }, ref) {
  const style = theme?.launcher_style === 'pill' ? 'pill' : 'bubble';
  const Icon = LAUNCHER_ICONS[theme?.launcher_icon ?? 'chat'] ?? LAUNCHER_ICONS.chat;
  const size = Math.max(40, Math.min(96, theme?.launcher_size ?? 60));
  return (
    <button
      ref={ref}
      className="n-launcher"
      data-style={style}
      onClick={onOpen}
      aria-label={label}
      // Inline, because it is a per-website number and a CSS variable set on the root
      // would have to be threaded through applyTheme for one value used in one place.
      style={style === 'bubble' ? { width: size, height: size } : { height: size }}
    >
      {/* The glyph scales with the button, so a large launcher is not a large circle
          with a small icon marooned in the middle. */}
      <Icon size={Math.round(size * 0.43)} />
      {style === 'pill' && <span>{label}</span>}
      {unread > 0 && (
        <span className="n-badge" aria-label={`${unread} unread`}>
          {unread}
        </span>
      )}
    </button>
  );
});
