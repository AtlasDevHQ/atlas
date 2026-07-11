/**
 * runExpertSchedulerTick — auto-approve invariant (#4486, #4506) + SaaS-first
 * per-workspace iteration (#4516).
 *
 * Auto-approve invariant: every proposal is inserted `pending`; eligible ones
 * route through the decide seam (`decideAmendment`), which owns claim → apply →
 * stamp. This pins "status='approved' ⇒ applied":
 *   - eligible + seam approves     → autoApproved
 *   - eligible + seam throws       → an error (seam already compensated to pending)
 *   - eligible + already decided   → queued, never a second apply
 *   - not eligible                 → queued, the seam never invoked
 *   - rejected identity            → suppressed, no seam, no queue (#4507)
 *   - already-pending identity     → deduped, no seam, no queue (#4507)
 *
 * SaaS-first iteration (#4516): the tick enumerates opted-in workspaces on SaaS,
 * runs each degenerate self-hosted case identically, gates each workspace on its
 * billing status (a blocked workspace no-ops), and org-stamps every insert +
 * decide.
 *
 * A separate file from scheduler.test.ts (which only tests the config getters)
 * so the tick's module mocks don't leak into those tests.
 */

import { describe, it, expect, beforeEach, mock, type Mock } from "bun:test";
import type { AnalysisResult } from "../types";

const proposal: AnalysisResult = {
  category: "coverage_gaps",
  entityName: "companies",
  group: "default",
  amendmentType: "add_dimension",
  amendment: { name: "region", type: "string", description: "Region" },
  rationale: "Adds region dimension",
  impact: 0.9,
  confidence: 0.95,
  staleness: 0,
  score: 0.85,
};

// ── Mutable mock state (flipped per-test) ─────────────────────────────────
// Deploy mode: self-hosted (degenerate single-workspace) vs SaaS (enumerate).
let saasMode = false;
// SaaS opt-in enumeration: org ids returned by the settings-table scan.
let optedInOrgs: string[] = [];
// When true, the settings-table enumeration query rejects (models a DB blip).
let enumerationThrows = false;
// Captured enumeration query + params (assert the opt-in filter + the key).
let enumerationSql = "";
let enumerationParams: unknown[] = [];
// Per-org billing gate: default allow; a test can block/error a workspace, or
// throw from the gate entirely (models a gate-lookup that itself fails).
// `httpStatus` drives the block(policy)/error(fail-closed 503) split in the tick.
type GateResult = { allowed: true } | { allowed: false; errorCode: string; httpStatus: 403 | 404 | 429 | 503 };
let gateFor: (orgId: string | undefined) => GateResult = () => ({ allowed: true });
const gateCalls: Array<string | undefined> = [];
// Captured request-context frames — assert origin/actor stamping (#4508, AC3).
const capturedContexts: Array<{ requestId?: string; agentOrigin?: string; actor?: { kind?: string } }> = [];
// Loader org-scope capture — which orgId each context loader was called with.
const loaderOrgIds: {
  entitiesForOrg: string[];
  entitiesFromDisk: number;
  audit: Array<string | undefined>;
  rejected: Array<string | undefined>;
} = { entitiesForOrg: [], entitiesFromDisk: 0, audit: [], rejected: [] };

// Context loaders. `loadEntitiesForOrg` is only reached on the SaaS (orgId)
// path; `loadEntitiesFromDisk` on the self-hosted degenerate path. The analyzer
// is mocked to return our proposal regardless, so any non-empty entity list
// clears the `entities.length === 0` early return.
void mock.module("../context-loader", () => ({
  loadEntitiesFromDisk: async () => {
    loaderOrgIds.entitiesFromDisk++;
    return [{ name: "companies" }];
  },
  loadEntitiesForOrg: async (orgId: string) => {
    loaderOrgIds.entitiesForOrg.push(orgId);
    return { entities: [{ name: "companies" }], totalRows: 1, parseFailures: 0 };
  },
  loadGlossaryFromDisk: async () => [],
  loadAuditPatterns: async (orgId?: string) => {
    loaderOrgIds.audit.push(orgId);
    return [];
  },
  loadRejectedKeys: async (orgId?: string) => {
    loaderOrgIds.rejected.push(orgId);
    return new Set<string>();
  },
}));

void mock.module("../profile-cache", () => ({
  loadCachedProfiles: () => [],
}));

let proposals: AnalysisResult[] = [proposal];
void mock.module("../analyzer", () => ({
  analyzeSemanticLayer: () => proposals,
}));

