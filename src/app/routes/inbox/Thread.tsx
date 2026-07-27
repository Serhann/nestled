import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Languages, Sparkles, User } from 'lucide-react';
import { Markdown } from '../../../lib/markdown';
import { relative } from './ConversationList';
import type { TranslationState } from './useTranslate';
import type { Message } from '../../../lib/api/types';

/**
 * The message thread.
 *
 * `aria-live="polite"` on the list is what makes an incoming message announced
 * rather than silently appearing — for an agent using a screen reader, a chat
 * transcript without it is unusable.
 */
export function Thread({
  messages,
  visitorTyping,
  translation,
}: {
  messages: Message[];
  visitorTyping: boolean;
  translation?: TranslationState;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    // Only auto-scroll if the agent was already at the bottom. Yanking them down
    // while they are reading back through the history is worse than a missed
    // scroll.
    if (pinnedToBottom.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, visitorTyping]);

  return (
    <div
      ref={container}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      {translation?.on && translation.skipped > 0 && (
        <p className="text-center text-[11px] text-gray-400 py-1">
          The {translation.skipped} older message{translation.skipped === 1 ? '' : 's'} above{' '}
          {translation.skipped === 1 ? 'was' : 'were'} left untranslated.
        </p>
      )}
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          translation={translation?.results[message.id]}
          translating={translation?.pending.has(message.id) ?? false}
        />
      ))}
      {visitorTyping && (
        <div className="flex gap-2 items-end">
          <Avatar type="visitor" />
          <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
            <span className="flex gap-1" aria-label="The visitor is typing">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </span>
          </div>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}

export function MessageBubble({
  message,
  translation,
  translating,
}: {
  message: Message;
  /** Present only when this message has been through the translator. */
  translation?: { text: string; translated: boolean };
  translating?: boolean;
}) {
  const fromUs = message.sender_type !== 'visitor';
  const system = message.sender_type === 'system';
  // Default to the translation when there is one, because that is what the agent
  // switched it on to read. The original stays one click away — an agent chasing a
  // reference number or a name needs the words the customer actually typed, and a
  // translation that hides them is worse than none.
  const [showOriginal, setShowOriginal] = useState(false);
  const translated = translation?.translated ? translation : null;
  const body = translated && !showOriginal ? translated.text : message.content;

  if (system) {
    return (
      <p className="text-center text-[11px] text-gray-400 py-1">{message.content}</p>
    );
  }

  return (
    <div className={`flex gap-2 items-end ${fromUs ? 'flex-row-reverse' : ''}`}>
      <Avatar type={message.sender_type} />
      <div className={`max-w-[75%] ${fromUs ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}>
        <div
          className={`px-4 py-2.5 text-sm shadow-sm ${
            fromUs
              ? 'bg-blue-600 text-white rounded-2xl rounded-br-md'
              : 'bg-white text-gray-800 border border-gray-100 rounded-2xl rounded-bl-md'
          }`}
        >
          <Markdown text={body} />
        </div>
        <span className="text-[10px] text-gray-400 px-1 flex items-center gap-1.5 flex-wrap">
          <span>
            {message.sender_name ?? label(message.sender_type)} · {relative(message.created_at)}
          </span>
          {translating && (
            <span className="inline-flex items-center gap-1 text-gray-400">
              <Languages className="w-3 h-3 animate-pulse" aria-hidden />
              translating…
            </span>
          )}
          {translated && (
            <button
              onClick={() => setShowOriginal((v) => !v)}
              className="inline-flex items-center gap-1 text-blue-700 hover:underline"
            >
              <Languages className="w-3 h-3" aria-hidden />
              {showOriginal ? 'show translation' : 'translated · show original'}
            </button>
          )}
          {/*
            Delivery, and only where it can actually fail. A reply that bounced is the
            one thing an agent must not miss: they will move on believing they
            answered, and the customer is waiting for a message that does not exist.
          */}
          {message.delivery_status === 'failed' && (
            <span
              className="inline-flex items-center gap-1 text-red-700 font-medium"
              title={message.delivery_error ?? undefined}
            >
              <AlertTriangle className="w-3 h-3" aria-hidden />
              not delivered
            </span>
          )}
          {message.delivery_status === 'pending' && (
            <span className="inline-flex items-center gap-1 text-gray-400">sending…</span>
          )}
        </span>
      </div>
    </div>
  );
}

function Avatar({ type }: { type: Message['sender_type'] }) {
  const styles: Record<string, string> = {
    visitor: 'bg-gray-200 text-gray-600',
    agent: 'bg-blue-100 text-blue-700',
    ai: 'bg-violet-100 text-violet-700',
    bot: 'bg-green-100 text-green-700',
    system: 'bg-gray-100 text-gray-400',
  };
  const Icon = type === 'ai' ? Sparkles : type === 'bot' ? Bot : User;
  return (
    <span
      className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center ${styles[type] ?? styles.visitor}`}
      aria-hidden
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

function label(type: Message['sender_type']): string {
  return type === 'ai' ? 'AI' : type === 'bot' ? 'Bot' : type === 'agent' ? 'Agent' : 'Visitor';
}
