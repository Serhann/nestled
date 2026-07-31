import type { KnowledgeItem } from './types.js';

/**
 * Knowledge-base retrieval: which entries get put in front of the model.
 *
 * This is keyword scoring, not embeddings, and that is a deliberate trade for now — but
 * the version this replaced had two failures that no amount of tuning fixes, and both
 * showed up as "the assistant ignores our knowledge base":
 *
 *   1. **It only ever looked at `question` and `keywords`.** An entry whose answer says
 *      "we ship within 3 working days" scored zero for "how many days does shipping
 *      take" unless somebody had thought to list "days" as a keyword.
 *
 *   2. **A near-miss returned NOTHING.** Entries were filtered to `score > 0`, so a
 *      message that matched nothing sent the model a prompt with no knowledge block at
 *      all — and the grounding rule then correctly refused to answer. A customer with
 *      twelve entries watched their assistant say "I'll check with the team" to a
 *      question entry #4 answers verbatim. `selectForPrompt` is the fix: relevance
 *      first, then top up by priority, because the whole small KB in the prompt is
 *      strictly better than an empty one.
 *
 * Matching is also accent- and suffix-tolerant. Turkish is the first language this had to
 * work in beyond English, and it defeats `includes()` twice over: visitors type "fiyati"
 * for "fiyatı", and agglutination means the word in the question ("fiyat") is a *prefix*
 * of the word they typed ("fiyatları"), never a substring of it.
 */

/**
 * Fold case and accents to one comparable form.
 *
 * NFD + combining-mark strip handles é/ü/ş and, usefully, the dotted capital İ — whose
 * JS lowercase is "i" plus a combining dot. `ı` and `ð`/`ø`-style letters carry no
 * combining mark, so the few that matter are mapped by hand.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss');
}

/** Words worth scoring on: folded, punctuation-free, stopword-length excluded. */
function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/** Shortest shared prefix that counts as the same word. Below this, "car"/"carpet" collide. */
const STEM_MIN = 4;

/**
 * Do two words refer to the same thing? True on an exact match, or when one is a prefix
 * of the other and they agree for at least `STEM_MIN` characters — which is what makes
 * "fiyat" match "fiyatları" and "shipping" match "ship" without matching "shine".
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= STEM_MIN && longer.startsWith(shorter);
}

/** How many of `needles` appear in `haystack`, counting each needle at most once. */
function overlap(needles: string[], haystack: string[]): number {
  let hits = 0;
  for (const needle of needles) {
    if (haystack.some((word) => sameWord(needle, word))) hits += 1;
  }
  return hits;
}

/**
 * Relevance of one entry to one message.
 *
 * The weights say what they mean: a phrase match is near-certain, an author-supplied
 * keyword is a strong signal, a word shared with the question is a decent one, and a
 * word shared with the ANSWER is a weak one — it earns an entry a place in the prompt
 * without ever outranking a real question match.
 */
export function scoreEntry(message: string, item: KnowledgeItem): number {
  const messageFolded = fold(message);
  const questionFolded = fold(item.question);
  const messageWords = words(message);
  let score = 0;

  if (questionFolded && (questionFolded.includes(messageFolded) || messageFolded.includes(questionFolded))) {
    score += 5;
  }

  for (const keyword of item.keywords) {
    const folded = fold(keyword).trim();
    if (!folded) continue;
    // Multi-word keywords are phrases; single words go through stem matching so a
    // keyword of "kargo" is found in "kargonuz".
    const hit = folded.includes(' ')
      ? messageFolded.includes(folded)
      : messageWords.some((word) => sameWord(word, folded));
    if (hit) score += 2;
  }

  score += overlap(messageWords, words(item.question)) * 1;
  // Capped: a long answer shares incidental words with everything, and uncapped this
  // would rank the wordiest entry first for every message.
  score += Math.min(overlap(messageWords, words(item.answer)), 4) * 0.5;
  score += overlap(messageWords, words(item.category)) * 0.5;

  // Zero means "did not match", and callers rely on that: `topRelevant` filters on it and
  // `keywordAnswer` decides whether it has an answer at all from it. So the priority
  // tiebreak is added only to an entry that ALREADY matched. Adding it unconditionally —
  // as this did — gave every entry with a non-zero priority a floor of 0.1, which made
  // every entry match every message: the keyword provider answered "what is the capital of
  // France" with the shipping policy, and a genuine no-match was indistinguishable from a
  // weak hit.
  if (score === 0) return 0;
  score += Math.min(item.priority, 3) * 0.1;
  return score;
}

/** Entries that genuinely match, best first. Empty when nothing does. */
export function topRelevant(message: string, items: KnowledgeItem[], limit = 5): KnowledgeItem[] {
  return items
    .map((item) => ({ item, score: scoreEntry(message, item) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

/**
 * What goes in the prompt: the matches, then the highest-priority remaining entries to
 * fill the slots.
 *
 * The padding is the point. Retrieval missing is normal — a follow-up, a typo, a phrasing
 * nobody anticipated — and the cost of a near-miss must be "the model has a few entries
 * that turned out not to help", not "the model has nothing and must refuse". For a KB
 * smaller than `limit` this hands over all of it, which is the correct answer for most
 * customers.
 */
export function selectForPrompt(message: string, items: KnowledgeItem[], limit = 8): KnowledgeItem[] {
  const matched = topRelevant(message, items, limit);
  if (matched.length >= limit) return matched;

  const chosen = new Set(matched);
  const padding = items
    .filter((item) => !chosen.has(item))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit - matched.length);
  return [...matched, ...padding];
}

/** Pure keyword fallback answer (no LLM). Used by the knowledge_base provider. */
export function keywordAnswer(message: string, items: KnowledgeItem[]): string {
  // Strict matching on purpose: with no model to judge relevance, answering off a
  // padded-in entry would confidently reply to a question nobody asked.
  const best = topRelevant(message, items, 1)[0];
  if (best) return best.answer;

  const messageFolded = fold(message);
  const greetings = ['hi', 'hello', 'hey', 'merhaba', 'selam'];
  if (greetings.some((g) => messageFolded.includes(g))) {
    return 'Hello! How can I help you today?';
  }
  return "I'm here to help! Could you please provide more details about your question?";
}

/** Characters of knowledge base allowed in one prompt. Whole entries are dropped, never cut. */
export const MAX_KNOWLEDGE_CHARS = 8000;

/**
 * Compact the retrieved entries into a Q/A context block for the system prompt.
 *
 * Truncates by dropping trailing (lowest-ranked) entries rather than cutting mid-answer:
 * half a refund policy in the prompt is worse than not having it, because the model will
 * quote the half it can see.
 */
export function buildContext(items: KnowledgeItem[]): string {
  const blocks: string[] = [];
  let total = 0;
  for (const item of items) {
    const block = `Q: ${item.question}\nA: ${item.answer}`;
    if (blocks.length > 0 && total + block.length > MAX_KNOWLEDGE_CHARS) break;
    blocks.push(block);
    total += block.length + 2;
  }
  return blocks.join('\n\n');
}
