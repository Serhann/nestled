import { useEffect, useRef } from 'react';
import type { ChatMessage, ContextCard as ContextCardPayload } from '../../types/chat';
import { MessageBubble } from './MessageBubble';
import { ContextCard } from './ContextCard';
import { BotStep, readBotStep } from './BotStep';

/**
 * The scrolling transcript.
 *
 * Auto-scroll is anchored to a sentinel rather than to `scrollHeight`, so it
 * behaves when an image or a context card changes height after paint. It only
 * follows when the visitor is already near the bottom: yanking someone back down
 * while they are reading what an agent said three messages ago is worse than a
 * missed scroll.
 */
export function Thread({
  messages,
  nudge,
  contextCard,
  agentTyping,
  busy,
  botStepsEnabled,
  onBotAnswer,
}: {
  messages: ChatMessage[];
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

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 160) end.current?.scrollIntoView({ block: 'end' });
  }, [messages, agentTyping, contextCard]);

  const last = messages[messages.length - 1];
  const step =
    botStepsEnabled && last && last.sender_type !== 'visitor' ? readBotStep(last.metadata) : null;

  return (
    <div className="n-body" ref={scroller}>
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
