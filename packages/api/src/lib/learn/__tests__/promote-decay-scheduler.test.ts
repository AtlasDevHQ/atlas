import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { loadSettings, _resetSettingsCache } from "@atlas/api/lib/settings";

// ---------------------------------------------------------------------------
// Mock internal DB. `dbAvailable` / `settingsRows` drive the settings tier
// chain (same shape as the expert-scheduler test). `candidates` feeds the tick;
// `promotedIds` / `demotedIds` capture what the tick asked the DB to flip.
// ---------------------------------------------------------------------------
let dbAvailable = false;
let settingsRows: Array<{
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
  org_id: string | null;
}> = [];

let candidates: Array<Record<string, unknown>> = [];
let promotedIds: readonly string[] = [];
let demotedIds: readonly string[] = [];
let invalidatedOrgs: Array<string | null> = [];
let failPromote = false;
let failDemote = false;

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => dbAvailable,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async () => settingsRows,
  internalExecute: () => {},
  getApprovedPatterns: async () => [],
  getPromoteDecayCandidates: async () => candidates,
  promoteLearnedPatterns: async (ids: readonly string[]) => {
    if (failPromote) throw new Error("boom");
    promotedIds = ids;
    return { count: ids.length, orgIds: ids.length > 0 ? ["org-a"] : [] };
  },
  demoteLearnedPatterns: async (ids: readonly string[]) => {
    if (failDemote) throw new Error("kaboom");
    demotedIds = ids;
    return { count: ids.length, orgIds: ids.length > 0 ? ["org-b"] : [] };
  },
  getEncryptionKey: () => null,
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  setWorkspaceRegion: mock(async () => {}),
}));

// The scheduler only touches pattern-cache via a dynamic import of
// invalidatePatternCache (in runPromoteDecayTick), which we observe here. It no
// longer reads any default constant from pattern-cache (those moved to
// learn-settings, #3722), so this mock stubs only the invalidation hook.
mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  invalidatePatternCache: (orgId: string | null) => {
    invalidatedOrgs.push(orgId);
  },
}));

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  isPromoteDecaySchedulerEnabled,
  getPromoteDecaySchedulerIntervalMs,
  resolvePromoteDecayThresholds,
  runPromoteDecayTick,
  DEFAULT_PROMOTE_DECAY_INTERVAL_MS,
} = await import("@atlas/api/lib/learn/promote-decay-scheduler");

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function candidateRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "c",
    type: "query_pattern",
    status: "pending",
    confidence: 0.9,
    repetition_count: 10,
    avg_duration_ms: 200,
    last_seen_at: daysAgo(1),
    auto_promoted: false,
    ...over,
  };
}

beforeEach(() => {
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED;
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS;
  _resetSettingsCache();
  dbAvailable = false;
  settingsRows = [];
  candidates = [];
  promotedIds = [];
  demotedIds = [];
  invalidatedOrgs = [];
  failPromote = false;
  failDemote = false;
});

afterEach(() => {
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED;
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS;
  _resetSettingsCache();
});

describe("isPromoteDecaySchedulerEnabled", () => {
  it("is off by default", () => {
    expect(isPromoteDecaySchedulerEnabled()).toBe(false);
  });

  it("turns on for 'true' / '1'", () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "true";
    expect(isPromoteDecaySchedulerEnabled()).toBe(true);
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "1";
    expect(isPromoteDecaySchedulerEnabled()).toBe(true);
  });

  it("a platform DB override beats the env var (#3392 pattern)", async () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "false";
    dbAvailable = true;
    settingsRows = [
      { key: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED", value: "true", updated_at: "2026-01-01", updated_by: null, org_id: null },
    ];
    await loadSettings();
    expect(isPromoteDecaySchedulerEnabled()).toBe(true);
  });
});

