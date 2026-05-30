/**
 * Route-level tests for `admin-openapi-datasources` (PRD #2868 slice 2, #2926).
 *
 * Focus on this router's OWN logic — the bits the shared admin middleware can't
 * cover:
 *   - the workspace-scoping invariant (the `WHERE workspace_id = $1` predicate
 *     is the tenant boundary: a cross-workspace install must 404, never leak),
 *   - the not-found branches,
 *   - the mutation guarantee that the encrypted `auth_value` never round-trips
 *     through the rediscover/patch UPDATEs,
 *   - probe-failure → 400 mapping on rediscover.
 *
 * The shared `adminAuth` / `mfaRequired` / `requirePermission` middleware is
 * exercised in `admin-router.test.ts`; here `./admin-router` is replaced with
 * pass-throughs (the org context comes from the per-test `CURRENT_ORG`) so the
 * assertions are about THIS file, not the perimeter.
 */

import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";

// ── Mutable per-test state the mock factories close over ─────────────────────

/** The authenticated workspace driving the request (set per test). */
let CURRENT_ORG = "org-owner";
/** Flip the mocked probe to fail (rediscover error-mapping test). */
let probeShouldFail = false;

const CATALOG_ID = "catalog:openapi-generic";

/**
 * One install owned by `org-owner`. The `internalQuery` mock emulates the SQL's
 * `WHERE workspace_id = $1` predicate — it only returns this row when the query
 * is scoped to its owner, so a request authenticated as any other workspace
 * resolves `[]` (→ 404), proving the scope clause is load-bearing.
 */
const FIXTURE = {
  install_id: "ds-1",
  owner: "org-owner",
  status: "draft",
  config: {
    openapi_url: "https://crm.example.com/openapi.json",
    auth_kind: "none",
    representation_mode: "operation-graph",
    // An (otherwise-encrypted) credential field — assert it's NEVER in a write.
    auth_value: "enc:v1:should-never-be-rewritten",
    openapi_snapshot: {
      probedAt: "2026-05-29T00:00:00.000Z",
      title: "Widget API",
      version: "1.0.0",
      openapiVersion: "3.1.0",
      operationCount: 2,
      doc: { openapi: "3.1.0", info: { title: "Widget API", version: "1.0.0" }, paths: {} },
    },
  } as Record<string, unknown>,
};

// ── Mocks (declared before importing the SUT) ────────────────────────────────

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params: unknown[] = []) => {
    const ws = params[0];
    const ownedRow = { install_id: FIXTURE.install_id, config: FIXTURE.config, status: FIXTURE.status };

    if (sql.includes("DELETE FROM workspace_plugins")) {
      const instId = params[1];
      return ws === FIXTURE.owner && instId === FIXTURE.install_id ? [{ install_id: FIXTURE.install_id }] : [];
    }
    if (sql.includes("UPDATE workspace_plugins")) {
      return []; // rediscover/patch UPDATE — rowcount unused (loadInstall already gated)
    }
    if (sql.includes("ORDER BY installed_at")) {
      return ws === FIXTURE.owner ? [ownedRow] : []; // list
    }
    // loadInstall SELECT (LIMIT 1, install_id = $2)
    const instId = params[1];
    return ws === FIXTURE.owner && instId === FIXTURE.install_id ? [ownedRow] : [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: () => true,
}));

mock.module("@atlas/api/lib/effect/hono", () => ({
  runHandler: async (_c: unknown, _label: string, fn: () => unknown) => fn(),
}));

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test-req" }) };
});

mock.module("@atlas/api/lib/audit", () => ({
  logAdminAction: () => {},
  logAdminActionAwait: async () => {},
  ADMIN_ACTIONS: {
    connection: { probe: "connection:probe", update: "connection:update", delete: "connection:delete" },
  },
}));

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

// Passthrough secrets: this suite is about the mutation paths NOT rewriting the
// credential, not about encryption itself (that's the handler test). Returning
// the config as-is keeps the fixture's (encrypted-shaped) auth_value intact so
// the "never written back" assertions are meaningful without a real keyset.
mock.module("@atlas/api/lib/plugins/secrets", () => ({
  parseConfigSchema: () => [],
  decryptSecretFields: (config: Record<string, unknown>) => ({ ...config }),
}));

/**
 * Spy on the graph-cache eviction so the rediscover/DELETE wiring (#3009) is
 * asserted at the ROUTE level — the unit tests in `probe.test.ts` prove the
 * eviction LOGIC, but only this catches a regression that drops the call, swaps
 * its args, or hoists it above the 404 guard.
 */
const invalidateGraphCacheSpy = mock((_workspaceId: string, _installId: string) => {});

