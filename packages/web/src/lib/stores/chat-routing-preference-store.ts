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
 * **Workspace-scoped (#3044 Codex review).** `localStorage` is one bucket for the
 * whole browser, but group/connection ids are only unique *within* a workspace —
 * two workspaces can both have a `prod` group with a `warehouse` connection. The
 * stored `workspaceId` lets the consumer ignore a preference left by a different
 * workspace (SaaS org switch / shared browser) instead of seeding a new chat with
 * the wrong environment. `null` workspaceId = self-hosted / no active org (a
 * single workspace, so it always matches).
 *
 * Follows the `tour-store.ts` pattern: `persist` + `createJSONStorage(localStorage)`,
 * `partialize` to the persisted fields only.
 */
export interface ChatRoutingPreference {
  /** Workspace (active org) this preference belongs to. `null` = self-hosted / no org. */
  readonly workspaceId: string | null;
  /** Active connection group id, or null when none was chosen. */
  readonly groupId: string | null;
  /** Pinned member / execution-target connection id, or null. */
  readonly connectionId: string | null;
  /** Three-state Auto/Pin/All routing mode, or null (pre-#2518 back-compat). */
  readonly routingMode: ConversationRoutingMode | null;
  /**
   * #3066 — REST datasource exclude-set the user last chose (excluded
   * `install_id`s). Seeds NEW chats only; the per-conversation row is
   * authoritative once a conversation exists. Empty = nothing excluded.
   */
  readonly restExcludedDatasourceIds: readonly string[];
  /**
   * #3067 — REST-only focus the user last chose (a single `install_id`, or
   * null = not focused). Seeds NEW chats only; the per-conversation row is
   * authoritative once a conversation exists. When set, the conversation
   * targets only that datasource and SQL is suspended.
   */
  readonly restFocusDatasourceId: string | null;
  /**
   * #3895 (ADR-0022) — Group reach the user last chose. `null` = **All sources**
   * (every visible Connection group reachable — the new default); a
   * `connection_group_id` value = **Focus → that group** (hard/exclusive). Seeds
   * NEW chats only (mirrors `restFocusDatasourceId`); the per-conversation row is
   * authoritative once a conversation exists. The clean-break migration (persist
   * `version: 1`) clears any legacy single-group preference so existing browsers
   * start fresh at All sources (ADR-0022 migration).
   */
  readonly groupReach: string | null;
}

interface ChatRoutingPreferenceStore extends ChatRoutingPreference {
  /**
   * Transient (non-persisted) flag: `persist` has finished rehydrating
   * `localStorage`. Consumers (atlas-chat's seed/restore effect) gate on
   * this so a default env seed is never committed before the stored
   * preference is available — that ordering is the reset-on-reload bug
   * (#3064). Starts `false`; `onRehydrateStorage` flips it `true` once
   * rehydration completes (synchronous storage → flips during create).
   */
  _hasHydrated: boolean;
  /** Flip {@link _hasHydrated} — called by `onRehydrateStorage`. */
  setHasHydrated: (value: boolean) => void;
  /** Persist the user's latest env-picker selection. */
  setPreference: (next: ChatRoutingPreference) => void;
  /** Forget the stored preference (e.g. on sign-out / workspace switch). */
  clear: () => void;
}

const EMPTY: ChatRoutingPreference = {
  workspaceId: null,
  groupId: null,
  connectionId: null,
  routingMode: null,
  restExcludedDatasourceIds: [],
  restFocusDatasourceId: null,
  groupReach: null,
};

export const useChatRoutingPreferenceStore = create<ChatRoutingPreferenceStore>()(
  persist(
    (set) => ({
      ...EMPTY,
      _hasHydrated: false,
      setHasHydrated: (value) => set({ _hasHydrated: value }),
      setPreference: (next) =>
        set({
          workspaceId: next.workspaceId,
          groupId: next.groupId,
          connectionId: next.connectionId,
          routingMode: next.routingMode,
          restExcludedDatasourceIds: next.restExcludedDatasourceIds,
          restFocusDatasourceId: next.restFocusDatasourceId,
          groupReach: next.groupReach,
        }),
      // Partial set — zustand shallow-merges, so `_hasHydrated` (absent from
      // EMPTY) is preserved. A clear must not re-close the hydration gate.
      clear: () => set({ ...EMPTY }),
    }),
    {
      name: "atlas:chat:routing-preference",
      storage: createJSONStorage(() => localStorage),
      // #3895 (ADR-0022) — clean-break migration. v0 stored a single-group
      // preference (groupId/connectionId/routingMode) that seeded each new chat
      // onto that one group. Cross-group reach flips the default to All sources,
      // so a persisted v0 single-group seed must be CLEARED: drop the SQL pin and
      // start at All sources (groupReach null), exactly as the conversation-row
      // migration clears the sticky single-group preference. REST scope carries
      // forward (a separate axis, unchanged). New browsers persist v1 directly.
      version: 1,
      migrate: (persisted, version) => {
        const prev = (persisted ?? {}) as Partial<ChatRoutingPreference>;
        if (version < 1) {
          return {
            ...EMPTY,
            // Keep the workspace + REST scope; clear the SQL single-group seed so
            // new chats default to All sources rather than re-focusing the last group.
            workspaceId: prev.workspaceId ?? null,
            restExcludedDatasourceIds: prev.restExcludedDatasourceIds ?? [],
            restFocusDatasourceId: prev.restFocusDatasourceId ?? null,
          } satisfies ChatRoutingPreference;
        }
        return prev as ChatRoutingPreference;
      },
      // Persist ONLY the preference fields. `_hasHydrated` + setters are
      // transient: persisting them is meaningless, and a stored
      // `_hasHydrated: true` would — under any async-storage swap — report
      // hydration complete before the read, reopening the reset-on-reload gate.
      partialize: (s) => ({
        workspaceId: s.workspaceId,
        groupId: s.groupId,
        connectionId: s.connectionId,
        routingMode: s.routingMode,
        restExcludedDatasourceIds: s.restExcludedDatasourceIds,
        restFocusDatasourceId: s.restFocusDatasourceId,
        groupReach: s.groupReach,
      }),
      // Fires after rehydration (synchronously for localStorage, even when
      // storage was empty), so the consumer's gate opens exactly once the
      // stored preference — if any — has been read back in.
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
