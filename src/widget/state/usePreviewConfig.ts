import { useEffect, useState } from 'react';
import type { BootPayload, BootTheme } from '../../types/chat';

/**
 * The widget, rendering for the appearance editor instead of for a visitor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two rules, and the first is why this is its own file rather than a `preview`
 * branch inside the normal boot:
 *
 * 1. **No network, ever.** A preview URL carries no website key, so a real boot could
 *    only fail — but the important direction is the other one: the editor pushes a new
 *    draft on every keystroke, and a preview that minted widget sessions or created
 *    conversations would fill a customer's own inbox with junk while they picked a
 *    colour.
 * 2. **It waits to be told, and it asks.** A parent cannot post into an iframe that
 *    has not loaded yet, so a one-way "post on change" handshake drops the first
 *    message and leaves the preview blank until somebody touches a control. That is
 *    exactly what was happening. This announces itself when ready and the editor
 *    answers with the draft it already has.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * What the editor sends.
 *
 * `theme` is the raw `website_settings` row rather than a hand-built theme object,
 * and that is deliberate: those field names are already identical to `BootTheme`'s,
 * so a translation layer here would be a second place to keep in step for no gain.
 * Every field is read defensively anyway, because this is a wire boundary.
 */
interface PreviewMessage {
  source: 'nestled-preview';
  theme?: Record<string, unknown>;
  copy?: Record<string, string>;
  /** The editor's light/dark toggle, which overrides the saved scheme. */
  color_mode?: 'light' | 'dark';
}

function bootFromDraft(message: PreviewMessage): BootPayload {
  const draft = message.theme ?? {};
  const str = <T extends string>(key: string, fallback: T): T => {
    const value = draft[key];
    return typeof value === 'string' && value ? (value as T) : fallback;
  };
  const num = (key: string, fallback: number): number => {
    const value = Number(draft[key]);
    return Number.isFinite(value) ? value : fallback;
  };

  const theme: BootTheme = {
    primary_color: str('primary_color', '#4f46e5'),
    // The toggle wins over the saved value, so "preview dark" works even on a website
    // configured as always-light — which is the only way to check contrast before
    // shipping it.
    color_mode: message.color_mode ?? str<BootTheme['color_mode']>('color_mode', 'light'),
    radius_px: num('radius_px', 16),
    font_family: str('font_family', 'system'),
    position: str<BootTheme['position']>('position', 'right'),
    offset_x: num('offset_x', 20),
    offset_y: num('offset_y', 20),
    launcher_style: str<BootTheme['launcher_style']>('launcher_style', 'bubble'),
    show_branding: draft.show_branding !== false,
  };

  return {
    enabled: true,
    authorized: true,
    website: { id: 'preview', name: 'Preview' },
    theme,
    copy: message.copy ?? (draft.copy as Record<string, string> | undefined) ?? {},
    behavior: {
      ai_enabled: false,
      pre_chat_enabled: false,
      pre_chat_fields: [],
      // Off, deliberately. A welcome message firing on a timer inside the editor makes
      // the preview move while you are trying to look at it.
      auto_welcome_enabled: false,
      auto_welcome_message: null,
      auto_welcome_delay: 0,
      file_upload_enabled: Boolean(draft.file_upload_enabled),
      // Silent. A preview that plays a notification sound while somebody adjusts a
      // colour picker is a preview people close.
      sound_enabled: false,
      reset_after_resolve: false,
      rating_tags: [],
    },
    // Empty on purpose. A preview showing starters and triggers would be a preview
    // making claims about screens this one does not edit.
    starters: [],
    triggers: [],
    availability: { online: true, within_hours: true, offline_behavior: 'collect_email' },
  };
}

export function usePreviewConfig(): BootPayload | null {
  const [boot, setBoot] = useState<BootPayload | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as PreviewMessage | null;
      if (!data || data.source !== 'nestled-preview') return;
      // No origin check, and that is defensible HERE and nowhere else in this codebase:
      // the payload is colours and strings that only change how a throwaway iframe
      // paints itself. It carries no token, reaches no API and is never persisted.
      // Pinning an origin would also break the single-domain layout, where the editor
      // and the widget share one.
      setBoot(bootFromDraft(data));
    };
    window.addEventListener('message', onMessage);

    // Rule 2: ask. This is what makes the preview correct on first paint instead of
    // after the first edit.
    try {
      window.parent?.postMessage({ source: 'nestled-preview-ready' }, '*');
    } catch {
      // Opened directly rather than framed — the sandbox does that. Harmless.
    }

    return () => window.removeEventListener('message', onMessage);
  }, []);

  return boot;
}
