import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import {
  conversationScopeReducer,
  INITIAL_CONVERSATION_SCOPE,
  useConversationScope,
  type ConversationScopeState,
} from "../hooks/use-conversation-scope";
import { useChatRoutingPreferenceStore } from "@/lib/stores/chat-routing-preference-store";
import type {
  ChatEnvGroup,
  ChatEnvSelection,
  ConversationScopeSource,
} from "../components/chat/env-picker";

// ── Fixtures ─────────────────────────────────────────────────────────

const SINGLE_GROUP: ChatEnvGroup[] = [
  {
    id: "g1",
    name: "prod",
    primaryConnectionId: "c1",
    members: [{ connectionId: "c1", dbType: "postgres", description: null }],
  },
];

const MULTI_MEMBER_GROUP: ChatEnvGroup[] = [
  {
    id: "g1",
    name: "prod",
    primaryConnectionId: "c1",
    members: [
      { connectionId: "c1", dbType: "postgres", description: null },
      { connectionId: "c2", dbType: "postgres", description: null },
    ],
  },
];

/** A non-initial state, so a transition's untouched fields are observable. */
const SEEDED_STATE: ConversationScopeState = {
  groupId: "g1",
  connectionId: "c1",
  routingMode: "pin",
  restExcludedDatasourceIds: ["x1"],
  restFocusDatasourceId: "f1",
  groupReach: "g1",
  sqlProvenance: "default",
  restProvenance: "default",
  reachProvenance: "default",
};

// ── Pure reducer — transitions unit-tested outside any component ──────

describe("conversationScopeReducer — seedResolved (#4189)", () => {
  test("restore applies all six values + marks SQL/reach explicit, leaves REST provenance", () => {
    const next = conversationScopeReducer(INITIAL_CONVERSATION_SCOPE, {
      type: "seedResolved",
      decision: {
        kind: "restore",
        groupId: "g1",
        connectionId: "c2",
        routingMode: "all",
        restExcludedDatasourceIds: ["x1"],
        restFocusDatasourceId: "f1",
        groupReach: "g1",
      },
    });
    expect(next).toEqual({
      groupId: "g1",
      connectionId: "c2",
      routingMode: "all",
      restExcludedDatasourceIds: ["x1"],
      restFocusDatasourceId: "f1",
      groupReach: "g1",
      sqlProvenance: "explicit",
      restProvenance: "unset", // unchanged from INITIAL — mirrors the old effect
      reachProvenance: "explicit",
    });
  });

  test("seed preserves routingMode + REST provenance, marks SQL/reach default", () => {
    // Start from a state with a routingMode set to prove seed never touches it
    // (a seed decision carries no routingMode).
    const start: ConversationScopeState = {
      ...INITIAL_CONVERSATION_SCOPE,
      routingMode: "auto",
      restProvenance: "explicit",
    };
    const next = conversationScopeReducer(start, {
      type: "seedResolved",
      decision: {
        kind: "seed",
        groupId: "g1",
        connectionId: "c1",
        restExcludedDatasourceIds: [],
        restFocusDatasourceId: null,
        groupReach: null,
      },
    });
    expect(next.groupId).toBe("g1");
    expect(next.connectionId).toBe("c1");
    expect(next.routingMode).toBe("auto"); // preserved
    expect(next.sqlProvenance).toBe("default");
    expect(next.reachProvenance).toBe("default");
    expect(next.restProvenance).toBe("explicit"); // preserved (decoupled)
  });
});

describe("conversationScopeReducer — conversationRestored (#4189)", () => {
  test("restore kind: SQL + REST + reach all explicit", () => {
    const source = {
      kind: "restore" as const,
      groupId: "g1",
      connectionId: "c2",
      routingMode: "all" as const,
      restExcludedDatasourceIds: ["x1"],
      restFocusDatasourceId: null,
      groupReach: "g1",
    };
    const next = conversationScopeReducer(INITIAL_CONVERSATION_SCOPE, {
      type: "conversationRestored",
      decision: source,
    });
    expect(next).toEqual({
      groupId: "g1",
      connectionId: "c2",
      routingMode: "all",
      restExcludedDatasourceIds: ["x1"],
      restFocusDatasourceId: null,
      groupReach: "g1",
      sqlProvenance: "explicit",
      restProvenance: "explicit",
      reachProvenance: "explicit",
    });
  });

  test("seed kind: REST + reach restored explicit, SQL reset to unset/null", () => {
    // A row with no usable SQL scope but a live REST scope (the #3078 seam):
    // the REST + reach survive as explicit while SQL defers to the seed effect.
    const next = conversationScopeReducer(SEEDED_STATE, {
      type: "conversationRestored",
      decision: {
        kind: "seed",
        restExcludedDatasourceIds: ["x9"],
        restFocusDatasourceId: "f9",
        groupReach: "g2",
      },
    });
    expect(next.groupId).toBeNull();
    expect(next.connectionId).toBeNull();
    expect(next.routingMode).toBeNull();
    expect(next.sqlProvenance).toBe("unset");
    expect(next.restExcludedDatasourceIds).toEqual(["x9"]);
    expect(next.restFocusDatasourceId).toBe("f9");
    expect(next.restProvenance).toBe("explicit");
    expect(next.groupReach).toBe("g2");
    expect(next.reachProvenance).toBe("explicit");
  });
});

