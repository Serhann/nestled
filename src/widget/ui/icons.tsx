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

/**
 * The launcher glyphs a customer can choose between.
 *
 * A curated set rather than an arbitrary image URL. Each one is drawn on the same
 * 24px grid with the same stroke weight, so switching between them does not change
 * the optical weight of the button — which an uploaded PNG could not promise, and
 * which is the actual reason a picker beats a file field here.
 */
export const QuestionIcon = ({ size = 26 }: Props) =>
  svg(
    size,
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.4 9.2a2.7 2.7 0 1 1 3.4 2.6c-.6.2-.9.7-.9 1.3v.6" />
      <path d="M12 17h.01" />
    </>,
  );

export const SparkleIcon = ({ size = 26 }: Props) =>
  svg(
    size,
    <>
      <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z" />
      <path d="M18.5 4v3M20 5.5h-3" />
    </>,
  );

export const EnvelopeIcon = ({ size = 26 }: Props) =>
  svg(
    size,
    <>
      <rect x="2.75" y="5" width="18.5" height="14" rx="2.5" />
      <path d="m3.5 7.5 7.3 5a2 2 0 0 0 2.4 0l7.3-5" />
    </>,
  );

export const WaveIcon = ({ size = 26 }: Props) =>
  svg(
    size,
    <>
      <path d="M11 3.8a1.3 1.3 0 0 1 2.6 0v6" />
      <path d="M8.4 6a1.3 1.3 0 0 1 2.6 0v4" />
      <path d="M13.6 5.4a1.3 1.3 0 0 1 2.6 0v4.4" />
      <path d="M16.2 8.6a1.3 1.3 0 0 1 2.6 0v4.2a7.2 7.2 0 0 1-7.2 7.2h-.6a6.4 6.4 0 0 1-4.6-1.9L3 14.7a1.4 1.4 0 0 1 2-2l1.7 1.7" />
      <path d="M6.7 14.4V8.9a1.3 1.3 0 0 1 2.6 0" />
    </>,
  );

/** One place that maps the stored value to a component. */
export const LAUNCHER_ICONS = {
  chat: ChatIcon,
  question: QuestionIcon,
  sparkle: SparkleIcon,
  envelope: EnvelopeIcon,
  wave: WaveIcon,
} as const;
