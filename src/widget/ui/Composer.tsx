import { useEffect, useRef, useState } from 'react';
import { SendIcon } from './icons';

/**
 * The message box.
 *
 * A textarea rather than an input so a visitor can paste a paragraph and see it,
 * with Enter sending and Shift+Enter making a newline — the convention every
 * chat product shares, and the one people try first.
 *
 * No attachment button. `boot.behavior.file_upload_enabled` exists, but the v1
 * widget plane has no upload endpoint yet; a paperclip that always fails is
 * worse than no paperclip. See the report.
 */
/** Matches `.n-composer textarea { max-height }`. Kept in step by the clamp below. */
const MAX_COMPOSER_PX = 96;

export function Composer({
  placeholder,
  sendLabel,
  disabled,
  autoFocus,
  onSend,
  onTyping,
  preview,
}: {
  placeholder: string;
  sendLabel: string;
  disabled: boolean;
  autoFocus: boolean;
  onSend(text: string): void;
  onTyping(): void;
  /**
   * Rendering inside the appearance editor.
   *
   * The composer is shown, because it is a third of what the customer is styling — but
   * it cannot send: a preview has no session by design, so pressing the button used to
   * produce "something went wrong" on a screen where nothing had gone wrong. It is
   * inert and says so instead.
   */
  preview?: boolean;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  /**
   * Grow with the content, up to the cap.
   *
   * Measured in a frame rather than synchronously, and clamped in JS as well as in
   * CSS. Both matter, and the bug that taught me is worth recording: this component
   * remounts when the view changes, and a `scrollHeight` read during that layout change
   * came back as 343px — the height of the whole panel body. The stylesheet's
   * `max-height` then clamped it to 96, so a one-line box rendered two and a half
   * inches tall for every visitor, forever, because nothing ever re-measured it.
   *
   * `requestAnimationFrame` waits for layout to settle. The clamp means that even if a
   * reading is wrong again, the damage is one line rather than the whole panel.
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // An empty box is exactly one row, and `rows={1}` already says so. Clearing the
    // inline height is not an optimisation, it is the fix: measuring is what went
    // wrong. `scrollHeight` read while the panel is opening — the iframe is mid-resize
    // from 96px to 640px — came back as the height of the whole body, so the clamp
    // below pinned an empty one-line composer at its 96px maximum on every single
    // open. Not measuring cannot be mismeasured.
    if (!value) {
      el.style.height = '';
      return;
    }

    // With content there is nothing to do but measure. In a frame, so layout has
    // settled, and clamped so a bad reading costs one line rather than the panel.
    const frame = requestAnimationFrame(() => {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  const submit = () => {
    if (preview) return;
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    onSend(text);
  };

  return (
    <form
      className="n-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        // Read-only, not disabled: disabled greys the control out, and the point of the
        // preview is to show the customer what their composer looks like.
        readOnly={preview}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          setValue(event.target.value);
          onTyping();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button className="n-send" type="submit" disabled={disabled || !value.trim()} aria-label={sendLabel}>
        <SendIcon />
      </button>
    </form>
  );
}
