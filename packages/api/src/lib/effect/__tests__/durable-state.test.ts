/**
 * Layer.provide tests for the `DurableState` Effect service (#3754, ADR-0020).
 * Verifies the real layer delegates to the plain load/commit helpers and the
 * Noop layer is inert — no top-level singleton mutation, every dependency
 * injected via `Layer.provide`.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import * as realInternal from "@atlas/api/lib/db/internal";

let hasInternalDB = true;
const execCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryRows: Array<{ namespace: string; value: unknown }> = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    execCalls.push({ sql, params });
  },
  internalQuery: async () => queryRows,
}));

const { DurableState } = await import("@atlas/api/lib/effect/services");
const { DurableStateLive, NoopDurableStateLayer, durableStateLayer } = await import(
  "@atlas/api/lib/effect/durable-state"
);

beforeEach(() => {
  hasInternalDB = true;
  execCalls.length = 0;
  queryRows = [];
});

describe("DurableStateLive", () => {
  it("reports available and loads a session's slots into a map", async () => {
    queryRows = [
      { namespace: "a", value: 1 },
      { namespace: "b", value: { nested: true } },
    ];
    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const ds = yield* DurableState;
        expect(ds.available).toBe(true);
        return yield* ds.load("conv-1");
      }).pipe(Effect.provide(DurableStateLive)),
    );

    expect(loaded.get("a")).toBe(1);
    expect(loaded.get("b")).toEqual({ nested: true });
  });

  it("commits dirty slots via internalExecute (one upsert per slot)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ds = yield* DurableState;
        ds.commit({
          conversationId: "conv-1",
          orgId: "org-1",
          slots: [
            { namespace: "a", value: 1 },
            { namespace: "b", value: "two" },
          ],
        });
      }).pipe(Effect.provide(DurableStateLive)),
    );

    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]!.sql).toContain("INSERT INTO agent_session_memory");
    expect(execCalls[0]!.sql).toContain("ON CONFLICT (conversation_id, namespace) DO UPDATE");
    expect(execCalls[0]!.params).toEqual(["conv-1", "org-1", "a", JSON.stringify(1)]);
    expect(execCalls[1]!.params).toEqual(["conv-1", "org-1", "b", JSON.stringify("two")]);
  });
});

describe("NoopDurableStateLayer", () => {
  it("reports unavailable, loads empty, commits nothing", async () => {
    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const ds = yield* DurableState;
        expect(ds.available).toBe(false);
        ds.commit({
          conversationId: "conv-1",
          orgId: null,
          slots: [{ namespace: "a", value: 1 }],
        });
        return yield* ds.load("conv-1");
      }).pipe(Effect.provide(NoopDurableStateLayer)),
    );

    expect(loaded.size).toBe(0);
    expect(execCalls).toHaveLength(0);
  });
});

describe("durableStateLayer selector", () => {
  it("selects the real layer when an internal DB is present", async () => {
    const available = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* DurableState).available;
      }).pipe(Effect.provide(durableStateLayer(true))),
    );
    expect(available).toBe(true);
  });

  it("selects the Noop layer when no internal DB is present", async () => {
    const available = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* DurableState).available;
      }).pipe(Effect.provide(durableStateLayer(false))),
    );
    expect(available).toBe(false);
  });
});