// The tick routes eligible inserts through the decide seam — mock it directly
// (its own claim/apply/stamp mechanics are unit-tested in decide.test.ts and
// the route suite).
type DecideOutcome = { kind: "approved" | "rejected" | "not_pending"; id: string };
const mockDecideAmendment: Mock<
  (params: { id: string; orgId: string | null; decision: string; reviewedBy: string; requestId: string }) => Promise<DecideOutcome>
> = mock(async (params) => ({ kind: "approved", id: params.id }));
void mock.module("../decide", () => ({
  decideAmendment: mockDecideAmendment,
}));

// insertSemanticAmendment returns a discriminated union (#4507); the
// `inserted` arm reports auto-approve ELIGIBILITY (#4506).
const mockInsertSemanticAmendment: Mock<
  (params: { orgId: string | null }) => Promise<{ outcome: string; id?: string; autoApprove?: boolean }>
> = mock(() => Promise.resolve({ outcome: "inserted", id: "sch-1", autoApprove: true }));
// internal DB: partial mock — the tick uses only hasInternalDB (loader/decide
// gate), insertSemanticAmendment (choke point), and internalQuery (the SaaS
// opt-in enumeration). Complete for this file; every other DB access is mocked
// away by the context-loader / decide mocks above.
void mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  insertSemanticAmendment: mockInsertSemanticAmendment,
  internalQuery: async (sql: string, params: unknown[]) => {
    enumerationSql = sql;
    enumerationParams = params;
    if (enumerationThrows) throw new Error("settings enumeration failed");
    return optedInOrgs.map((org_id) => ({ org_id }));
  },
}));

// Billing gate — partial mock (the tick calls only checkAgentBillingGate).
// Records every orgId it was asked about and answers via gateFor (which may
// itself throw, to model a gate-lookup that fails rather than returns a block).
void mock.module("@atlas/api/lib/billing/agent-gate", () => ({
  checkAgentBillingGate: async (orgId: string | undefined) => {
    gateCalls.push(orgId);
    return gateFor(orgId);
  },
}));

// logger — partial mock (createLogger + withRequestContext are all the tick
// touches). withRequestContext is a passthrough that ALSO records the frame so
// origin/actor stamping can be asserted.
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  withRequestContext: (ctx: { requestId?: string; agentOrigin?: string; actor?: { kind?: string } }, fn: () => unknown) => {
    capturedContexts.push(ctx);
    return fn();
  },
}));

// settings — partial mock (getSetting + isSaasModeForGuard are all the tick reads).
void mock.module("@atlas/api/lib/settings", () => ({
  getSetting: () => undefined,
  isSaasModeForGuard: () => saasMode,
}));

const { runExpertSchedulerTick, AUTONOMOUS_IMPROVE_ENABLED_KEY } = await import("../scheduler");

function resetMocks(): void {
  saasMode = false;
  optedInOrgs = [];
  enumerationThrows = false;
  enumerationSql = "";
  enumerationParams = [];
  gateFor = () => ({ allowed: true });
  gateCalls.length = 0;
  capturedContexts.length = 0;
  loaderOrgIds.entitiesForOrg = [];
  loaderOrgIds.entitiesFromDisk = 0;
  loaderOrgIds.audit = [];
  loaderOrgIds.rejected = [];
  proposals = [proposal];
  mockDecideAmendment.mockClear();
  mockDecideAmendment.mockImplementation(async (params) => ({ kind: "approved", id: params.id }));
  mockInsertSemanticAmendment.mockClear();
  mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "sch-1", autoApprove: true });
}

