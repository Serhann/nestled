import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGES,
  buildTurns,
  retrievalQuery,
} from '../services/ai/history.js';
import {
  MAX_KNOWLEDGE_CHARS,
  buildContext,
  keywordAnswer,
  scoreEntry,
  selectForPrompt,
  topRelevant,
} from '../services/ai/knowledge.js';
import { systemWithContext } from '../services/ai/prompt.js';
import { HANDOFF_ONLY } from '../services/ai/actions.js';
import type { AISettings, KnowledgeItem } from '../services/ai/types.js';

/**
 * What the assistant is actually told.
 *
 * Two bugs are pinned here, both of which read to a customer as "the AI ignores us":
 *
 *   - it was sent ONE message and no transcript, so every reply was a first reply;
 *   - a knowledge-base near-miss sent it an EMPTY knowledge block, and the grounding rule
 *     then correctly refused to answer a question the KB answers verbatim.
 *
 * All pure functions — no database, no provider. That is the point: this is where the
 * feature is either right or subtly wrong, and a test that needs Postgres to prove the
 * transcript reaches the model is a test nobody runs while editing retrieval.
 */

const settings: AISettings = {
  ai_provider: 'anthropic',
  ai_model: 'claude-opus-4-8',
  system_prompt: 'You work for Kahve A.Ş., which sells coffee beans.',
  anthropic_api_key: 'k',
  openai_api_key: null,
  openai_model: 'gpt-4o-mini',
  ollama_url: null,
  ollama_model: 'llama3',
};

function entry(over: Partial<KnowledgeItem>): KnowledgeItem {
  return {
    question: 'q',
    answer: 'a',
    category: 'general',
    keywords: [],
    priority: 0,
    ...over,
  };
}

// ── The transcript reaches the model ─────────────────────────────────────────

test('the conversation is sent, not just the latest message', () => {
  const turns = buildTurns(
    [
      { sender_type: 'visitor', content: 'do you ship to Izmir?' },
      { sender_type: 'ai', content: 'Yes, next-day.' },
      { sender_type: 'visitor', content: 'how much?' },
    ],
    'how much?',
  );
  assert.deepEqual(turns, [
    { role: 'user', content: 'do you ship to Izmir?' },
    { role: 'assistant', content: 'Yes, next-day.' },
    { role: 'user', content: 'how much?' },
  ]);
});

test('the message being answered is not repeated when it is already the last row', () => {
  // The caller writes the visitor's message before asking for a reply, so it IS the last
  // row. Appending it again would show the visitor asking twice.
  const turns = buildTurns([{ sender_type: 'visitor', content: 'hello' }], 'hello');
  assert.deepEqual(turns, [{ role: 'user', content: 'hello' }]);
});

test('a bot flow question that is not in the transcript is appended', () => {
  // `ai_answer` passes the flow author's question, which was never posted as a message.
  const turns = buildTurns(
    [
      { sender_type: 'bot', content: 'Hi! What can I help with?' },
      { sender_type: 'visitor', content: 'shipping' },
    ],
    'How long does delivery take?',
  );
  // Merged into the visitor's own last turn rather than added after it — two user turns in
  // a row is the shape the Messages API rejects — but the question is what the model reads
  // last either way.
  assert.equal(turns.at(-1)?.role, 'user');
  assert.match(turns.at(-1)!.content, /How long does delivery take\?$/);
  assert.match(turns.at(-1)!.content, /shipping/);
});

test('a priority is a tiebreak between matches, not a match of its own', () => {
  // Every entry used to score at least 0.1 as long as somebody had set a priority, so
  // "did this match?" was always yes — the keyword provider answered an unrelated question
  // with its highest-priority entry, and no-match looked exactly like a weak hit.
  const items = [entry({ question: 'Kargo ne kadar sürer?', answer: '2 iş günü.', priority: 9 })];
  assert.equal(scoreEntry('what is the capital of France', items[0]!), 0);
  assert.deepEqual(topRelevant('what is the capital of France', items), []);
});