describe("getPromoteDecaySchedulerIntervalMs", () => {
  it("defaults to 24h", () => {
    expect(getPromoteDecaySchedulerIntervalMs()).toBe(DEFAULT_PROMOTE_DECAY_INTERVAL_MS);
  });

  it("converts hours to ms", () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS = "6";
    expect(getPromoteDecaySchedulerIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });

  it("falls back to the default on a non-positive / invalid value", () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS = "0";
    expect(getPromoteDecaySchedulerIntervalMs()).toBe(DEFAULT_PROMOTE_DECAY_INTERVAL_MS);
    process.env.ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS = "abc";
    expect(getPromoteDecaySchedulerIntervalMs()).toBe(DEFAULT_PROMOTE_DECAY_INTERVAL_MS);
  });
});

describe("resolvePromoteDecayThresholds", () => {
  it("uses registry defaults when nothing is set", () => {
    const t = resolvePromoteDecayThresholds();
    expect(t.confidenceThreshold).toBe(0.7);
    expect(t.minRepetitions).toBe(5);
    expect(t.latencyBudgetMs).toBe(5000);
    expect(t.decayUnseenMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("reads platform DB overrides", async () => {
    dbAvailable = true;
    settingsRows = [
      { key: "ATLAS_LEARN_PROMOTE_MIN_REPETITIONS", value: "12", updated_at: "x", updated_by: null, org_id: null },
      { key: "ATLAS_LEARN_DECAY_UNSEEN_DAYS", value: "7", updated_at: "x", updated_by: null, org_id: null },
      { key: "ATLAS_LEARN_LATENCY_BUDGET_MS", value: "1500", updated_at: "x", updated_by: null, org_id: null },
    ];
    await loadSettings();
    const t = resolvePromoteDecayThresholds();
    expect(t.minRepetitions).toBe(12);
    expect(t.latencyBudgetMs).toBe(1500);
    expect(t.decayUnseenMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("runPromoteDecayTick", () => {
  it("no-ops without an internal DB", async () => {
    dbAvailable = false;
    const r = await runPromoteDecayTick();
    expect(r).toEqual({ candidates: 0, promoted: 0, demoted: 0, errors: 0 });
    expect(promotedIds).toEqual([]);
    expect(demotedIds).toEqual([]);
  });

  it("promotes qualifying rows, demotes stale auto-promoted rows, leaves human approvals", async () => {
    dbAvailable = true;
    candidates = [
      candidateRow({ id: "promote-me" }),
      candidateRow({ id: "demote-me", status: "approved", auto_promoted: true, last_seen_at: daysAgo(60) }),
      // Human approval — never auto-demoted even if stale.
      candidateRow({ id: "human", status: "approved", auto_promoted: false, last_seen_at: daysAgo(99) }),
      // Too slow to promote.
      candidateRow({ id: "slow", avg_duration_ms: 99999 }),
    ];

    const r = await runPromoteDecayTick();

    expect(promotedIds).toEqual(["promote-me"]);
    expect(demotedIds).toEqual(["demote-me"]);
    expect(r.candidates).toBe(4);
    expect(r.promoted).toBe(1);
    expect(r.demoted).toBe(1);
    expect(r.errors).toBe(0);
    // Affected workspaces are cache-invalidated.
    expect(invalidatedOrgs).toContain("org-a");
    expect(invalidatedOrgs).toContain("org-b");
  });

  it("records an error instead of throwing when a query rejects", async () => {
    dbAvailable = true;
    candidates = [candidateRow({ id: "x" })];
    failPromote = true;
    const r = await runPromoteDecayTick();
    expect(r.errors).toBe(1);
  });

  it("preserves the successful side when the other batch throws (no Promise.all masking)", async () => {
    // promote succeeds, demote throws: the committed promotion's count must
    // survive AND its cache must still be invalidated — a Promise.all would lose
    // both by unwinding to the outer catch (#3636 review).
    dbAvailable = true;
    candidates = [
      candidateRow({ id: "promote-me" }),
      candidateRow({ id: "demote-me", status: "approved", auto_promoted: true, last_seen_at: daysAgo(60) }),
    ];
    failDemote = true;

    const r = await runPromoteDecayTick();

    expect(r.promoted).toBe(1); // not lost
    expect(r.demoted).toBe(0); // the failed side
    expect(r.errors).toBe(1); // exactly the demote failure
    expect(promotedIds).toEqual(["promote-me"]);
    // The successful promote still invalidated its workspace's cache.
    expect(invalidatedOrgs).toContain("org-a");
  });
});
