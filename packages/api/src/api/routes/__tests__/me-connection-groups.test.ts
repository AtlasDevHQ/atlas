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
// Post-#2744 the route reads `workspace_plugins (pillar='datasource')`
// and projects:
//   - `config->>'group_id' AS group_id` (also acts as the group name)
//   - `install_id AS connection_id`
//   - `config->>'db_type' AS db_type`
//   - `config->>'description' AS description`
// The `connection_groups` table is gone, so there's no separate
// `group_name` or `primary_connection_id` column to mock.
type GroupRow = {
  group_id: string;
  connection_id: string;
  db_type: string | null;
  description: string | null;
};
// #3044 — the route now also reads REST datasource installs (group_id may be
// NULL) for the picker's scope footer. Routed by SQL content in the mock.
type RestRow = {
  install_id: string;
  display_name: string | null;
  snapshot_title: string | null;
  group_id: string | null;
};
let rowsForOrg: Record<string, GroupRow[]> = {};
let restRowsForOrg: Record<string, RestRow[]> = {};
let capturedQueries: string[] = [];

mock.module("@atlas/api/lib/db/internal", () => {
  const notUsed = () => {
    throw new Error("internal.ts helper not used in this route");
  };
  return {
    hasInternalDB: () => dbAvailable,
    internalQuery: async (sql: string, params: unknown[]) => {
      capturedQueries.push(sql);
      const [orgId] = params as [string];
      // The REST-datasource query is the one projecting `display_name`; the
      // SQL-member query projects `install_id AS connection_id`.
      if (sql.includes("display_name")) return restRowsForOrg[orgId] ?? [];
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
    groups: Array<{
      id: string;
      name: string;
      primaryConnectionId: string | null;
      members: Array<{ connectionId: string; dbType: string; description: string | null }>;
    }>;
    restDatasources: Array<{ id: string; displayName: string; groupId: string | null }>;
    reason: "no_active_org" | "no_internal_db" | null;
  };
}

beforeEach(() => {
  fakeAuth = null;
  dbAvailable = true;
  rowsForOrg = {};
  restRowsForOrg = {};
  capturedQueries = [];
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
        group_id: "prod",
        connection_id: "us-int",
        db_type: "postgres",
        description: null,
      },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.groups).toHaveLength(1);
    // Post-cutover groupName mirrors groupId verbatim — the
    // `connection_groups.name` separate-from-id distinction is gone.
    expect(body.groups[0]).toMatchObject({ id: "prod", name: "prod" });
    expect(body.reason).toBeNull();
  });
});