describe("conversationScopeReducer — user intents (#4189)", () => {
  test("selectionApplied sets SQL + reach explicit, leaves REST untouched", () => {
    const next = conversationScopeReducer(SEEDED_STATE, {
      type: "selectionApplied",
      next: {
        groupReach: null,
        groupId: "g2",
        connectionId: "c3",
        routingMode: "auto",
      },
    });
    expect(next.groupReach).toBeNull();
    expect(next.groupId).toBe("g2");
    expect(next.connectionId).toBe("c3");
    expect(next.routingMode).toBe("auto");
    expect(next.sqlProvenance).toBe("explicit");
    expect(next.reachProvenance).toBe("explicit");
    // REST axis untouched.
    expect(next.restExcludedDatasourceIds).toEqual(["x1"]);
    expect(next.restFocusDatasourceId).toBe("f1");
    expect(next.restProvenance).toBe("default");
  });

  test("restExcludedApplied marks REST + SQL explicit (not reach)", () => {
    const next = conversationScopeReducer(SEEDED_STATE, {
      type: "restExcludedApplied",
      next: ["x1", "x2"],
    });
    expect(next.restExcludedDatasourceIds).toEqual(["x1", "x2"]);
    expect(next.restProvenance).toBe("explicit");
    expect(next.sqlProvenance).toBe("explicit");
    expect(next.reachProvenance).toBe("default"); // untouched
  });

  test("restFocusApplied marks REST + SQL explicit (not reach)", () => {
    const next = conversationScopeReducer(SEEDED_STATE, {
      type: "restFocusApplied",
      next: null,
    });
    expect(next.restFocusDatasourceId).toBeNull();
    expect(next.restProvenance).toBe("explicit");
    expect(next.sqlProvenance).toBe("explicit");
    expect(next.reachProvenance).toBe("default");
  });

  test("resetForNewChat returns the fresh-chat initial state", () => {
    const next = conversationScopeReducer(SEEDED_STATE, {
      type: "resetForNewChat",
    });
    expect(next).toEqual(INITIAL_CONVERSATION_SCOPE);
  });
});

// ── Hook integration — seed effect + persist-back ────────────────────

function resetPreferenceStore() {
  localStorage.clear();
  act(() => {
    useChatRoutingPreferenceStore.setState({
      workspaceId: null,
      groupId: null,
      connectionId: null,
      routingMode: null,
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
      groupReach: null,
      _hasHydrated: true,
    });
  });
}

