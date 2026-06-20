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
  renderDurableMemoryBlock,
  DURABLE_MEMORY_BLOCK_HEADING,
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

  it("update() read-modify-writes over a seeded value", async () => {
    queryImpl = async () => [{ namespace: "counter", value: 10 }];
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });

    runWithDurableState(store, () => {
      const counter = defineDurableState<number>("counter");
      counter.update((prev) => (prev ?? 0) + 5);
      expect(counter.get()).toBe(15);
    });
    expect(store.drainDirty()).toEqual([{ namespace: "counter", value: 15 }]);
  });
});

describe("LiveDurableStateStore.drainDirty — only slots written this turn", () => {
  it("excludes a seeded slot that was only read, includes one that was written", async () => {
    queryImpl = async () => [{ namespace: "seeded", value: "loaded" }];
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });

    runWithDurableState(store, () => {
      const seeded = defineDurableState<string>("seeded");
      const fresh = defineDurableState<string>("fresh");
      expect(seeded.get()).toBe("loaded"); // read only → must NOT be re-committed
      fresh.set("new"); // written → must be committed
    });

    // Only the written slot is dirty — a read of a seeded slot never re-upserts it.
    expect(store.drainDirty()).toEqual([{ namespace: "fresh", value: "new" }]);
  });

  it("collapses repeated writes to one slot into a single last-write-wins entry", async () => {
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });

    runWithDurableState(store, () => {
      const count = defineDurableState<number>("count");
      count.set(1);
      count.set(2);
    });

    expect(store.drainDirty()).toEqual([{ namespace: "count", value: 2 }]);
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

describe("store.snapshot — read-only view of every current slot (#3755)", () => {
  it("snapshots seeded + written slots; the Noop store snapshots empty", async () => {
    queryImpl = async () => [{ namespace: "seeded", value: "loaded" }];
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });

    runWithDurableState(store, () => {
      defineDurableState<string>("fresh").set("new");
    });

    const snap = store.snapshot();
    expect(snap.get("seeded")).toBe("loaded"); // seeded from the prior load
    expect(snap.get("fresh")).toBe("new"); // written this turn
    expect(snap.size).toBe(2);

    // The Noop store snapshots empty — an inactive turn threads nothing.
    expect(NOOP_DURABLE_STATE_STORE.snapshot().size).toBe(0);
  });

  it("returns a defensive copy — mutating the snapshot does not touch the store", async () => {
    queryImpl = async () => [{ namespace: "a", value: 1 }];
    const store = await buildDurableStateStore({
      conversationId: "conv-1",
      orgId: "org-1",
      active: true,
    });
    const snap = store.snapshot() as Map<string, unknown>;
    snap.set("a", 999);
    snap.set("b", 2);
    // The store's own view is unchanged.
    expect(store.snapshot().get("a")).toBe(1);
    expect(store.snapshot().has("b")).toBe(false);
  });
});

describe("renderDurableMemoryBlock — deterministic memory block (#3755)", () => {
  it("returns an empty string for an empty store (threads nothing)", () => {
    expect(renderDurableMemoryBlock(new Map())).toBe("");
  });

  it("renders the heading + every slot, sorted by name for stability", () => {
    // Insertion order is b, a — the load query has no ORDER BY, so the renderer
    // must sort so the block is byte-stable across loads (cache-friendly).
    const block = renderDurableMemoryBlock(
      new Map<string, unknown>([
        ["lastTable", "orders"],
        ["filters", { region: "EU" }],
      ]),
    );
    expect(block).toContain(DURABLE_MEMORY_BLOCK_HEADING);
    // Sorted: `filters` before `lastTable`.
    expect(block.indexOf("`filters`")).toBeLessThan(block.indexOf("`lastTable`"));
    // Values are rendered as compact JSON.
    expect(block).toContain('- `lastTable`: "orders"');
    expect(block).toContain('- `filters`: {"region":"EU"}');
  });

  it("renders an explicit null value rather than dropping the slot", () => {
    const block = renderDurableMemoryBlock(new Map<string, unknown>([["cleared", null]]));
    expect(block).toContain("- `cleared`: null");
  });

  it("fail-soft: a circular slot value renders a placeholder, never throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let block!: string;
    expect(() => {
      block = renderDurableMemoryBlock(new Map<string, unknown>([["bad", circular]]));
    }).not.toThrow();
    expect(block).toContain("- `bad`: [unserializable]");
  });

  it("renders a placeholder (not a literal 'undefined') for a value JSON.stringify drops", () => {
    // JSON.stringify of a top-level function/symbol returns the JS value
    // `undefined` WITHOUT throwing — the `?? "[unserializable]"` guard must catch
    // it so no stray literal `undefined` lands in the block. (Defensive: a loaded
    // snapshot is JSONB data, never a function — but the renderer must stay total.)
    const block = renderDurableMemoryBlock(new Map<string, unknown>([["fn", () => 1]]));
    expect(block).toContain("- `fn`: [unserializable]");
    expect(block).not.toContain("undefined");
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

  it("skips a single un-serializable slot without stranding the rest of the batch", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws on this slot
    expect(() =>
      commitSessionMemory({
        conversationId: "conv-1",
        orgId: "org-1",
        slots: [
          { namespace: "bad", value: circular }, // throws inside the try → skipped
          { namespace: "good", value: 2 }, // still committed
        ],
      }),
    ).not.toThrow();
    // The bad slot never reached internalExecute; the good slot still did.
    expect(execCalls).toHaveLength(1);
    expect((execCalls[0]!.params as unknown[])[2]).toBe("good");
  });
});