// Controllable probe stub — success returns a tiny graph; failure throws the
// (locally-defined) OpenApiProbeError the route does `instanceof` against.
mock.module("@atlas/api/lib/openapi/probe", () => {
  class OpenApiProbeError extends Error {
    reason: string;
    httpStatus?: number;
    constructor(reason: string, message: string, httpStatus?: number) {
      super(message);
      this.name = "OpenApiProbeError";
      this.reason = reason;
      if (httpStatus !== undefined) this.httpStatus = httpStatus;
    }
  }
  const emptyGraph = {
    operations: new Map(),
    schemas: new Map(),
    info: { title: "Widget API", version: "1.0.0", openapiVersion: "3.1.0" },
    servers: [],
  };
  return {
    OpenApiProbeError,
    assertSpecUrlAllowed: () => {},
    buildResolvedAuth: () => ({ kind: "none" }),
    // The shared decrypt→auth glue the rediscover route now calls. The fixture's
    // auth_kind is "none", so the success arm (ok: true) is the relevant one;
    // the 400 (ok: false) branch is exercised by the workspace-resolver tests.
    resolveAuthFromDecryptedConfig: () => ({ ok: true, auth: { kind: "none" } }),
    probeSpec: async () => {
      if (probeShouldFail) throw new OpenApiProbeError("unreachable", "probe boom");
      return { doc: { openapi: "3.1.0" }, graph: emptyGraph };
    },
    buildSnapshot: (doc: unknown, _g: unknown, probedAt: string) => ({
      probedAt,
      title: "Widget API",
      version: "1.0.0",
      openapiVersion: "3.1.0",
      operationCount: 0,
      doc,
    }),
    snapshotToGraph: () => emptyGraph,
    invalidateInstallGraphCache: invalidateGraphCacheSpy,
    summarizeOperations: () => [],
    __resetSnapshotGraphCacheForTests: () => {},
  };
});

// Replace the shared admin middleware with pass-throughs; org id = CURRENT_ORG.
mock.module("../admin-router", () => ({
  createAdminRouter: () => new OpenAPIHono(),
  requireOrgContext: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("orgContext", { requestId: "test-req", orgId: CURRENT_ORG });
    await next();
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

// ── SUT (dynamic import AFTER mocks so a static import isn't hoisted above them) ─

const { adminOpenApiDatasources } = await import("../admin-openapi-datasources");

const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(() => {
  CURRENT_ORG = FIXTURE.owner;
  probeShouldFail = false;
  mockInternalQuery.mockClear();
  invalidateGraphCacheSpy.mockClear();
});
afterEach(() => {
  CURRENT_ORG = FIXTURE.owner;
  probeShouldFail = false;
});

// ── Workspace scoping (tenant isolation) ─────────────────────────────────────

describe("admin-openapi-datasources — workspace scoping", () => {
  it("returns the install on GET detail when owned by the caller's workspace", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("ds-1");
  });

  it("404s every per-install op for a workspace that does NOT own the install (no cross-tenant leak)", async () => {
    CURRENT_ORG = "org-attacker"; // authenticated as a different workspace
    const detail = await adminOpenApiDatasources.request("/ds-1");
    const del = await adminOpenApiDatasources.request("/ds-1", { method: "DELETE" });
    const rediscover = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    const patch = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ representationMode: "semantic-yaml" }),
    });
    expect([detail.status, del.status, rediscover.status, patch.status]).toEqual([404, 404, 404, 404]);
  });

  it("scopes loadInstall by both workspace_id ($1) and install_id ($2), passing the authed org", async () => {
    await adminOpenApiDatasources.request("/ds-1");
    const select = mockInternalQuery.mock.calls.find(([sql]) => sql.includes("LIMIT 1"));
    expect(select?.[0]).toContain("workspace_id = $1");
    expect(select?.[0]).toContain("install_id = $2");
    expect((select?.[1] as unknown[])[0]).toBe(FIXTURE.owner); // authed org is $1
  });

  it("list only returns the calling workspace's datasources", async () => {
    const owned = (await (await adminOpenApiDatasources.request("/")).json()) as { datasources: unknown[] };
    expect(owned.datasources).toHaveLength(1);
    CURRENT_ORG = "org-attacker";
    const other = (await (await adminOpenApiDatasources.request("/")).json()) as { datasources: unknown[] };
    expect(other.datasources).toHaveLength(0);
  });

  it("404s a nonexistent install", async () => {
    const res = await adminOpenApiDatasources.request("/does-not-exist");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });
});

// ── The encrypted auth_value never round-trips through a mutation ────────────

describe("admin-openapi-datasources — mutations never rewrite the credential", () => {
  it("PATCH writes only representation_mode (no auth_value in the UPDATE)", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ representationMode: "semantic-yaml" }),
    });
    expect(res.status).toBe(200);
    const update = mockInternalQuery.mock.calls.find(
      ([sql]) => sql.includes("UPDATE") && sql.includes("representation_mode"),
    );
    expect(update).toBeDefined();
    expect(update![0]).toContain("jsonb_build_object('representation_mode'");
    expect(update![0]).not.toContain("auth_value");
    expect(update![1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, "semantic-yaml"]);
  });

  it("rediscover writes only openapi_snapshot — no auth_value in the SQL or the payload", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);
    const update = mockInternalQuery.mock.calls.find(
      ([sql]) => sql.includes("UPDATE") && sql.includes("openapi_snapshot"),
    );
    expect(update).toBeDefined();
    expect(update![0]).toContain("jsonb_build_object('openapi_snapshot'");
    expect(update![0]).not.toContain("auth_value");
    const snapshotJson = (update![1] as unknown[])[3] as string;
    expect(snapshotJson).not.toContain("auth_value");
    expect(snapshotJson).not.toContain("should-never-be-rewritten");
  });
});

