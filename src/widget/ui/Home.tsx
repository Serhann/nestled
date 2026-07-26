import type { Starter } from '../../types/chat';
import type { Copy } from '../copy';
import { ChatIcon, ChevronIcon } from './icons';

/**
 * What the visitor sees before there is anything to read.
 *
 * Starters are pure configuration: a label, an optional icon and an optional
 * intake form. The widget ships no built-in set, because "what a visitor might
 * want" is the customer's domain and not ours — the pre-tenant build hard-coded
 * one food-delivery company's intents into the product.
 */
export function Home({
  copy,
  online,
  starters,
  busy,
  onStarter,
  onPlainChat,
}: {
  copy: Copy;
  online: boolean;
  starters: Starter[];
  busy: boolean;
  onStarter(starter: Starter): void;
  onPlainChat(): void;
}) {
  return (
    <div className="n-body">
      <div className="n-hero">
        <span className="n-avatar" data-large="true" aria-hidden="true">
          <ChatIcon size={26} />
        </span>
        <p className="n-hero-title">{copy.greeting}</p>
        <p className="n-header-status">
          <span className="n-dot" data-online={online} />
          {online ? copy.headerOnline : copy.headerOffline}
        </p>
      </div>

      <div className="n-bubble-row">
        <div className="n-bubble">{copy.welcomeMessage}</div>
      </div>

      {starters.length > 0 && <p className="n-section-label">{copy.starterHeading}</p>}
      {starters.map((starter) => (
        <button
          key={starter.id}
          className="n-starter"
          disabled={busy}
          onClick={() => onStarter(starter)}
        >
          <span className="n-starter-icon" aria-hidden="true">
            <ChatIcon size={15} />
          </span>
          <span className="n-spread">{starter.label}</span>
          <ChevronIcon />
        </button>
      ))}

      {starters.length > 0 && (
        <button className="n-starter" disabled={busy} onClick={onPlainChat}>
          <span className="n-starter-icon" aria-hidden="true">
            <ChatIcon size={15} />
          </span>
          <span className="n-spread">{copy.starterOther}</span>
          <ChevronIcon />
        </button>
      )}
    </div>
  );
}
