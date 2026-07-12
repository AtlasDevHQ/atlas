import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  loadSettings,
  _resetSettingsCache,
  getSettingDefinition,
} from "@atlas/api/lib/settings";
import type { ResolvedConfig } from "@atlas/api/lib/config";
import { _setConfigForTest, _resetConfig } from "@atlas/api/lib/config";

// ---------------------------------------------------------------------------
// Mock internal DB. `dbAvailable` / `settingsRows` drive the settings tier
// chain (same shape as the expert-scheduler test). `internalQuery` branches on
// the SQL so the SaaS opt-in enumeration (`SELECT DISTINCT s.org_id …`) returns
// `optedInOrgRows` while `loadSettings()` still gets `settingsRows`.
//
// `candidatesByOrg` feeds per-workspace scans; `candidateFetchCalls` records the
// orgId each `getPromoteDecayCandidates` was asked for (the #4582 per-workspace
// contract). `promotedIds` / `demotedIds` capture what the tick asked the DB to
// flip; `promoteOrgs` / `demoteOrgs` are the RETURNING org ids the tick evicts
// caches for.
// ---------------------------------------------------------------------------
let dbAvailable = false;
let settingsRows: Array<{
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
  org_id: string | null;
}> = [];

let optedInOrgRows: Array<{ org_id: string }> = [];
// Captured from the SaaS opt-in enumeration query so a test can assert it binds
// the right key and keeps its tenant-safety filters (#4582).
let enumerationSql: string | null = null;
let enumerationParams: unknown[] | null = null;
let enumerationThrows = false;

let candidatesByOrg = new Map<string | null, Array<Record<string, unknown>>>();
let defaultCandidates: Array<Record<string, unknown>> = [];
let candidateFetchCalls: Array<string | null> = [];
let failCandidateFetch = false;

let promotedIds: readonly string[] = [];
let demotedIds: readonly string[] = [];
let invalidatedOrgs: Array<string | null> = [];
let promoteOrgs: Array<string | null> = ["org-a"];
let demoteOrgs: Array<string | null> = ["org-b"];
let failPromote = false;
let failDemote = false;
let errorLogs: string[] = [];

void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => dbAvailable,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async (sql: string, params?: unknown[]) => {
    if (typeof sql === "string" && sql.includes("SELECT DISTINCT s.org_id")) {
      enumerationSql = sql;
      enumerationParams = params ?? null;
      if (enumerationThrows) throw new Error("enumeration boom");
      return optedInOrgRows;
    }
    return settingsRows;
  },
  internalExecute: () => {},
  getApprovedPatterns: async () => [],
  getPromoteDecayCandidates: async (orgId: string | null) => {
    candidateFetchCalls.push(orgId);
    if (failCandidateFetch) throw new Error("candidate fetch boom");
    const explicit = candidatesByOrg.get(orgId);
    return explicit ?? defaultCandidates;
  },
  promoteLearnedPatterns: async (ids: readonly string[]) => {
    if (failPromote) throw new Error("boom");
    promotedIds = ids;
    return { count: ids.length, orgIds: ids.length > 0 ? promoteOrgs : [] };
  },
  demoteLearnedPatterns: async (ids: readonly string[]) => {
    if (failDemote) throw new Error("kaboom");
    demotedIds = ids;
    return { count: ids.length, orgIds: ids.length > 0 ? demoteOrgs : [] };
  },
  getEncryptionKey: () => null,
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string) => v,
  setWorkspaceRegion: mock(async () => {}),
}));

// The scheduler only touches pattern-cache via a dynamic import of
// invalidatePatternCache (in the per-workspace tick), which we observe here.
void mock.module("@atlas/api/lib/learn/pattern-cache", () => ({
  invalidatePatternCache: (orgId: string | null) => {
    invalidatedOrgs.push(orgId);
  },
}));

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: (_obj: unknown, msg?: string) => {
      errorLogs.push(typeof msg === "string" ? msg : "");
    },
    debug: () => {},
  }),
}));

const {
  isPromoteDecayEnabledForWorkspace,
  getPromoteDecaySchedulerIntervalMs,
  resolvePromoteDecayThresholds,
  runPromoteDecayTick,
  PROMOTE_DECAY_ENABLED_KEY,
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

/** Fully-typed `ResolvedConfig` so a `deployMode` typo can't compile silently. */
function configWithDeployMode(deployMode: "saas" | "self-hosted"): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "managed",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}

beforeEach(() => {
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED;
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS;
  _resetSettingsCache();
  _resetConfig();
  dbAvailable = false;
  settingsRows = [];
  optedInOrgRows = [];
  enumerationSql = null;
  enumerationParams = null;
  enumerationThrows = false;
  candidatesByOrg = new Map();
  defaultCandidates = [];
  candidateFetchCalls = [];
  failCandidateFetch = false;
  promotedIds = [];
  demotedIds = [];
  invalidatedOrgs = [];
  promoteOrgs = ["org-a"];
  demoteOrgs = ["org-b"];
  failPromote = false;
  failDemote = false;
  errorLogs = [];
});

