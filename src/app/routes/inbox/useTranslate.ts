import { useCallback, useEffect, useRef, useState } from 'react';
import { translate } from '../../../lib/api/inbox';
import { AGENT_LANGUAGE } from '../../../lib/language';
import type { Message } from '../../../lib/api/types';

/**
 * Live translation for one conversation.
 *
 * Three things here exist because each translation is a metered LLM call against
 * the customer's AI allowance — this is spending their money, one click at a time:
 *
 *   - **Results are cached per message.** A message is translated once. Re-renders,
 *     a new incoming message, toggling off and on again: none of those pay twice.
 *   - **The backlog is capped.** Switching this on in a conversation with two
 *     hundred messages must not fire two hundred billed calls. Only the most
 *     recent `MAX_BACKLOG` visitor messages are translated, and `skipped` reports
 *     how many were left alone so the UI can say so — a cap the agent cannot see
 *     reads as "everything is translated" when it is not.
 *   - **It resets when the conversation changes.** Carrying the toggle into the
 *     next conversation would quietly translate a queue that did not need it.
 *
 * New visitor messages arriving while it is on are translated as they land, which
 * is the whole point: the agent should not have to click after every reply.
 */

/** Most recent visitor messages translated when the toggle goes on. */
const MAX_BACKLOG = 30;

export interface Translation {
  /** The translated text, or the original when `translated` is false. */
  text: string;
  translated: boolean;
  reason?: 'plan_limit' | 'unavailable';
}

export interface TranslationState {
  on: boolean;
  toggle: () => void;
  /** Keyed by message id. Absent means not translated (yet, or capped out). */
  results: Record<string, Translation>;
  /** In flight right now, so a bubble can show a spinner rather than nothing. */
  pending: Set<string>;
  /** Older visitor messages deliberately not translated. */
  skipped: number;
  /** Set when the server refused or could not translate. Shown once, not per bubble. */
  problem: 'plan_limit' | 'unavailable' | null;
}

export function useTranslate(
  workspaceId: string,
  conversationId: string,
  messages: Message[],
): TranslationState {
  const [on, setOn] = useState(false);
  const [results, setResults] = useState<Record<string, Translation>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<TranslationState['problem']>(null);
  /**
   * Ids currently awaiting a response, and ids already settled.
   *
   * Both are refs rather than state, and `results` is deliberately NOT an effect
   * dependency. The first version had it as one, and the bug it caused is a good
   * warning: every completed translation re-ran the effect, whose cleanup cancelled
   * the loop that was still working through the rest of the queue. Only the first
   * message was ever translated, and every later one sat on "translating…" forever,
   * because it had been marked in-flight but its request was never made.
   */
  const inFlight = useRef<Set<string>>(new Set());
  const settled = useRef<Set<string>>(new Set());

  // A different conversation is a different language and a different budget.
  useEffect(() => {
    setOn(false);
    setResults({});
    setPending(new Set());
    setProblem(null);
    inFlight.current = new Set();
    settled.current = new Set();
  }, [conversationId]);

  const visitorMessages = messages.filter((m) => m.sender_type === 'visitor');
  const translatable = visitorMessages.slice(-MAX_BACKLOG);
  const skipped = on ? visitorMessages.length - translatable.length : 0;
  // The dependency: which messages there are, not which array instance holds them.
  const ids = translatable.map((m) => m.id).join(',');

  useEffect(() => {
    if (!on) return;
    let cancelled = false;

    void (async () => {
      // Sequential on purpose. Firing thirty concurrent LLM calls would spike our
      // provider rate limit for a screen the agent reads top to bottom anyway.
      for (const message of translatable) {
        if (cancelled) break;
        if (settled.current.has(message.id) || inFlight.current.has(message.id)) continue;

        // Marked immediately before the request and cleared in `finally`, so a
        // cancelled loop cannot leave an id claimed with no request behind it.
        inFlight.current.add(message.id);
        setPending(new Set(inFlight.current));
        try {
          const res = await translate(workspaceId, message.content, AGENT_LANGUAGE);
          settled.current.add(message.id);
          setResults((prev) => ({
            ...prev,
            [message.id]: { text: res.text, translated: res.translated, reason: res.reason },
          }));
          if (!res.translated && res.reason) {
            setProblem(res.reason);
            // A plan limit will not clear on the next message; stop asking. Anything
            // still unsettled stays untranslated, which the banner explains.
            if (res.reason === 'plan_limit') break;
          }
        } catch {
          // A failed translation leaves the original in place. The bubble shows the
          // message it always showed, which is the correct degradation. Marked
          // settled so a re-render does not retry it in a loop.
          settled.current.add(message.id);
        } finally {
          inFlight.current.delete(message.id);
          setPending(new Set(inFlight.current));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // `translatable` is rebuilt every render; `ids` is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, workspaceId, ids]);

  const toggle = useCallback(() => {
    setOn((v) => !v);
    setProblem(null);
  }, []);

  return { on, toggle, results, pending, skipped, problem };
}
