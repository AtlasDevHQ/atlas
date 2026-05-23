/**
 * Unit tests for `WorkspaceInstallGate` — Atlas issue #2655.
 *
 * Pins every branch documented on the gate:
 *
 *   - present + enabled + plan ok → true
 *   - install row absent → false (silent — no warn)
 *   - install row's `enabled = false` → false
 *   - catalog row's `enabled = false` → false
 *   - plan_tier ranks below min_plan → false
 *   - NULL plan_tier (LEFT JOIN miss) → false (fail closed — rank 0)
 *   - unknown min_plan value (catalog drift) → false (warn)
 *   - DB throws → false (warn — fail closed)
 *   - `hasInternalDB()` returns false → false (no DB roundtrip)
 *
 * Plus the cache invariant: a second `(workspaceId, catalogId)` call
 * within one event handler invocation returns the same verdict from
 * ONE underlying gate invocation — the "called exactly once per
 * event" sentinel mirroring the pattern from #2623 item 6.
 *
 * Mock pattern matches `workspace-config-loader.test.ts`: spread the
 * real `@atlas/api/lib/db/internal` module then override the two
 * functions the gate reads, so unrelated tests in the suite don't see
 * a partial module shape.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  type Mock,
} from "bun:test";

// ── Logger mock ─────────────────────────────────────────────────────

const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogInfo: Mock<(...args: unknown[]) => void> = mock(() => {});

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    warn: mockLogWarn,
    info: mockLogInfo,
    debug: () => {},
    error: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    child: () => ({
      warn: mockLogWarn,
      info: mockLogInfo,
      debug: () => {},
      error: () => {},
      trace: () => {},
      fatal: () => {},
      silent: () => {},
    }),
  }),
}));

// ── DB internal mock ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realInternal = require("@atlas/api/lib/db/internal") as typeof import("@atlas/api/lib/db/internal");

const mockInternalQuery: Mock<
  (sql: string, params: unknown[]) => Promise<unknown[]>
> = mock(async () => []);
const mockHasInternalDB: Mock<() => boolean> = mock(() => true);

mock.module("@atlas/api/lib/db/internal", () => ({
  ...realInternal,
  internalQuery: (sql: string, params: unknown[]) =>
    mockInternalQuery(sql, params),
  hasInternalDB: () => mockHasInternalDB(),
}));

// ── Module under test (loaded AFTER mocks via sync require) ──────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gateModule = require("../workspace-install-gate") as typeof import("../workspace-install-gate");
const {
  isWorkspaceInstallActive,
  createInstallGateCache,
  describeInstallGateState,
  WorkspaceInstallGate,
} = gateModule;

// ── Per-test reset ──────────────────────────────────────────────────

beforeEach(() => {
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async () => []);
  mockHasInternalDB.mockClear();
  mockHasInternalDB.mockImplementation(() => true);
  mockLogWarn.mockClear();
  mockLogInfo.mockClear();
});

afterEach(() => {
  mockInternalQuery.mockClear();
  mockLogWarn.mockClear();
  mockLogInfo.mockClear();
});

function row(overrides: Partial<{
  install_enabled: boolean;
  catalog_enabled: boolean;
  min_plan: string;
  plan_tier: string | null;
  is_operator_workspace: boolean | null;
}> = {}): Record<string, unknown> {
  return {
    install_enabled: true,
    catalog_enabled: true,
    min_plan: "starter",
    plan_tier: "business",
    is_operator_workspace: false,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────
// isWorkspaceInstallActive
// ───────────────────────────────────────────────────────────────────

describe("isWorkspaceInstallActive", () => {
  it("returns true when install + catalog are enabled and plan ranks >= min_plan", async () => {
    mockInternalQuery.mockImplementation(async () => [row()]);
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(true);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns false when no install row exists (silent — no warn)", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
    // Steady-state "workspace has no Slack integration" must not fill
    // the structured log — log only on DB error / drift.
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns false when the install row is disabled (enabled = false)", async () => {
    mockInternalQuery.mockImplementation(async () => [row({ install_enabled: false })]);
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
  });

  it("returns false when the catalog row is disabled (catalog.enabled = false)", async () => {
    // The issue acceptance criteria pin this explicitly: catalog
    // `enabled = false` → gate returns false even with install row present.
    mockInternalQuery.mockImplementation(async () => [row({ catalog_enabled: false })]);
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
  });

  it("returns false when the workspace plan_tier ranks below catalog min_plan", async () => {
    // free (rank 0) < business (rank 4)
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "business", plan_tier: "free" })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
  });

  it("returns true when plan_tier matches min_plan exactly", async () => {
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "starter", plan_tier: "starter" })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(true);
  });

  it("returns false when plan_tier is NULL (LEFT JOIN miss — fail closed)", async () => {
    // Workspace pre-dates the plan_tier column or the org row was
    // never created. Rank defaults to 0 → below every gate.
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "starter", plan_tier: null })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
  });

  it("returns false and warns when min_plan is an unknown value (catalog drift)", async () => {
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "ultimate", plan_tier: "business" })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
    // Catalog drift is operator-actionable — surface at warn.
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it("returns false (fail closed) when the DB query throws", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("connection terminated");
    });
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it("returns false without a DB roundtrip when hasInternalDB() is false", async () => {
    mockHasInternalDB.mockImplementation(() => false);
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("returns false on empty workspaceId / catalogId without a DB roundtrip", async () => {
    expect(await isWorkspaceInstallActive("", "catalog:slack")).toBe(false);
    expect(await isWorkspaceInstallActive("ws-1", "")).toBe(false);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("accepts pro plan_tier against starter min_plan (pro ranks higher)", async () => {
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "starter", plan_tier: "pro" })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(true);
  });

  it("denies trial plan_tier against business min_plan (trial ranks below)", async () => {
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "business", plan_tier: "trial" })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
  });

  // ── Operator-workspace bypass (#2702) ───────────────────────────

  it("admits operator workspace regardless of plan_tier (bypass)", async () => {
    // Atlas-own: plan_tier='trial' (rank 1), min_plan='business' (rank 4).
    // Without the bypass: deny. With is_operator_workspace=true: admit.
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "business", plan_tier: "trial", is_operator_workspace: true })],
    );
    expect(await isWorkspaceInstallActive("ws-op", "catalog:slack")).toBe(true);
  });

  it("admits operator workspace with NULL plan_tier (no plan at all)", async () => {
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "starter", plan_tier: null, is_operator_workspace: true })],
    );
    expect(await isWorkspaceInstallActive("ws-op", "catalog:slack")).toBe(true);
  });

  it("denies operator workspace when install_enabled=false (flag does NOT bypass install gate)", async () => {
    // Operators still have to actually install the integration. The
    // bypass only covers plan ranking, not the install row's enabled
    // bit — otherwise an operator couldn't uninstall a misbehaving
    // integration without flipping the column off.
    mockInternalQuery.mockImplementation(async () =>
      [row({ install_enabled: false, is_operator_workspace: true })],
    );
    expect(await isWorkspaceInstallActive("ws-op", "catalog:slack")).toBe(false);
  });

  it("denies operator workspace when catalog_enabled=false (flag does NOT bypass kill switch)", async () => {
    // A platform-admin kill switch must override the operator bypass —
    // otherwise an emergency-disabled platform would still fire for
    // the dogfood workspace.
    mockInternalQuery.mockImplementation(async () =>
      [row({ catalog_enabled: false, is_operator_workspace: true })],
    );
    expect(await isWorkspaceInstallActive("ws-op", "catalog:slack")).toBe(false);
  });

  it("denies operator workspace when min_plan is unknown (catalog drift still fails closed)", async () => {
    // Even for operators, a typo in a catalog seed should fail closed —
    // the operator-bypass branch sits BELOW the unknown-min_plan check
    // so drift surfaces as a denial + warn rather than silent admit.
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "ultimate", is_operator_workspace: true })],
    );
    expect(await isWorkspaceInstallActive("ws-op", "catalog:slack")).toBe(false);
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it("non-operator workspace unaffected by the flag column (false / null treated identically)", async () => {
    // The flag defaults to false on the DB column; a NULL would only
    // appear on a LEFT JOIN miss, which is also "not an operator".
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "business", plan_tier: "trial", is_operator_workspace: false })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
  });

  it("denies legacy plan_tier='team' (unknown post-#2666) — falls back to rank 0", async () => {
    // Post-#2666 PLAN_TIERS is the single vocabulary. 'team' is not in
    // the rank table; planRank returns null, plan_tier falls back to
    // rank 0, and even a free-tier catalog row admits at-or-above 0.
    // For any min_plan stricter than 'free', a legacy 'team' workspace
    // is denied. Pin the strict case here; the unknown-value branch is
    // the same as a NULL plan_tier from a LEFT JOIN miss.
    mockInternalQuery.mockImplementation(async () =>
      [row({ min_plan: "starter", plan_tier: "team" })],
    );
    expect(await isWorkspaceInstallActive("ws-1", "catalog:slack")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// createInstallGateCache — "called exactly once per event" sentinel
// ───────────────────────────────────────────────────────────────────

describe("createInstallGateCache", () => {
  it("caches a true verdict for the lifetime of one event invocation", async () => {
    const underlying: Mock<
      (workspaceId: string, catalogId: string) => Promise<boolean>
    > = mock(async () => true);
    const cached = createInstallGateCache(underlying);

    expect(await cached("ws-1", "catalog:slack")).toBe(true);
    expect(await cached("ws-1", "catalog:slack")).toBe(true);
    expect(await cached("ws-1", "catalog:slack")).toBe(true);

    // The "called exactly once per event" sentinel — mirrors the
    // pattern from #2623 item 6. Three calls, one roundtrip.
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("caches a false verdict (does not retry on no-install)", async () => {
    const underlying: Mock<
      (workspaceId: string, catalogId: string) => Promise<boolean>
    > = mock(async () => false);
    const cached = createInstallGateCache(underlying);

    expect(await cached("ws-1", "catalog:slack")).toBe(false);
    expect(await cached("ws-1", "catalog:slack")).toBe(false);

    // Even false verdicts cache — a single event shouldn't re-probe
    // (would cost N reads against a workspace that just isn't installed).
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("separates verdicts by workspaceId and catalogId", async () => {
    const underlying: Mock<
      (workspaceId: string, catalogId: string) => Promise<boolean>
    > = mock(async (workspaceId: string) =>
      workspaceId === "ws-allow",
    );
    const cached = createInstallGateCache(underlying);

    expect(await cached("ws-allow", "catalog:slack")).toBe(true);
    expect(await cached("ws-deny", "catalog:slack")).toBe(false);
    // Same workspace, different catalog id = separate cache entry.
    expect(await cached("ws-allow", "catalog:jira")).toBe(true);
    expect(underlying).toHaveBeenCalledTimes(3);
  });

  it("de-duplicates concurrent in-flight calls (single roundtrip under contention)", async () => {
    let resolveGate: (verdict: boolean) => void = () => {};
    const underlying: Mock<
      (workspaceId: string, catalogId: string) => Promise<boolean>
    > = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveGate = resolve;
        }),
    );
    const cached = createInstallGateCache(underlying);

    const a = cached("ws-1", "catalog:slack");
    const b = cached("ws-1", "catalog:slack");
    expect(underlying).toHaveBeenCalledTimes(1);

    resolveGate(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("propagates a rejected gate promise to all concurrent callers without re-invoking", async () => {
    // Cache-the-Promise (not the value) means a rejected verdict is
    // ALSO cached. Concurrent callers within one event share the same
    // rejection — they don't independently retry the gate. The listener
    // wraps the cache with its own try/catch (`installGateCacheForEvent`
    // in listener.ts), so this is the expected contract: the cache is
    // the de-dup layer, the wrapper is the fail-closed layer.
    const underlying: Mock<
      (workspaceId: string, catalogId: string) => Promise<boolean>
    > = mock(async () => {
      throw new Error("gate failed");
    });
    const cached = createInstallGateCache(underlying);

    const a = cached("ws-1", "catalog:slack");
    const b = cached("ws-1", "catalog:slack");

    await expect(a).rejects.toThrow("gate failed");
    await expect(b).rejects.toThrow("gate failed");
    // Only one underlying call — the rejected Promise is cached and
    // re-awaited by the second caller.
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("a fresh cache (new event) re-queries the underlying gate", async () => {
    const underlying: Mock<
      (workspaceId: string, catalogId: string) => Promise<boolean>
    > = mock(async () => true);

    const eventA = createInstallGateCache(underlying);
    await eventA("ws-1", "catalog:slack");
    await eventA("ws-1", "catalog:slack");
    expect(underlying).toHaveBeenCalledTimes(1);

    // Listener allocates a fresh cache at the top of the next event,
    // so admin toggle flips between events are picked up immediately.
    const eventB = createInstallGateCache(underlying);
    await eventB("ws-1", "catalog:slack");
    expect(underlying).toHaveBeenCalledTimes(2);
  });
});

// ───────────────────────────────────────────────────────────────────
// Namespace surface — proves the deep-module export shape
// ───────────────────────────────────────────────────────────────────

describe("WorkspaceInstallGate namespace", () => {
  it("exposes isWorkspaceInstallActive, createCache, and describeState from the bound namespace", () => {
    expect(typeof WorkspaceInstallGate.isWorkspaceInstallActive).toBe("function");
    expect(typeof WorkspaceInstallGate.createCache).toBe("function");
    expect(typeof WorkspaceInstallGate.describeState).toBe("function");
    expect(WorkspaceInstallGate.isWorkspaceInstallActive).toBe(
      isWorkspaceInstallActive,
    );
    expect(WorkspaceInstallGate.createCache).toBe(createInstallGateCache);
    expect(WorkspaceInstallGate.describeState).toBe(describeInstallGateState);
  });
});

// ───────────────────────────────────────────────────────────────────
// describeInstallGateState — structured verdict for the deny-path log
// ───────────────────────────────────────────────────────────────────

describe("describeInstallGateState", () => {
  it("returns active=true + reason='active' on the happy path", async () => {
    mockInternalQuery.mockImplementation(async () => [
      row({ min_plan: "starter", plan_tier: "business" }),
    ]);
    const verdict = await describeInstallGateState("ws-1", "catalog:slack");
    expect(verdict.active).toBe(true);
    expect(verdict.reason).toBe("active");
    expect(verdict.installEnabled).toBe(true);
    expect(verdict.catalogEnabled).toBe(true);
    expect(verdict.planTier).toBe("business");
    expect(verdict.minPlan).toBe("starter");
    expect(verdict.operatorBypass).toBe(false);
  });

  it("returns reason='plan_below_min' with the rank facts on plan mismatch", async () => {
    mockInternalQuery.mockImplementation(async () => [
      row({ min_plan: "business", plan_tier: "trial" }),
    ]);
    const verdict = await describeInstallGateState("ws-1", "catalog:slack");
    expect(verdict.active).toBe(false);
    expect(verdict.reason).toBe("plan_below_min");
    expect(verdict.planTier).toBe("trial");
    expect(verdict.minPlan).toBe("business");
  });

  it("returns reason='operatorBypass active' for operator workspaces", async () => {
    mockInternalQuery.mockImplementation(async () => [
      row({ min_plan: "business", plan_tier: "trial", is_operator_workspace: true }),
    ]);
    const verdict = await describeInstallGateState("ws-op", "catalog:slack");
    expect(verdict.active).toBe(true);
    expect(verdict.reason).toBe("active");
    expect(verdict.operatorBypass).toBe(true);
  });

  it("returns reason='install_disabled' when wp.enabled=false", async () => {
    mockInternalQuery.mockImplementation(async () => [
      row({ install_enabled: false }),
    ]);
    const verdict = await describeInstallGateState("ws-1", "catalog:slack");
    expect(verdict.active).toBe(false);
    expect(verdict.reason).toBe("install_disabled");
  });

  it("returns reason='catalog_disabled' when pc.enabled=false", async () => {
    mockInternalQuery.mockImplementation(async () => [
      row({ catalog_enabled: false }),
    ]);
    const verdict = await describeInstallGateState("ws-1", "catalog:slack");
    expect(verdict.active).toBe(false);
    expect(verdict.reason).toBe("catalog_disabled");
  });

  it("returns reason='unknown_min_plan' on catalog drift", async () => {
    mockInternalQuery.mockImplementation(async () => [
      row({ min_plan: "ultimate" }),
    ]);
    const verdict = await describeInstallGateState("ws-1", "catalog:slack");
    expect(verdict.active).toBe(false);
    expect(verdict.reason).toBe("unknown_min_plan");
    expect(verdict.minPlan).toBe("ultimate");
  });

  it("returns reason='no_install_row' when the workspace has no install", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    const verdict = await describeInstallGateState("ws-1", "catalog:slack");
    expect(verdict.active).toBe(false);
    expect(verdict.reason).toBe("no_install_row");
    expect(verdict.installFound).toBe(false);
  });

  it("returns reason='db_error' when internalQuery throws", async () => {
    mockInternalQuery.mockImplementation(async () => {
      throw new Error("connection terminated");
    });
    const verdict = await describeInstallGateState("ws-1", "catalog:slack");
    expect(verdict.active).toBe(false);
    expect(verdict.reason).toBe("db_error");
  });
});
