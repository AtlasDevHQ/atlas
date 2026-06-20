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
const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown[]> = async () => [];

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    execCalls.push({ sql, params });
    if (throwOnExecute) throw new Error("exec boom");
  },
  internalQuery: (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    return queryImpl(sql, params);
  },
}));

const {
  defineDurableState,
  runWithDurableState,
  buildDurableStateStore,
  loadSessionMemory,
  commitSessionMemory,
  readSessionMemorySlots,
  listSessionMemory,
  resetSessionMemory,
  NOOP_DURABLE_STATE_STORE,
  DurableStateContextError,
  RESERVED_NAMESPACE_PREFIX,
  _resetDurableStateRegistry,
} = await import("@atlas/api/lib/durable-state");

beforeEach(() => {
  hasInternalDB = true;
  throwOnExecute = false;
  execCalls.length = 0;
  queryCalls.length = 0;
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

// ── Read / reset affordance (admin + in-conversation) — #3758 ──────────────────

describe("readSessionMemorySlots — tenant-scoped read", () => {
  it("returns [] without an internal DB (Noop) and never queries", async () => {
    hasInternalDB = false;
    expect(await readSessionMemorySlots({ conversationId: "conv-1", orgId: "org-1" })).toEqual([]);
    expect(queryCalls).toHaveLength(0);
  });

  it("maps rows to wire slots, coercing a Date updated_at to ISO", async () => {
    const when = new Date("2026-06-20T10:00:00.000Z");
    queryImpl = async () => [
      { namespace: "lastTable", value: "orders", updatedAt: when },
      { namespace: "region", value: "EU", updatedAt: "2026-06-20T11:00:00.000Z" },
    ];
    const slots = await readSessionMemorySlots({ conversationId: "conv-1", orgId: "org-1", strictOrg: true });
    expect(slots).toEqual([
      { namespace: "lastTable", value: "orders", updatedAt: "2026-06-20T10:00:00.000Z" },
      { namespace: "region", value: "EU", updatedAt: "2026-06-20T11:00:00.000Z" },
    ]);
  });

  it("JOINs conversations and threads the org scope (admin: strict org, no NULL fallback)", async () => {
    await readSessionMemorySlots({ conversationId: "conv-1", orgId: "org-1", strictOrg: true });
    const { sql, params } = queryCalls[0]!;
    expect(sql).toContain("JOIN conversations c");
    expect(sql).toContain("c.deleted_at IS NULL");
    expect(sql).toContain("c.org_id = $2");
    expect(sql).not.toContain("c.org_id IS NULL");
    expect(params).toEqual(["conv-1", "org-1"]);
  });

  it("threads the owner scope (userId + NULL-org fallback) for the in-conversation surface", async () => {
    await readSessionMemorySlots({ conversationId: "conv-1", userId: "user-1", orgId: "org-1" });
    const { sql, params } = queryCalls[0]!;
    expect(sql).toContain("c.user_id = $2");
    expect(sql).toContain("(c.org_id = $3 OR c.org_id IS NULL)");
    expect(params).toEqual(["conv-1", "user-1", "org-1"]);
  });

  it("returns [] when the scope matches nothing (cross-org read sees no rows)", async () => {
    queryImpl = async () => []; // a wrong-org conversation never matches the JOIN scope
    expect(await readSessionMemorySlots({ conversationId: "conv-1", orgId: "other-org", strictOrg: true })).toEqual([]);
  });

  it("is fail-soft: a query throw yields []", async () => {
    queryImpl = async () => {
      throw new Error("read boom");
    };
    expect(await readSessionMemorySlots({ conversationId: "conv-1", orgId: "org-1" })).toEqual([]);
  });
});

describe("listSessionMemory — admin overview", () => {
  it("returns [] without an internal DB (Noop)", async () => {
    hasInternalDB = false;
    expect(await listSessionMemory("org-1")).toEqual([]);
    expect(queryCalls).toHaveLength(0);
  });

  it("groups slots by session and surfaces the latest slot write as the session updatedAt", async () => {
    queryImpl = async () => [
      { conversationId: "conv-a", title: "Q2 revenue", namespace: "region", value: "EU", updatedAt: "2026-06-20T09:00:00.000Z" },
      { conversationId: "conv-a", title: "Q2 revenue", namespace: "table", value: "orders", updatedAt: "2026-06-20T12:00:00.000Z" },
      { conversationId: "conv-b", title: null, namespace: "x", value: 1, updatedAt: "2026-06-19T08:00:00.000Z" },
    ];
    const sessions = await listSessionMemory("org-1");
    // conv-a is most-recently-active → sorted first.
    expect(sessions.map((s) => s.conversationId)).toEqual(["conv-a", "conv-b"]);
    expect(sessions[0]!.title).toBe("Q2 revenue");
    expect(sessions[0]!.updatedAt).toBe("2026-06-20T12:00:00.000Z");
    expect(sessions[0]!.slots).toHaveLength(2);
    expect(sessions[1]!.title).toBeNull();
  });

  it("scopes strictly to the caller's org", async () => {
    await listSessionMemory("org-1");
    const { sql, params } = queryCalls[0]!;
    expect(sql).toContain("c.org_id = $1");
    expect(sql).toContain("c.deleted_at IS NULL");
    expect(params).toEqual(["org-1"]);
  });
});

describe("resetSessionMemory — tenant-scoped, idempotent clear", () => {
  it("no-ops to 0 without an internal DB (Noop) and never queries", async () => {
    hasInternalDB = false;
    expect(await resetSessionMemory({ conversationId: "conv-1", orgId: "org-1" })).toBe(0);
    expect(queryCalls).toHaveLength(0);
  });

  it("DELETEs scoped to the conversation + org and returns the cleared count", async () => {
    queryImpl = async () => [{ namespace: "a" }, { namespace: "b" }];
    const cleared = await resetSessionMemory({ conversationId: "conv-1", orgId: "org-1", strictOrg: true });
    expect(cleared).toBe(2);
    const { sql, params } = queryCalls[0]!;
    expect(sql).toContain("DELETE FROM agent_session_memory m");
    expect(sql).toContain("USING conversations c");
    expect(sql).toContain("m.conversation_id = $1");
    expect(sql).toContain("c.org_id = $2");
    expect(params).toEqual(["conv-1", "org-1"]);
  });

  it("clears a single namespace when one is given", async () => {
    queryImpl = async () => [{ namespace: "region" }];
    const cleared = await resetSessionMemory({
      conversationId: "conv-1",
      userId: "user-1",
      orgId: "org-1",
      namespace: "region",
    });
    expect(cleared).toBe(1);
    const { sql, params } = queryCalls[0]!;
    // conversationId=$1, userId=$2, orgId=$3, namespace=$4
    expect(sql).toContain("m.namespace = $4");
    expect(params).toEqual(["conv-1", "user-1", "org-1", "region"]);
  });

  it("is idempotent: a clear with nothing to delete returns 0 (no rows)", async () => {
    queryImpl = async () => [];
    expect(await resetSessionMemory({ conversationId: "conv-1", orgId: "org-1" })).toBe(0);
  });

  it("clears nothing for an out-of-scope conversation (cross-org reset matches no rows)", async () => {
    queryImpl = async () => []; // wrong org → JOIN scope excludes every slot
    expect(await resetSessionMemory({ conversationId: "conv-1", orgId: "other-org", strictOrg: true })).toBe(0);
  });

  it("is fail-soft: a delete throw yields 0", async () => {
    queryImpl = async () => {
      throw new Error("delete boom");
    };
    expect(await resetSessionMemory({ conversationId: "conv-1", orgId: "org-1" })).toBe(0);
  });
});

describe("reset → load: the runAgent seam threads no stale value after a reset", () => {
  it("a subsequent loadSessionMemory sees empty once the slots are cleared", async () => {
    // Turn N wrote a slot; the live store loads it.
    queryImpl = async () => [{ namespace: "region", value: "EU" }];
    expect((await loadSessionMemory("conv-1")).get("region")).toBe("EU");

    // The owner resets — the DELETE clears the row.
    queryImpl = async () => [{ namespace: "region" }];
    expect(await resetSessionMemory({ conversationId: "conv-1", userId: "user-1" })).toBe(1);

    // Turn N+1 loads from the (now-empty) table — nothing to thread.
    queryImpl = async () => [];
    expect((await loadSessionMemory("conv-1")).size).toBe(0);
  });
});
