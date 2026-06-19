/**
 * Layer.provide tests for the `DurableSession` Effect service (#3745,
 * ADR-0020). Verifies the real layer delegates to the plain write/sweep
 * helpers and the Noop layer is inert — no top-level singleton mutation, every
 * dependency injected via `Layer.provide`.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import * as realInternal from "@atlas/api/lib/db/internal";

let hasInternalDB = true;
const execCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryRows: Array<{ id: string }> = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    execCalls.push({ sql, params });
  },
  internalQuery: async () => queryRows,
}));

mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: () => undefined,
}));

const { DurableSession } = await import("@atlas/api/lib/effect/services");
const { DurableSessionLive, NoopDurableSessionLayer, durableSessionLayer } = await import(
  "@atlas/api/lib/effect/durable-session"
);

beforeEach(() => {
  hasInternalDB = true;
  execCalls.length = 0;
  queryRows = [];
});

describe("DurableSessionLive", () => {
  it("reports available and records a terminal run via internalExecute", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ds = yield* DurableSession;
        expect(ds.available).toBe(true);
        ds.recordTerminal({
          runId: "run-1",
          conversationId: "conv-1",
          orgId: "org-1",
          status: "done",
          stepIndex: 1,
          transcript: [],
        });
      }).pipe(Effect.provide(DurableSessionLive)),
    );

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.sql).toContain("INSERT INTO agent_runs");
    expect(execCalls[0]!.sql).toContain("status = EXCLUDED.status");
  });

  it("records a per-step `running` checkpoint via internalExecute", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ds = yield* DurableSession;
        ds.recordCheckpoint({
          runId: "run-1",
          conversationId: "conv-1",
          orgId: "org-1",
          stepIndex: 2,
          transcript: [],
        });
      }).pipe(Effect.provide(DurableSessionLive)),
    );

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(execCalls[0]!.params?.[3]).toBe("running");
  });

  it("sweepTerminal returns the deleted count", async () => {
    queryRows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const deleted = await Effect.runPromise(
      Effect.gen(function* () {
        const ds = yield* DurableSession;
        return yield* ds.sweepTerminal(30);
      }).pipe(Effect.provide(DurableSessionLive)),
    );
    expect(deleted).toBe(3);
  });
});

describe("NoopDurableSessionLayer", () => {
  it("reports unavailable, records nothing, sweeps nothing", async () => {
    const deleted = await Effect.runPromise(
      Effect.gen(function* () {
        const ds = yield* DurableSession;
        expect(ds.available).toBe(false);
        ds.recordCheckpoint({
          runId: "run-1",
          conversationId: "conv-1",
          orgId: null,
          stepIndex: 1,
          transcript: [],
        });
        ds.recordTerminal({
          runId: "run-1",
          conversationId: "conv-1",
          orgId: null,
          status: "failed",
          stepIndex: 0,
          transcript: [],
        });
        return yield* ds.sweepTerminal(30);
      }).pipe(Effect.provide(NoopDurableSessionLayer)),
    );

    expect(execCalls).toHaveLength(0);
    expect(deleted).toBe(0);
  });
});

describe("durableSessionLayer selector", () => {
  it("selects the real layer when an internal DB is present", async () => {
    const available = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* DurableSession).available;
      }).pipe(Effect.provide(durableSessionLayer(true))),
    );
    expect(available).toBe(true);
  });

  it("selects the Noop layer when no internal DB is present", async () => {
    const available = await Effect.runPromise(
      Effect.gen(function* () {
        return (yield* DurableSession).available;
      }).pipe(Effect.provide(durableSessionLayer(false))),
    );
    expect(available).toBe(false);
  });
});
