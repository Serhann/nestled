import { forwardRef, useState } from 'react';
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

  /**
   * The customer's own mark instead of one of our five glyphs.
   *
   * `custom_icon` was already an option on the Appearance screen and already a member of
   * `launcher_style` — it just did nothing here, so choosing it drew the same bubble as
   * `bubble`. The picture it uses is `brand_avatar_url`, the one the panel header already
   * shows, so a customer who has set their logo once does not set it twice.
   *
   * Two guards, both about not ending up with an empty circle in the corner of somebody's
   * website. `custom_icon` with no URL falls back to the glyph, and a URL that fails to
   * load falls back at runtime — it points at a server we do not control and will
   * eventually 404 without anyone telling us, exactly as in Panel.tsx.
   */
  const [logoBroken, setLogoBroken] = useState(false);
  const logo =
    theme?.launcher_style === 'custom_icon' && theme.brand_avatar_url && !logoBroken
      ? theme.brand_avatar_url
      : null;
  const glyph = Math.round(size * 0.43);
  // A logo gets a larger box than a glyph. 43% suits a monoline icon, which reads at any
  // size; a logo carries a shape or a word and is simply illegible in the same 26px on a
  // medium launcher. 58% still leaves a clear ring of brand colour around it.
  const logoBox = Math.round(size * 0.58);

  return (
    <button
      ref={ref}
      className="n-launcher"
      data-style={style}
      data-pulse={theme?.launcher_pulse ? 'true' : undefined}
      onClick={onOpen}
      aria-label={label}
      // Inline, because it is a per-website number and a CSS variable set on the root
      // would have to be threaded through applyTheme for one value used in one place.
      style={style === 'bubble' ? { width: size, height: size } : { height: size }}
    >
      {/* The glyph scales with the button, so a large launcher is not a large circle
          with a small icon marooned in the middle. A logo is given the SAME box, and the
          size is set inline rather than in CSS: the host frame is measured from this
          button one frame after layout (see Widget.tsx), so an image whose dimensions
          arrive with the download would be measured before it had any. */}
      {logo ? (
        <img
          className="n-launcher-logo"
          src={logo}
          alt=""
          width={logoBox}
          height={logoBox}
          onError={() => setLogoBroken(true)}
        />
      ) : (
        <Icon size={glyph} />
      )}
      {style === 'pill' && <span>{label}</span>}
      {unread > 0 && (
        <span className="n-badge" aria-label={`${unread} unread`}>
          {unread}
        </span>
      )}
    </button>
  );
});