afterEach(() => {
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED;
  delete process.env.ATLAS_LEARN_PROMOTE_DECAY_INTERVAL_HOURS;
  _resetSettingsCache();
  _resetConfig();
});

// ── Workspace-scoped enablement resolver (#4582) ──────────────────────
describe("isPromoteDecayEnabledForWorkspace", () => {
  it("is off by default", () => {
    expect(isPromoteDecayEnabledForWorkspace(null)).toBe(false);
    expect(isPromoteDecayEnabledForWorkspace("ws-1")).toBe(false);
  });

  it("turns on for 'true' / '1' via the env/default tier (self-hosted opt-in)", () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "true";
    expect(isPromoteDecayEnabledForWorkspace(null)).toBe(true);
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "1";
    expect(isPromoteDecayEnabledForWorkspace(null)).toBe(true);
  });

  it("a per-workspace DB override opts in one workspace and leaves others off", async () => {
    dbAvailable = true;
    settingsRows = [
      {
        key: "ATLAS_LEARN_PROMOTE_DECAY_ENABLED",
        value: "true",
        updated_at: "2026-01-01",
        updated_by: null,
        org_id: "ws-1",
      },
    ];
    await loadSettings();
    expect(isPromoteDecayEnabledForWorkspace("ws-1")).toBe(true);
    expect(isPromoteDecayEnabledForWorkspace("ws-2")).toBe(false);
    expect(isPromoteDecayEnabledForWorkspace(null)).toBe(false);
  });
});

