/*
 * Quick-action template rendering (no DB needed).
 * Guards the JetFood regression: a visitor with NO active order clicking
 * "Where's my order?" must not be told "your order is being processed".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_ORDER_REPLY,
  needsOrder,
  renderReply,
  renderTemplate,
} from '../lib/quickActionTemplate.js';

const WHERE_VISITOR = 'Where is my order {order}?';
const WHERE_REPLY =
  "Your order {order}{restaurant_clause} is {status}{eta_clause}. I'll let you know the moment it's nearby! 🛵";
const LATE_VISITOR = 'My order {order} seems late — can someone check?';
const HUMAN_REPLY = 'Of course — connecting you with an agent now. Please hold on a moment.';

test('renders the full order context', () => {
  const order = { id: '1234', status: 'on the way', eta: '12 min', restaurant: 'Pizza Place' };
  assert.equal(renderTemplate(WHERE_VISITOR, order, {}), 'Where is my order #1234?');
  assert.equal(
    renderReply(WHERE_REPLY, order, {}).text,
    "Your order #1234 from Pizza Place is on the way — estimated arrival in 12 min. I'll let you know the moment it's nearby! 🛵",
  );
});

test('an order with no status is "being processed", never a fake ETA', () => {
  const out = renderReply(WHERE_REPLY, { id: '7' }, {}).text;
  assert.match(out, /Your order #7 is being processed\./);
  assert.doesNotMatch(out, /estimated arrival/);
});

test('no order in context → asks for the order number instead of inventing a status', () => {
  const { text, missingOrder } = renderReply(WHERE_REPLY, {}, {});
  assert.equal(missingOrder, true);
  assert.equal(text, NO_ORDER_REPLY);
  assert.doesNotMatch(text, /being processed|is on the way/);
});

test('no order in context → the visitor request reads cleanly', () => {
  // Not "Where is my order your order?" / "My order  seems late".
  assert.equal(renderTemplate(WHERE_VISITOR, {}, {}), 'Where is my order?');
  assert.equal(renderTemplate(LATE_VISITOR, {}, {}), 'My order seems late — can someone check?');
});

test('replies that never mention an order are unaffected', () => {
  assert.equal(needsOrder(HUMAN_REPLY), false);
  const { text, missingOrder } = renderReply(HUMAN_REPLY, {}, {});
  assert.equal(missingOrder, false);
  assert.equal(text, HUMAN_REPLY);
});

test('intake fields fill their own placeholders', () => {
  const tpl = "I'm running into a technical issue — store {store} ({state}).";
  assert.equal(
    renderTemplate(tpl, {}, { store: 'Kadıköy', state: 'IST' }),
    "I'm running into a technical issue — store Kadıköy (IST).",
  );
});
