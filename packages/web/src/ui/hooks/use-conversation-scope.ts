"use client";

/**
 * Conversation scope — the one owning module (#4189).
 *
 * CONTEXT.md defines **Conversation scope** as a single umbrella concept: the
 * per-conversation, authoritative SQL routing + REST scope, seeded by a
 * workspace-sticky preference (ADR-0011). Before this module that state was
 * shattered across `atlas-chat.tsx` — six `useState`, three hand-synced
 * provenance refs, and seven scope-field preference-store selectors (plus a
 * hydration flag and a setter) — with the seed/restore/new-chat/persist-back
 * transitions fanned out to as many as 6 `setState` + 3 ref assignments across
 * six call sites. Adding a scope axis (#3895 was the last) meant duplicating the
 * provenance-decoupling dance everywhere.
 *
 * This hook owns the three **(value, provenance) axes** plus the sticky
 * preference, and exposes one flat {@link ConversationScope} object plus intent
 * methods. The pure resolvers stay in `env-picker.tsx`; this is the missing
 * state-owning shell around them.
 *
 * ## The three axes
 *
 *   - **SQL** — `groupId` / `connectionId` / `routingMode` (the member-routing
 *     triple), provenance `sqlProvenance`.
 *   - **REST** — `restExcludedDatasourceIds` / `restFocusDatasourceId`,
 *     provenance `restProvenance` (#3078: decoupled from SQL so opening a
 *     conversation can restore the row's REST scope even while the SQL scope
 *     defers to a seed).
 *   - **Reach** — `groupReach` (#3895 / ADR-0022: `null` = All sources, a group
 *     id = Focus → that group), provenance `reachProvenance` (same decoupling as
 *     REST).
 *
 * ## Value + provenance are one atomic reducer state
 *
 * The old code kept each axis' value in `useState` and its provenance in a
 * `useRef`, mutating the ref *before* the `setState` so the re-running
 * seed/restore effect would read the fresh provenance. Folding both into one
 * reducer state removes that ordering hazard entirely: every transition updates
 * value and provenance in a single dispatch, so the effect (which re-runs on the
 * state change) can never observe a (new value, stale provenance) pair. The pure
 * {@link conversationScopeReducer} is exported so the seed / restore /
 * new-chat-reset transitions are unit-testable outside any component.
 */

import { useEffect, useReducer } from "react";
import { useChatRoutingPreferenceStore } from "@/lib/stores/chat-routing-preference-store";
import {
  resolveConversationScope,
  resolveEnvSelection,
  type ChatEnvGroup,
  type ChatEnvSelection,
  type ConversationRoutingMode,
  type ConversationScopeDecision,
  type ConversationScopeSource,
  type EnvSelectionDecision,
  type EnvSelectionProvenance,
} from "../components/chat/env-picker";

/**
 * The flat scope object the orchestrator holds — the six axis values with no
 * provenance bookkeeping. This is what the chat transport forwards on every turn
 * and what the `<ChatEnvPicker>` renders from.
 */
export interface ConversationScope {
  readonly groupId: string | null;
  readonly connectionId: string | null;
  readonly routingMode: ConversationRoutingMode | null;
  // `ReadonlyArray`, not `string[]`, so the array handed out on `scope` (and
  // aliased into the transport getter) can't be mutated out-of-band — matches
  // `ResolveEnvSelectionInput.current.restExcludedDatasourceIds` in env-picker.
  readonly restExcludedDatasourceIds: ReadonlyArray<string>;
  readonly restFocusDatasourceId: string | null;
  readonly groupReach: string | null;
}

/**
 * The reducer state: the six values plus each axis' provenance. Provenance
 * governs whether the seed/restore effect may replace an axis (see
 * {@link EnvSelectionProvenance}): `explicit` short-circuits it, `default`
 * yields to a later-arriving sticky-preference match, `unset` is a fresh chat.
 */
