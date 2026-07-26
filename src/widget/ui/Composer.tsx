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
export function Composer({
  placeholder,
  sendLabel,
  disabled,
  autoFocus,
  onSend,
  onTyping,
}: {
  placeholder: string;
  sendLabel: string;
  disabled: boolean;
  autoFocus: boolean;
  onSend(text: string): void;
  onTyping(): void;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Grow with the content, up to the max-height the stylesheet caps it at.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const submit = () => {
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
