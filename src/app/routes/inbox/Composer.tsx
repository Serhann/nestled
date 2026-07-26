import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { listCanned, sendTyping } from '../../../lib/api/inbox';
import { qk } from '../../../lib/queryKeys';
import { useAppStore } from '../../store';
import { Button } from '../../../ui/Button';

/**
 * The reply box.
 *
 * Three behaviours it must get right:
 *
 * - **The draft survives navigation.** Agents switch conversations constantly;
 *   losing a half-written reply to a click is the fastest way to make a tool feel
 *   hostile. Drafts live in the client store, keyed by conversation.
 * - **Typing is throttled.** It fires on the first keystroke and then at most
 *   every few seconds, not on every character.
 * - **`/shortcut` expands a canned response** without leaving the keyboard.
 */
const TYPING_THROTTLE_MS = 3000;

export function Composer({
  workspaceId,
  conversationId,
  onSend,
  sending,
  disabled,
}: {
  workspaceId: string;
  conversationId: string;
  onSend: (content: string) => void;
  sending: boolean;
  disabled?: boolean;
}) {
  const draft = useAppStore((s) => s.drafts[conversationId] ?? '');
  const setDraft = useAppStore((s) => s.setDraft);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastTypingAt = useRef(0);

  const canned = useQuery({
    queryKey: qk.canned(workspaceId),
    queryFn: () => listCanned(workspaceId),
    staleTime: 5 * 60_000,
  });

  // A conversation change means a different draft; keep the box in sync and the
  // caret at the end of what was already typed.
  useEffect(() => {
    const el = textarea.current;
    if (el) el.style.height = 'auto';
  }, [conversationId]);

  const shortcutQuery = draft.startsWith('/') ? draft.slice(1).toLowerCase() : null;
  const matches =
    shortcutQuery !== null
      ? (canned.data?.items ?? []).filter((c) => c.shortcut.startsWith(shortcutQuery)).slice(0, 6)
      : [];

  const submit = () => {
    const value = draft.trim();
    if (!value || sending) return;
    onSend(value);
  };

  return (
    <div className="border-t border-gray-100 bg-cream p-3">
      {matches.length > 0 && (
        <ul className="mb-2 rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          {matches.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => {
                  setDraft(conversationId, item.content);
                  textarea.current?.focus();
                }}
                className="w-full text-left px-3 py-2 hover:bg-gray-50"
              >
                <span className="text-xs font-semibold text-blue-700">/{item.shortcut}</span>
                <span className="block text-xs text-gray-600 truncate">{item.content}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textarea}
          value={draft}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? 'You can’t reply to this conversation' : 'Write a reply… (/ for canned replies)'}
          aria-label="Reply"
          onChange={(e) => {
            setDraft(conversationId, e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            const now = Date.now();
            if (now - lastTypingAt.current > TYPING_THROTTLE_MS) {
              lastTypingAt.current = now;
              sendTyping(workspaceId, conversationId, true);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline. The reverse is what chat
            // products that feel like email get wrong.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="flex-1 resize-none rounded-2xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:bg-gray-50"
        />
        <Button onClick={submit} busy={sending} disabled={disabled || !draft.trim()} aria-label="Send">
          <Send className="w-4 h-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
