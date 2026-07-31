import { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { useWebsiteSettings } from './WebsiteLayout';
import { widgetDocumentUrl } from '../../../lib/origins';
import { Section } from '../../../ui/Card';
import { Field, Select, TextInput } from '../../../ui/Form';
import { Toggle } from '../../../ui/Toggle';
import { Locked } from '../../../ui/Locked';

/**
 * Appearance, with a live preview of the actual widget.
 *
 * The preview is the real widget in an iframe, fed the unsaved draft over
 * postMessage. A hand-drawn mock would drift from the thing it depicts within a
 * release or two, and the whole value of this screen is that what you see is what
 * your visitors get.
 */

const FONTS = [
  { value: 'system', label: 'System (fastest)' },
  { value: 'Inter', label: 'Inter' },
  { value: 'Figtree', label: 'Figtree' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'ui-rounded', label: 'Rounded' },
];

const RADII = [
  { value: 0, label: 'Square' },
  { value: 8, label: 'Soft' },
  { value: 16, label: 'Rounded' },
  { value: 28, label: 'Pill' },
];

export default function Appearance() {
  const { data, save } = useWebsiteSettings();
  const settings = data.settings;
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  const frame = useRef<HTMLIFrameElement>(null);

  /**
   * Feed the draft to the preview.
   *
   * A handshake, not a broadcast. Posting on change alone looked right and was blank:
   * on first render the iframe has not loaded, so that message goes nowhere and the
   * preview stays empty until somebody touches a control — which, on a screen whose
   * whole purpose is "see it before you save it", means it appeared broken. The widget
   * announces itself when it is ready and we answer with whatever we have.
   */
  const push = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { source: 'nestled-preview', theme: settings, copy: settings.copy, color_mode: mode, device },
      '*',
    );
  }, [settings, mode, device]);

  useEffect(() => {
    push();
  }, [push]);

  useEffect(() => {
    const onReady = (event: MessageEvent): void => {
      if ((event.data as { source?: string } | null)?.source === 'nestled-preview-ready') push();
    };
    window.addEventListener('message', onReady);
    return () => window.removeEventListener('message', onReady);
  }, [push]);

  const contrast = contrastRatio(settings.primary_color, '#ffffff');

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <Section title="Brand" description="Everything else is derived from these.">
          <div className="space-y-4">
            <Field
              label="Primary colour"
              error={
                contrast < 4.5
                  ? `White text on this colour has a contrast ratio of ${contrast.toFixed(1)}:1, below the 4.5:1 minimum. Some visitors will not be able to read your buttons.`
                  : null
              }
            >
              {(a) => (
                <div className="flex items-center gap-2">
                  <input
                    {...a}
                    type="color"
                    value={settings.primary_color}
                    onChange={(e) => save({ primary_color: e.target.value })}
                    className="w-11 h-11 rounded-xl border border-gray-200 bg-white p-1 cursor-pointer"
                  />
                  <TextInput
                    value={settings.primary_color}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (/^#[0-9a-fA-F]{6}$/.test(value)) save({ primary_color: value });
                    }}
                    className="w-32 font-mono"
                  />
                </div>
              )}
            </Field>

            <Field label="Corners">
              {() => (
                <div className="flex gap-2">
                  {RADII.map((r) => (
                    <button
                      key={r.value}
                      onClick={() => save({ radius_px: r.value })}
                      className={`flex-1 border-[1.5px] px-3 py-2 text-xs font-semibold transition ${
                        settings.radius_px === r.value
                          ? 'border-blue-500 bg-blue-50 text-blue-700'
                          : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                      }`}
                      style={{ borderRadius: Math.min(r.value, 20) }}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <Field label="Font">
              {(a) => (
                <Select
                  {...a}
                  value={settings.font_family}
                  onChange={(e) => save({ font_family: e.target.value })}
                >
                  {FONTS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field label="Colour scheme" hint="“Follow the visitor’s device” respects their dark mode.">
              {(a) => (
                <Select
                  {...a}
                  value={settings.color_mode}
                  onChange={(e) =>
                    save({ color_mode: e.target.value as typeof settings.color_mode })
                  }
                >
                  <option value="light">Always light</option>
                  <option value="dark">Always dark</option>
                  <option value="auto">Follow the visitor’s device</option>
                </Select>
              )}
            </Field>
            <Field
              label="Dark mode colour"
              hint="Optional. A colour that reads well on white is often unreadable on a dark panel — set a lighter one here and the light theme keeps yours."
            >
              {(a) => (
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={settings.primary_color_dark ?? settings.primary_color}
                    onChange={(e) => save({ primary_color_dark: e.target.value })}
                    className="w-11 h-11 rounded-xl border border-gray-200 bg-white p-1 cursor-pointer shrink-0"
                    aria-label="Dark mode colour"
                  />
                  <TextInput
                    {...a}
                    value={settings.primary_color_dark ?? ''}
                    placeholder={`Same as ${settings.primary_color}`}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === '' || /^#[0-9a-fA-F]{6}$/.test(value)) {
                        save({ primary_color_dark: value });
                      }
                    }}
                  />
                  {settings.primary_color_dark && (
                    <button
                      onClick={() => save({ primary_color_dark: '' })}
                      className="text-xs font-semibold text-gray-500 hover:text-gray-700 shrink-0"
                    >
                      Clear
                    </button>
                  )}
                </div>
              )}
            </Field>
          </div>
        </Section>

        <Section title="Launcher" description="The bubble in the corner of your site.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Style">
              {(a) => (
                <Select
                  {...a}
                  value={settings.launcher_style}
                  onChange={(e) =>
                    save({ launcher_style: e.target.value as typeof settings.launcher_style })
                  }
                >
                  <option value="bubble">Bubble</option>
                  <option value="pill">Pill with text</option>
                  <option value="custom_icon">Your logo</option>
                </Select>
              )}
            </Field>
            {settings.launcher_style === 'custom_icon' && !settings.brand_avatar_url?.trim() && (
              /*
               * "Your logo" with no logo set falls back to the chosen glyph, which is the
               * right thing for the visitor and invisible to the person configuring it —
               * they pick the option, the preview does not change, and there is nothing to
               * tell them the picture field two sections down is the missing half.
               */
              <p className="sm:col-span-2 text-xs text-amber-800 bg-amber-50 rounded-xl px-3 py-2">
                Add a picture under <strong>Branding</strong> below, or the launcher keeps
                using the icon you picked.
              </p>
            )}
            <Field label="Side">
              {(a) => (
                <Select
                  {...a}
                  value={settings.position}
                  onChange={(e) => save({ position: e.target.value as 'left' | 'right' })}
                >
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </Select>
              )}
            </Field>
            <Field label="Distance from the side" hint="Pixels.">
              {(a) => (
                <TextInput
                  {...a}
                  type="number"
                  min={0}
                  max={200}
                  value={settings.offset_x}
                  onChange={(e) => save({ offset_x: Number(e.target.value) })}
                />
              )}
            </Field>
            <Field label="Distance from the bottom">
              {(a) => (
                <TextInput
                  {...a}
                  type="number"
                  min={0}
                  max={200}
                  value={settings.offset_y}
                  onChange={(e) => save({ offset_y: Number(e.target.value) })}
                />
              )}
            </Field>
            <Field label="Size">
              {() => (
                <div className="flex gap-1.5">
                  {(
                    [
                      [48, 'Small'],
                      [60, 'Medium'],
                      [72, 'Large'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => save({ launcher_size: value })}
                      className={`flex-1 border-[1.5px] px-2 py-2 text-xs font-semibold transition rounded-xl ${
                        settings.launcher_size === value
                          ? 'border-blue-500 text-blue-700 bg-blue-50/50'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Icon">
              {() => (
                <div className="flex gap-1.5">
                  {(
                    [
                      ['chat', 'Chat'],
                      ['question', 'Question'],
                      ['sparkle', 'Sparkle'],
                      ['envelope', 'Envelope'],
                      ['wave', 'Wave'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => save({ launcher_icon: value })}
                      className={`flex-1 border-[1.5px] px-1.5 py-2 text-[11px] font-semibold transition rounded-xl ${
                        settings.launcher_icon === value
                          ? 'border-blue-500 text-blue-700 bg-blue-50/50'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <Field
              label="Attention pulse"
              hint="A slow ring around the closed bubble. Effective, and irritating in equal measure — off unless you want it. Respects a visitor's reduced-motion setting."
            >
              {() => (
                <Toggle
                  checked={settings.launcher_pulse}
                  onChange={(value) => save({ launcher_pulse: value })}
                  label="Draw attention to the bubble"
                />
              )}
            </Field>
          </div>
        </Section>

        <Section title="Branding">
          {data.plan_features.remove_branding ? (
            <Toggle
              checked={!settings.show_branding}
              onChange={(v) => save({ show_branding: !v })}
              label="Hide “Powered by Nestled”"
            />
          ) : (
            <Locked feature="Removing our branding">
              <Toggle checked={false} onChange={() => undefined} label="Hide “Powered by Nestled”" />
            </Locked>
          )}
        </Section>

      <Section title="The panel" description="The conversation itself: how much of your colour it carries, and how much room it takes.">
          <div className="space-y-4">
            <Field label="Style">
              {() => (
              <div className="flex gap-1.5">
                {(
                  [
                    ['solid', 'Solid', 'A full block of your colour.'],
                    // Not "Soft": the Corners control above already has a button by
                    // that name, and two different settings offering the same word on
                    // one screen is a page nobody reads carefully.
                    ['soft', 'Tinted', 'A light tint of it.'],
                    ['minimal', 'Minimal', 'Just a line.'],
                  ] as const
                ).map(([value, label, hint]) => (
                  <button
                    key={value}
                    onClick={() => save({ header_style: value })}
                    title={hint}
                    className={`flex-1 border-[1.5px] px-3 py-2 text-xs font-semibold transition rounded-xl ${
                      settings.header_style === value
                        ? 'border-blue-500 text-blue-700 bg-blue-50/50'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              )}
            </Field>

            <Field
              label="Picture"
              hint="A square image you already host. Shown at the top of the chat, and in the closed launcher when its style is “Your logo”. Leave empty for the default mark."
            >
              {(a) => (
                <TextInput
                  {...a}
                  value={settings.brand_avatar_url ?? ''}
                  placeholder="https://your-site.com/logo.png"
                  onChange={(e) => save({ brand_avatar_url: e.target.value })}
                />
              )}
            </Field>

            <Field label="Your customers’ own messages">
              {() => (
                <div className="flex gap-1.5">
                  {(
                    [
                      ['brand', 'Your colour'],
                      ['neutral', 'Neutral grey'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() => save({ bubble_style: value })}
                      className={`flex-1 border-[1.5px] px-3 py-2 text-xs font-semibold transition rounded-xl ${
                        settings.bubble_style === value
                          ? 'border-blue-500 text-blue-700 bg-blue-50/50'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <Field
              label="Width"
              hint="How wide the open panel is, in pixels. Wider suits long answers and screenshots; narrower covers less of the page underneath."
            >
              {(a) => (
                <TextInput
                  {...a}
                  type="number"
                  min={320}
                  max={520}
                  step={8}
                  value={settings.panel_width}
                  onChange={(e) => save({ panel_width: Number(e.target.value) })}
                />
              )}
            </Field>
          </div>
        </Section>
      </div>

      <div className="lg:sticky lg:top-6 h-fit">
        <div className="flex items-center gap-1.5 mb-2">
          <button
            onClick={() => setDevice('desktop')}
            aria-pressed={device === 'desktop'}
            className={`p-1.5 rounded-lg ${device === 'desktop' ? 'bg-gray-200' : 'text-gray-400'}`}
            aria-label="Desktop preview"
          >
            <Monitor className="w-4 h-4" aria-hidden />
          </button>
          <button
            onClick={() => setDevice('mobile')}
            aria-pressed={device === 'mobile'}
            className={`p-1.5 rounded-lg ${device === 'mobile' ? 'bg-gray-200' : 'text-gray-400'}`}
            aria-label="Mobile preview"
          >
            <Smartphone className="w-4 h-4" aria-hidden />
          </button>
          <button
            onClick={() => setMode(mode === 'light' ? 'dark' : 'light')}
            className="ml-auto text-xs font-semibold text-gray-500 hover:text-gray-700"
          >
            {mode === 'light' ? 'Preview dark' : 'Preview light'}
          </button>
        </div>
        <div
          className={`rounded-3xl border border-gray-200 overflow-hidden bg-white ${
            device === 'mobile' ? 'w-[320px]' : 'w-full'
          }`}
        >
          <iframe
            ref={frame}
            title="Widget preview"
            // The document, by the one function that knows where it lives in either
            // layout. `ORIGINS.widget + '?preview=1'` did resolve — but only because an
            // exact nginx location and a Vite fallback happen to agree, which is the
            // same assumption `/widget/embed.js` made before it broke.
            src={widgetDocumentUrl('?preview=1')}
            className="w-full h-[520px] border-0"
          />
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          This is the real widget, showing your unsaved changes.
        </p>
        {/*
          Said out loud, because otherwise it reads as the setting not working. The
          preview column is fixed at 360px, so a panel wider than that is shown
          narrowed — and a customer who sets 460, sees 334 and concludes the control
          is broken is exactly the failure this whole screen keeps having.
        */}
        {device === 'desktop' && settings.panel_width > 330 && (
          <p className="text-[11px] text-amber-700 mt-1">
            Your panel is {settings.panel_width}px wide — wider than this preview column,
            so it is shown narrowed here. On your site it will be the full width.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * WCAG relative-luminance contrast.
 *
 * Worth computing rather than eyeballing: a mid-tone brand colour with white text
 * looks fine to the person who picked it and is unreadable for a meaningful share
 * of their visitors.
 */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, bl] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  try {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  } catch {
    return 21;
  }
}
