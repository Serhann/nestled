import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The unread badge on the launcher.
 *
 * Only counts what the visitor could not have seen: messages that arrive while
 * the panel is closed or the tab is hidden. Counting everything and clearing on
 * open produces a badge that flashes on every reply the visitor is already
 * reading, which trains people to ignore it.
 */
export function useUnread(panelOpen: boolean): {
  unread: number;
  bump: () => void;
  clear: () => void;
} {
  const [unread, setUnread] = useState(0);
  // A ref as well as state: `bump` is called from socket callbacks that are
  // registered once, so they must not close over a stale `panelOpen`.
  const visible = useRef(panelOpen);
  visible.current = panelOpen;

  useEffect(() => {
    if (panelOpen) setUnread(0);
  }, [panelOpen]);

  const bump = useCallback(() => {
    if (visible.current && document.visibilityState === 'visible') return;
    setUnread((n) => Math.min(n + 1, 99));
  }, []);

  const clear = useCallback(() => setUnread(0), []);

  return { unread, bump, clear };
}
