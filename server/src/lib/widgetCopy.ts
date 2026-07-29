/**
 * Default visitor-facing copy.
 *
 * Website settings store ONLY the strings a customer overrode, merged over these at
 * boot. That way an improvement to a default reaches every customer who never
 * edited that particular line — the opposite of copying the full set into each
 * website row, which freezes today's wording forever.
 *
 * The key set is closed: a zod schema rejects unknown keys on save, so a typo
 * becomes a 400 rather than a string that silently never renders.
 */
export const DEFAULT_COPY = {
  launcherLabel: 'Chat with us',
  headerTitle: 'Chat with us',
  headerOnline: "We're online",
  headerOffline: 'Away — leave a message',
  greeting: 'Hi there!',
  welcomeMessage: 'Hi! How can we help?',
  starterHeading: 'HOW CAN WE HELP?',
  starterOther: 'Something else — just chat',
  composerPlaceholder: 'Type your message…',
  composerWaiting: 'Connecting you to someone…',
  sendLabel: 'Send',
  attachLabel: 'Attach a file',
  attachTooLarge: 'That file is too large.',
  attachRejected: "We can't accept that file type.",
  preChatHeading: 'Before we start',
  preChatSubmit: 'Start chatting',
  offlineHeading: 'Leave us a message',
  offlineBody: "We're not around right now, but we'll reply by email.",
  offlineEmailLabel: 'Your email',
  offlineMessageLabel: 'Your message',
  offlineSubmit: 'Send message',
  offlineSent: "Thanks — we'll be in touch.",
  ratingHeading: 'How did we do?',
  ratingTagsHeading: 'WHAT STOOD OUT?',
  ratingCommentPlaceholder: 'Anything else we should know? (optional)',
  ratingSubmit: 'Send rating',
  ratingSkip: 'Skip',
  closeConfirmHeading: 'Close this chat?',
  closeConfirmBody: 'Your conversation will be cleared.',
  closeConfirmYes: 'Close chat',
  closeConfirmNo: 'Keep chatting',
  resolvedNotice: 'This chat was closed.',
  genericError: 'Something went wrong. Please try again.',
  poweredBy: 'Powered by Nestled',
} as const;

export type CopyKey = keyof typeof DEFAULT_COPY;
export const COPY_KEYS = Object.keys(DEFAULT_COPY) as CopyKey[];