test('the turns always start with the visitor', () => {
  // Every `first_message` install opens with the assistant's greeting, and the Messages
  // API rejects a conversation that starts with an assistant turn.
  const turns = buildTurns(
    [
      { sender_type: 'ai', content: 'Welcome to Kahve A.Ş.!' },
      { sender_type: 'visitor', content: 'are you open on Sunday?' },
    ],
    'are you open on Sunday?',
  );
  assert.equal(turns[0]?.role, 'user');
  assert.equal(turns.length, 1);
});

test('roles strictly alternate however the transcript ran', () => {
  const turns = buildTurns(
    [
      { sender_type: 'visitor', content: 'hi' },
      { sender_type: 'visitor', content: 'still there?' },
      { sender_type: 'bot', content: 'One moment.' },
      { sender_type: 'agent', content: 'Hello, Ayşe here.' },
      { sender_type: 'visitor', content: 'my order is late' },
    ],
    'my order is late',
  );
  for (let i = 1; i < turns.length; i += 1) {
    assert.notEqual(turns[i]?.role, turns[i - 1]?.role, 'two turns of the same role in a row');
  }
  assert.equal(turns[0]?.content, 'hi\nstill there?');
  assert.equal(turns[1]?.content, 'One moment.\nHello, Ayşe here.');
});

test('internal system notes and empty messages are left out', () => {
  const turns = buildTurns(
    [
      { sender_type: 'visitor', content: 'refund please' },
      { sender_type: 'system', content: 'Handed off to a human — AI reply quota reached' },
      { sender_type: 'ai', content: '   ' },
    ],
    'refund please',
  );
  assert.deepEqual(turns, [{ role: 'user', content: 'refund please' }]);
});

test('a long conversation is trimmed from the oldest end and still starts with the visitor', () => {
  const rows = Array.from({ length: MAX_HISTORY_MESSAGES * 2 }, (_, i) => ({
    sender_type: i % 2 === 0 ? 'visitor' : 'ai',
    content: `${i % 2 === 0 ? 'visitor' : 'assistant'} message ${i}`,
  }));
  const turns = buildTurns(rows, 'and one more thing');
  assert.ok(turns.length <= MAX_HISTORY_MESSAGES + 1);
  assert.equal(turns[0]?.role, 'user');
  assert.equal(turns.at(-1)?.content, 'and one more thing');
  assert.ok(turns.some((t) => t.content.includes(`message ${MAX_HISTORY_MESSAGES * 2 - 1}`)));
  assert.ok(!turns.some((t) => t.content.includes('message 0')));
});

test('one enormous message is truncated rather than dropped', () => {
  const turns = buildTurns([], 'x'.repeat(MAX_HISTORY_CHARS * 2));
  assert.equal(turns.length, 1);
  assert.ok(turns[0]!.content.length <= MAX_HISTORY_CHARS + 1);
});

// ── Retrieval runs over the visitor's recent words ───────────────────────────

test('a follow-up retrieves against its own subject too', () => {
  const turns = buildTurns(
    [
      { sender_type: 'visitor', content: 'what is your refund policy?' },
      { sender_type: 'ai', content: '14 days.' },
      { sender_type: 'visitor', content: 'and for sale items?' },
    ],
    'and for sale items?',
  );
  const query = retrievalQuery(turns, 'and for sale items?');
  assert.match(query, /refund policy/);
  assert.match(query, /sale items/);
  // The assistant's own wording is excluded: otherwise one wrong retrieval scores itself
  // up on the next turn and the conversation locks onto it.
  assert.doesNotMatch(query, /14 days/);
});

// ── The knowledge base actually reaches the prompt ───────────────────────────

test('a near-miss still sends the knowledge base', () => {
  // The reported bug. None of these entries keyword-match the question, and the old
  // retrieval therefore sent an empty knowledge block — after which the grounding rule
  // refused to answer something entry #2 answers outright.
  const items = [
    entry({ question: 'Kargo ne kadar sürer?', answer: '2 iş günü.' }),
    entry({ question: 'Hafta sonu açık mısınız?', answer: 'Cumartesi 10-18, Pazar kapalı.' }),
    entry({ question: 'Hangi ödeme yöntemleri var?', answer: 'Kart ve havale.' }),
  ];
  const selected = selectForPrompt('pazar günü çalışıyor musunuz', items);
  assert.equal(selected.length, 3, 'the whole small KB should go in the prompt');
  assert.match(buildContext(selected), /Cumartesi 10-18/);
});

