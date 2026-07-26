import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Client state that is NOT server state.
 *
 * The split matters: anything the server owns lives in TanStack Query, and
 * anything only this browser knows lives here. Mixing them is how you get a
 * "reply draft" wiped by a background refetch, or a sound preference that resets
 * when the cache is cleared.
 */

interface TypingEntry {
  conversationId: string;
  expiresAt: number;
}

interface AppState {
  /** Per-conversation reply drafts, kept so switching conversations is lossless. */
  drafts: Record<string, string>;
  setDraft: (conversationId: string, value: string) => void;
  clearDraft: (conversationId: string) => void;

  /** Visitors currently typing. Ephemeral: entries expire, they are not deleted by an event. */
  typing: TypingEntry[];
  markTyping: (conversationId: string, isTyping: boolean) => void;
  isTyping: (conversationId: string) => boolean;

  soundEnabled: boolean;
  setSoundEnabled: (value: boolean) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  /** Banners the user has dismissed, by a stable key. */
  dismissed: string[];
  dismiss: (key: string) => void;
  isDismissed: (key: string) => boolean;
}

/** A typing indicator that is never cleared by an event still has to disappear. */
const TYPING_TTL_MS = 4000;

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      drafts: {},
      setDraft: (conversationId, value) =>
        set((s) => ({ drafts: { ...s.drafts, [conversationId]: value } })),
      clearDraft: (conversationId) =>
        set((s) => {
          const next = { ...s.drafts };
          delete next[conversationId];
          return { drafts: next };
        }),

      typing: [],
      markTyping: (conversationId, isTyping) =>
        set((s) => {
          const now = Date.now();
          const rest = s.typing.filter((t) => t.conversationId !== conversationId && t.expiresAt > now);
          return isTyping
            ? { typing: [...rest, { conversationId, expiresAt: now + TYPING_TTL_MS }] }
            : { typing: rest };
        }),
      isTyping: (conversationId) => {
        const now = Date.now();
        return get().typing.some((t) => t.conversationId === conversationId && t.expiresAt > now);
      },

      soundEnabled: true,
      setSoundEnabled: (value) => set({ soundEnabled: value }),

      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      dismissed: [],
      dismiss: (key) => set((s) => ({ dismissed: [...new Set([...s.dismissed, key])] })),
      isDismissed: (key) => get().dismissed.includes(key),
    }),
    {
      name: 'nestled.ui.v1',
      // Drafts and typing are deliberately NOT persisted. A draft that outlives
      // the tab reappears in a conversation the agent has since resolved, and a
      // persisted typing indicator is simply wrong the moment it is restored.
      partialize: (s) => ({
        soundEnabled: s.soundEnabled,
        sidebarCollapsed: s.sidebarCollapsed,
        dismissed: s.dismissed,
      }),
    },
  ),
);
