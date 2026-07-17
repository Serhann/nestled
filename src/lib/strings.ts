/*
 * All visitor-facing widget copy, in one place, English-only. JetFood serves US
 * customers — no Turkish (or any other language) may render to a site visitor.
 * The old widget had Turkish strings scattered inline and an alert() in Turkish;
 * everything now routes through here.
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