// ── Rediscover probe-failure mapping ─────────────────────────────────────────

describe("admin-openapi-datasources — rediscover error mapping", () => {
  it("maps a probe failure to 400 probe_failed (not a 500)", async () => {
    probeShouldFail = true;
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("probe_failed");
  });

  it("Refresh now (rediscover) re-probes the upstream spec on success", async () => {
    // The snapshot UPDATE only fires after probeSpec resolves, so its presence is
    // proof the manual "Refresh now" triggered a live re-probe (AC: re-probe).
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);
    const update = mockInternalQuery.mock.calls.find(
      ([sql]) => (sql as string).includes("UPDATE") && (sql as string).includes("openapi_snapshot"),
    );
    expect(update).toBeDefined();
  });
});

// ── Graph-cache eviction wiring (#3009) ──────────────────────────────────────

describe("admin-openapi-datasources — graph-cache eviction wiring", () => {
  it("rediscover evicts the install's cached graph after a successful re-probe", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);
    // Scoped to (workspaceId, installId) — the exact #3009 wiring, args in order.
    expect(invalidateGraphCacheSpy).toHaveBeenCalledTimes(1);
    expect(invalidateGraphCacheSpy).toHaveBeenLastCalledWith(FIXTURE.owner, "ds-1");
  });

  it("DELETE evicts the uninstalled datasource's cached graph", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(invalidateGraphCacheSpy).toHaveBeenCalledTimes(1);
    expect(invalidateGraphCacheSpy).toHaveBeenLastCalledWith(FIXTURE.owner, "ds-1");
  });

  it("does NOT evict on a failed rediscover (eviction only after a successful re-probe)", async () => {
    probeShouldFail = true;
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(400);
    expect(invalidateGraphCacheSpy).not.toHaveBeenCalled();
  });

  it("does NOT evict when the install is not owned by the caller (404 — no cross-tenant flush)", async () => {
    CURRENT_ORG = "org-attacker";
    const del = await adminOpenApiDatasources.request("/ds-1", { method: "DELETE" });
    const rediscover = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect([del.status, rediscover.status]).toEqual([404, 404]);
    expect(invalidateGraphCacheSpy).not.toHaveBeenCalled();
  });
});

// ── Per-install spec-refresh interval (#2977) ────────────────────────────────

/** The merge UPDATE the PATCH handler issues, if any. */
function findConfigUpdate() {
  return mockInternalQuery.mock.calls.find(([sql]) => (sql as string).includes("UPDATE"));
}

describe("admin-openapi-datasources — spec_refresh_interval set / clear / clamp", () => {
  it("GET detail surfaces specRefreshInterval (default off when the row has no key)", async () => {
    const body = (await (await adminOpenApiDatasources.request("/ds-1")).json()) as {
      specRefreshInterval: string;
    };
    // The fixture config carries no spec_refresh_interval → coerced to the default.
    expect(body.specRefreshInterval).toBe("off");
  });

  it("PATCH sets a named preset, writing only spec_refresh_interval (never auth_value)", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ specRefreshInterval: "daily" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { specRefreshInterval: string }).toMatchObject({
      specRefreshInterval: "daily",
    });
    const update = findConfigUpdate();
    expect(update?.[0]).toContain("jsonb_build_object('spec_refresh_interval'");
    expect(update?.[0]).not.toContain("auth_value");
    expect(update?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, "daily"]);
  });

  it("PATCH clears the interval by setting it back to off", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ specRefreshInterval: "off" }),
    });
    expect(res.status).toBe(200);
    expect(findConfigUpdate()?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, "off"]);
  });

  it("PATCH clamps an out-of-range custom interval to the ceiling (not a rejection)", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ specRefreshInterval: "9000h" }),
    });
    expect(res.status).toBe(200);
    // 30-day ceiling = 720h.
    expect(findConfigUpdate()?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, "720h"]);
  });

  it("PATCH rejects an unparseable interval with an actionable 400 — no silent fallback, no UPDATE", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ specRefreshInterval: "soon" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("daily"); // names the valid options
    // The bad value never reached the database.
    expect(findConfigUpdate()).toBeUndefined();
  });

  it("PATCH can update representation mode and refresh interval together", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ representationMode: "semantic-yaml", specRefreshInterval: "weekly" }),
    });
    expect(res.status).toBe(200);
    const update = findConfigUpdate();
    expect(update?.[0]).toContain("representation_mode");
    expect(update?.[0]).toContain("spec_refresh_interval");
    expect(update?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, "semantic-yaml", "weekly"]);
  });

  it("PATCH with an empty body is a 400 (at least one field required)", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
