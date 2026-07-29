import type { BootTheme } from '../../types/chat';
import type { Copy } from '../copy';
import { FIXED } from '../copy';
import { ChatIcon, CloseIcon, MinimizeIcon } from './icons';

/**
 * The open panel's chrome: header, warnings, footer.
 *
 * The body and the composer are passed in, because which one of eight screens
 * is showing is state that belongs to the widget root — not to the frame around
 * it. Keeping the frame dumb is what stops "the header looks different on the
 * rating screen" from ever being possible.
 */
export function Panel({
  copy,
  theme,
  online,
  contrastWarning,
  showBranding,
  onMinimize,
  onClose,
  overlay,
  children,
  composer,
  notice,
}: {
  copy: Copy;
  /** Header presentation and the brand avatar both come off the theme. */
  theme?: BootTheme;
  online: boolean;
  contrastWarning: string | null;
  showBranding: boolean;
  onMinimize(): void;
  onClose(): void;
  overlay?: React.ReactNode;
  children: React.ReactNode;
  composer?: React.ReactNode;
  notice?: string | null;
}) {
  return (
    <div className="n-panel" data-bubbles={theme?.bubble_style ?? 'brand'}>
      {/*
        `data-style` rather than three header components. The difference between solid,
        soft and minimal is entirely which colours are used — the structure, the buttons
        and the accessible names are identical, and three copies of that would drift.
      */}
      <header className="n-header" data-style={theme?.header_style ?? 'solid'}>
        <span className="n-avatar" aria-hidden="true">
          {theme?.brand_avatar_url ? (
            // The customer's own image. `onError` hides it rather than leaving a broken
            // icon in the corner of their chat: the URL points at a server we do not
            // control, and it will eventually 404 without anyone telling us.
            <img
              src={theme.brand_avatar_url}
              alt=""
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <ChatIcon size={14} />
          )}
        </span>
        <div className="n-spread">
          <h1 className="n-header-title">{copy.headerTitle}</h1>
          <p className="n-header-status">
            <span className="n-dot" data-online={online} />
            {online ? copy.headerOnline : copy.headerOffline}
          </p>
        </div>
        <button className="n-icon-button" onClick={onMinimize} aria-label={FIXED.minimize}>
          <MinimizeIcon />
        </button>
        <button className="n-icon-button" onClick={onClose} aria-label={FIXED.close}>
          <CloseIcon />
        </button>
      </header>

      {/*
        Surfaced here rather than in the console on purpose. A console warning
        reaches whoever is debugging the host page; the person who chose an
        unreadable brand colour is looking at the widget.
      */}
      {contrastWarning && <div className="n-warning">{contrastWarning}</div>}

      {children}

      {notice && (
        <div className="n-notice" data-tone="error">
          {notice}
        </div>
      )}
      {composer}
      {showBranding && <div className="n-footer">{copy.poweredBy}</div>}
      {overlay}
    </div>
  );
}