describe("GET /api/v1/me/connection-groups — primaryConnectionId surfacing (post-cutover)", () => {
  // Post-#2744 there's no separate `connection_groups.primary_connection_id`
  // column — the route always emits `primaryConnectionId: null` on every
  // group. The wire field is preserved for backwards compatibility with
  // pre-#2744 clients; the picker now falls back to its deterministic
  // first-by-install_id ordering when no explicit pin exists. These tests
  // pin that contract so a regression that re-introduces a primary
  // lookup (or accidentally drops the field) fails loudly.

  it("emits primaryConnectionId: null on every group (no connection_groups table any more)", async () => {
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [
      {
        group_id: "prod",
        connection_id: "apac-prod",
        db_type: "postgres",
        description: "APAC",
      },
      {
        group_id: "prod",
        connection_id: "eu-prod",
        db_type: "postgres",
        description: "EU",
      },
      {
        group_id: "prod",
        connection_id: "us-prod",
        db_type: "postgres",
        description: "US",
      },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.primaryConnectionId).toBeNull();
    // Member ordering preserves the SQL `ORDER BY install_id ASC` ordering
    // so the picker's deterministic-default pick is stable.
    expect(body.groups[0]?.members.map((m) => m.connectionId)).toEqual([
      "apac-prod",
      "eu-prod",
      "us-prod",
    ]);
  });

  it("buckets multiple group_ids into separate group entries", async () => {
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [
      { group_id: "prod", connection_id: "us-prod", db_type: "postgres", description: null },
      { group_id: "staging", connection_id: "us-stg", db_type: "postgres", description: null },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    const body = await getJson(res);
    expect(body.groups).toHaveLength(2);
    const ids = body.groups.map((g) => g.id).sort();
    expect(ids).toEqual(["prod", "staging"]);
  });

  it("does NOT surface a group when every member is archived (config->>'group_id' IS NOT NULL filter)", async () => {
    // The post-cutover query filters `config->>'group_id' IS NOT NULL`
    // AND `status != 'archived'`, so the legacy LEFT JOIN behavior of
    // returning a one-row-with-NULL-connection_id for an empty group is
    // gone. Archived-only groups disappear from the picker entirely —
    // which is the right UX (an empty group with no live members can't
    // route a query anywhere).
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    const body = await getJson(res);
    expect(body.groups).toEqual([]);
  });

  it("surfaces dbType + description from JSONB config fields", async () => {
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [
      {
        group_id: "prod",
        connection_id: "us-prod",
        db_type: "postgres",
        description: "US production",
      },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    const body = await getJson(res);
    expect(body.groups[0]?.members[0]).toEqual({
      connectionId: "us-prod",
      dbType: "postgres",
      description: "US production",
    });
  });

  it("falls back to dbType: 'unknown' when JSONB config has no db_type key", async () => {
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [
      {
        group_id: "prod",
        connection_id: "us-prod",
        db_type: null,
        description: null,
      },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    const body = await getJson(res);
    expect(body.groups[0]?.members[0]?.dbType).toBe("unknown");
  });
});

describe("GET /api/v1/me/connection-groups — REST datasource scope (#3044)", () => {
  it("surfaces REST datasources with their groupId (workspace-global vs scoped)", async () => {
    fakeAuth = userAuth();
    restRowsForOrg["org-1"] = [
      { install_id: "stripe-1", display_name: "Stripe", snapshot_title: null, group_id: null },
      { install_id: "intl-api", display_name: null, snapshot_title: "Intl API", group_id: "eu" },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.restDatasources).toEqual([
      { id: "stripe-1", displayName: "Stripe", groupId: null },
      // display_name blank → falls back to the spec title.
      { id: "intl-api", displayName: "Intl API", groupId: "eu" },
    ]);
  });

  it("always includes restDatasources (empty array when the workspace has none)", async () => {
    fakeAuth = userAuth();
    const res = await meConnectionGroups.request("/", { method: "GET" });
    const body = await getJson(res);
    expect(body.restDatasources).toEqual([]);
  });

  it("falls back to install_id for displayName when both display_name and spec title are blank", async () => {
    fakeAuth = userAuth();
    restRowsForOrg["org-1"] = [
      { install_id: "anon-ds", display_name: null, snapshot_title: null, group_id: null },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    const body = await getJson(res);
    expect(body.restDatasources).toEqual([
      { id: "anon-ds", displayName: "anon-ds", groupId: null },
    ]);
  });

  it("the SQL-member query excludes REST catalog_ids; the REST query selects them", async () => {
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [];
    await meConnectionGroups.request("/", { method: "GET" });

    const memberQuery = capturedQueries.find((q) => q.includes("install_id           AS connection_id"));
    const restQuery = capturedQueries.find((q) => q.includes("display_name"));
    expect(memberQuery).toBeDefined();
    expect(restQuery).toBeDefined();
    // Members EXCLUDE REST; the REST list INCLUDES exactly those catalogs.
    expect(memberQuery!.replace(/\s+/g, " ")).toContain("catalog_id <> ALL($2)");
    expect(restQuery!.replace(/\s+/g, " ")).toContain("catalog_id = ANY($2)");
  });

  it("REST datasources do NOT appear as SQL group members", async () => {
    // A REST install scoped to a SQL group must never be returned as a pickable
    // member (it can't run SQL). The route's catalog exclusion + separate query
    // keep the two surfaces disjoint.
    fakeAuth = userAuth();
    rowsForOrg["org-1"] = [
      { group_id: "prod", connection_id: "us-prod", db_type: "postgres", description: null },
    ];
    restRowsForOrg["org-1"] = [
      { install_id: "rest-prod", display_name: "Prod API", snapshot_title: null, group_id: "prod" },
    ];
    const res = await meConnectionGroups.request("/", { method: "GET" });
    const body = await getJson(res);
    expect(body.groups[0]?.members.map((m) => m.connectionId)).toEqual(["us-prod"]);
    expect(body.restDatasources.map((d) => d.id)).toEqual(["rest-prod"]);
  });
});
