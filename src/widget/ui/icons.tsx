/**
 * Inline icons.
 *
 * Hand-written rather than pulled from lucide-react: the widget ships to third
 * party pages under a payload budget, and an icon library — even tree-shaken —
 * costs more than the six glyphs actually used here. `currentColor` throughout,
 * so they inherit whatever token the surrounding rule set.
 */
interface Props {
  size?: number;
}

function svg(size: number, children: React.ReactNode) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ChatIcon = ({ size = 26 }: Props) =>
  svg(size, <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5a8.4 8.4 0 0 1-.9-3.8 8.4 8.4 0 0 1 8.4-9h.6a8.4 8.4 0 0 1 8 8v.3z" />);

export const CloseIcon = ({ size = 17 }: Props) =>
  svg(
    size,
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>,
  );

export const MinimizeIcon = ({ size = 17 }: Props) => svg(size, <path d="M5 12h14" />);

export const SendIcon = ({ size = 18 }: Props) =>
  svg(
    size,
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>,
  );

export const ChevronIcon = ({ size = 16 }: Props) => svg(size, <path d="m9 18 6-6-6-6" />);

export const ExternalIcon = ({ size = 13 }: Props) =>
  svg(
    size,
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>,
  );

export const StarIcon = ({ size = 30, filled = false }: Props & { filled?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.9-6.2-3.3-6.2 3.3L7 14.2l-5-4.9 6.9-1z" />
  </svg>
);
