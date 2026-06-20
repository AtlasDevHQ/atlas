/**
 * Unit tests for the durable-session plain helpers (#3745, ADR-0020).
 *
 * Covers the write path (`recordTerminalAgentRun`), the retention sweep
 * (`sweepTerminalAgentRuns`), and the settings readers (`isDurabilityEnabled`,
 * `getRetentionDays`) — the no-DB gate, the INSERT/DELETE shape, terminal-only
 * sweeping, and the default-off / default-retention fallbacks.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { ModelMessage } from "ai";
import * as realInternal from "@atlas/api/lib/db/internal";
import * as realLogger from "@atlas/api/lib/logger";

let hasInternalDB = true;
const execCalls: Array<{ sql: string; params?: unknown[] }> = [];
const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryRows: Array<{ id: string }> = [];
let queryThrow: Error | null = null;
// Captures the fail-soft warn the write helpers must emit so a circular
// transcript (or any synchronous throw) is observable, not silently swallowed.
const warnCalls: Array<{ obj: unknown; msg: unknown }> = [];

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  hasInternalDB: () => hasInternalDB,
  internalExecute: (sql: string, params?: unknown[]) => {
    execCalls.push({ sql, params });
  },
  internalQuery: async (sql: string, params?: unknown[]) => {
    queryCalls.push({ sql, params });
    if (queryThrow) throw queryThrow;
    return queryRows;
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  ...realLogger,
  createLogger: () => ({
    warn: (obj: unknown, msg?: unknown) => {
      warnCalls.push({ obj, msg });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

let settingValue: Record<string, string | undefined> = {};
mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) => settingValue[key],
}));

const {
  recordRunCheckpoint,
  recordTerminalAgentRun,
  sweepTerminalAgentRuns,
  isDurabilityEnabled,
  getRetentionDays,
  DEFAULT_RETENTION_DAYS,
} = await import("@atlas/api/lib/durable-session");

beforeEach(() => {
  hasInternalDB = true;
  execCalls.length = 0;
  queryCalls.length = 0;
  warnCalls.length = 0;
  queryRows = [];
  queryThrow = null;
  settingValue = {};
});

describe("recordTerminalAgentRun", () => {
  it("upserts a single agent_runs row keyed on run id with status + transcript params", () => {
    recordTerminalAgentRun({
      runId: "run-1",
      conversationId: "conv-1",
      orgId: "org-9",
      status: "done",
      stepIndex: 3,
      transcript: [{ role: "user", content: "hi" }],
    });

    expect(execCalls).toHaveLength(1);
    const call = execCalls[0]!;
    expect(call.sql).toContain("INSERT INTO agent_runs");
    // In-place update keyed on the run id (one row per turn), not append.
    expect(call.sql).toContain("ON CONFLICT (id) DO UPDATE");
    // Terminal write always wins the status; step index never regresses.
    expect(call.sql).toContain("status = EXCLUDED.status");
    expect(call.sql).toContain("step_index = GREATEST(agent_runs.step_index, EXCLUDED.step_index)");
    expect(call.sql).toContain("$6::jsonb");
    expect(call.params).toEqual([
      "run-1",
      "conv-1",
      "org-9",
      "done",
      3,
      JSON.stringify([{ role: "user", content: "hi" }]),
    ]);
  });

  it("is a no-op when no internal DB is configured", () => {
    hasInternalDB = false;
    recordTerminalAgentRun({
      runId: "run-1",
      conversationId: "conv-1",
      orgId: null,
      status: "failed",
      stepIndex: 0,
      transcript: [],
    });
    expect(execCalls).toHaveLength(0);
  });

  it("serializes a nullish transcript as an empty array (runtime guard)", () => {
    // The arg type is `ModelMessage[]`, so callers can't pass null; the `?? []`
    // is a belt-and-suspenders guard for a nullish value crossing an untyped
    // boundary. Cast to exercise that runtime defense.
    recordTerminalAgentRun({
      runId: "run-1",
      conversationId: "conv-1",
      orgId: null,
      status: "done",
      stepIndex: 0,
      transcript: null as unknown as ModelMessage[],
    });
    expect((execCalls[0]!.params as unknown[])[5]).toBe("[]");
  });

  it("never throws and writes nothing when JSON.stringify fails (circular transcript)", () => {
    // The documented synchronous-throw hazard: a circular structure makes
    // `JSON.stringify` throw. The helper must catch it (fail-soft), so the
    // stream is never disrupted and no row is written.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      recordTerminalAgentRun({
        runId: "run-1",
        conversationId: "conv-1",
        orgId: null,
        status: "done",
        stepIndex: 0,
        transcript: [circular] as unknown as ModelMessage[],
      }),
    ).not.toThrow();
    expect(execCalls).toHaveLength(0);
    // Fail-soft, not silent: the catch must log a type-narrowed warn so the
    // dropped checkpoint is observable.
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.msg).toBe("Failed to record terminal agent run checkpoint");
    expect((warnCalls[0]!.obj as { err: unknown }).err).toBeTypeOf("string");
  });
});

describe("recordRunCheckpoint", () => {
  it("upserts a `running` checkpoint keyed on run id, advancing step index in place", () => {
    recordRunCheckpoint({
      runId: "run-1",
      conversationId: "conv-1",
      orgId: "org-9",
      stepIndex: 2,
      transcript: [{ role: "user", content: "hi" }],
    });

    expect(execCalls).toHaveLength(1);
    const call = execCalls[0]!;
    expect(call.sql).toContain("INSERT INTO agent_runs");
    // In-place update keyed on the run id — one row per turn, not append.
    expect(call.sql).toContain("ON CONFLICT (id) DO UPDATE");
    // Monotonic step index: a reordered fire-and-forget write can't regress it.
    expect(call.sql).toContain("step_index = GREATEST(agent_runs.step_index, EXCLUDED.step_index)");
    // Transcript is reorder-safe too: only overwritten when the incoming
    // checkpoint is at least as advanced as the stored row.
    expect(call.sql).toContain("WHEN EXCLUDED.step_index >= agent_runs.step_index THEN EXCLUDED.transcript");
    // Guard: a stale checkpoint must never resurrect a terminated/parked row.
    expect(call.sql).toContain("WHERE agent_runs.status NOT IN ('done', 'failed', 'parked')");
    expect(call.sql).toContain("$6::jsonb");
    expect(call.params).toEqual([
      "run-1",
      "conv-1",
      "org-9",
      "running",
      2,
      JSON.stringify([{ role: "user", content: "hi" }]),
    ]);
  });

  it("is a no-op when no internal DB is configured", () => {
    hasInternalDB = false;
    recordRunCheckpoint({
      runId: "run-1",
      conversationId: "conv-1",
      orgId: null,
      stepIndex: 1,
      transcript: [],
    });
    expect(execCalls).toHaveLength(0);
  });

  it("never throws and writes nothing when JSON.stringify fails (circular transcript)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      recordRunCheckpoint({
        runId: "run-1",
        conversationId: "conv-1",
        orgId: null,
        stepIndex: 1,
        transcript: [circular] as unknown as ModelMessage[],
      }),
    ).not.toThrow();
    expect(execCalls).toHaveLength(0);
    // Fail-soft, not silent: the catch must log a type-narrowed warn.
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.msg).toBe("Failed to record agent run checkpoint");
    expect((warnCalls[0]!.obj as { err: unknown }).err).toBeTypeOf("string");
  });
});

describe("sweepTerminalAgentRuns", () => {
  it("deletes only terminal runs past the window and returns the count", async () => {
    queryRows = [{ id: "a" }, { id: "b" }];
    const count = await sweepTerminalAgentRuns(7);

    expect(count).toBe(2);
    expect(queryCalls).toHaveLength(1);
    const call = queryCalls[0]!;
    expect(call.sql).toContain("DELETE FROM agent_runs");
    expect(call.sql).toContain("status IN ('done', 'failed')");
    // Non-terminal runs must never be swept.
    expect(call.sql).not.toContain("'running'");
    expect(call.sql).not.toContain("'parked'");
    expect(call.params).toEqual(["7"]);
  });

  it("returns 0 and issues no query when no internal DB is configured", async () => {
    hasInternalDB = false;
    const count = await sweepTerminalAgentRuns(30);
    expect(count).toBe(0);
    expect(queryCalls).toHaveLength(0);
  });

  it("falls back to the default window for a non-positive retention value", async () => {
    await sweepTerminalAgentRuns(0);
    expect((queryCalls[0]!.params as unknown[])[0]).toBe(String(DEFAULT_RETENTION_DAYS));
  });

  it("returns -1 (never throws) on a DB error", async () => {
    queryThrow = new Error("connection reset");
    const count = await sweepTerminalAgentRuns(30);
    expect(count).toBe(-1);
  });
});

describe("isDurabilityEnabled", () => {
  it("is false by default (flag unset)", () => {
    expect(isDurabilityEnabled("org-1")).toBe(false);
  });

  it("is true only when the flag is exactly 'true'", () => {
    settingValue = { ATLAS_DURABILITY_ENABLED: "true" };
    expect(isDurabilityEnabled("org-1")).toBe(true);
    settingValue = { ATLAS_DURABILITY_ENABLED: "1" };
    expect(isDurabilityEnabled("org-1")).toBe(false);
  });
});

describe("getRetentionDays", () => {
  it("returns the default when unset", () => {
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("parses a positive integer setting", () => {
    settingValue = { ATLAS_DURABILITY_RETENTION_DAYS: "14" };
    expect(getRetentionDays()).toBe(14);
  });

  it("falls back to the default for a non-positive or unparseable value", () => {
    settingValue = { ATLAS_DURABILITY_RETENTION_DAYS: "0" };
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    settingValue = { ATLAS_DURABILITY_RETENTION_DAYS: "abc" };
    expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });
});