export interface ConversationScopeState extends ConversationScope {
  /** How the SQL scope (group / member / mode) came to be. */
  readonly sqlProvenance: EnvSelectionProvenance;
  /** How the REST scope (exclude-set + focus) came to be (#3078, decoupled). */
  readonly restProvenance: EnvSelectionProvenance;
  /** How the Group reach came to be (#3895, decoupled). */
  readonly reachProvenance: EnvSelectionProvenance;
}

/**
 * A fresh chat: nothing selected, every axis `unset`. Frozen — it is shared as
 * the reducer's initial value, the `resetForNewChat` return (by reference), and
 * the transport mirror ref's seed, so freezing forbids any accidental in-place
 * mutation of the shared constant.
 */
export const INITIAL_CONVERSATION_SCOPE: ConversationScopeState = Object.freeze({
  groupId: null,
  connectionId: null,
  routingMode: null,
  restExcludedDatasourceIds: [] as ReadonlyArray<string>,
  restFocusDatasourceId: null,
  groupReach: null,
  sqlProvenance: "unset",
  restProvenance: "unset",
  reachProvenance: "unset",
});

/**
 * A {@link resolveEnvSelection} decision that actually mutates the scope — the
 * `seed` / `restore` arms. `wait` / `noop` are handled in the effect (they never
 * dispatch), so the reducer's `seedResolved` branch is exhaustive over these two.
 */
export type AppliedEnvSelectionDecision = Extract<
  EnvSelectionDecision,
  { kind: "seed" | "restore" }
>;

/**
 * The scope transitions, as a closed set of intents. Each mirrors exactly one
 * of the six fan-out sites the old component held:
 *
 *   - `seedResolved` — the fresh-chat seed/restore effect applied a
 *     {@link resolveEnvSelection} decision (seed the default / restore the
 *     sticky preference). Only `seed` / `restore` decisions are dispatched;
 *     `wait` / `noop` never reach the reducer.
 *   - `conversationRestored` — a saved conversation opened; apply a
 *     {@link resolveConversationScope} decision (row > preference > seed).
 *   - `selectionApplied` — the user picked a group / member / mode / reach.
 *   - `restExcludedApplied` — the user toggled a REST exclude checkbox.
 *   - `restFocusApplied` — the user focused / cleared a REST datasource.
 *   - `resetForNewChat` — the user started a new chat.
 */
export type ConversationScopeAction =
  | {
      readonly type: "seedResolved";
      readonly decision: AppliedEnvSelectionDecision;
    }
  | {
      readonly type: "conversationRestored";
      readonly decision: ConversationScopeDecision;
    }
  | { readonly type: "selectionApplied"; readonly next: ChatEnvSelection }
  | { readonly type: "restExcludedApplied"; readonly next: string[] }
  | { readonly type: "restFocusApplied"; readonly next: string | null }
  | { readonly type: "resetForNewChat" };

/**
 * Pure scope state machine. Every branch mirrors the exact provenance mutations
 * the old inline fan-out performed — see the per-branch notes. Kept pure (no
 * store, no effects) so the transitions are unit-testable without rendering.
 */
