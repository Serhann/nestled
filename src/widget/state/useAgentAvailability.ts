import { useCallback, useEffect, useState } from 'react';
import type { BootPayload } from '../../types/chat';
import { fetchBoot, type EmbedParams } from '../boot';

export interface Availability {
  online: boolean;
  withinHours: boolean;
  /** What the customer wants to happen when nobody is around. */
  offlineBehavior: string;
  setOnline: (online: boolean) => void;
}

/**
 * Is anyone there?
 *
 * Seeded from the boot payload, then kept live by the conversation socket's
 * `agent:status` frames — which is why `setOnline` is exported rather than this
 * hook owning a poll.
 *
 * Before a conversation exists there is no socket, so the value can go stale. It
 * is refreshed on focus WHILE THE PANEL IS OPEN and nowhere else. That
 * deliberately is not a timer: /boot upserts a `website_domains` row and can
 * publish an install-progress event, so polling it every 15 seconds — which the
 * pre-tenant widget effectively did against its own status endpoint — would
 * write to the database once per visitor per quarter minute for the lifetime of
 * every open tab. A dedicated cheap endpoint is the right fix; see the report.
 */
export function useAgentAvailability(
  boot: BootPayload,
  params: EmbedParams,
  opts: { panelOpen: boolean; hasSocket: boolean },
): Availability {
  const [online, setOnline] = useState(Boolean(boot.availability?.online));
  const { panelOpen, hasSocket } = opts;

  const refresh = useCallback(() => {
    void fetchBoot(params).then((result) => {
      if (result.status === 'ready') setOnline(Boolean(result.payload.availability?.online));
    });
  }, [params]);

  useEffect(() => {
    if (!panelOpen || hasSocket) return;
    const onFocus = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [panelOpen, hasSocket, refresh]);

  return {
    online,
    withinHours: boot.availability?.within_hours ?? true,
    offlineBehavior: boot.availability?.offline_behavior ?? 'collect_email',
    setOnline,
  };
}
