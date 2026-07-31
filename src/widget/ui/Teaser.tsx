// The widget ships its own icons rather than lucide: this bundle is 42kB and loads on a
// stranger's website, so an icon library for one glyph is not a trade worth making.
import { CloseIcon } from './icons';

/**
 * A campaign's message, shown above the CLOSED launcher.
 *
 * Without this a proactive message had nowhere to be seen. The nudge is drawn by `Thread`,
 * which lives inside the panel — so the only way a visitor ever read a campaign was if the
 * campaign also forced the panel open, and a chat window that opens itself over somebody's
 * shopping is the interruption everyone hates. This is the other half: the message sits in
 * the corner next to the bubble, the visitor reads it in place, and opening the chat is
 * their decision.
 *
 * The whole bubble is the open button, because the message is the invitation — asking
 * someone to read a sentence and then find a separate control to answer it is a step that
 * loses most of them. `aria-label` carries the intent, since the visible text is the
 * customer's sentence and not a description of what clicking does.
 *
 * Dismiss is a real requirement, not a courtesy: this box sits over the corner of somebody
 * else's website, and the visitor must be able to get rid of it without starting a
 * conversation. It is a `<button>` inside a `<button>`'s sibling rather than nested, which
 * is invalid HTML and swallows the outer click in some browsers.
 */
export function Teaser({
  message,
  avatarUrl,
  onOpen,
  onDismiss,
}: {
  message: string;
  avatarUrl: string | null;
  onOpen(): void;
  onDismiss(): void;
}) {
  return (
    <div className="n-teaser">
      <button className="n-teaser-body" onClick={onOpen} aria-label={`Open chat: ${message}`}>
        {avatarUrl && (
          // The same picture the panel header and the launcher use. Hidden on error rather
          // than left as a broken image: the URL points at a server we do not control.
          <img
            className="n-teaser-avatar"
            src={avatarUrl}
            alt=""
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        )}
        <span className="n-teaser-text">{message}</span>
      </button>
      <button className="n-teaser-close" onClick={onDismiss} aria-label="Dismiss">
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
