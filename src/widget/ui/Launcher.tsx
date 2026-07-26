import type { BootTheme } from '../../types/chat';
import { ChatIcon } from './icons';

/**
 * The closed state.
 *
 * Centred in its own box rather than anchored: when embedded, the host iframe is
 * only a little larger than the button (see embed.js), so centring is what keeps
 * the drop shadow from being clipped into a square. Anchoring happens on the
 * host side, where the iframe itself is positioned.
 */
export function Launcher({
  theme,
  label,
  unread,
  onOpen,
}: {
  theme: BootTheme | undefined;
  label: string;
  unread: number;
  onOpen(): void;
}) {
  const style = theme?.launcher_style === 'pill' ? 'pill' : 'bubble';
  return (
    <button className="n-launcher" data-style={style} onClick={onOpen} aria-label={label}>
      <ChatIcon />
      {style === 'pill' && <span>{label}</span>}
      {unread > 0 && (
        <span className="n-badge" aria-label={`${unread} unread`}>
          {unread}
        </span>
      )}
    </button>
  );
}
