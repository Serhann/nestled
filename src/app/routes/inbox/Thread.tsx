import { useEffect, useRef } from 'react';
import { Bot, Sparkles, User } from 'lucide-react';
import { Markdown } from '../../../lib/markdown';
import { relative } from './ConversationList';
import type { Message } from '../../../lib/api/types';

/**
 * The message thread.
 *
 * `aria-live="polite"` on the list is what makes an incoming message announced
 * rather than silently appearing — for an agent using a screen reader, a chat
 * transcript without it is unusable.
 */
export function Thread({ messages, visitorTyping }: { messages: Message[]; visitorTyping: boolean }) {
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
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
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

export function MessageBubble({ message }: { message: Message }) {
  const fromUs = message.sender_type !== 'visitor';
  const system = message.sender_type === 'system';

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
          <Markdown text={message.content} />
        </div>
        <span className="text-[10px] text-gray-400 px-1">
          {message.sender_name ?? label(message.sender_type)} · {relative(message.created_at)}
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