export function conversationScopeReducer(
  state: ConversationScopeState,
  action: ConversationScopeAction,
): ConversationScopeState {
  switch (action.type) {
    case "seedResolved": {
      const decision = action.decision;
      if (decision.kind === "restore") {
        // A restored sticky preference is the user's deliberate prior choice —
        // mark SQL + reach `explicit` so a later effect run can't seed over it.
        // REST provenance is intentionally left as-is (the old effect's restore
        // branch set the REST *values* but never touched its provenance ref).
        return {
          ...state,
          groupId: decision.groupId,
          connectionId: decision.connectionId,
          routingMode: decision.routingMode,
          restExcludedDatasourceIds: decision.restExcludedDatasourceIds,
          restFocusDatasourceId: decision.restFocusDatasourceId,
          groupReach: decision.groupReach,
          sqlProvenance: "explicit",
          reachProvenance: "explicit",
        };
      }
      // seed — the group-primary / All-sources default. `routingMode` is NOT in
      // a seed decision, so it is preserved (a fresh chat leaves it null). SQL +
      // reach become `default`: a workspace-matching preference arriving later
      // is still restored over this, but a second default seed is suppressed.
      return {
        ...state,
        groupId: decision.groupId,
        connectionId: decision.connectionId,
        restExcludedDatasourceIds: decision.restExcludedDatasourceIds,
        restFocusDatasourceId: decision.restFocusDatasourceId,
        groupReach: decision.groupReach,
        sqlProvenance: "default",
        reachProvenance: "default",
      };
    }
    case "conversationRestored": {
      const decision = action.decision;
      // REST scope + Group reach are restored from the row on BOTH decision
      // kinds and made authoritative (#3078 / #3895): they are independent of
      // the SQL member-routing decision, so a row's exclude-set / focus / reach
      // survives even when its SQL scope must be seeded (an all-null row).
      const base: ConversationScopeState = {
        ...state,
        restExcludedDatasourceIds: decision.restExcludedDatasourceIds,
        restFocusDatasourceId: decision.restFocusDatasourceId,
        restProvenance: "explicit",
        groupReach: decision.groupReach,
        reachProvenance: "explicit",
      };
      if (decision.kind === "restore") {
        // The row carried a usable SQL scope — authoritative, mark `explicit`.
        return {
          ...base,
          groupId: decision.groupId,
          connectionId: decision.connectionId,
          routingMode: decision.routingMode,
          sqlProvenance: "explicit",
        };
      }
      // seed — the row had no usable SQL scope; reset SQL to `unset` and let the
      // seed/restore effect seed the default / restore the sticky preference.
      return {
        ...base,
        groupId: null,
        connectionId: null,
        routingMode: null,
        sqlProvenance: "unset",
      };
    }
    case "selectionApplied": {
      // A user group / member / mode / reach pick. Both the SQL and reach axes
      // are set together, so mark BOTH `explicit`; REST is untouched.
      const { groupReach, groupId, connectionId, routingMode } = action.next;
      return {
        ...state,
        groupReach,
        groupId,
        connectionId,
        routingMode,
        sqlProvenance: "explicit",
        reachProvenance: "explicit",
      };
    }
    case "restExcludedApplied":
      // A REST exclude toggle. Mark REST `explicit`; keep SQL `explicit` too so
      // the toggle doesn't trigger a stray sticky-preference restore of the SQL
      // scope as a side effect (the old handler's rationale, preserved).
      return {
        ...state,
        restExcludedDatasourceIds: action.next,
        restProvenance: "explicit",
        sqlProvenance: "explicit",
      };
    case "restFocusApplied":
      // A REST focus / clear. Same provenance treatment as the exclude toggle.
      return {
        ...state,
        restFocusDatasourceId: action.next,
        restProvenance: "explicit",
        sqlProvenance: "explicit",
      };
    case "resetForNewChat":
      // A new chat is bound to no conversation's scope — reset every axis so the
      // seed/restore effect re-runs from scratch (sticky preference, else default).
      return INITIAL_CONVERSATION_SCOPE;
    default: {
      // Exhaustiveness guard — a new action variant must add a branch.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}

/** Environment inputs the seed/restore effect needs to decide correctly. */
export interface UseConversationScopeArgs {
  /** Resolved groups from `/api/v1/me/connection-groups`. */
  readonly groups: ReadonlyArray<ChatEnvGroup>;
  /** A `/me/connection-groups` fetch has settled at least once (#3078). */
  readonly groupsLoaded: boolean;
  /** Active workspace id (`null` = self-hosted / no active org). */
  readonly activeWorkspaceId: string | null;
  /** The auth session has resolved, so {@link activeWorkspaceId} is final. */
  readonly sessionResolved: boolean;
}

/**
 * The scope object + the intent methods the orchestrator drives. `restore` and
 * `resetForNewChat` are called from the conversation-open / new-chat handlers;
 * `applySelection` / `applyRestExcluded` / `applyRestFocus` wire straight to the
 * picker's `onSelect` / `onRestExcludedChange` / `onRestFocusChange` and persist
 * the pick back to the sticky preference internally.
 */
export interface UseConversationScopeResult {
  readonly scope: ConversationScope;
  /** Restore an opened conversation's persisted scope (row > preference > seed). */
  readonly restore: (
    source: ConversationScopeSource,
    groups: ReadonlyArray<ChatEnvGroup>,
  ) => void;
  /** Apply a user group / member / mode / reach pick (and persist it). */
  readonly applySelection: (next: ChatEnvSelection) => void;
  /** Apply a REST exclude-set toggle (and persist it). */
  readonly applyRestExcluded: (next: string[]) => void;
  /** Apply a REST focus / clear (and persist it). */
  readonly applyRestFocus: (next: string | null) => void;
  /** Reset to a fresh chat (no persist — the preference is unchanged). */
  readonly resetForNewChat: () => void;
}

/**
 * The state-owning shell around the pure resolvers. Owns the three
 * (value, provenance) axes, reads + writes the sticky preference, and runs the
 * fresh-chat seed/restore effect internally so the orchestrator only holds the
 * flat {@link ConversationScope} and calls intent methods.
 */
export function useConversationScope({
  groups,
  groupsLoaded,
  activeWorkspaceId,
  sessionResolved,
}: UseConversationScopeArgs): UseConversationScopeResult {
  const [state, dispatch] = useReducer(
    conversationScopeReducer,
    INITIAL_CONVERSATION_SCOPE,
  );

  // Sticky preference (#3044). Select fields individually so the store object
  // identity doesn't churn the seed effect's deps.
  const prefWorkspaceId = useChatRoutingPreferenceStore((s) => s.workspaceId);
  const prefGroupId = useChatRoutingPreferenceStore((s) => s.groupId);
  const prefConnectionId = useChatRoutingPreferenceStore((s) => s.connectionId);
  const prefRoutingMode = useChatRoutingPreferenceStore((s) => s.routingMode);
  const prefRestExcluded = useChatRoutingPreferenceStore(
    (s) => s.restExcludedDatasourceIds,
  );
  const prefRestFocus = useChatRoutingPreferenceStore(
    (s) => s.restFocusDatasourceId,
  );
  const prefGroupReach = useChatRoutingPreferenceStore((s) => s.groupReach);
  const prefHasHydrated = useChatRoutingPreferenceStore((s) => s._hasHydrated);
  const setRoutingPreference = useChatRoutingPreferenceStore(
    (s) => s.setPreference,
  );

  // Seed / restore the picker selection on a fresh chat. The decision is
  // centralized in `resolveEnvSelection`: it waits until groups, the persisted
  // preference, and the workspace id are all ready (so a default seed never
  // pre-empts a restorable preference — the reset-on-reload bug #3064), restores
  // a workspace-matching sticky preference over the default seed, and never
  // clobbers an explicit pick. Only `seed` / `restore` decisions are dispatched;
  // `wait` / `noop` leave the state untouched so the reducer never churns.
  useEffect(() => {
    const decision = resolveEnvSelection({
      groups,
      current: {
        groupId: state.groupId,
        connectionId: state.connectionId,
        routingMode: state.routingMode,
        restExcludedDatasourceIds: state.restExcludedDatasourceIds,
        restFocusDatasourceId: state.restFocusDatasourceId,
        groupReach: state.groupReach,
      },
      provenance: state.sqlProvenance,
      restProvenance: state.restProvenance,
      groupReachProvenance: state.reachProvenance,
      preference: {
        workspaceId: prefWorkspaceId,
        groupId: prefGroupId,
        connectionId: prefConnectionId,
        routingMode: prefRoutingMode,
        restExcludedDatasourceIds: prefRestExcluded,
        restFocusDatasourceId: prefRestFocus,
        groupReach: prefGroupReach,
      },
      activeWorkspaceId,
      preferenceHydrated: prefHasHydrated,
      sessionResolved,
      groupsLoaded,
    });
    switch (decision.kind) {
      case "seed":
      case "restore":
        dispatch({ type: "seedResolved", decision });
        break;
      case "wait":
      case "noop":
        // Inputs not ready or already settled — leave the state alone.
        break;
      default: {
        // Exhaustiveness guard — a new `EnvSelectionDecision` variant must add a
        // branch here (restores the compile-time net the old inline switch held,
        // so a future kind can't be silently skipped by the `Extract` filter).
        const _exhaustive: never = decision;
        void _exhaustive;
      }
    }
  }, [
    groups,
    groupsLoaded,
    // `state` covers every `state.*` read above. The reducer returns a new
    // reference only for a real transition, and only `seed` / `restore` are
    // dispatched, so this re-runs the resolver (which then no-ops) rather than
    // looping — matching the old value-state deps run-for-run.
    state,
    prefWorkspaceId,
    prefGroupId,
    prefConnectionId,
    prefRoutingMode,
    prefRestExcluded,
    prefRestFocus,
    prefGroupReach,
    prefHasHydrated,
    activeWorkspaceId,
    sessionResolved,
  ]);

  // Intent methods. Not manually memoized — React Compiler handles that, and
  // hand-kept dep arrays for the persist-back closures would be a drift footgun
  // (the exact class this refactor removes). Each closes over the current render's
  // `state`, so the persisted preference carries the up-to-date sibling axes.
  const restore = (
    source: ConversationScopeSource,
    groupsAtOpen: ReadonlyArray<ChatEnvGroup>,
  ) => {
    dispatch({
      type: "conversationRestored",
      decision: resolveConversationScope(source, groupsAtOpen),
    });
  };

  const applySelection = (next: ChatEnvSelection) => {
    dispatch({ type: "selectionApplied", next });
    // Persist the pick (scoped to the active workspace) so a reload restores it.
    // Carry the CURRENT REST scope so an env change doesn't drop it.
    setRoutingPreference({
      workspaceId: activeWorkspaceId,
      groupId: next.groupId,
      connectionId: next.connectionId,
      routingMode: next.routingMode,
      restExcludedDatasourceIds: state.restExcludedDatasourceIds,
      restFocusDatasourceId: state.restFocusDatasourceId,
      groupReach: next.groupReach,
    });
  };

  const applyRestExcluded = (next: string[]) => {
    dispatch({ type: "restExcludedApplied", next });
    // Carry the current SQL scope + focus + reach so the exclude change doesn't
    // drop them from the sticky preference.
    setRoutingPreference({
      workspaceId: activeWorkspaceId,
      groupId: state.groupId,
      connectionId: state.connectionId,
      routingMode: state.routingMode,
      restExcludedDatasourceIds: next,
      restFocusDatasourceId: state.restFocusDatasourceId,
      groupReach: state.groupReach,
    });
  };

  const applyRestFocus = (next: string | null) => {
    dispatch({ type: "restFocusApplied", next });
    setRoutingPreference({
      workspaceId: activeWorkspaceId,
      groupId: state.groupId,
      connectionId: state.connectionId,
      routingMode: state.routingMode,
      restExcludedDatasourceIds: state.restExcludedDatasourceIds,
      restFocusDatasourceId: next,
      groupReach: state.groupReach,
    });
  };

  const resetForNewChat = () => {
    dispatch({ type: "resetForNewChat" });
  };

  const scope: ConversationScope = {
    groupId: state.groupId,
    connectionId: state.connectionId,
    routingMode: state.routingMode,
    restExcludedDatasourceIds: state.restExcludedDatasourceIds,
    restFocusDatasourceId: state.restFocusDatasourceId,
    groupReach: state.groupReach,
  };

  return {
    scope,
    restore,
    applySelection,
    applyRestExcluded,
    applyRestFocus,
    resetForNewChat,
  };
}
