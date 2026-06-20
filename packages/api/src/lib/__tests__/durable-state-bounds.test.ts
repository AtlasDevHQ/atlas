/**
 * Unit tests for durable-memory bounds & safety (#3757, ADR-0020, slice 4):
 *   - size + slot caps resolved from the settings registry (hot-reloadable,
 *     workspace > platform > env > default) — a write that would exceed a cap is
 *     REJECTED at staging time (surfaced to the caller), never truncated;
 *   - the secrets/credentials prohibition — a write whose value looks like a
 *     credential is rejected before persistence;
 *   - tenant scoping — the Live store is bound to its session's conversation +
 *     org, and a commit can only ever target that bound scope.
 *
 * Caps/secrets are enforced in the store's `set` (reached synchronously from a
 * tool's `defineDurableState(...).set()` inside `runWithDurableState`), so the
 * rejection propagates up through the tool's `execute` to the caller — unlike
 * the fire-and-forget commit, which can't surface an error.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import * as realInternal from "@atlas/api/lib/db/internal";

let hasInternalDB = true;
// Rows the load query returns — seeds a store with a prior turn's slots so a
// test can exercise the seeded-slot-counts-toward-the-cap path.
let loadRows: Array<{ namespace: string; value: unknown }> = [];
// Platform-tier overrides (no orgId), keyed on the setting key.
const settings = new Map<string, string>();
// Workspace-tier overrides, keyed on `key\0orgId` — the workspace > platform
// precedence the real `getSetting` resolves so a per-tenant cap is honored.
const workspaceSettings = new Map<string, string>();
const wsKey = (key: string, orgId: string) => `${key}\0${orgId}`;

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: () => {},
  internalQuery: async () => loadRows,
}));

// Drive cap resolution off an in-memory settings map so a test can flip a cap
// the way the settings registry would (workspace OR platform override) and
// assert the store honors it WITHOUT a redeploy — the hot-reload contract.
// The mock mirrors the real four-tier precedence the resolver relies on:
// workspace override (key+orgId) > platform override (key) > registry default.
const realSettings = await import("@atlas/api/lib/settings");
mock.module("@atlas/api/lib/settings", () => ({
  ...realSettings,
  getSettingAuto: (key: string, orgId?: string) =>
    (orgId !== undefined ? workspaceSettings.get(wsKey(key, orgId)) : undefined) ??
    settings.get(key) ??
    realSettings.getSettingDefinition(key)?.default,
}));

const {
  defineDurableState,
  runWithDurableState,
  buildDurableStateStore,
  DurableStateLimitError,
  DurableStateSecretError,
  MEMORY_MAX_SLOTS_SETTING,
  MEMORY_MAX_VALUE_BYTES_SETTING,
  DEFAULT_MEMORY_MAX_SLOTS,
  DEFAULT_MEMORY_MAX_VALUE_BYTES,
  getMemoryMaxSlots,
  getMemoryMaxValueBytes,
  _resetDurableStateRegistry,
} = await import("@atlas/api/lib/durable-state");

beforeEach(() => {
  hasInternalDB = true;
  loadRows = [];
  settings.clear();
  workspaceSettings.clear();
  _resetDurableStateRegistry();
});

async function liveStore(orgId: string | null = "org-1") {
  return buildDurableStateStore({ conversationId: "conv-1", orgId, active: true });
}

describe("cap resolvers — settings registry resolution (hot-reloadable)", () => {
  it("falls back to the registry default when unset", () => {
    expect(getMemoryMaxSlots()).toBe(DEFAULT_MEMORY_MAX_SLOTS);
    expect(getMemoryMaxValueBytes()).toBe(DEFAULT_MEMORY_MAX_VALUE_BYTES);
  });

  it("honors a settings override without a redeploy", () => {
    settings.set(MEMORY_MAX_SLOTS_SETTING, "3");
    settings.set(MEMORY_MAX_VALUE_BYTES_SETTING, "128");
    expect(getMemoryMaxSlots()).toBe(3);
    expect(getMemoryMaxValueBytes()).toBe(128);
  });

  it("clamps a non-positive / unparseable override back to the default", () => {
    settings.set(MEMORY_MAX_SLOTS_SETTING, "0");
    settings.set(MEMORY_MAX_VALUE_BYTES_SETTING, "not-a-number");
    expect(getMemoryMaxSlots()).toBe(DEFAULT_MEMORY_MAX_SLOTS);
    expect(getMemoryMaxValueBytes()).toBe(DEFAULT_MEMORY_MAX_VALUE_BYTES);
  });

  it("resolves a per-workspace override (workspace > platform > default)", () => {
    // A platform-tier override applies to every tenant...
    settings.set(MEMORY_MAX_SLOTS_SETTING, "10");
    // ...but org-A pins a tighter workspace-tier cap that must win for org-A only.
    workspaceSettings.set(wsKey(MEMORY_MAX_SLOTS_SETTING, "org-A"), "3");
    expect(getMemoryMaxSlots("org-A")).toBe(3); // workspace override wins
    expect(getMemoryMaxSlots("org-B")).toBe(10); // falls through to platform
    expect(getMemoryMaxSlots()).toBe(10); // no orgId → platform tier
  });

  it("threads the session's org into cap resolution at store build", async () => {
    // org-A's workspace cap is 1 slot; the store built for org-A must enforce it.
    workspaceSettings.set(wsKey(MEMORY_MAX_SLOTS_SETTING, "org-A"), "1");
    const store = await liveStore("org-A");
    runWithDurableState(store, () => {
      defineDurableState<number>("first").set(1);
      // org-A's 1-slot workspace cap rejects the second slot — proving the store
      // resolved caps against the session's org, not the platform default (64).
      expect(() => defineDurableState<number>("second").set(2)).toThrow(DurableStateLimitError);
    });
  });
});

describe("size cap — a too-large value is rejected, never truncated", () => {
  it("rejects a write whose serialized value exceeds the byte cap", async () => {
    settings.set(MEMORY_MAX_VALUE_BYTES_SETTING, "64");
    const store = await liveStore();
    runWithDurableState(store, () => {
      const slot = defineDurableState<string>("big");
      expect(() => slot.set("x".repeat(200))).toThrow(DurableStateLimitError);
      // The over-cap write never staged — nothing to commit, no truncated value.
      expect(slot.get()).toBeUndefined();
    });
    expect(store.drainDirty()).toEqual([]);
  });

  it("allows a write within the byte cap", async () => {
    settings.set(MEMORY_MAX_VALUE_BYTES_SETTING, "64");
    const store = await liveStore();
    runWithDurableState(store, () => {
      defineDurableState<string>("ok").set("short");
    });
    expect(store.drainDirty()).toEqual([{ namespace: "ok", value: "short" }]);
  });

  it("measures UTF-8 byte length, not character count (multi-byte chars count fully)", async () => {
    settings.set(MEMORY_MAX_VALUE_BYTES_SETTING, "16");
    const store = await liveStore();
    runWithDurableState(store, () => {
      // 10 emoji × 4 bytes each = 40 bytes (well over 16) though only 10 "chars".
      expect(() => defineDurableState<string>("emoji").set("😀".repeat(10))).toThrow(
        DurableStateLimitError,
      );
    });
  });
});

describe("slot cap — a new slot past the cap is rejected", () => {
  it("rejects a NEW slot once the slot cap is reached, but allows overwriting an existing one", async () => {
    settings.set(MEMORY_MAX_SLOTS_SETTING, "2");
    const store = await liveStore();
    runWithDurableState(store, () => {
      const a = defineDurableState<number>("a");
      a.set(1);
      defineDurableState<number>("b").set(2);
      // Cap reached: a third distinct slot is rejected.
      expect(() => defineDurableState<number>("c").set(3)).toThrow(DurableStateLimitError);
      // Overwriting an EXISTING slot is fine — it does not grow the slot count.
      expect(() => a.set(99)).not.toThrow();
    });
    const dirty = store.drainDirty();
    expect(dirty.map((d) => d.namespace).sort()).toEqual(["a", "b"]);
  });

  it("counts a SEEDED slot (loaded from a prior turn) toward the cap", async () => {
    settings.set(MEMORY_MAX_SLOTS_SETTING, "1");
    // The prior turn left one slot; the load seeds the store at the 1-slot cap.
    loadRows = [{ namespace: "fromLastTurn", value: "orders" }];
    const store = await liveStore();
    runWithDurableState(store, () => {
      // A brand-new slot must reject — the seeded slot already fills the budget,
      // so the cap counts loaded slots, not just slots written this turn.
      expect(() => defineDurableState<number>("freshThisTurn").set(1)).toThrow(
        DurableStateLimitError,
      );
      // Overwriting the seeded slot stays allowed (no growth in slot count).
      expect(() => defineDurableState<string>("fromLastTurn").set("payments")).not.toThrow();
    });
  });
});

describe("size cap — boundary (exactly-at-cap is allowed, one byte over rejects)", () => {
  it("accepts a value of exactly maxValueBytes and rejects one byte more", async () => {
    // A JSON string is the quoted content plus 2 quote bytes: `"xxxx"`. Pick a
    // cap so a known-length string lands exactly on it.
    settings.set(MEMORY_MAX_VALUE_BYTES_SETTING, "12"); // 10 chars + 2 quotes
    const store = await liveStore();
    runWithDurableState(store, () => {
      // Exactly 12 bytes — the strict `>` check accepts the boundary value.
      expect(() => defineDurableState<string>("atCap").set("x".repeat(10))).not.toThrow();
      // 13 bytes — one over → rejected.
      expect(() => defineDurableState<string>("overCap").set("x".repeat(11))).toThrow(
        DurableStateLimitError,
      );
    });
    expect(store.drainDirty()).toEqual([{ namespace: "atCap", value: "x".repeat(10) }]);
  });
});

describe("secrets prohibition — a credential-shaped value is rejected pre-persist", () => {
  it("rejects a write whose value looks like an API key", async () => {
    const store = await liveStore();
    runWithDurableState(store, () => {
      const slot = defineDurableState<string>("creds");
      expect(() => slot.set("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd")).toThrow(
        DurableStateSecretError,
      );
      expect(slot.get()).toBeUndefined(); // never staged
    });
    expect(store.drainDirty()).toEqual([]);
  });

  it("rejects a secret nested inside a remembered object", async () => {
    const store = await liveStore();
    runWithDurableState(store, () => {
      expect(() =>
        defineDurableState<unknown>("cfg").set({ db: { url: "postgres://u:p4ssword-here@h/db" } }),
      ).toThrow(DurableStateSecretError);
    });
  });

  it("allows ordinary analyst memory through", async () => {
    const store = await liveStore();
    runWithDurableState(store, () => {
      defineDurableState<unknown>("ctx").set({ lastTable: "orders", region: "EU", rows: 1432 });
    });
    expect(store.drainDirty()).toEqual([{ namespace: "ctx", value: { lastTable: "orders", region: "EU", rows: 1432 } }]);
  });
});

// Tenant scoping has two enforcement points, tested in two places:
//   - the WRITE/commit path: the Live store IS the session's scope — it is bound
//     to one conversation + org at build, and the commit keys every upsert on
//     `(conversation_id, namespace)` with that bound org, so a write can target
//     no other session. These tests pin that binding (the only thing the write
//     path can carry).
//   - the READ/reset path: the org/user WHERE-clause scoping (a cross-org read
//     sees no rows) is tested in durable-state.test.ts ("cross-org read sees no
//     rows", "cross-org reset matches no rows").
describe("tenant scoping — the Live store is bound to its session's conversation + org", () => {
  it("binds the store to the session's conversation + org (the only write target)", async () => {
    const store = await liveStore("org-A");
    expect(store.conversationId).toBe("conv-1");
    expect(store.orgId).toBe("org-A");
  });

  it("the Noop store carries no tenant binding (a write can target nothing)", async () => {
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: false,
    });
    expect(store.conversationId).toBeNull();
    expect(store.orgId).toBeNull();
  });
});

describe("Noop store — bounds checks never fire (behavior identical to today)", () => {
  it("never throws a limit/secret error (writes are dropped, not validated)", async () => {
    settings.set(MEMORY_MAX_VALUE_BYTES_SETTING, "1");
    hasInternalDB = false;
    const store = await buildDurableStateStore({ conversationId: "conv-1", orgId: "org-1", active: true });
    runWithDurableState(store, () => {
      const slot = defineDurableState<string>("x");
      expect(() => slot.set("way over the 1-byte cap")).not.toThrow();
      expect(() => slot.set("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).not.toThrow();
    });
    expect(store.drainDirty()).toEqual([]);
  });
});