describe("runExpertSchedulerTick auto-approve → decide seam invariant (#4486, #4506)", () => {
  beforeEach(resetMocks);

  it("routes an eligible proposal through the decide seam with the insert's id", async () => {
    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    const [params] = mockDecideAmendment.mock.calls[0];
    expect(params).toMatchObject({
      id: "sch-1",
      orgId: null,
      decision: "approved",
      reviewedBy: "expert-scheduler",
    });
    expect(result.autoApproved).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("counts an error when the seam's apply fails (row already compensated to pending)", async () => {
    mockDecideAmendment.mockImplementation(async () => {
      throw new Error("entity not found");
    });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).toHaveBeenCalledTimes(1);
    expect(result.autoApproved).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("counts queued (never autoApproved) when a concurrent decision beat the tick", async () => {
    mockDecideAmendment.mockImplementation(async (params) => ({ kind: "not_pending", id: params.id }));

    const result = await runExpertSchedulerTick();

    expect(result.autoApproved).toBe(0);
    expect(result.queued).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("does not invoke the seam when the proposal is not auto-approve eligible", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "inserted", id: "sch-2", autoApprove: false });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.queued).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("counts a rejected identity as suppressed — no seam decision, no queue (#4507)", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "rejected", id: "rej-1" });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.rejected).toBe(1);
    expect(result.queued).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("counts an already-pending identity as deduped — no seam decision, no queue (#4507)", async () => {
    mockInsertSemanticAmendment.mockResolvedValue({ outcome: "already_pending", id: "pend-1" });

    const result = await runExpertSchedulerTick();

    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(result.deduped).toBe(1);
    expect(result.queued).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe("runExpertSchedulerTick — self-hosted degenerate case (#4516)", () => {
  beforeEach(resetMocks);

  it("runs once for the NULL-org workspace and stamps NULL on inserts + decides", async () => {
    const result = await runExpertSchedulerTick();

    expect(result.workspacesConsidered).toBe(1);
    expect(result.workspacesGateBlocked).toBe(0);
    // Degenerate path reads the bundled disk layer (never the per-org loader).
    expect(loaderOrgIds.entitiesFromDisk).toBe(1);
    expect(loaderOrgIds.entitiesForOrg).toEqual([]);
    // Global (unscoped) audit + rejected loaders — self-hosted single workspace.
    expect(loaderOrgIds.audit).toEqual([undefined]);
    expect(loaderOrgIds.rejected).toEqual([undefined]);
    // Insert + decide are NULL-org stamped.
    expect(mockInsertSemanticAmendment.mock.calls[0][0]).toMatchObject({ orgId: null });
    expect(mockDecideAmendment.mock.calls[0][0]).toMatchObject({ orgId: null });
    expect(result.autoApproved).toBe(1);
  });

  it("passes the billing gate for the no-org workspace (self-hosted passthrough)", async () => {
    await runExpertSchedulerTick();
    expect(gateCalls).toEqual([undefined]);
  });

  it("stamps agentOrigin 'scheduler' with a self-scoped requestId", async () => {
    await runExpertSchedulerTick();

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0].agentOrigin).toBe("scheduler");
    expect(capturedContexts[0].requestId).toMatch(/^scheduled-self-/);
  });
});

describe("runExpertSchedulerTick — SaaS per-workspace iteration (#4516)", () => {
  beforeEach(() => {
    resetMocks();
    saasMode = true;
  });

  it("no opted-in workspaces → no work, no inserts", async () => {
    optedInOrgs = [];

    const result = await runExpertSchedulerTick();

    expect(result.workspacesConsidered).toBe(0);
    expect(mockInsertSemanticAmendment).not.toHaveBeenCalled();
    expect(mockDecideAmendment).not.toHaveBeenCalled();
    expect(gateCalls).toEqual([]);
  });

  it("iterates each opted-in workspace and org-stamps every insert + decide", async () => {
    optedInOrgs = ["org-a", "org-b"];

    const result = await runExpertSchedulerTick();

    expect(result.workspacesConsidered).toBe(2);
    // Per-org entity loader used (never the bundled disk loader) on SaaS.
    expect(loaderOrgIds.entitiesForOrg).toEqual(["org-a", "org-b"]);
    expect(loaderOrgIds.entitiesFromDisk).toBe(0);
    // Audit + rejected loaders org-scoped so no cross-tenant contamination.
    expect(loaderOrgIds.audit).toEqual(["org-a", "org-b"]);
    expect(loaderOrgIds.rejected).toEqual(["org-a", "org-b"]);
    // Every insert + decide carries the workspace owner.
    const insertOrgs = mockInsertSemanticAmendment.mock.calls.map((c) => c[0].orgId);
    const decideOrgs = mockDecideAmendment.mock.calls.map((c) => c[0].orgId);
    expect(insertOrgs).toEqual(["org-a", "org-b"]);
    expect(decideOrgs).toEqual(["org-a", "org-b"]);
    expect(result.autoApproved).toBe(2);
  });

  it("a POLICY-blocked workspace no-ops at the gate — zero inserts, counted as gate-blocked", async () => {
    optedInOrgs = ["org-blocked", "org-ok"];
    // 429 = over budget: a real policy block, not an infra failure.
    gateFor = (orgId) =>
      orgId === "org-blocked"
        ? { allowed: false, errorCode: "plan_limit_exceeded", httpStatus: 429 }
        : { allowed: true };

    const result = await runExpertSchedulerTick();

    expect(result.workspacesConsidered).toBe(2);
    expect(result.workspacesGateBlocked).toBe(1);
    expect(result.workspacesGateErrored).toBe(0);
    // The blocked workspace never loaded context or inserted anything.
    expect(loaderOrgIds.entitiesForOrg).toEqual(["org-ok"]);
    const insertOrgs = mockInsertSemanticAmendment.mock.calls.map((c) => c[0].orgId);
    expect(insertOrgs).toEqual(["org-ok"]);
    expect(result.autoApproved).toBe(1);
  });

  it("a fail-closed gate (503) is counted as errored, NOT blocked — infra ≠ policy", async () => {
    optedInOrgs = ["org-brownout", "org-ok"];
    // 503 = the workspace-status / plan lookup could not complete (fail-closed).
    gateFor = (orgId) =>
      orgId === "org-brownout"
        ? { allowed: false, errorCode: "workspace_check_failed", httpStatus: 503 }
        : { allowed: true };

    const result = await runExpertSchedulerTick();

    expect(result.workspacesConsidered).toBe(2);
    expect(result.workspacesGateErrored).toBe(1);
    expect(result.workspacesGateBlocked).toBe(0);
    // Still skips the workspace (fail-closed) — no spend.
    expect(loaderOrgIds.entitiesForOrg).toEqual(["org-ok"]);
    expect(result.autoApproved).toBe(1);
  });

  it("one workspace throwing never aborts the sweep (outer per-workspace catch)", async () => {
    optedInOrgs = ["org-a", "org-b"];
    // org-a's gate lookup THROWS (not a returned block) — this escapes
    // runWorkspaceImproveTick and must be contained by the sweep-level catch so
    // org-b is still processed.
    gateFor = (orgId) => {
      if (orgId === "org-a") throw new Error("gate lookup crashed");
      return { allowed: true };
    };

    const result = await runExpertSchedulerTick();

    expect(result.workspacesConsidered).toBe(2);
    expect(result.errors).toBe(1);
    // org-a never loaded context; org-b still auto-approved.
    expect(loaderOrgIds.entitiesForOrg).toEqual(["org-b"]);
    expect(result.autoApproved).toBe(1);
    expect(mockDecideAmendment.mock.calls.map((c) => c[0].orgId)).toEqual(["org-b"]);
  });

  it("stamps agentOrigin + actor 'scheduler' and an org-scoped requestId per workspace", async () => {
    optedInOrgs = ["org-a"];

    await runExpertSchedulerTick();

    expect(capturedContexts).toHaveLength(1);
    const ctx = capturedContexts[0];
    expect(ctx.agentOrigin).toBe("scheduler");
    expect(ctx.actor?.kind).toBe("scheduler");
    expect(ctx.requestId).toMatch(/^scheduled-org-a-/);
  });

  it("enumerates opted-in workspaces with the autonomy key and opt-in filter (AC2)", async () => {
    optedInOrgs = ["org-a"];

    await runExpertSchedulerTick();

    // The scan filters on the shared knob key + explicit-true + non-null org.
    expect(enumerationParams).toEqual([AUTONOMOUS_IMPROVE_ENABLED_KEY]);
    expect(enumerationSql).toContain("s.key = $1");
    expect(enumerationSql).toContain("s.value IN ('true', '1')");
    expect(enumerationSql).toContain("s.org_id IS NOT NULL");
    // JOIN drops stale overrides for deleted workspaces.
    expect(enumerationSql).toContain("JOIN organization");
  });

  it("an enumeration failure is logged + counted, never a NULL-org fallthrough", async () => {
    enumerationThrows = true;

    const result = await runExpertSchedulerTick();

    expect(result.errors).toBe(1);
    expect(result.workspacesConsidered).toBe(0);
    // Critically, a failed enumeration must NOT degrade to the self-hosted
    // [{ orgId: null }] path and produce a global-scope tick on SaaS.
    expect(mockInsertSemanticAmendment).not.toHaveBeenCalled();
    expect(gateCalls).toEqual([]);
  });
});

describe("runExpertSchedulerTick — key/registry drift guard (#4516)", () => {
  it("the enumeration key matches the exported constant (registry must mirror it)", () => {
    // If settings.ts renames the registry key/envVar without updating the
    // constant, the SaaS enumeration silently matches zero workspaces. This
    // pins the constant's value so that drift is at least visible here.
    expect(AUTONOMOUS_IMPROVE_ENABLED_KEY).toBe("ATLAS_AUTONOMOUS_IMPROVE_ENABLED");
  });
});
