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
let queryRows: Array<Record<string, unknown>> = [];
// Optional per-call response queue: when set, each `internalQuery` call shifts
// the next array off it (the lease helper issues two queries — existence SELECT
// then claim UPDATE — and needs distinct results). Falls back to `queryRows`
// when the queue is exhausted/unset so existing single-query tests are unchanged.
let queryRowsByCall: Array<Array<Record<string, unknown>>> | null = null;
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
    if (queryRowsByCall && queryRowsByCall.length > 0) return queryRowsByCall.shift()!;
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
  recordParkedAgentRun,
  sweepTerminalAgentRuns,
  sweepExpiredParkedRuns,
  loadParkedRunByApprovalRef,
  resolveParkedRun,
  isDurabilityEnabled,
  getRetentionDays,
  getResumeLeaseSeconds,
  getMaxParkMinutes,
  loadAndLeaseResumableRun,
  releaseResumeLease,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_RESUME_LEASE_SECONDS,
  DEFAULT_MAX_PARK_MINUTES,
} = await import("@atlas/api/lib/durable-session");

beforeEach(() => {
  hasInternalDB = true;
  execCalls.length = 0;
  queryCalls.length = 0;
  warnCalls.length = 0;
  queryRows = [];
  queryRowsByCall = null;
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

describe("recordParkedAgentRun (#3748)", () => {
  it("upserts a `parked` row carrying the approval ref in parked_reason ($7)", () => {
    recordParkedAgentRun({
      runId: "run-1",
      conversationId: "conv-1",
      orgId: "org-9",
      stepIndex: 4,
      transcript: [{ role: "user", content: "hi" }],
      parkedReason: "req-42",
    });

    expect(execCalls).toHaveLength(1);
    const call = execCalls[0]!;
    expect(call.sql).toContain("INSERT INTO agent_runs");
    expect(call.sql).toContain("parked_reason");
    expect(call.sql).toContain("ON CONFLICT (id) DO UPDATE");
    // Park is the authoritative end-of-stream — overwrites unconditionally.
    expect(call.sql).toContain("status = EXCLUDED.status");
    expect(call.sql).toContain("parked_reason = EXCLUDED.parked_reason");
    expect(call.params).toEqual([
      "run-1",
      "conv-1",
      "org-9",
      "parked",
      4,
      JSON.stringify([{ role: "user", content: "hi" }]),
      "req-42",
    ]);
  });

  it("is a no-op when no internal DB is configured", () => {
    hasInternalDB = false;
    recordParkedAgentRun({
      runId: "run-1",
      conversationId: "conv-1",
      orgId: null,
      stepIndex: 0,
      transcript: [],
      parkedReason: "req-1",
    });
    expect(execCalls).toHaveLength(0);
  });

  it("never throws and writes nothing when JSON.stringify fails (circular transcript)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      recordParkedAgentRun({
        runId: "run-1",
        conversationId: "conv-1",
        orgId: null,
        stepIndex: 0,
        transcript: [circular] as unknown as ModelMessage[],
        parkedReason: "req-1",
      }),
    ).not.toThrow();
    expect(execCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]!.msg).toBe("Failed to record parked agent run checkpoint");
  });
});

describe("sweepExpiredParkedRuns (#3748)", () => {
  it("fails only parked runs past the max-park window and returns the count", async () => {
    queryRows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const count = await sweepExpiredParkedRuns(60);

    expect(count).toBe(3);
    expect(queryCalls).toHaveLength(1);
    const call = queryCalls[0]!;
    expect(call.sql).toContain("UPDATE agent_runs");
    expect(call.sql).toContain("SET status = 'failed'");
    expect(call.sql).toContain("WHERE status = 'parked'");
    // Measured in minutes off the park time (updated_at).
    expect(call.sql).toContain("minutes");
    expect(call.params).toEqual(["60"]);
  });

  it("returns 0 and issues no query when no internal DB is configured", async () => {
    hasInternalDB = false;
    expect(await sweepExpiredParkedRuns(60)).toBe(0);
    expect(queryCalls).toHaveLength(0);
  });

  it("falls back to the default window for a non-positive value", async () => {
    await sweepExpiredParkedRuns(0);
    expect((queryCalls[0]!.params as unknown[])[0]).toBe(String(DEFAULT_MAX_PARK_MINUTES));
  });

  it("returns -1 (never throws) on a DB error", async () => {
    queryThrow = new Error("connection reset");
    expect(await sweepExpiredParkedRuns(60)).toBe(-1);
  });
});

