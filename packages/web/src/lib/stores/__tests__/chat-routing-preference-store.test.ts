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
    });
    const s = useChatRoutingPreferenceStore.getState();
    expect(s.workspaceId).toBe("org-1");
    expect(s.groupId).toBe("prod");
    expect(s.connectionId).toBe("eu-prod");
    expect(s.routingMode).toBe("pin");
  });

  it("persists ONLY the preference fields to localStorage (partialize drops setters)", () => {
    useChatRoutingPreferenceStore.getState().setPreference({
      workspaceId: "org-1",
      groupId: "prod",
      connectionId: "eu-prod",
      routingMode: "all",
    });
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(persisted.state).toEqual({
      workspaceId: "org-1",
      groupId: "prod",
      connectionId: "eu-prod",
      routingMode: "all",
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
