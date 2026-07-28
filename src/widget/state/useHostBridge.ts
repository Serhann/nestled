import { useCallback, useEffect, useMemo, useRef } from 'react';

/** Everything the host page told us, read at the moment a conversation is created. */
export interface HostState {
  identity: Record<string, string>;
  data: Record<string, string>;
  contextToken: string | null;
  triggerId: string | null;
  prechat: Record<string, string>;
}

/**
 * The postMessage channel between the host page's embed.js and this iframe.
 *
 * `event.origin` cannot be validated: the host page is, by definition, an
 * arbitrary customer domain. `event.source === window.parent` is the check that
 * is actually available, and it is enough — a third party who can already run
 * script in the parent frame has the page anyway. What matters is what the
 * channel is TRUSTED for: identity and attributes that arrive here are unsigned
 * hints, forwarded to the server as such. Anything trusted travels as an
 * HMAC-signed context token that only the server verifies.
 *
 * The widget also no longer decodes that token. Reading a JWT payload in the
 * browser to render fields was both a layering mistake (the client learning the
 * customer's domain model) and a lie (unverified here, verified only server
 * side). See ContextCard.tsx.
 */

export interface HostCommands {
  open(): void;
  close(): void;
  toggle(): void;
  reset(): void;
  sendMessage(text: string): void;
  startBot(flow: string): void;
  proactive(payload: { conversation_id: string; claim_token: string; message?: string }): void;
  context(token: string): void;
}

type Frame = Record<string, unknown> & { type?: string };

export interface HostBridge {
  /** Announce a state change to host-page subscribers (`Nestled('on', …)`). */
  emit(name: string, payload?: Record<string, unknown>): void;
  /** Tell the embed how large to make the iframe. */
  resize(state: 'closed' | 'open' | 'minimized', width: number, height: number): void;
  /**
   * Hand the signed session to embed.js so presence.js can authenticate.
   *
   * The host page cannot mint one itself: `POST /widget/session` is a
   * cross-origin fetch from an arbitrary customer domain, and no CORS allowlist
   * can ever contain "every customer's website". The widget's own origin is a
   * single known host, so it is the only place the call can be made from.
   *
   * Deliberately NOT routed through `emit`: that channel is subscribable by the
   * customer's own JavaScript via `Nestled('on', …)`, and the session token is a
   * credential, not an event.
   */
  session(token: string): void;
  /**
   * Where the launcher should sit, from the customer's saved settings.
   *
   * Sent once /boot has answered, because embed.js is pasted into a page once and
   * never edited again — so the snippet cannot know a placement the customer changed
   * in their dashboard last week. Without this the "side" and "distance" controls on
   * the appearance screen did nothing whatsoever.
   */
  placement(position: 'left' | 'right', offsetX: number, offsetY: number, radius: number): void;
}

export function useHostBridge(
  host: React.MutableRefObject<HostState>,
  commands: HostCommands,
): HostBridge {
  const latest = useRef(commands);
  latest.current = commands;

  const post = useCallback((message: Record<string, unknown>) => {
    // '*' rather than the host origin: we do not know it, and every field we
    // send is either a state name or something the host told us in the first place.
    window.parent.postMessage(message, '*');
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const frame = event.data as Frame | null;
      if (!frame || typeof frame.type !== 'string' || !frame.type.startsWith('nestled:')) return;
      const c = latest.current;

      switch (frame.type) {
        case 'nestled:identify': {
          const traits = frame.traits as Record<string, unknown> | undefined;
          for (const [key, value] of Object.entries(traits ?? {})) {
            if (value != null) host.current.identity[key] = String(value);
          }
          break;
        }
        case 'nestled:data': {
          const attributes = frame.attributes as Record<string, unknown> | undefined;
          for (const [key, value] of Object.entries(attributes ?? {})) {
            if (value == null) delete host.current.data[key];
            else host.current.data[key] = String(value);
          }
          break;
        }
        case 'nestled:context':
          if (typeof frame.token === 'string' && frame.token) {
            host.current.contextToken = frame.token;
            c.context(frame.token);
          }
          break;
        case 'nestled:proactive':
          if (typeof frame.conversation_id === 'string' && typeof frame.claim_token === 'string') {
            c.proactive({
              conversation_id: frame.conversation_id,
              claim_token: frame.claim_token,
              message: typeof frame.message === 'string' ? frame.message : undefined,
            });
          }
          break;
        case 'nestled:open':
          c.open();
          break;
        case 'nestled:close':
          c.close();
          break;
        case 'nestled:toggle':
          c.toggle();
          break;
        case 'nestled:reset':
          c.reset();
          break;
        case 'nestled:send':
          if (typeof frame.text === 'string' && frame.text.trim()) c.sendMessage(frame.text.trim());
          break;
        case 'nestled:bot':
          if (typeof frame.flow === 'string' && frame.flow) c.startBot(frame.flow);
          break;
      }
    };

    window.addEventListener('message', onMessage);
    // The embed holds every command issued before this point in a queue and
    // flushes it on `ready`, so a snippet that calls Nestled('identify', …) on
    // line one is not racing the iframe's load.
    window.parent.postMessage({ type: 'nestled:ready' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [host]);

  // Memoised as one object: callers put it in effect dependency arrays, and a
  // fresh identity every render would re-post the iframe size on every keystroke.
  return useMemo<HostBridge>(
    () => ({
      emit: (name, payload) => post({ type: 'nestled:event', name, payload: payload ?? {} }),
      resize: (state, width, height) => post({ type: 'nestled:resize', state, width, height }),
      session: (token) => post({ type: 'nestled:session', token }),
      placement: (position, offsetX, offsetY, radius) =>
        post({ type: 'nestled:placement', position, offsetX, offsetY, radius }),
    }),
    [post],
  );
}