describe("loadParkedRunByApprovalRef (#3748)", () => {
  it("loads the parked run keyed on parked_reason and maps the row", async () => {
    queryRows = [
      {
        id: "run-9",
        conversation_id: "conv-1",
        org_id: "org-1",
        step_index: 3,
        transcript: [{ role: "user", content: "hi" }],
      },
    ];
    const parked = await loadParkedRunByApprovalRef("req-42");
    expect(parked).not.toBeNull();
    expect(parked!.runId).toBe("run-9");
    expect(parked!.conversationId).toBe("conv-1");
    expect(parked!.orgId).toBe("org-1");
    expect(parked!.stepIndex).toBe(3);
    expect(parked!.transcript).toEqual([{ role: "user", content: "hi" }]);

    const call = queryCalls[0]!;
    expect(call.sql).toContain("FROM agent_runs");
    expect(call.sql).toContain("WHERE parked_reason = $1 AND status = 'parked'");
    expect(call.params).toEqual(["req-42"]);
  });

  it("returns null when no parked run matches", async () => {
    queryRows = [];
    expect(await loadParkedRunByApprovalRef("req-x")).toBeNull();
  });

  it("returns null (never throws) on a DB error", async () => {
    queryThrow = new Error("boom");
    expect(await loadParkedRunByApprovalRef("req-x")).toBeNull();
    expect(warnCalls.some((w) => w.msg === "Failed to load parked run for approval resolution")).toBe(true);
  });

  it("clamps a corrupt negative step_index to 0", async () => {
    queryRows = [{ id: "r", conversation_id: "c", org_id: null, step_index: -2, transcript: [] }];
    expect((await loadParkedRunByApprovalRef("req-1"))!.stepIndex).toBe(0);
  });
});

describe("resolveParkedRun (#3748)", () => {
  it("writes the rewritten transcript and flips parked → running, clearing parked_reason", async () => {
    queryRows = [{ id: "run-9" }];
    const ok = await resolveParkedRun({
      runId: "run-9",
      transcript: [{ role: "tool", content: "approved" }] as unknown as ModelMessage[],
      stepIndex: 3,
    });
    expect(ok).toBe(true);
    const call = queryCalls[0]!;
    expect(call.sql).toContain("UPDATE agent_runs");
    expect(call.sql).toContain("status = 'running'");
    expect(call.sql).toContain("parked_reason = NULL");
    // Guard: only a still-parked row is resolvable (double-resolution is a no-op).
    expect(call.sql).toContain("WHERE id = $1 AND status = 'parked'");
    expect(call.params).toEqual([
      "run-9",
      JSON.stringify([{ role: "tool", content: "approved" }]),
      3,
    ]);
  });

  it("returns false when no parked row was updated (already resolved / double-review)", async () => {
    queryRows = [];
    expect(
      await resolveParkedRun({ runId: "run-9", transcript: [], stepIndex: 0 }),
    ).toBe(false);
  });

  it("returns false (never throws) on a DB error", async () => {
    queryThrow = new Error("boom");
    expect(
      await resolveParkedRun({ runId: "run-9", transcript: [], stepIndex: 0 }),
    ).toBe(false);
    expect(warnCalls.some((w) => w.msg === "Failed to resolve parked agent run")).toBe(true);
  });

  it("is a no-op returning false when no internal DB is configured", async () => {
    hasInternalDB = false;
    expect(
      await resolveParkedRun({ runId: "run-9", transcript: [], stepIndex: 0 }),
    ).toBe(false);
    expect(queryCalls).toHaveLength(0);
  });
});

