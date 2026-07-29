import type { Conversation } from './api';

/**
 * The widget's browser storage.
 *
 * Every key lives here so the whole footprint on a customer's origin is one
 * short file — the pre-tenant build scattered five keys across three modules
 * with two different naming schemes, which is how the host page and the iframe
 * ended up disagreeing about who the visitor was.
 *
 * Everything is wrapped: private mode and blocked third-party storage throw on
 * plain access, and a widget that crashes because someone browses in a private
 * window is worse than one that forgets a conversation on reload.
 */

/** Namespaced per website: one origin may preview several of them (our sandbox). */
function conversationKey(websiteKey: string): string {
  return `nestled_conv_${websiteKey}`;
}

export function loadConversation(websiteKey: string): Conversation | null {
  try {
    const raw = localStorage.getItem(conversationKey(websiteKey));
    const parsed = raw ? (JSON.parse(raw) as Conversation) : null;
    return parsed?.id && parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

export function saveConversation(websiteKey: string, conversation: Conversation | null): void {
  try {
    if (conversation) localStorage.setItem(conversationKey(websiteKey), JSON.stringify(conversation));
    else localStorage.removeItem(conversationKey(websiteKey));
  } catch {
    // Storage blocked: the conversation simply does not survive a reload.
  }
}
