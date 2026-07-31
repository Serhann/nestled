import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerBody } from '../services/triggers.js';

/**
 * The campaign payload contract.
 *
 * This exists because the dashboard's campaigns screen could not save. Ever. It sent its
 * own invented vocabulary at four strict JSONB schemas:
 *
 *   identifier  "help_on_pricing"                 → /^[a-z0-9-]+$/ wanted dashes
 *   actions     { type: 'message', message }       → { show_message, message_content }
 *   events      { type: 'time_on_page', seconds }  → { after_delay, delay_seconds }
 *   behaviors   { once_per_session }               → not a key that exists
 *   platforms   { desktop, mobile }                → { desktop_enabled, mobile_enabled }
 *
 * Five validation errors in one response, and nothing in either codebase could catch it:
 * the client typed all four columns as `Record<string, unknown>`, and the schema itself
 * lived in a route module that imports prisma, so checking a payload against it meant
 * booting a server with a database — which is to say, never, while editing the screen.
 *
 * So the payloads below are written the way the DASHBOARD writes them, on purpose. If
 * somebody renames a field on either side, this fails.
 */

/** Exactly what `Campaigns.tsx` seeds a new campaign with. */
const NEW_CAMPAIGN = {
  name: 'Help on the pricing page',
  identifier: 'help-on-the-pricing-page',
  is_active: false,
  priority: 10,
  events: { after_delay: true, delay_seconds: 30 },
  actions: { show_message: true, message_content: '', open_chatbox: true },
  behaviors: {},
  platforms: { desktop_enabled: true, mobile_enabled: true },
};

test('the payload the dashboard seeds a new campaign with is accepted', () => {
  const parsed = triggerBody.parse(NEW_CAMPAIGN);
  assert.equal(parsed.actions.show_message, true);
  assert.equal(parsed.events.delay_seconds, 30);
  // Unmentioned members of a partially-specified column still come back defaulted, which
  // is what lets the screen send only the keys it has controls for.
  assert.equal(parsed.actions.play_sound, false);
  assert.equal(parsed.events.on_leave_intent, false);
  assert.equal(parsed.behaviors.execute_if_online, false);
});

test('every field the campaigns screen can set round-trips', () => {
  const parsed = triggerBody.parse({
    ...NEW_CAMPAIGN,
    website_id: null,
    events: { after_delay: false, delay_seconds: 0, on_leave_intent: true, on_pages: true, page_urls: ['/pricing*'] },
    actions: { show_message: true, message_content: 'Comparing plans?', open_chatbox: true },
    behaviors: { execute_if_online: true, execute_on_first_visit: true },
  });
  assert.equal(parsed.events.on_leave_intent, true);
  assert.deepEqual(parsed.events.page_urls, ['/pricing*']);
  assert.equal(parsed.actions.message_content, 'Comparing plans?');
  assert.equal(parsed.behaviors.execute_on_first_visit, true);
});

test('the shape the screen used to send is rejected on all five counts', () => {
  // Pinned as a regression: this is the exact request that produced the 400, and it must
  // keep failing — if a later edit makes it pass, the strict schemas have been loosened
  // into the junk drawer they were written to prevent.
  const result = triggerBody.safeParse({
    name: 'Help on the pricing page',
    identifier: 'help_on_the_pricing_page',
    is_active: false,
    priority: 10,
    events: { type: 'time_on_page', seconds: 30 },
    actions: { type: 'message', message: '' },
    behaviors: { once_per_session: true },
    platforms: { desktop: true, mobile: true },
  });
  assert.equal(result.success, false);
  const paths = new Set(result.error!.issues.map((i) => String(i.path[0])));
  assert.deepEqual(paths, new Set(['identifier', 'actions', 'events', 'behaviors', 'platforms']));
});

test('an identifier with underscores is not a valid identifier', () => {
  // The one error that would have survived fixing all four column shapes, because the
  // slugifier joined words with `_`.
  const bad = triggerBody.safeParse({ ...NEW_CAMPAIGN, identifier: 'help_on_pricing' });
  assert.equal(bad.success, false);
  assert.match(bad.error!.issues[0]!.message, /lowercase letters, numbers and dashes/);
  assert.equal(triggerBody.safeParse({ ...NEW_CAMPAIGN, identifier: 'help-on-pricing' }).success, true);
});

test('a slug that folds away to nothing is rejected, not silently accepted', () => {
  // `slugify('!!!')` and `slugify('Şşğ')` both strip to '', and min(1) is what turns that
  // into a validation error instead of a row with a blank identifier.
  assert.equal(triggerBody.safeParse({ ...NEW_CAMPAIGN, identifier: '' }).success, false);
});

test('columns the screen omits get their defaults', () => {
  const parsed = triggerBody.parse({ name: 'Bare', identifier: 'bare' });
  assert.equal(parsed.platforms.desktop_enabled, true);
  assert.equal(parsed.platforms.mobile_enabled, true);
  assert.equal(parsed.actions.message_content, null);
  assert.deepEqual(parsed.behaviors.country_restriction, []);
  assert.equal(parsed.is_active, true);
});

test('a partial update does not carry defaults that would blank a column', () => {
  // The PUT route parses `triggerBody.partial()`. zod keeps `.default()` on an optional
  // field, so a rename-only update would otherwise arrive carrying a full set of default
  // columns — see the `keepPresent` note in routes/v1/automation.ts for the narrowing that
  // makes a partial update actually partial. This pins the hazard the narrowing exists for.
  const parsed = triggerBody.partial().parse({ name: 'Renamed' });
  assert.equal(parsed.name, 'Renamed');
  assert.ok('actions' in parsed, 'zod still materialises defaults — keepPresent must strip them');
});
