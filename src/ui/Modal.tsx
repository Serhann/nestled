import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal dialog with a real focus trap.
 *
 * Without the trap, tabbing out of a dialog lands on the page behind it while the
 * backdrop still covers everything — the keyboard focus is somewhere the user
 * cannot see. Escape closes, focus is restored to whatever opened the dialog, and
 * the backdrop is inert to the tab order.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    const node = panel.current;
    // Focus the dialog itself rather than its first control: an input that steals
    // focus also scrolls a long dialog past its own heading.
    node?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-gray-900/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} bg-cream rounded-t-3xl sm:rounded-3xl shadow-xl border border-gray-100 max-h-[92dvh] flex flex-col animate-pop-in focus:outline-none`}
      >
        <div className="px-5 pt-5 pb-3 shrink-0">
          <h2 className="font-display text-2xl text-gray-800">{title}</h2>
        </div>
        <div className="px-5 pb-1 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-5 py-4 shrink-0 flex gap-2 justify-end">{footer}</div>}
      </div>
    </div>
  );
}
