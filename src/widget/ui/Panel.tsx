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
    <div className="n-panel">
      <header className="n-header">
        <span className="n-avatar" aria-hidden="true">
          <ChatIcon size={14} />
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
