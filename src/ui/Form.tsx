import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * Form controls.
 *
 * `Field` generates the id and wires `htmlFor`, `aria-describedby` and
 * `aria-invalid` itself. Left to each screen, those are the first things dropped
 * under deadline, and their absence is invisible until someone uses a screen
 * reader.
 */

export const fieldClass =
  'w-full px-3.5 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-800 ' +
  'placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-400 ' +
  'disabled:bg-gray-50 disabled:text-gray-400 transition';

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-gray-700 mb-1.5">
        {label}
        {required && <span className="text-red-500 ml-0.5" aria-hidden>*</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && (
        <p id={errorId} className="text-xs text-red-600 mt-1">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="text-xs text-gray-400 mt-1">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldClass} ${className}`} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${fieldClass} resize-y ${className}`} />;
}

/**
 * A select that looks like the rest of the product.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A native `<select>` cannot be styled where it matters. The closed control takes
 * CSS; the OPEN list is drawn by the operating system, so the options ignore the
 * font, the radii, the palette and the spacing everything else in this app uses.
 * On Windows in particular the dropdown is a grey system menu in the middle of a
 * warm, rounded interface.
 *
 * So this is a listbox. Two constraints shaped it:
 *
 * **The call sites did not change.** It still takes `<option>` children and still
 * reports through `onChange` with `event.target.value`, because seventeen files use
 * it and a new API would mean seventeen chances to translate one wrong. The children
 * are read for their value and label rather than rendered as-is.
 *
 * **It searches once the list is long.** The timezone picker has four hundred and
 * fifty entries; scrolling that is not a control, it is a punishment.
 *
 * Keyboard behaviour follows the native one, because people already know it: arrows
 * move, Home/End jump, Enter and Space commit, Escape cancels, and typing filters.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const SEARCH_THRESHOLD = 12;

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Read `<option>` children without rendering them. */
function readOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    // <optgroup> is flattened: its label becomes a heading in the list rather than a
    // nesting level, because a two-level listbox is a lot of behaviour for the one
    // place this app might ever use it.
    const props = child.props as { value?: unknown; children?: ReactNode; disabled?: boolean };
    if (child.type === 'optgroup') {
      out.push(...readOptions(props.children));
      return;
    }
    const label =
      typeof props.children === 'string'
        ? props.children
        : Array.isArray(props.children)
          ? props.children.filter((c) => typeof c === 'string').join('')
          : String(props.value ?? '');
    out.push({ value: String(props.value ?? ''), label, disabled: props.disabled });
  });
  return out;
}

export function Select({
  className = '',
  value,
  onChange,
  children,
  disabled,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = useMemo(() => readOptions(children), [children]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = options.find((o) => o.value === String(value ?? ''));
  const searchable = options.length > SEARCH_THRESHOLD;
  const shown = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    // Open onto the current value, not onto the top of the list.
    const index = shown.findIndex((o) => o.value === String(value ?? ''));
    setActive(index === -1 ? 0 : index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * Report the way a native select does.
   *
   * Call sites read `event.target.value`, so that is what they get. Anything richer
   * would mean editing every one of them, and this component exists precisely so that
   * none of them have to change.
   */
  const commit = (option: SelectOption) => {
    if (option.disabled) return;
    setOpen(false);
    onChange?.({ target: { value: option.value } } as never);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(shown.length - 1);
    } else if (event.key === 'Enter' || (event.key === ' ' && !searchable)) {
      event.preventDefault();
      const option = shown[active];
      if (option) commit(option);
    }
  };

  return (
    /*
      `min-w-0` is not cosmetic. A native <select> shrinks below its longest option
      when a flex row runs out of room; this one is a button whose automatic minimum
      size is the label's full width, so three of them in a 320px column pushed the
      last one straight through the edge of the inbox list and over the thread beside
      it. Anything that replaces a native control has to keep its layout behaviour too,
      or the swap is only transparent until the container gets narrow.
    */
    <div ref={root} className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        {...(rest as Record<string, unknown>)}
        className={`${fieldClass} flex items-center gap-2 text-left ${
          disabled ? '' : 'cursor-pointer'
        }`}
      >
        <span className={`flex-1 truncate ${current ? '' : 'text-gray-400'}`}>
          {current?.label ?? 'Select…'}
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-[10rem] rounded-2xl border border-gray-200 bg-white shadow-xl overflow-hidden">
          {searchable && (
            <div className="p-2 border-b border-gray-100">
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder="Search…"
                aria-label="Search options"
                className="w-full px-3 py-1.5 text-sm rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
              />
            </div>
          )}
          <ul
            id={listId}
            role="listbox"
            className="max-h-64 overflow-y-auto py-1"
            // Focus stays on the trigger (or the search box), so the list is driven by
            // `aria-activedescendant` rather than by moving focus into it.
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          >
            {shown.length === 0 && (
              <li className="px-3 py-2 text-sm text-gray-400">Nothing matches.</li>
            )}
            {shown.map((option, index) => {
              const selected = option.value === String(value ?? '');
              return (
                <li key={`${option.value}-${index}`} id={`${listId}-${index}`} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    disabled={option.disabled}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => commit(option)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition ${
                      index === active ? 'bg-blue-50' : ''
                    } ${selected ? 'font-semibold text-blue-800' : 'text-gray-700'} ${
                      option.disabled ? 'opacity-40 cursor-not-allowed' : ''
                    }`}
                  >
                    <span className="flex-1 truncate">{option.label}</span>
                    {selected && <Check className="w-4 h-4 shrink-0" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A labelled text field in one call — the shape most forms actually need. */
export function TextField({
  label,
  hint,
  error,
  required,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | null }) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(a) => <TextInput {...input} {...a} required={required} />}
    </Field>
  );
}
