/*
 * All visitor-facing widget copy, in one place, English-only by product decision
 * (no i18n layer). Nothing may render to a site visitor from an inline literal —
 * everything routes through here, which is also what makes every string editable
 * per website once Phase 9 layers customer overrides on top of these defaults.
 */
export const strings = {
  headerDefaultTitle: 'Chat with us',
  onlineStatus: "We're online",
  offlineStatus: "We're offline",
  welcomeFallback: 'Hi! How can we help you today?',
  inputPlaceholder: 'Type your message…',
  send: 'Send',
  attach: 'Attach a file',
  minimize: 'Minimize',
  close: 'Close',
  aiLabel: 'AI Assistant',
  agentLabel: 'Agent',
  agentTyping: 'typing…',
  muteOn: 'Mute sound',
  muteOff: 'Unmute sound',

  preChatTitle: 'Before we start',
  preChatSubtitle: 'Please share a few details so we can help you better.',
  preChatStart: 'Start chat',
  preChatSkip: 'Skip',
  requiredField: 'This field is required',
  invalidEmail: 'Please enter a valid email address',

  // Offline fallback (no agent online and AI disabled).
  leaveMessageTitle: 'Leave us a message',
  leaveMessageSubtitle: "We're not available right now. Leave your email and message and we'll get back to you.",
  emailPlaceholder: 'you@example.com',
  messagePlaceholder: 'How can we help?',
  leaveMessageSubmit: 'Send message',
  leaveMessageThanks: "Thanks! We'll be in touch soon.",

  attachmentTooLarge: 'That file is too large (max 10 MB).',
  attachmentRejected: "That file type isn't supported.",
  genericError: 'Something went wrong. Please try again.',
} as const;