describe("useConversationScope — seed/restore effect + persist-back (#4189)", () => {
  beforeEach(() => {
    resetPreferenceStore();
  });
  afterEach(() => {
    cleanup();
  });

  test("seeds the group-primary default on a fresh chat once inputs are ready", async () => {
    const { result } = renderHook(() =>
      useConversationScope({
        groups: SINGLE_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: null,
        sessionResolved: true,
      }),
    );
    await waitFor(() => expect(result.current.scope.groupId).toBe("g1"));
    expect(result.current.scope.connectionId).toBe("c1");
  });

  test("stays unseeded until the preference store has hydrated", async () => {
    act(() => {
      useChatRoutingPreferenceStore.setState({ _hasHydrated: false });
    });
    const { result } = renderHook(() =>
      useConversationScope({
        groups: SINGLE_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: null,
        sessionResolved: true,
      }),
    );
    // Give effects a chance to run; the gate must keep it null.
    await Promise.resolve();
    expect(result.current.scope.groupId).toBeNull();
  });

  test("stays unseeded until the session has resolved", async () => {
    const { result } = renderHook(() =>
      useConversationScope({
        groups: SINGLE_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: null,
        sessionResolved: false, // the resolver returns `wait`
      }),
    );
    await Promise.resolve();
    expect(result.current.scope.groupId).toBeNull();
  });

  test("the seed settles — the effect does not loop after applying it", async () => {
    // The effect now depends on the whole reducer `state` (not the old
    // individual value fields). Guard the "re-runs the resolver, which then
    // no-ops, rather than looping" claim: once seeded, renders must stop.
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useConversationScope({
        groups: SINGLE_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: null,
        sessionResolved: true,
      });
    });
    await waitFor(() => expect(result.current.scope.groupId).toBe("g1"));
    const afterSeed = renders;
    // Let any further effect passes drain; a looping effect would keep bumping
    // the count (or hang). It must be quiescent.
    await new Promise((r) => setTimeout(r, 30));
    expect(renders).toBe(afterSeed);
  });

  test("applySelection persists the pick + carries the current REST scope forward", async () => {
    const { result } = renderHook(() =>
      useConversationScope({
        groups: MULTI_MEMBER_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: "ws1",
        sessionResolved: true,
      }),
    );
    // Establish a REST scope first, so the selection below must carry it into the
    // preference (the #3066/#3067 "an env change must not drop the REST scope"
    // contract). A dropped carry would leave the pref REST fields empty.
    act(() => result.current.applyRestExcluded(["d1"]));
    const selection: ChatEnvSelection = {
      groupReach: "g1",
      groupId: "g1",
      connectionId: "c2",
      routingMode: "pin",
    };
    act(() => result.current.applySelection(selection));
    expect(result.current.scope.connectionId).toBe("c2");
    expect(result.current.scope.routingMode).toBe("pin");
    const pref = useChatRoutingPreferenceStore.getState();
    expect(pref.workspaceId).toBe("ws1");
    expect(pref.groupId).toBe("g1");
    expect(pref.connectionId).toBe("c2");
    expect(pref.routingMode).toBe("pin");
    expect(pref.groupReach).toBe("g1"); // the picked reach is persisted
    expect(pref.restExcludedDatasourceIds).toEqual(["d1"]); // carried, not dropped
    expect(pref.restFocusDatasourceId).toBeNull();
  });

  test("applyRestExcluded persists the exclude-set + keeps current SQL scope", async () => {
    const { result } = renderHook(() =>
      useConversationScope({
        groups: MULTI_MEMBER_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: "ws1",
        sessionResolved: true,
      }),
    );
    // Establish an SQL pick + a non-null reach first, then toggle a REST
    // exclusion — the toggle must carry BOTH forward (the #3078/#3895 "a REST
    // toggle must not drop the SQL scope / reach from the preference" contract).
    act(() =>
      result.current.applySelection({
        groupReach: "g1",
        groupId: "g1",
        connectionId: "c1",
        routingMode: "pin",
      }),
    );
    act(() => result.current.applyRestExcluded(["d1"]));
    expect(result.current.scope.restExcludedDatasourceIds).toEqual(["d1"]);
    const pref = useChatRoutingPreferenceStore.getState();
    expect(pref.restExcludedDatasourceIds).toEqual(["d1"]);
    // The exclude toggle carried the current SQL scope + reach into the preference.
    expect(pref.groupId).toBe("g1");
    expect(pref.connectionId).toBe("c1");
    expect(pref.groupReach).toBe("g1");
  });

  test("applyRestFocus persists the focus + carries the current SQL scope forward", async () => {
    const { result } = renderHook(() =>
      useConversationScope({
        groups: MULTI_MEMBER_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: "ws1",
        sessionResolved: true,
      }),
    );
    // Establish an SQL pick first; the focus below must carry it (the #3078
    // "a focus toggle must not drop the SQL scope from the preference" contract).
    act(() =>
      result.current.applySelection({
        groupReach: null,
        groupId: "g1",
        connectionId: "c2",
        routingMode: "pin",
      }),
    );
    act(() => result.current.applyRestFocus("d7"));
    expect(result.current.scope.restFocusDatasourceId).toBe("d7");
    const pref = useChatRoutingPreferenceStore.getState();
    expect(pref.restFocusDatasourceId).toBe("d7");
    expect(pref.groupId).toBe("g1"); // SQL scope carried
    expect(pref.connectionId).toBe("c2");
    expect(pref.routingMode).toBe("pin");
  });

  test("restore applies an opened conversation's persisted scope", async () => {
    const { result } = renderHook(() =>
      useConversationScope({
        groups: MULTI_MEMBER_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: "ws1",
        sessionResolved: true,
      }),
    );
    const source: ConversationScopeSource = {
      connectionGroupId: "g1",
      connectionId: "c2",
      routingMode: "all",
      restExcludedDatasourceIds: ["d1"],
      restFocusDatasourceId: null,
      groupReach: "g1",
    };
    act(() => result.current.restore(source, MULTI_MEMBER_GROUP));
    expect(result.current.scope.groupId).toBe("g1");
    expect(result.current.scope.connectionId).toBe("c2");
    expect(result.current.scope.routingMode).toBe("all");
    expect(result.current.scope.restExcludedDatasourceIds).toEqual(["d1"]);
    expect(result.current.scope.groupReach).toBe("g1");
  });

  test("resetForNewChat clears an explicit scope then re-seeds the default", async () => {
    const { result } = renderHook(() =>
      useConversationScope({
        groups: SINGLE_GROUP,
        groupsLoaded: true,
        activeWorkspaceId: null,
        sessionResolved: true,
      }),
    );
    // Restore a conversation's explicit "all" scope (this does NOT persist to the
    // sticky preference — so the reset below re-seeds the bare default, not it).
    act(() =>
      result.current.restore(
        {
          connectionGroupId: "g1",
          connectionId: "c1",
          routingMode: "all",
          restExcludedDatasourceIds: [],
          restFocusDatasourceId: null,
          groupReach: null,
        },
        SINGLE_GROUP,
      ),
    );
    expect(result.current.scope.routingMode).toBe("all");
    act(() => result.current.resetForNewChat());
    // The new chat re-seeds from scratch: SQL default seed (single group), and
    // the explicit "all" mode is gone (a seed carries no routingMode).
    await waitFor(() => expect(result.current.scope.groupId).toBe("g1"));
    expect(result.current.scope.routingMode).toBeNull();
  });
});
