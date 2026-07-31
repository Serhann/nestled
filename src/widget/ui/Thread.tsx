import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatMessage, ContextCard as ContextCardPayload } from '../../types/chat';
import { MessageBubble } from './MessageBubble';
import { ContextCard } from './ContextCard';
import { BotStep, readBotStep } from './BotStep';

/**
 * The scrolling transcript.
 *
 * Auto-scroll follows only when the visitor is already near the bottom — yanking someone
 * back down while they are reading what an agent said three messages ago is worse than a
 * missed scroll — with one exception: a message the VISITOR just sent always scrolls into
 * view. They pressed send; not showing them the result reads as the message not having
 * been sent at all.
 *
 * "Near the bottom" has to be measured BEFORE the new message lands, which is why it lives
 * in a ref updated on scroll rather than being computed in the effect. Computing it in the
 * effect — what this did — measures the DOM that already contains the new bubble, so the
 * bubble's own height counts as distance from the bottom and anything taller than the
 * threshold silently switched auto-scroll off. AI replies are routinely that tall, so the
 * symptom was "it stops scrolling exactly when the interesting messages arrive".
 */

/** Distance from the bottom, in px, still counted as "following the conversation". */
const PINNED_SLACK = 160;

export function Thread({
  messages,
  welcome,
  nudge,
  contextCard,
  agentTyping,
  busy,
  botStepsEnabled,
  onBotAnswer,
}: {
  messages: ChatMessage[];
  /** Shown when there is nothing else in the thread. From the Wording screen. */
  welcome: string;
  nudge: string | null;
  contextCard: ContextCardPayload | null;
  agentTyping: boolean;
  busy: boolean;
  /** False once a human has taken the chat — stale bot choices would mislead. */
  botStepsEnabled: boolean;
  onBotAnswer(text: string): void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Was the visitor at the bottom before this render's content arrived? Starts true so
   *  opening a chat with history lands on the newest message. */
  const pinned = useRef(true);
  /** The newest message we have already scrolled for, so an unrelated re-render does not
   *  re-trigger the visitor's own forced scroll. */
  const lastSeenId = useRef<string | null>(null);

  const toBottom = () => end.current?.scrollIntoView({ block: 'end' });

  const last = messages[messages.length - 1];

  // Layout effect, not effect: scrolling after the browser has painted shows one frame at
  // the old offset, which in a 400px panel is a visible jump.
  useLayoutEffect(() => {
    const ownNewMessage = !!last && last.sender_type === 'visitor' && last.id !== lastSeenId.current;
    lastSeenId.current = last?.id ?? null;
    if (pinned.current || ownNewMessage) toBottom();
  }, [messages, agentTyping, contextCard, last]);

  /**
   * Keep the bottom in view when something changes height after the fact.
   *
   * Two real cases, neither of which the effect above can see: the composer grows a line
   * and steals height from this box, and a bubble reflows once its avatar image loads. The
   * observer watches the scroller (its own box = the viewport) and each child (the
   * content), which between them covers both. Re-subscribed on every message change so new
   * children are picked up.
   */
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [messages, contextCard, agentTyping]);

  const step =
    botStepsEnabled && last && last.sender_type !== 'visitor' ? readBotStep(last.metadata) : null;

  const empty = messages.length === 0 && !nudge && !contextCard;

  return (
    <div
      className="n-body"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_SLACK;
      }}
    >
      {/*
        An open panel with nothing in it.
        
        Four hundred pixels of empty grey was what a visitor saw every time they opened
        a chat on a website with no welcome message and no starters configured — which
        is the default. It reads as broken rather than as ready, and it is the first
        thing anyone sees. `welcomeMessage` is already an editable string on the Wording
        screen, so this needs no new copy key and the customer can change it.
      */}
      {empty && (
        <div className="n-empty">
          <p>{welcome}</p>
        </div>
      )}

      {contextCard && <ContextCard card={contextCard} />}

      {nudge && (
        <div className="n-bubble-row">
          <div className="n-bubble">{nudge}</div>
        </div>
      )}

      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}

      {step && <BotStep step={step} busy={busy} onAnswer={onBotAnswer} />}

      {agentTyping && (
        <div className="n-bubble-row">
          <div className="n-bubble n-typing" aria-label="typing">
            <span />
            <span />
            <span />
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
