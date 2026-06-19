/**
 * Unit tests for the durable-session plain helpers (#3745, ADR-0020).
 *
 * Covers the write path (`recordTerminalAgentRun`), the retention sweep
 * (`sweepTerminalAgentRuns`), and the settings readers (`isDurabilityEnabled`,
 * `getRetentionDays`) — the no-DB gate, the INSERT/DELETE shape, terminal-only
 * sweeping, and the default-off / default-retention fallbacks.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import * as realInternal from "@atlas/api/lib/db/internal";

let hasInternalDB = true;
const execCalls: Array<{ sql: string; params?: unknown[] }> = [];
const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
let queryRows: Array<{ id: string }> = [];
let queryThrow: Error | null = null;

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

let settingValue: Record<string, string | undefined> = {};
mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) => settingValue[key],
}));

const {
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
  queryRows = [];
  queryThrow = null;
  settingValue = {};
});

describe("recordTerminalAgentRun", () => {
  it("writes a single INSERT INTO agent_runs with status + transcript params", () => {
    recordTerminalAgentRun({
      conversationId: "conv-1",
      orgId: "org-9",
      status: "done",
      stepIndex: 3,
      transcript: [{ role: "user", content: "hi" }],
    });

    expect(execCalls).toHaveLength(1);
    const call = execCalls[0]!;
    expect(call.sql).toContain("INSERT INTO agent_runs");
    expect(call.sql).toContain("$5::jsonb");
    expect(call.params).toEqual([
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
      conversationId: "conv-1",
      orgId: null,
      status: "failed",
      stepIndex: 0,
      transcript: [],
    });
    expect(execCalls).toHaveLength(0);
  });

  it("serializes a null transcript as an empty array", () => {
    recordTerminalAgentRun({
      conversationId: "conv-1",
      orgId: null,
      status: "done",
      stepIndex: 0,
      transcript: null,
    });
    expect((execCalls[0]!.params as unknown[])[4]).toBe("[]");
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
