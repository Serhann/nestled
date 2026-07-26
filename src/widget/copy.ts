import type { BootPayload } from '../types/chat';

/**
 * Visitor-facing copy.
 *
 * This duplicates `server/src/lib/widgetCopy.ts` on purpose. The widget has to
 * paint something before /boot resolves — and has to stay usable if /boot never
 * resolves at all — so the default set must exist client-side. The server is
 * still the authority: whatever it returns is merged over this, and the closed
 * key set is enforced there.
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
};

export type Copy = typeof DEFAULT_COPY;

/** Strings the widget needs that are not customer-editable, so never on the wire. */
export const FIXED = {
  requiredField: 'This field is required',
  invalidEmail: 'Enter a valid email address',
  minimize: 'Minimize',
  close: 'Close',
  cancel: 'Cancel',
  continueLabel: 'Continue',
  skip: 'Skip',
  back: 'Back to chat',
  thanks: 'Thank you!',
  agentLabel: 'Support',
  aiLabel: 'Assistant',
  typing: 'typing',
};

/** Merge the server's overrides over the defaults, ignoring keys we do not know. */
export function resolveCopy(boot: BootPayload | null): Copy {
  const merged = { ...DEFAULT_COPY };
  for (const [key, value] of Object.entries(boot?.copy ?? {})) {
    if (key in merged && typeof value === 'string' && value) {
      merged[key as keyof Copy] = value;
    }
  }
  return merged;
}
