import type { KnowledgeItem } from './types.js';

/**
 * Keyword scoring, ported from the old edge function but used for *retrieval*
 * rather than answer selection: we pick the top-N relevant entries to put in
 * the LLM prompt instead of stuffing the entire knowledge base. Phase 7 may
 * replace this with BM25 or pgvector embeddings.
 */
export function scoreEntry(message: string, item: KnowledgeItem): number {
  const messageLower = message.toLowerCase();
  const questionLower = item.question.toLowerCase();
  let score = 0;

  if (questionLower.includes(messageLower) || messageLower.includes(questionLower)) {
    score += 5;
  }
  for (const keyword of item.keywords) {
    if (keyword && messageLower.includes(keyword.toLowerCase())) score += 2;
  }
  for (const word of messageLower.split(/\s+/)) {
    if (word.length > 3 && questionLower.includes(word)) score += 1;
  }
  // Small tiebreak by editorial priority.
  score += Math.min(item.priority, 3) * 0.1;
  return score;
}

/** Return the most relevant entries (default top 5), best first. */
export function topRelevant(message: string, items: KnowledgeItem[], limit = 5): KnowledgeItem[] {
  return items
    .map((item) => ({ item, score: scoreEntry(message, item) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

/** Pure keyword fallback answer (no LLM). Used by the knowledge_base provider. */
export function keywordAnswer(message: string, items: KnowledgeItem[]): string {
  const best = topRelevant(message, items, 1)[0];
  if (best) return best.answer;

  const messageLower = message.toLowerCase();
  const greetings = ['hi', 'hello', 'hey'];
  if (greetings.some((g) => messageLower.includes(g))) {
    return 'Hello! How can I help you today?';
  }
  return "I'm here to help! Could you please provide more details about your question?";
}

/** Compact the retrieved entries into a Q/A context block for the system prompt. */
export function buildContext(items: KnowledgeItem[]): string {
  return items.map((i) => `Q: ${i.question}\nA: ${i.answer}`).join('\n\n');
}
