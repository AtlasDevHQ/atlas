/**
 * Unit tests for the durable-state handle + plain load/commit helpers (#3754,
 * ADR-0020). Covers the declaration guards (reserved namespace, duplicate,
 * empty), the outside-context throw, the get/set/update round-trip inside an
 * ambient store, the Noop store, and the fail-soft persistence helpers.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import * as realInternal from "@atlas/api/lib/db/internal";

let hasInternalDB = true;
let throwOnExecute = false;
const execCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => [];

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    execCalls.push({ sql, params });
    if (throwOnExecute) throw new Error("exec boom");
  },
  internalQuery: (sql: string, params?: unknown[]) => queryImpl(sql, params),
}));

const {
  defineDurableState,
  runWithDurableState,
  buildDurableStateStore,
  loadSessionMemory,
  commitSessionMemory,
  NOOP_DURABLE_STATE_STORE,
  DurableStateContextError,
  RESERVED_NAMESPACE_PREFIX,
  _resetDurableStateRegistry,
} = await import("@atlas/api/lib/durable-state");

beforeEach(() => {
  hasInternalDB = true;
  throwOnExecute = false;
  execCalls.length = 0;
  queryImpl = async () => [];
  _resetDurableStateRegistry();
});

describe("defineDurableState — declaration guards", () => {
  it("rejects a reserved-namespace slot name", () => {
    expect(() => defineDurableState(`${RESERVED_NAMESPACE_PREFIX}internal`)).toThrow(
      DurableStateContextError,
    );
    expect(() => defineDurableState(`${RESERVED_NAMESPACE_PREFIX}internal`)).toThrow(/reserved/);
  });

  it("rejects an empty slot name", () => {
    expect(() => defineDurableState("")).toThrow(DurableStateContextError);
  });

  it("rejects a duplicate slot declaration", () => {
    defineDurableState("count");
    expect(() => defineDurableState("count")).toThrow(/already declared/);
  });
});

describe("durable-state handle — ambient context", () => {
  it("throws when accessed outside an active session context", () => {
    const handle = defineDurableState<number>("orphan");
    expect(() => handle.get()).toThrow(DurableStateContextError);
    expect(() => handle.set(1)).toThrow(DurableStateContextError);
    expect(() => handle.update((p) => (p ?? 0) + 1)).toThrow(DurableStateContextError);
  });

  it("reads default, then set/get/update round-trip inside a live store", async () => {
    queryImpl = async () => [];
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });
    expect(store.available).toBe(true);

    runWithDurableState(store, () => {
      const count = defineDurableState<number>("count", { default: 0 });
      expect(count.get()).toBe(0); // declared default when unset
      count.set(5);
      expect(count.get()).toBe(5);
      count.update((prev) => (prev ?? 0) + 1);
      expect(count.get()).toBe(6);
    });

    // The store accumulated the write; drainDirty surfaces it for commit.
    expect(store.drainDirty()).toEqual([{ namespace: "count", value: 6 }]);
    // Drain clears — a second drain is empty.
    expect(store.drainDirty()).toEqual([]);
  });

  it("reads the seeded value from a prior session load", async () => {
    queryImpl = async () => [{ namespace: "lastTable", value: "orders" }];
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });

    runWithDurableState(store, () => {
      const lastTable = defineDurableState<string>("lastTable");
      expect(lastTable.get()).toBe("orders");
    });
  });
});

describe("Noop store inside a context — behavior identical to today", () => {
  it("returns the declared default on read and drops writes", () => {
    runWithDurableState(NOOP_DURABLE_STATE_STORE, () => {
      const count = defineDurableState<number>("count", { default: 42 });
      expect(count.get()).toBe(42);
      count.set(5); // dropped
      expect(count.get()).toBe(42);
    });
    expect(NOOP_DURABLE_STATE_STORE.drainDirty()).toEqual([]);
  });
});

describe("buildDurableStateStore — gating", () => {
  it("returns the Noop store when inactive", async () => {
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: false,
    });
    expect(store.available).toBe(false);
    expect(store).toBe(NOOP_DURABLE_STATE_STORE);
  });

  it("returns the Noop store when there is no internal DB", async () => {
    hasInternalDB = false;
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });
    expect(store.available).toBe(false);
  });

  it("returns a live store when active with an internal DB", async () => {
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });
    expect(store.available).toBe(true);
  });
});

describe("loadSessionMemory — fail-soft", () => {
  it("returns an empty map without an internal DB", async () => {
    hasInternalDB = false;
    expect((await loadSessionMemory("conv-1")).size).toBe(0);
  });

  it("maps rows by namespace", async () => {
    queryImpl = async () => [
      { namespace: "a", value: 1 },
      { namespace: "b", value: [1, 2] },
    ];
    const map = await loadSessionMemory("conv-1");
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toEqual([1, 2]);
  });

  it("returns an empty map when the load query throws (fail-soft)", async () => {
    queryImpl = async () => {
      throw new Error("query boom");
    };
    expect((await loadSessionMemory("conv-1")).size).toBe(0);
  });
});

describe("commitSessionMemory — fire-and-forget upserts", () => {
  it("no-ops without an internal DB", () => {
    hasInternalDB = false;
    commitSessionMemory({ conversationId: "conv-1", orgId: "org-1", slots: [{ namespace: "a", value: 1 }] });
    expect(execCalls).toHaveLength(0);
  });

  it("upserts one row per slot with serialized JSON", () => {
    commitSessionMemory({
      conversationId: "conv-1",
      orgId: "org-1",
      slots: [
        { namespace: "a", value: 1 },
        { namespace: "b", value: { x: true } },
      ],
    });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]!.sql).toContain("INSERT INTO agent_session_memory");
    expect(execCalls[0]!.params).toEqual(["conv-1", "org-1", "a", JSON.stringify(1)]);
    expect(execCalls[1]!.params).toEqual(["conv-1", "org-1", "b", JSON.stringify({ x: true })]);
  });

  it("never throws when a slot write fails (fail-soft)", () => {
    throwOnExecute = true;
    expect(() =>
      commitSessionMemory({ conversationId: "conv-1", orgId: "org-1", slots: [{ namespace: "a", value: 1 }] }),
    ).not.toThrow();
  });
});
