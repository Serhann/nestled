import type { ChatMessage } from '../../types/chat';
import { FIXED } from '../copy';

/**
 * One message.
 *
 * The inline formatter below is deliberately tiny and produces React elements
 * only — never `dangerouslySetInnerHTML`. Agent and AI text is authored by a
 * human on the other side of a text box, so it is untrusted input as far as this
 * component is concerned; the safe way to support **bold** and links is to build
 * nodes, not to parse HTML.
 */

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+)/g;

function format(text: string): React.ReactNode[] {
  return text.split(TOKEN).map((part, index) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;

    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer noopener">
          {link[1]}
        </a>
      );
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={index} href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>
      );
    }
    return part;
  });
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const own = message.sender_type === 'visitor';
  const isAi = message.sender_type === 'ai' || message.sender_type === 'bot';
  const name = message.metadata?.agent?.name || (isAi ? FIXED.aiLabel : FIXED.agentLabel);
  const avatar = message.metadata?.agent?.avatar_url;

  return (
    <div className="n-bubble-row" data-own={own}>
      {!own &&
        (avatar ? (
          <img className="n-avatar" src={avatar} alt="" />
        ) : (
          <span className="n-avatar" aria-hidden="true">
            {name.charAt(0).toUpperCase()}
          </span>
        ))}
      <div className="n-spread">
        <div className="n-bubble" data-own={own}>
          {format(message.content)}
        </div>
        <div className="n-meta" style={own ? { textAlign: 'right' } : undefined}>
          {own ? time(message.created_at) : `${name} · ${time(message.created_at)}`}
        </div>
      </div>
    </div>
  );
}
