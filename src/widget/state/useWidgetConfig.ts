import { useEffect, useMemo, useRef, useState } from 'react';
import type { BootPayload } from '../../types/chat';
import { fetchBoot, readParams, type EmbedParams } from '../boot';
import { createApi, type WidgetApi } from '../api';
import { applyTheme, type ThemeState } from '../theme/applyTheme';
import { resolveCopy, type Copy } from '../copy';
import { usePreviewConfig } from './usePreviewConfig';

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
  /**
   * The appearance editor's copy of the widget.
   *
   * The hook is called unconditionally — React requires that — but it only listens
   * for postMessage, so on a normal visitor load it costs one event listener and
   * returns null forever.
   */
  const previewBoot = usePreviewConfig();
  const [theme, setTheme] = useState<ThemeState>({ scheme: 'light', contrastWarning: null });
  const disposeTheme = useRef<() => void>(() => undefined);

  useEffect(() => {
    // A preview has no website key and must make no requests. See usePreviewConfig:
    // the editor remounts this on every keystroke, and booting for real would mint a
    // session against the customer's live website each time.
    if (params.preview) return;
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

  // In preview the draft IS the boot payload.
  const effective = params.preview ? previewBoot : boot;

  useEffect(() => {
    if (!effective) return;
    disposeTheme.current();
    disposeTheme.current = applyTheme(effective.theme, setTheme);
    return () => disposeTheme.current();
  }, [effective]);

  const copy = useMemo(() => resolveCopy(effective), [effective]);

  // `failed` cannot be set in preview, because nothing was attempted.
  if (failed) return { status: 'disabled' };
  if (!effective) return { status: 'loading' };
  return { status: 'ready', params, api, boot: effective, copy, theme };
}