// The SaaS enumeration filters `WHERE s.key = $1` bound to
// PROMOTE_DECAY_ENABLED_KEY. If settings.ts renames the registry key/envVar
// without updating the constant, enumeration silently matches ZERO workspaces
// (promotion never runs for any tenant) with no other failure. This crosses the
// constant against the REAL registry (this test uses the unmocked settings
// module) so drift ships red. It also pins the web-toggle contract: the key is a
// workspace-scoped boolean, so the data-driven Workspace Settings page renders
// it as a toggle (#4582).
describe("ATLAS_LEARN_PROMOTE_DECAY_ENABLED registry ↔ constant (#4582)", () => {
  it("the registry has a workspace-scoped boolean entry keyed by the exported constant", () => {
    const def = getSettingDefinition(PROMOTE_DECAY_ENABLED_KEY);
    expect(def).toBeDefined();
    expect(def?.scope).toBe("workspace");
    expect(def?.type).toBe("boolean");
    expect(def?.envVar).toBe(PROMOTE_DECAY_ENABLED_KEY);
    // Not requiresRestart and not hidden from SaaS workspace admins — the two
    // properties that make it a live, self-service toggle on the settings page.
    expect(def?.requiresRestart).toBeFalsy();
    expect(def?.saasVisible).not.toBe(false);
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

// ── Self-hosted (single implicit workspace, degenerate case) ──────────
describe("runPromoteDecayTick — self-hosted", () => {
  beforeEach(() => {
    _setConfigForTest(configWithDeployMode("self-hosted"));
    dbAvailable = true;
  });

  it("no-ops without an internal DB", async () => {
    dbAvailable = false;
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "true";
    const r = await runPromoteDecayTick();
    expect(r).toEqual({ workspacesConsidered: 0, candidates: 0, promoted: 0, demoted: 0, errors: 0 });
    expect(candidateFetchCalls).toEqual([]);
  });

  it("no-ops (no scan) when the single workspace has NOT opted in", async () => {
    // knob unset → off by default
    const r = await runPromoteDecayTick();
    expect(r.workspacesConsidered).toBe(0);
    expect(candidateFetchCalls).toEqual([]);
    expect(promotedIds).toEqual([]);
    expect(demotedIds).toEqual([]);
  });

  it("promotes / demotes / spares human approvals for the opted-in NULL-org workspace", async () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "true";
    defaultCandidates = [
      candidateRow({ id: "promote-me" }),
      candidateRow({ id: "demote-me", status: "approved", auto_promoted: true, last_seen_at: daysAgo(60) }),
      // Human approval — never auto-demoted even if stale.
      candidateRow({ id: "human", status: "approved", auto_promoted: false, last_seen_at: daysAgo(99) }),
      // Too slow to promote.
      candidateRow({ id: "slow", avg_duration_ms: 99999 }),
    ];

    const r = await runPromoteDecayTick();

    // The self-hosted degenerate path scans exactly the single NULL-org workspace.
    expect(candidateFetchCalls).toEqual([null]);
    expect(promotedIds).toEqual(["promote-me"]);
    expect(demotedIds).toEqual(["demote-me"]);
    expect(r.workspacesConsidered).toBe(1);
    expect(r.candidates).toBe(4);
    expect(r.promoted).toBe(1);
    expect(r.demoted).toBe(1);
    expect(r.errors).toBe(0);
    expect(invalidatedOrgs).toContain("org-a");
    expect(invalidatedOrgs).toContain("org-b");
  });

  it("records an error instead of throwing when a query rejects", async () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "true";
    defaultCandidates = [candidateRow({ id: "x" })];
    failPromote = true;
    const r = await runPromoteDecayTick();
    expect(r.errors).toBe(1);
  });

  it("preserves the successful side when the other batch throws (no Promise.all masking)", async () => {
    process.env.ATLAS_LEARN_PROMOTE_DECAY_ENABLED = "true";
    defaultCandidates = [
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

// ── SaaS (iterate opted-in workspaces) ────────────────────────────────
describe("runPromoteDecayTick — SaaS", () => {
  beforeEach(() => {
    _setConfigForTest(configWithDeployMode("saas"));
    dbAvailable = true;
  });

  it("iterates ONLY the opted-in workspaces; opted-out workspaces are never scanned", async () => {
    optedInOrgRows = [{ org_id: "ws-1" }, { org_id: "ws-2" }];
    // ws-3 is intentionally NOT in the opted-in set.
    candidatesByOrg.set("ws-1", [candidateRow({ id: "p1" })]);
    candidatesByOrg.set("ws-2", []);
    promoteOrgs = ["ws-1"];

    const r = await runPromoteDecayTick();

    // Exactly the two opted-in workspaces were scanned, in enumeration order.
    expect(candidateFetchCalls).toEqual(["ws-1", "ws-2"]);
    expect(candidateFetchCalls).not.toContain("ws-3");
    expect(candidateFetchCalls).not.toContain(null);
    expect(r.workspacesConsidered).toBe(2);
    expect(promotedIds).toEqual(["p1"]);
    expect(r.promoted).toBe(1);
    expect(invalidatedOrgs).toContain("ws-1");
  });

  it("no-ops when no workspace has opted in (empty enumeration)", async () => {
    optedInOrgRows = [];
    const r = await runPromoteDecayTick();
    expect(r.workspacesConsidered).toBe(0);
    expect(candidateFetchCalls).toEqual([]);
  });

  it("the opt-in enumeration binds the promote key and keeps its tenant-safety filters", async () => {
    optedInOrgRows = [{ org_id: "ws-1" }];
    await runPromoteDecayTick();
    // Bound to the exported key, not a stray literal — a rename that broke this
    // would enroll ZERO tenants with no other signal.
    expect(enumerationParams).toEqual([PROMOTE_DECAY_ENABLED_KEY]);
    // The three clauses that keep the sweep org-safe: only explicit workspace
    // overrides (never a platform/self-hosted NULL-org row), only truthy values,
    // and joined to a live organization (a deleted workspace's stale row drops).
    expect(enumerationSql).toContain("s.org_id IS NOT NULL");
    expect(enumerationSql).toContain("value IN ('true', '1')");
    expect(enumerationSql).toContain("JOIN organization");
  });

  it("an enumeration failure is contained — NO NULL-org fallthrough", async () => {
    // If a future refactor added `catch { return [null] }` to the resolver, a DB
    // blip during enumeration would trigger a cross-tenant NULL-org scan. Pin
    // that the failure is counted and the sweep is skipped entirely instead.
    enumerationThrows = true;
    const r = await runPromoteDecayTick();
    expect(r.errors).toBe(1);
    expect(r.workspacesConsidered).toBe(0);
    expect(candidateFetchCalls).not.toContain(null);
    expect(candidateFetchCalls).toEqual([]);
  });

  it("escalates to an error log when EVERY considered workspace fails systemically", async () => {
    // A schema drift / DB outage fails each workspace's candidate fetch at the
    // outer catch. Per-workspace warns alone would bury a whole-feature outage,
    // so the tick summary must escalate to error (panel review).
    optedInOrgRows = [{ org_id: "ws-1" }, { org_id: "ws-2" }];
    failCandidateFetch = true;

    const r = await runPromoteDecayTick();

    expect(r.workspacesConsidered).toBe(2);
    expect(r.errors).toBe(2);
    expect(errorLogs.some((m) => m.includes("every considered workspace failed"))).toBe(true);
  });

  it("a failure in one workspace does not abort the sweep of the others", async () => {
    optedInOrgRows = [{ org_id: "ws-1" }, { org_id: "ws-2" }];
    candidatesByOrg.set("ws-1", [candidateRow({ id: "p1" })]);
    candidatesByOrg.set("ws-2", [candidateRow({ id: "p2" })]);
    // promote throws for BOTH — but each workspace is settled independently, so
    // both are still considered and each records its own error.
    failPromote = true;

    const r = await runPromoteDecayTick();

    expect(r.workspacesConsidered).toBe(2);
    expect(candidateFetchCalls).toEqual(["ws-1", "ws-2"]);
    expect(r.errors).toBe(2);
  });
});
