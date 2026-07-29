import { embedScriptUrl } from './origins';

/**
 * Our own support chat, on our own surfaces.
 *
 * Nestled runs Nestled: the marketing site and the customer panel both carry a
 * widget pointed at a website in one of our own workspaces. Dogfooding is the
 * honest reason; the practical one is better — someone stuck halfway through
 * installing their snippet should be able to ask about it without leaving the
 * page they are stuck on.
 *
 * Two things keep this from being a liability:
 *
 *   - It is OFF unless an operator names a support website in the ops panel. A
 *     self-hoster is not our customer, and shipping them a bubble that reaches
 *     our support team would be baffling and a privacy leak.
 *   - It never blocks the page. The config request is deferred until the browser
 *     is idle, and a failure is silent: our own chat bubble failing to appear
 *     must not be visible to a customer as a broken page.
 */

interface SupportConfig {
  enabled: boolean;
  key: string | null;
}

type NestledFn = ((...args: unknown[]) => void) & { q?: unknown[] };

declare global {
  interface Window {
    Nestled?: NestledFn;
    NestledId?: string;
  }
}

let started = false;

/**
 * Load the widget, if this install has one configured.
 *
 * `identity` is a callback rather than a value because the panel knows who the
 * user is and the marketing site does not, and because fetching a signed context
 * should not happen at all when no widget is going to load.
 */
export function mountSupportWidget(
  identity?: () => Promise<{ context_token: string | null } | null>,
): void {
  // Guarded rather than idempotent-by-accident: a second embed script would give
  // the visitor two launchers and two conversations.
  if (started || typeof window === 'undefined') return;
  started = true;

  const begin = () => {
    void fetch('/api/v1/support-widget')
      .then((res) => (res.ok ? (res.json() as Promise<SupportConfig>) : null))
      .then(async (config) => {
        if (!config?.enabled || !config.key) return;

        window.Nestled =
          window.Nestled ??
          (((...args: unknown[]) => {
            (window.Nestled!.q = window.Nestled!.q ?? []).push(args);
          }) as NestledFn);
        window.NestledId = config.key;

        // embedScriptUrl(), not ORIGINS.widget + '/embed.js'. In the single-domain
        // layout ORIGINS.widget is the PATH '/widget', and '/widget/embed.js' is
        // not where nginx serves the script — it falls through to the SPA
        // fallback, so the browser loads HTML as JavaScript and the bubble simply
        // never appears. There is one function that knows this; use it.
        const script = document.createElement('script');
        script.async = true;
        script.src = embedScriptUrl();
        document.body.appendChild(script);

        // Queued before the script has loaded — the stub above collects calls and
        // the real runtime replays them, which is the whole point of the snippet
        // shape we hand customers.
        if (identity) {
          const signed = await identity().catch(() => null);
          if (signed?.context_token) window.Nestled('context', signed.context_token);
        }
      })
      .catch(() => undefined);
  };

  // Our support chat is the least important thing on any of these pages. It waits
  // for the browser to be idle rather than competing with first paint.
  if ('requestIdleCallback' in window) {
    (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(
      begin,
    );
  } else {
    setTimeout(begin, 1500);
  }
}
