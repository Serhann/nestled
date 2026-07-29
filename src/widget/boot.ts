import type { BootPayload } from '../types/chat';

/**
 * Everything the widget knows before it has spoken to the server.
 *
 * All of it arrives as query parameters on the iframe URL, set by embed.js. Note
 * what is NOT here: no visitor email, name or phone. The pre-tenant embed put
 * those in the iframe src, which meant a visitor's address sat in a URL for the
 * lifetime of the page. Identity now arrives over postMessage after the widget
 * announces itself ready — see useHostBridge.
 */
export interface EmbedParams {
  /** The website's unguessable public key. The ONLY tenant selector. */
  websiteKey: string;
  /** Origin of the REST + WebSocket API. Same-origin by default. */
  apiBase: string;
  /** Stable visitor id from the host page's single `nestled_vid` entry. */
  visitorId: string | null;
  fingerprint: string | null;
  /** The HOST page's URL — not ours. Drives domain checks and page triggers. */
  href: string;
  /** Corner to anchor to before /boot answers; boot's theme wins afterwards. */
  position: 'left' | 'right';
  /** False when /widget is opened directly (sandbox, previews). */
  embedded: boolean;
  /**
   * Rendering for the appearance editor rather than for a visitor.
   *
   * In preview the widget makes NO network calls at all: there is no website key to
   * boot with, and more importantly a preview must not mint sessions or conversations
   * against the customer's live website every time somebody drags a colour picker.
   * The theme and copy arrive over postMessage instead.
   */
  preview: boolean;
  /**
   * `Nestled('reset')` reloads the iframe with this set. It is a marker rather
   * than an action because the stored conversation lives in the WIDGET origin's
   * localStorage, which the host page cannot reach cross-origin.
   */
  reset: boolean;
}

function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access, which is itself the answer.
    return true;
  }
}

export function readParams(): EmbedParams {
  const q = new URLSearchParams(window.location.search);
  const api = q.get('api') || '';
  return {
    websiteKey: q.get('key') || '',
    apiBase: api.replace(/\/$/, '') || window.location.origin,
    visitorId: q.get('vid'),
    fingerprint: q.get('fp'),
    href: q.get('href') || document.referrer || window.location.href,
    position: q.get('pos') === 'left' ? 'left' : 'right',
    embedded: isEmbedded(),
    preview: q.has('preview'),
    reset: q.has('reset'),
  };
}

export type BootResult =
  | { status: 'ready'; payload: BootPayload }
  /** Suspended workspace, unauthorized domain, or unknown key: render nothing. */
  | { status: 'disabled' }
  | { status: 'error'; error: string };

/**
 * The single pre-paint round trip.
 *
 * One request instead of the old three (config + triggers + agent status),
 * because every extra hop before the launcher appears is visible to the visitor
 * as a widget that arrives late.
 */
export async function fetchBoot(params: EmbedParams): Promise<BootResult> {
  if (!params.websiteKey) return { status: 'error', error: 'no website key' };
  const url =
    `${params.apiBase}/api/v1/widget/boot?key=${encodeURIComponent(params.websiteKey)}` +
    `&href=${encodeURIComponent(params.href)}`;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return res.status === 404 ? { status: 'disabled' } : { status: 'error', error: `boot ${res.status}` };
    const payload = (await res.json()) as BootPayload;
    return payload.enabled ? { status: 'ready', payload } : { status: 'disabled' };
  } catch {
    return { status: 'error', error: 'network' };
  }
}
