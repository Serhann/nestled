import type { Copy } from '../copy';

/**
 * The X button on a live chat asks first.
 *
 * Closing clears the thread, and a visitor who has just typed out a problem and
 * missed the minimize button should not lose it to one tap. Rendered inside the
 * panel rather than over the host page, because the widget's iframe is only as
 * large as the panel — a scrim on `document.body` here would be invisible.
 */
export function ConfirmClose({
  copy,
  onKeep,
  onClose,
}: {
  copy: Copy;
  onKeep(): void;
  onClose(): void;
}) {
  return (
    <div className="n-scrim" onClick={onKeep} role="presentation">
      <div className="n-sheet" onClick={(event) => event.stopPropagation()}>
        <p className="n-card-title">{copy.closeConfirmHeading}</p>
        <p className="n-card-sub">{copy.closeConfirmBody}</p>
        <button className="n-button" onClick={onClose}>
          {copy.closeConfirmYes}
        </button>
        <button className="n-button" data-variant="ghost" onClick={onKeep}>
          {copy.closeConfirmNo}
        </button>
      </div>
    </div>
  );
}