test('padding is by priority and never displaces a real match', () => {
  const match = entry({ question: 'How do I reset my password?', priority: 0 });
  const items = [
    entry({ question: 'unrelated one', priority: 9 }),
    match,
    entry({ question: 'unrelated two', priority: 8 }),
    entry({ question: 'unrelated three', priority: 1 }),
  ];
  const selected = selectForPrompt('password reset', items, 3);
  assert.equal(selected[0], match, 'the match must be first');
  assert.deepEqual(
    selected.slice(1).map((i) => i.question),
    ['unrelated one', 'unrelated two'],
  );
});

test('an entry is found by the wording of its answer', () => {
  // Nobody thinks to add "days" as a keyword to "What is your shipping time?".
  const items = [
    entry({ question: 'What is your shipping time?', answer: 'Orders arrive in 3 working days.' }),
    entry({ question: 'Do you have a shop?', answer: 'Yes, in Kadıköy.' }),
  ];
  const ranked = topRelevant('how many working days for an order', items);
  assert.equal(ranked[0]?.question, 'What is your shipping time?');
});

test('Turkish suffixes and missing diacritics still match', () => {
  const item = entry({ question: 'Fiyat listesi nerede?', answer: 'Sitede.', keywords: ['kargo'] });
  // Agglutination: the entry's word is a PREFIX of the visitor's, never a substring of it.
  assert.ok(scoreEntry('fiyatlarınız nedir', [item][0]!) > 0, 'suffixed form should match');
  // Typed without diacritics, as most visitors do.
  assert.ok(scoreEntry('fiyat listesi nerede', item) > 0);
  assert.ok(scoreEntry('kargonuz ne zaman gelir', item) > 0, 'keyword should match a suffixed form');
});

test('stem matching does not fire on a short shared prefix', () => {
  const item = entry({ question: 'Do you sell carpet?', answer: 'Yes.' });
  assert.equal(scoreEntry('where is my car', item), 0);
});

test('the no-LLM keyword answer stays strict', () => {
  // Padding is for the model, which can judge relevance. The keyword provider cannot, so
  // it must say "tell me more" rather than confidently answer a different question.
  const items = [entry({ question: 'Kargo ne kadar sürer?', answer: '2 iş günü.', priority: 9 })];
  assert.match(keywordAnswer('what is the capital of France', items), /more details/);
  assert.equal(keywordAnswer('kargo ne kadar sürer', items), '2 iş günü.');
});

test('a huge knowledge base cannot push everything else out of the prompt', () => {
  const items = Array.from({ length: 40 }, (_, i) =>
    entry({ question: `q${i}`, answer: 'a'.repeat(1000) }),
  );
  const context = buildContext(items);
  assert.ok(context.length <= MAX_KNOWLEDGE_CHARS + 1100, `context was ${context.length}`);
  assert.match(context, /^Q: q0/);
});

// ── The assembled prompt ─────────────────────────────────────────────────────

test('the system prompt carries knowledge even when retrieval matched nothing', () => {
  const prompt = systemWithContext({
    message: 'zzzzz qqqqq',
    settings,
    knowledge: [entry({ question: 'Do you roast in-house?', answer: 'Yes, weekly.' })],
    preamble: 'You are the first-line support assistant.',
    actions: HANDOFF_ONLY,
    turns: [{ role: 'user', content: 'zzzzz qqqqq' }],
  });
  assert.match(prompt, /Relevant knowledge base entries:/);
  assert.match(prompt, /Yes, weekly\./);
});

test('the prompt tells the model the transcript is one conversation', () => {
  const prompt = systemWithContext({
    message: 'how much?',
    settings,
    knowledge: [],
    preamble: 'p',
    actions: HANDOFF_ONLY,
  });
  assert.match(prompt, /one continuous conversation/);
  // And the fixed rules still sit below everything a human authored.
  assert.ok(prompt.indexOf('Rules:') > prompt.indexOf(settings.system_prompt));
});
