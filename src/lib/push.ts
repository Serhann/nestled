/*
 * Reusable Web Push client for the admin PWA (Phase 2).
 *
 * Framework-agnostic on purpose: it takes the API base URL and a token getter,
 * so it can be wired into the admin login flow when the frontend is cut over to
 * the new backend (Phase 5). Everything that must run from a user gesture
 * (Notification.requestPermission — required on iOS) is in `enablePush`, which
 * the "Enable notifications" button should call directly.
 *
 * iOS note: push requires iOS 16.4+, the app added to the Home Screen (installed
 * PWA), and permission requested from a real tap.
 */

export interface PushConfig {
  apiBase: string; // e.g. https://api.jetfood.com (no trailing slash)
  getAccessToken: () => string | null; // agent JWT, or null if logged out
}

export function isPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

async function fetchVapidKey(apiBase: string): Promise<string | null> {
  const res = await fetch(`${apiBase}/api/push/public-key`);
  if (!res.ok) return null;
  const data = (await res.json()) as { enabled: boolean; publicKey: string | null };
  return data.enabled ? data.publicKey : null;
}

/**
 * Full enable flow — call from a click handler. Returns true on success.
 * 1) ask permission, 2) register SW, 3) subscribe with the server VAPID key,
 * 4) POST the subscription, 5) hand the SW its config for re-subscribe.
 */
export async function enablePush(config: PushConfig): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'denied' };

  const registration = await registerServiceWorker();
  if (!registration) return { ok: false, reason: 'no-sw' };
  await navigator.serviceWorker.ready;

  const vapidPublicKey = await fetchVapidKey(config.apiBase);
  if (!vapidPublicKey) return { ok: false, reason: 'push-disabled' };

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const token = config.getAccessToken();
  if (!token) return { ok: false, reason: 'not-authenticated' };

  const res = await fetch(`${config.apiBase}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscription }),
  });
  if (!res.ok) return { ok: false, reason: 'subscribe-failed' };

  // Persist config in the SW so pushsubscriptionchange can re-subscribe without
  // a page open (no JWT needed there — the server re-attributes by endpoint).
  navigator.serviceWorker.controller?.postMessage({
    type: 'jetchat:push-config',
    config: { apiBase: config.apiBase, vapidPublicKey, lastEndpoint: subscription.endpoint },
  });

  return { ok: true };
}

/** Remove this device's subscription (on logout or a "disable" toggle). */
export async function disablePush(config: PushConfig): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const token = config.getAccessToken();
  if (token) {
    await fetch(`${config.apiBase}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => undefined);
  }
  await subscription.unsubscribe();
}

/** Subscribe to SW deep-link messages so the SPA can route on notification click. */
export function onNotificationNavigate(handler: (conversationId: string | null) => void): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'jetchat:navigate') {
      handler(event.data.conversationId ?? null);
    }
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
