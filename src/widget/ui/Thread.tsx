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

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 160) end.current?.scrollIntoView({ block: 'end' });
  }, [messages, agentTyping, contextCard]);

  const last = messages[messages.length - 1];
  const step =
    botStepsEnabled && last && last.sender_type !== 'visitor' ? readBotStep(last.metadata) : null;

  const empty = messages.length === 0 && !nudge && !contextCard;

  return (
    <div className="n-body" ref={scroller}>
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
