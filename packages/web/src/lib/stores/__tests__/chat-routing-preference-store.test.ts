import { describe, it, expect, beforeEach } from "bun:test";
import { useChatRoutingPreferenceStore } from "../chat-routing-preference-store";

const STORAGE_KEY = "atlas:chat:routing-preference";

beforeEach(() => {
  // Fresh slate: clear persisted state + reset the in-memory store so each
  // test sees the empty default (the persist hydration is module-singleton).
  localStorage.clear();
  useChatRoutingPreferenceStore.getState().clear();
});

describe("useChatRoutingPreferenceStore (#3044)", () => {
  it("starts empty (no remembered selection)", () => {
    const s = useChatRoutingPreferenceStore.getState();
    expect(s.workspaceId).toBeNull();
    expect(s.groupId).toBeNull();
    expect(s.connectionId).toBeNull();
    expect(s.routingMode).toBeNull();
  });

  it("setPreference records the user's last env-picker selection + workspace", () => {
    useChatRoutingPreferenceStore.getState().setPreference({
      workspaceId: "org-1",
      groupId: "prod",
      connectionId: "eu-prod",
      routingMode: "pin",
      restExcludedDatasourceIds: ["billing-api"],
      restFocusDatasourceId: "stripe",
    });
    const s = useChatRoutingPreferenceStore.getState();
    expect(s.workspaceId).toBe("org-1");
    expect(s.groupId).toBe("prod");
    expect(s.connectionId).toBe("eu-prod");
    expect(s.routingMode).toBe("pin");
    // #3066 / #3067 — the REST scope fields persist too.
    expect(s.restExcludedDatasourceIds).toEqual(["billing-api"]);
    expect(s.restFocusDatasourceId).toBe("stripe");
  });

  it("persists ONLY the preference fields to localStorage (partialize drops setters)", () => {
    useChatRoutingPreferenceStore.getState().setPreference({
      workspaceId: "org-1",
      groupId: "prod",
      connectionId: "eu-prod",
      routingMode: "all",
      restExcludedDatasourceIds: ["billing-api"],
      restFocusDatasourceId: "stripe",
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(persisted.state).toEqual({
      workspaceId: "org-1",
      groupId: "prod",
      connectionId: "eu-prod",
      routingMode: "all",
      restExcludedDatasourceIds: ["billing-api"],
      restFocusDatasourceId: "stripe",
    });
    // Setters must never be serialized.
    expect(persisted.state.setPreference).toBeUndefined();
    expect(persisted.state.clear).toBeUndefined();
  });

  it("records the workspace so a consumer can ignore another workspace's preference", () => {
    // The store itself just persists workspaceId; the consumer (atlas-chat)
    // compares it to the active org before restoring. Pin the round-trip here.
    useChatRoutingPreferenceStore.getState().setPreference({
      workspaceId: "org-A",
      groupId: "prod",
      connectionId: "warehouse",
      routingMode: "pin",
    });
    expect(useChatRoutingPreferenceStore.getState().workspaceId).toBe("org-A");
  });

  it("clear() forgets the stored preference", () => {
    const store = useChatRoutingPreferenceStore.getState();
    store.setPreference({
      workspaceId: "org-1",
      groupId: "prod",
      connectionId: "us-prod",
      routingMode: "auto",
    });
    store.clear();
    const s = useChatRoutingPreferenceStore.getState();
    expect(s.workspaceId).toBeNull();
    expect(s.groupId).toBeNull();
    expect(s.connectionId).toBeNull();
    expect(s.routingMode).toBeNull();
  });
});

describe("useChatRoutingPreferenceStore hydration gate (#3064)", () => {
  // The reset-on-reload fix gates atlas-chat's seed/restore effect on the
  // persist store having finished rehydrating localStorage. Without that
  // gate the default env seed is committed before the stored preference is
  // available and then locks it in. The store exposes a `_hasHydrated`
  // flag (flipped true by `onRehydrateStorage`) that the consumer reads.

  it("exposes setHasHydrated, which flips the _hasHydrated flag both ways", () => {
    useChatRoutingPreferenceStore.getState().setHasHydrated(false);
    expect(useChatRoutingPreferenceStore.getState()._hasHydrated).toBe(false);
    useChatRoutingPreferenceStore.getState().setHasHydrated(true);
    expect(useChatRoutingPreferenceStore.getState()._hasHydrated).toBe(true);
  });

  it("never persists the hydration flag to localStorage (partialize drops it)", () => {
    useChatRoutingPreferenceStore.getState().setHasHydrated(true);
    useChatRoutingPreferenceStore.getState().setPreference({
      workspaceId: "org-1",
      groupId: "prod",
      connectionId: "eu-prod",
      routingMode: "pin",
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as { state: Record<string, unknown> };
    // The flag is transient UI state, not a preference — it must never be
    // serialized (a persisted `true` would skip the gate on next load).
    expect("_hasHydrated" in persisted.state).toBe(false);
    expect("setHasHydrated" in persisted.state).toBe(false);
  });

  it("flips _hasHydrated true when persist rehydration runs (onRehydrateStorage wiring)", async () => {
    // The load-bearing link between the two halves of the fix: rehydration
    // must call setHasHydrated(true). A renamed/dropped onRehydrateStorage
    // callback would leave the gate stuck closed (picker never seeds) while
    // the setter-only test above still passes — so exercise the wiring.
    useChatRoutingPreferenceStore.setState({ _hasHydrated: false });
    await useChatRoutingPreferenceStore.persist.rehydrate();
    expect(useChatRoutingPreferenceStore.getState()._hasHydrated).toBe(true);
    expect(useChatRoutingPreferenceStore.persist.hasHydrated()).toBe(true);
  });
});
