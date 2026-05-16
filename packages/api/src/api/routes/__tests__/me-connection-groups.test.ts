/**
 * Tests for `GET /api/v1/me/connection-groups` — the empty-list reason
 * surface added for #2422. The route returns `{ groups: [], reason }`
 * with `reason` populated when the empty list is the consequence of a
 * known degraded state (no active org, or no internal DB). A workspace
 * that genuinely has no groups configured returns `reason: null` so the
 * picker stays hidden instead of displaying explanatory copy.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { AuthResult } from "@atlas/api/lib/auth/types";

// ── Auth mock ──────────────────────────────────────────────────────────────

let fakeAuth: (AuthResult & { authenticated: true }) | null = null;

mock.module("@atlas/api/lib/auth/middleware", () => ({
  authenticateRequest: () =>
    Promise.resolve(
      fakeAuth ?? { authenticated: false, status: 401 as const, error: "anonymous" },
    ),
  checkRateLimit: () => ({ allowed: true }),
  getClientIP: () => null,
  resetRateLimits: () => {},
  rateLimitCleanupTick: () => {},
}));

mock.module("@atlas/api/lib/residency/misrouting", () => ({
  detectMisrouting: async () => null,
  isStrictRoutingEnabled: () => false,
}));

mock.module("@atlas/api/lib/residency/readonly", () => ({
  isWorkspaceMigrating: async () => false,
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    createLogger: () => logger,
    getLogger: () => logger,
    withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
    getRequestContext: () => undefined,
    redactPaths: [],
  };
});

// ── DB mock ────────────────────────────────────────────────────────────────

let dbAvailable = true;
type GroupRow = {
  group_id: string;
  group_name: string;
  connection_id: string | null;
  db_type: string | null;
  description: string | null;
};
let rowsForOrg: Record<string, GroupRow[]> = {};

mock.module("@atlas/api/lib/db/internal", () => {
  const notUsed = () => {
    throw new Error("internal.ts helper not used in this route");
  };
  return {
    hasInternalDB: () => dbAvailable,
    internalQuery: async (_sql: string, params: unknown[]) => {
      const [orgId] = params as [string];
      return rowsForOrg[orgId] ?? [];
    },
    getInternalDB: () => null,
    queryEffect: notUsed,
    internalExecute: () => {},
    closeInternalDB: async () => {},
    encryptSecret: (s: string) => s,
    decryptSecret: (s: string) => s,
    isPlaintextUrl: () => false,
    isInternalCircuitOpen: () => false,
    _resetPool: () => {},
    _resetCircuitBreaker: () => {},
    _setInternalCircuitOpenForTests: () => {},
    getAutoApproveThreshold: () => 1,
    getAutoApproveTypes: () => new Set<string>(),
    MANAGED_AUTH_MIGRATIONS: [],
    InternalDB: { Service: Symbol("InternalDB") },
    makeInternalDBLive: notUsed,
    makeInternalDBShimLayer: notUsed,
    createInternalDBTestLayer: notUsed,
    migrateInternalDB: async () => {},
    loadSavedConnections: async () => 0,
    findPatternBySQL: async () => null,
    insertLearnedPattern: () => {},
    insertSemanticAmendment: async () => {},
    getPendingAmendmentCount: async () => 0,
    getPendingAmendments: async () => [],
    reviewSemanticAmendment: async () => {},
    incrementPatternCount: () => {},
    getApprovedPatterns: async () => [],
    upsertSuggestion: async () => {},
    getSuggestionsByTables: async () => [],
    getPopularSuggestions: async () => [],
    incrementSuggestionClick: () => {},
    deleteSuggestion: async () => {},
    getAuditLogQueries: async () => [],
    getWorkspaceStatus: async () => null,
    getWorkspaceNamesByIds: async () => new Map<string, string>(),
    getWorkspaceDetails: async () => null,
    updateWorkspaceStatus: async () => {},
    updateWorkspacePlanTier: async () => {},
    getWorkspaceRegion: async () => null,
    setWorkspaceRegion: async () => {},
    cascadeWorkspaceDelete: async () => ({}),
    getWorkspaceHealthSummary: async () => ({}),
    updateWorkspaceByot: async () => {},
    setWorkspaceStripeCustomerId: async () => {},
    setWorkspaceTrialEndsAt: async () => {},
    hardDeleteWorkspace: async () => ({}),
  };
});

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { meConnectionGroups } = await import("../me-connection-groups");

function userAuth(
  opts: { orgId: string | null } = { orgId: "org-1" },
): AuthResult & { authenticated: true } {
  return {
    authenticated: true,
    mode: "managed",
    user: {
      id: "user-1",
      mode: "managed",
      label: "user@test.dev",
      role: "member",
      activeOrganizationId: opts.orgId ?? undefined,
    },
  };
}

async function getJson(res: Response) {
  return (await res.json()) as {
    groups: Array<{ id: string; name: string; members: unknown[] }>;
    reason: "no_active_org" | "no_internal_db" | null;
  };
}

beforeEach(() => {
  fakeAuth = null;
  dbAvailable = true;
  rowsForOrg = {};
});

describe("GET /api/v1/me/connection-groups — reason field (#2422)", () => {
  it("returns 401 when unauthenticated", async () => {
    fakeAuth = null;
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("returns reason: 'no_active_org' when the user has no active organization", async () => {
    fakeAuth = userAuth({ orgId: null });
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.groups).toEqual([]);
    expect(body.reason).toBe("no_active_org");
  });

  it("returns reason: 'no_internal_db' when the internal database is unavailable (self-hosted)", async () => {
    fakeAuth = userAuth();
    dbAvailable = false;
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.groups).toEqual([]);
    expect(body.reason).toBe("no_internal_db");
  });

  it("prefers 'no_internal_db' over 'no_active_org' when both apply (single signal, not a state machine)", async () => {
    // The frontend is binary — either it shows an explanation or it
    // doesn't. Picking one canonical reason avoids two callers
    // disagreeing about which copy to render. `no_internal_db` is the
    // more useful diagnostic because it points at the operator-side
    // fix; an unassigned user can also see it in their topbar.
    fakeAuth = userAuth({ orgId: null });
    dbAvailable = false;
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.reason).toBe("no_internal_db");
  });

  it("returns reason: null when the workspace simply has no groups configured", async () => {
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.groups).toEqual([]);
    expect(body.reason).toBeNull();
  });

  it("returns reason: null when the workspace has groups", async () => {
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [
      {
        group_id: "g_prod",
        group_name: "prod",
        connection_id: "us-int",
        db_type: "postgres",
        description: null,
      },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ id: "g_prod", name: "prod" });
    expect(body.reason).toBeNull();
  });
});
