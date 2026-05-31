import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ConversationRoutingMode } from "@useatlas/types/conversation";

/**
 * Persisted chat env/member/routing selection (#3044).
 *
 * The chat env picker's selection (`atlas-chat.tsx`) was plain `useState` —
 * lost on every page reload, so the next visit always reverted to the default
 * environment seed. That is wrong for a user who deliberately pinned to one
 * environment: a reload silently widened (or moved) their scope.
 *
 * This store remembers the user's LAST selection in `localStorage` so a reload
 * (or a return visit) restores it, instead of re-seeding from the first group.
 * It is a UI *preference*, not server state: the authoritative per-conversation
 * routing still lives on the `conversations` row (the chat request body stamps
 * it). When a new chat opens with no conversation-restored value, this
 * preference is the seed; a stored selection that no longer matches an available
 * group/member is ignored (the picker falls back to the default seed).
 *
 * Follows the `tour-store.ts` pattern: `persist` + `createJSONStorage(localStorage)`,
 * `partialize` to the persisted fields only.
 */
export interface ChatRoutingPreference {
  /** Active connection group id, or null when none was chosen. */
  readonly groupId: string | null;
  /** Pinned member / execution-target connection id, or null. */
  readonly connectionId: string | null;
  /** Three-state Auto/Pin/All routing mode, or null (pre-#2518 back-compat). */
  readonly routingMode: ConversationRoutingMode | null;
}

interface ChatRoutingPreferenceStore extends ChatRoutingPreference {
  /** Persist the user's latest env-picker selection. */
  setPreference: (next: ChatRoutingPreference) => void;
  /** Forget the stored preference (e.g. on sign-out / workspace switch). */
  clear: () => void;
}

const EMPTY: ChatRoutingPreference = {
  groupId: null,
  connectionId: null,
  routingMode: null,
};

export const useChatRoutingPreferenceStore = create<ChatRoutingPreferenceStore>()(
  persist(
    (set) => ({
      ...EMPTY,
      setPreference: (next) =>
        set({
          groupId: next.groupId,
          connectionId: next.connectionId,
          routingMode: next.routingMode,
        }),
      clear: () => set({ ...EMPTY }),
    }),
    {
      name: "atlas:chat:routing-preference",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        groupId: s.groupId,
        connectionId: s.connectionId,
        routingMode: s.routingMode,
      }),
    },
  ),
);
