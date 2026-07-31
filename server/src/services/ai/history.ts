import type { AITurn } from './types.js';

/**
 * Turning a transcript into the turns a provider is sent.
 *
 * This file exists because the assistant used to be given exactly one message — the
 * visitor's latest — and nothing else. Every reply was therefore the first reply: it
 * re-asked for the email address the visitor had just typed, answered "why?" as if it
 * were the opening question, and contradicted what it had said two lines earlier. The
 * transcript was in the database the whole time; nobody was reading it.
 *
 * The rules below are not stylistic. Each one is a shape the Messages API rejects or a
 * provider quietly mangles:
 *
 *   - the list must START with a user turn — a conversation whose first line is the
 *     assistant's greeting (which is every `first_message` install) otherwise 400s;
 *   - two turns of the SAME role may not sit next to each other, and they routinely
 *     would: a visitor typing three lines in a row, or the bot posting a message and
 *     then a question;
 *   - it must END with the message being answered, so the model replies to that rather
 *     than continuing its own last sentence.
 *
 * Doing this once, here, is what lets all three provider adapters stay dumb.
 */

/** How many transcript rows to consider. Support chats are short; this is a ceiling, not a target. */
export const MAX_HISTORY_MESSAGES = 30;

/**
 * Character budget for the transcript, oldest dropped first. A cap rather than a token
 * count on purpose: the exact number matters far less than the guarantee that one
 * visitor pasting a stack trace cannot push the knowledge base out of the prompt.
 */
export const MAX_HISTORY_CHARS = 6000;

export interface TranscriptRow {
  sender_type: string;
  content: string;
}

/**
 * Map one stored message to a turn.
 *
 * `agent` and `bot` both become `assistant`, unlabelled. The model is standing in for
 * one support voice, and marking which lines a human wrote would invite it to disown
 * them ("my colleague said…") in the middle of a handoff-free conversation.
 *
 * `system` rows are internal notes — handoff reasons, "conversation resolved" markers.
 * They are addressed to the team, not the visitor, and are dropped.
 */
function roleOf(senderType: string): AITurn['role'] | null {
  if (senderType === 'visitor') return 'user';
  if (senderType === 'agent' || senderType === 'ai' || senderType === 'bot') return 'assistant';
  return null;
}

/**
 * The full turn list to send, oldest first, ending with `currentMessage`.
 *
 * `rows` are the conversation's messages in chronological order. `currentMessage` is the
 * text being answered — normally the last visitor row (the caller has already written it
 * before asking for a reply), but for a bot flow's `ai_answer` node it is the author's
 * question and appears nowhere in the transcript. Both cases land correctly: the trailing
 * duplicate is recognised and not repeated, and an absent one is appended.
 */
export function buildTurns(rows: TranscriptRow[], currentMessage: string): AITurn[] {
  const turns: AITurn[] = [];
  for (const row of rows) {
    const role = roleOf(row.sender_type);
    const content = row.content?.trim();
    if (!role || !content) continue;
    turns.push({ role, content });
  }

  // The message being answered is usually already the last row. Appending it again would
  // show the visitor asking the same thing twice and invite "as I said above".
  const last = turns[turns.length - 1];
  if (!(last && last.role === 'user' && last.content === currentMessage.trim())) {
    const content = currentMessage.trim();
    if (content) turns.push({ role: 'user', content });
  }

  return trimToBudget(mergeAdjacent(turns));
}

/** Join runs of same-role turns, so the result strictly alternates. */
function mergeAdjacent(turns: AITurn[]): AITurn[] {
  const out: AITurn[] = [];
  for (const turn of turns) {
    const prev = out[out.length - 1];
    if (prev && prev.role === turn.role) {
      prev.content = `${prev.content}\n${turn.content}`;
    } else {
      out.push({ ...turn });
    }
  }
  return out;
}

/**
 * Keep the newest turns that fit, then re-establish the "starts with user" invariant —
 * dropping a turn can expose a leading assistant turn that was legal a moment ago.
 */
function trimToBudget(turns: AITurn[]): AITurn[] {
  const kept = turns.slice(-MAX_HISTORY_MESSAGES);

  let total = kept.reduce((sum, t) => sum + t.content.length, 0);
  while (kept.length > 1 && total > MAX_HISTORY_CHARS) {
    const [dropped] = kept.splice(0, 1);
    total -= dropped?.content.length ?? 0;
  }

  while (kept[0]?.role === 'assistant') kept.splice(0, 1);

  // A single turn over budget is truncated rather than dropped: dropping it would leave
  // nothing to answer.
  const only = kept.length === 1 ? kept[0] : undefined;
  if (only && only.content.length > MAX_HISTORY_CHARS) {
    only.content = `${only.content.slice(0, MAX_HISTORY_CHARS)}…`;
  }
  return kept;
}

/**
 * The text knowledge-base retrieval is run against.
 *
 * Deliberately NOT just the latest message. Retrieval on "peki iadesi?" or "how much?"
 * finds nothing on its own, so the prompt arrived with an empty knowledge block and the
 * grounding rule turned a perfectly answerable follow-up into "I'll check with the team".
 * Widening the query to the last few things the visitor said is what makes a follow-up
 * retrieve what its own subject retrieved.
 *
 * Only the visitor's words. Including the assistant's would let one wrong retrieval feed
 * itself: it answers off a mismatched entry, that answer's wording then scores the same
 * entry up, and the conversation locks onto it.
 */
export function retrievalQuery(turns: AITurn[], currentMessage: string, lookback = 3): string {
  const userTurns = turns.filter((t) => t.role === 'user').slice(-lookback);
  const parts = userTurns.map((t) => t.content);
  const current = currentMessage.trim();
  if (current && !parts.includes(current)) parts.push(current);
  return parts.join('\n');
}
