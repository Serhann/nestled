/*
 * JetChat admin service worker — Web Push (Phase 2).
 *
 * Responsibilities:
 *   - show a notification from the server push payload (works with the app
 *     closed / phone locked)
 *   - on click, focus the admin window and deep-link to the conversation, or
 *     open a new window
 *   - re-subscribe automatically when the browser rotates the subscription
 *   - keep an app-icon badge in sync with the number of pending notifications
 *
 * Offline app-shell caching + versioned cache-busting is intentionally deferred
 * to Phase 5, so this worker does NOT cache responses (a stale cache would be
 * worse than none while the admin is still being built).
 */

const PUSH_CONFIG_URL = '/__push-config'; // synthetic key in CacheStorage
const PUSH_CONFIG_CACHE = 'jetchat-push-config';

// Bump SHELL_VERSION on deploy to bust the app-shell cache. Hashed Vite asset
// filenames change on their own; this version only gates the static shell.
const SHELL_VERSION = 'v2';
const SHELL_CACHE = `jetchat-shell-${SHELL_VERSION}`;
// The installable PWA is the admin app at /admin — precache that shell (not the
// marketing landing at /).
const SHELL_URLS = ['/admin', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop old shell caches (but never the push-config cache).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('jetchat-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Offline app shell. Navigations: network-first, fall back to cached shell.
// Same-origin GET assets: stale-while-revalidate. API/WS never cached.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch the API origin
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/admin').then((r) => r || fetch(req))),
    );
    return;
  }

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// ── Push ────────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'JetChat', body: event.data ? event.data.text() : 'New activity' };
  }

  const title = data.title || 'JetChat';
  const options = {
    body: data.body || 'You have new activity',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // One notification per conversation replaces the previous one for it.
    tag: data.conversationId ? `conv-${data.conversationId}` : 'jetchat',
    renotify: true,
    data: { url: data.url || '/admin', conversationId: data.conversationId || null },
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if ('setAppBadge' in self.navigator) {
        try {
          const notes = await self.registration.getNotifications();
          await self.navigator.setAppBadge(notes.length || 1);
        } catch {
          /* badge is best-effort */
        }
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/admin';
  const conversationId = event.notification.data && event.notification.data.conversationId;

  event.waitUntil(
    (async () => {
      if ('clearAppBadge' in self.navigator) {
        try {
          await self.navigator.clearAppBadge();
        } catch {
          /* best-effort */
        }
      }
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        // Focus an existing admin window and tell the SPA where to route.
        await client.focus();
        client.postMessage({ type: 'jetchat:navigate', conversationId, url: targetUrl });
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});

// ── Subscription rotation ─────────────────────────────────────────────────────
// The browser can silently rotate the push subscription. We re-subscribe using
// the config the client stashed (API base + VAPID key) and hand the server the
// OLD endpoint so it can re-attribute the row to the same agent without a JWT.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const config = await readPushConfig();
      if (!config || !config.vapidPublicKey) return;

      const oldEndpoint =
        (event.oldSubscription && event.oldSubscription.endpoint) ||
        (config.lastEndpoint ?? null);

      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });

      await fetch(`${config.apiBase}/api/push/resubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_endpoint: oldEndpoint, subscription }),
      });
      await writePushConfig({ ...config, lastEndpoint: subscription.endpoint });
    })(),
  );
});

// Client hands the SW its config (API base + VAPID key) to persist for later.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'jetchat:push-config') {
    event.waitUntil(writePushConfig(event.data.config));
  }
});

async function readPushConfig() {
  try {
    const cache = await caches.open(PUSH_CONFIG_CACHE);
    const res = await cache.match(PUSH_CONFIG_URL);
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

async function writePushConfig(config) {
  const cache = await caches.open(PUSH_CONFIG_CACHE);
  await cache.put(PUSH_CONFIG_URL, new Response(JSON.stringify(config)));
}

// VAPID public keys are base64url; the subscribe API wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = self.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
