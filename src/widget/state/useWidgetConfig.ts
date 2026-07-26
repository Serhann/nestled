import { useEffect, useMemo, useRef, useState } from 'react';
import type { BootPayload } from '../../types/chat';
import { fetchBoot, readParams, type EmbedParams } from '../boot';
import { createApi, type WidgetApi } from '../api';
import { applyTheme, type ThemeState } from '../theme/applyTheme';
import { resolveCopy, type Copy } from '../copy';

/**
 * Boot the widget: one request, then paint.
 *
 * Until this resolves the widget renders NOTHING — not a placeholder launcher.
 * A launcher that appears in our fallback colour and then repaints in the
 * customer's brand colour is worse than one that arrives 200 ms later, and a
 * launcher on a website whose subscription lapsed should never appear at all.
 */

export type ConfigState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | {
      status: 'ready';
      params: EmbedParams;
      api: WidgetApi;
      boot: BootPayload;
      copy: Copy;
      theme: ThemeState;
    };

export function useWidgetConfig(): ConfigState {
  const params = useMemo(readParams, []);
  const api = useMemo(() => createApi(params.apiBase), [params.apiBase]);
  const [boot, setBoot] = useState<BootPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [theme, setTheme] = useState<ThemeState>({ scheme: 'light', contrastWarning: null });
  const disposeTheme = useRef<() => void>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    void fetchBoot(params).then((result) => {
      if (cancelled) return;
      if (result.status === 'ready') setBoot(result.payload);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    if (!boot) return;
    disposeTheme.current();
    disposeTheme.current = applyTheme(boot.theme, setTheme);
    return () => disposeTheme.current();
  }, [boot]);

  const copy = useMemo(() => resolveCopy(boot), [boot]);

  if (failed) return { status: 'disabled' };
  if (!boot) return { status: 'loading' };
  return { status: 'ready', params, api, boot, copy, theme };
}