describe("getMaxParkMinutes (#3748)", () => {
  it("returns the default when unset", () => {
    expect(getMaxParkMinutes()).toBe(DEFAULT_MAX_PARK_MINUTES);
  });

  it("parses a positive integer setting", () => {
    settingValue = { ATLAS_DURABILITY_MAX_PARK_MINUTES: "30" };
    expect(getMaxParkMinutes()).toBe(30);
  });

  it("falls back to the default for a non-positive or unparseable value", () => {
    settingValue = { ATLAS_DURABILITY_MAX_PARK_MINUTES: "0" };
    expect(getMaxParkMinutes()).toBe(DEFAULT_MAX_PARK_MINUTES);
    settingValue = { ATLAS_DURABILITY_MAX_PARK_MINUTES: "soon" };
    expect(getMaxParkMinutes()).toBe(DEFAULT_MAX_PARK_MINUTES);
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

describe("getResumeLeaseSeconds", () => {
  it("returns the default when unset", () => {
    expect(getResumeLeaseSeconds()).toBe(DEFAULT_RESUME_LEASE_SECONDS);
  });

  it("parses a positive integer setting", () => {
    settingValue = { ATLAS_DURABILITY_RESUME_LEASE_SECONDS: "120" };
    expect(getResumeLeaseSeconds()).toBe(120);
  });

  it("falls back to the default for a non-positive or unparseable value", () => {
    settingValue = { ATLAS_DURABILITY_RESUME_LEASE_SECONDS: "0" };
    expect(getResumeLeaseSeconds()).toBe(DEFAULT_RESUME_LEASE_SECONDS);
    settingValue = { ATLAS_DURABILITY_RESUME_LEASE_SECONDS: "nope" };
    expect(getResumeLeaseSeconds()).toBe(DEFAULT_RESUME_LEASE_SECONDS);
  });
});

describe("loadAndLeaseResumableRun", () => {
  it("returns no_db when no internal DB is configured", async () => {
    hasInternalDB = false;
    const claim = await loadAndLeaseResumableRun("conv-1", 300);
    expect(claim.status).toBe("no_db");
    expect(queryCalls).toHaveLength(0);
  });

  it("returns none when no non-terminal run exists", async () => {
    // First query (existence SELECT) returns no rows.
    queryRowsByCall = [[]];
    const claim = await loadAndLeaseResumableRun("conv-1", 300);
    expect(claim.status).toBe("none");
    // Only the existence SELECT runs — no claim UPDATE when there's nothing to claim.
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]!.sql).toContain("SELECT id FROM agent_runs");
  });

  it("claims the lease and returns the run when a non-terminal run is free", async () => {
    queryRowsByCall = [
      [{ id: "run-9" }], // existence SELECT
      [
        {
          id: "run-9",
          org_id: "org-1",
          step_index: 2,
          transcript: [{ role: "user", content: "hi" }],
        },
      ], // claim UPDATE ... RETURNING
    ];
    const claim = await loadAndLeaseResumableRun("conv-1", 300);
    expect(claim.status).toBe("resumable");
    if (claim.status !== "resumable") throw new Error("unreachable");
    expect(claim.run.runId).toBe("run-9");
    expect(claim.run.orgId).toBe("org-1");
    expect(claim.run.stepIndex).toBe(2);
    expect(claim.run.transcript).toEqual([{ role: "user", content: "hi" }]);
    // A fresh per-resume lease token was minted.
    expect(claim.run.leaseOwner).toMatch(/^[0-9a-f-]{36}$/);

    // The claim is an atomic CTE UPDATE with the single-flight guard.
    const claimQuery = queryCalls[1]!;
    expect(claimQuery.sql).toContain("UPDATE agent_runs");
    expect(claimQuery.sql).toContain("resuming_lease IS NULL OR resuming_lease < now()");
    expect(claimQuery.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimQuery.sql).toContain("resuming_lease_owner = $3");
    // TTL + owner token are bound params (no SQL interpolation).
    expect((claimQuery.params as unknown[])[1]).toBe("300");
    expect((claimQuery.params as unknown[])[2]).toBe(claim.run.leaseOwner);
  });

  it("returns leased (single-flight rejection) when a run exists but the claim wins nothing", async () => {
    queryRowsByCall = [
      [{ id: "run-9" }], // existence SELECT — a non-terminal run IS present
      [], // claim UPDATE updated nothing — another resumer holds a live lease
    ];
    const claim = await loadAndLeaseResumableRun("conv-1", 300);
    expect(claim.status).toBe("leased");
  });

  it("fails closed (error, never resumes) when the claim query throws", async () => {
    queryThrow = new Error("connection reset");
    const claim = await loadAndLeaseResumableRun("conv-1", 300);
    expect(claim.status).toBe("error");
    // Fail-soft logging, not a silent swallow.
    expect(warnCalls.some((w) => w.msg === "Failed to load/lease resumable run")).toBe(true);
  });

  it("clamps a non-positive TTL to the default before binding it", async () => {
    queryRowsByCall = [
      [{ id: "run-9" }],
      [{ id: "run-9", org_id: null, step_index: 0, transcript: [] }],
    ];
    await loadAndLeaseResumableRun("conv-1", 0);
    expect((queryCalls[1]!.params as unknown[])[1]).toBe(String(DEFAULT_RESUME_LEASE_SECONDS));
  });

  it("clamps a corrupt negative step_index to 0 at the read boundary", async () => {
    queryRowsByCall = [
      [{ id: "run-9" }],
      [{ id: "run-9", org_id: null, step_index: -5, transcript: [] }],
    ];
    const claim = await loadAndLeaseResumableRun("conv-1", 300);
    expect(claim.status).toBe("resumable");
    if (claim.status !== "resumable") throw new Error("unreachable");
    // A negative offset must never reach the resume math — clamp it non-negative.
    expect(claim.run.stepIndex).toBe(0);
  });
});

describe("releaseResumeLease", () => {
  it("clears the lease only while this resumer still owns it (owner-guarded)", () => {
    releaseResumeLease({ runId: "run-9", leaseOwner: "owner-token-1" });
    expect(execCalls).toHaveLength(1);
    const call = execCalls[0]!;
    expect(call.sql).toContain("UPDATE agent_runs");
    expect(call.sql).toContain("resuming_lease = NULL");
    expect(call.sql).toContain("resuming_lease_owner = NULL");
    // The owner guard is what keeps a TTL-expired late release from wiping a
    // re-claimed live lease.
    expect(call.sql).toContain("resuming_lease_owner = $2");
    expect(call.params).toEqual(["run-9", "owner-token-1"]);
  });

  it("is a no-op when no internal DB is configured", () => {
    hasInternalDB = false;
    releaseResumeLease({ runId: "run-9", leaseOwner: "owner-token-1" });
    expect(execCalls).toHaveLength(0);
  });
});
