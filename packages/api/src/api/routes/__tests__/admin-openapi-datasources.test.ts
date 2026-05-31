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
 *
 * Test-infra note (#2991): the DB seam is an Effect test layer, not a
 * `mock.module()`. `createOpenApiDatasourceTestLayer` installs a recording fake
 * SqlClient into the module-level slot `internalQuery()` prefers, so the route's
 * REAL `internalQuery()` runs end-to-end and every statement lands in `db.calls`
 * (the typed replacement for `mock.fn.mock.calls`). The remaining `mock.module()`
 * calls cover dependencies with no Effect-layer seam: `openapi/probe` (the route
 * imports its functions directly — we need a controllable probe + a spy on
 * `invalidateInstallGraphCache`), `../admin-router` (Hono middleware, no layer),
 * `plugins/secrets` (a deliberate decrypt passthrough), `effect/hono` (run the
 * handler without booting the enterprise runtime), the `audit` modules
 * (`audit` + `audit/error-scrub` — silence + keep audit's DB writes out of
 * `db.calls`), and `logger`. Converting those would mean reshaping the route
 * into an Effect program — out of scope for this chore.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Effect, ManagedRuntime } from "effect";
import { createOpenApiDatasourceTestLayer } from "@atlas/api/__test-utils__/layers";

// ── Mutable per-test state the mock factories close over ─────────────────────

/** The authenticated workspace driving the request (set per test). */
let CURRENT_ORG = "org-owner";
/** Flip the mocked probe to fail (rediscover error-mapping test). */
let probeShouldFail = false;
/** Force resolveAuthFromDecryptedConfig to its ok:false arm (rediscover 400 tests). */
let authResultOverride: { ok: false; rawAuthKind: string } | null = null;
/** Extra config fields merged into the loaded install row (e.g. base_url_override). */
let configExtra: Record<string, unknown> = {};
/** #3044 — controllable verdict for the group-existence guard on group_id assignment. */
let mockGroupVerdict: "ok" | "not_found" | "error" | "no_db" = "ok";
/** The `options` the route last passed to `probeSpec` — asserts the #3034 host gate is threaded. */
let lastProbeOptions: { apiBaseUrl?: string } | undefined;

const CATALOG_ID = "catalog:openapi-generic";

/**
 * One install owned by `org-owner`. The `db` recorder's `query` callback (below)
 * emulates the SQL's `WHERE workspace_id = $1` predicate — it only returns this
 * row when the query is scoped to its owner, so a request authenticated as any
 * other workspace resolves `[]` (→ 404), proving the scope clause is load-bearing.
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

// ── DB seam — a recording Effect layer (NOT a module mock), see #2991 ────────

/**
 * Routes the route's module-level `internalQuery()` through a recording fake.
 * The `query` callback emulates the SQL behaviour the assertions rely on: the
 * `WHERE workspace_id = $1` scoping predicate, the DELETE `RETURNING` rowcount,
 * and the unused UPDATE rowcount. Every statement is captured in `db.calls`.
 * Built/disposed by the suite-level `beforeAll`/`afterAll` below.
 */
const db = createOpenApiDatasourceTestLayer((sql, params) => {
  const ws = params[0];
  const ownedRow = {
    install_id: FIXTURE.install_id,
    config: { ...FIXTURE.config, ...configExtra },
    status: FIXTURE.status,
  };

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
});

// ── Mocks (declared before importing the SUT) ────────────────────────────────

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

// #3044 — the group_id assignment guard calls verifyGroupBelongsToOrg; mock it
// so the existence verdict is controllable without seeding the db recorder.
mock.module("@atlas/api/lib/conversations", () => ({
  verifyGroupBelongsToOrg: async () => mockGroupVerdict,
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
    resolveAuthFromDecryptedConfig: () => authResultOverride ?? { ok: true, auth: { kind: "none" } },
    probeSpec: async (_url: string, _auth: unknown, options?: { apiBaseUrl?: string }) => {
      lastProbeOptions = options;
      if (probeShouldFail) throw new OpenApiProbeError("unreachable", "probe boom");
      return { doc: { openapi: "3.1.0" }, graph: emptyGraph };
    },
    // The credential-free conditional probe (#2970) — mocked for completeness
    // (the rediscover route under test is generic-only and never reaches it; the
    // "mock all exports" rule requires it so `shared-spec-cache`'s import resolves).
    conditionalProbe: async () => ({ notModified: false, doc: { openapi: "3.1.0" }, graph: emptyGraph }),
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

// Build the DB layer once for the file: `runPromise(Effect.void)` forces the
// scoped acquire (installs the recording client into the module slot), and
// `dispose()` runs the finalizer (restores the slot to null) so nothing leaks.
let dbRuntime: ManagedRuntime.ManagedRuntime<never, never>;
beforeAll(async () => {
  dbRuntime = ManagedRuntime.make(db.layer);
  await dbRuntime.runPromise(Effect.void);
});
afterAll(async () => {
  await dbRuntime.dispose();
});

beforeEach(() => {
  CURRENT_ORG = FIXTURE.owner;
  probeShouldFail = false;
  configExtra = {};
  mockGroupVerdict = "ok";
  lastProbeOptions = undefined;
  db.clear();
  invalidateGraphCacheSpy.mockClear();
});
afterEach(() => {
  CURRENT_ORG = FIXTURE.owner;
  probeShouldFail = false;
  authResultOverride = null;
  configExtra = {};
  lastProbeOptions = undefined;
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
    const select = db.calls.find(([sql]) => sql.includes("LIMIT 1"));
    expect(select?.[0]).toContain("workspace_id = $1");
    expect(select?.[0]).toContain("install_id = $2");
    expect(select?.[1][0]).toBe(FIXTURE.owner); // authed org is $1
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
    const update = db.calls.find(
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
    const update = db.calls.find(
      ([sql]) => sql.includes("UPDATE") && sql.includes("openapi_snapshot"),
    );
    expect(update).toBeDefined();
    expect(update![0]).toContain("jsonb_build_object('openapi_snapshot'");
    expect(update![0]).not.toContain("auth_value");
    const snapshotJson = update![1][3] as string;
    expect(snapshotJson).not.toContain("auth_value");
    expect(snapshotJson).not.toContain("should-never-be-rewritten");
  });

  it("rediscover persists the computed spec diff and returns its summary (#2976)", async () => {
    // Prior snapshot declares one operation; the mocked re-probe returns an empty
    // graph → the diff is "1 operation removed". This drives the REAL diff +
    // persistence end-to-end through the route (probe is mocked; diff is not).
    configExtra = {
      openapi_snapshot: {
        probedAt: "2026-05-28T00:00:00.000Z",
        title: "Widget API",
        version: "1.0.0",
        openapiVersion: "3.1.0",
        operationCount: 1,
        doc: {
          openapi: "3.1.0",
          info: { title: "Widget API", version: "1.0.0" },
          paths: {
            "/things/{id}": {
              get: {
                operationId: "getThing",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: {
                  "200": {
                    description: "ok",
                    content: {
                      "application/json": {
                        schema: { type: "object", properties: { id: { type: "string" } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);

    // The UPDATE merges BOTH the snapshot and the diff record in one statement.
    const update = db.calls.find(
      ([sql]) => sql.includes("UPDATE") && sql.includes("openapi_last_diff"),
    );
    expect(update).toBeDefined();
    expect(update![0]).toContain("jsonb_build_object('openapi_snapshot'");
    expect(update![0]).toContain("openapi_last_diff");
    const diffJson = JSON.parse(update![1][4] as string) as {
      previousProbedAt: string | null;
      currentProbedAt: string;
      diff: { counts: { operationsRemoved: number }; unchanged: boolean } | null;
    };
    expect(diffJson.previousProbedAt).toBe("2026-05-28T00:00:00.000Z");
    expect(diffJson.diff?.unchanged).toBe(false);
    expect(diffJson.diff?.counts.operationsRemoved).toBe(1);

    // …and the response surfaces the projected drift summary for the toast.
    const body = (await res.json()) as {
      drift: { baseline: boolean; unchanged: boolean; counts: { operationsRemoved: number } } | null;
    };
    expect(body.drift?.baseline).toBe(false);
    expect(body.drift?.unchanged).toBe(false);
    expect(body.drift?.counts.operationsRemoved).toBe(1);
  });

  it("records an unparseable-prior baseline when the prior snapshot no longer parses (#2976)", async () => {
    // The prior snapshot is structurally valid (passes isValidSnapshot) but its
    // cached `doc` no longer rebuilds — a `get` missing its operationId makes the
    // REAL buildOperationGraph throw (probe is mocked; spec.ts is not). The
    // rediscover must NOT fail: it records a baseline FLAGGED priorParseFailed and
    // still persists the fresh snapshot, so a dropped comparison is distinguishable
    // from a clean first-ever baseline.
    configExtra = {
      openapi_snapshot: {
        probedAt: "2026-05-27T00:00:00.000Z",
        title: "Widget API",
        version: "1.0.0",
        openapiVersion: "3.1.0",
        operationCount: 1,
        doc: {
          openapi: "3.1.0",
          info: { title: "Widget API", version: "1.0.0" },
          // `get` with no operationId → buildOperationGraph throws missing-operation-id.
          paths: { "/things": { get: { responses: { "200": { description: "ok" } } } } },
        },
      },
    };

    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);

    const update = db.calls.find(
      ([sql]) => sql.includes("UPDATE") && sql.includes("openapi_last_diff"),
    );
    expect(update).toBeDefined();
    const diffJson = JSON.parse(update![1][4] as string) as {
      previousProbedAt: string | null;
      diff: unknown;
      priorParseFailed?: boolean;
    };
    // Prior probedAt retained, comparison dropped, dropped-compare flag set.
    expect(diffJson.previousProbedAt).toBe("2026-05-27T00:00:00.000Z");
    expect(diffJson.diff).toBeNull();
    expect(diffJson.priorParseFailed).toBe(true);

    const body = (await res.json()) as {
      drift: { baseline: boolean; priorParseFailed: boolean } | null;
    };
    expect(body.drift?.baseline).toBe(true);
    expect(body.drift?.priorParseFailed).toBe(true);
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
    const update = db.calls.find(
      ([sql]) => sql.includes("UPDATE") && sql.includes("openapi_snapshot"),
    );
    expect(update).toBeDefined();
  });

  it("threads base_url_override as the probe host gate (apiBaseUrl) on re-probe (#3034)", async () => {
    // The stored API host is the admin's base_url_override. The route must forward
    // it to probeSpec so the host-match gate decides whether to re-attach the
    // credential — install + rediscover stay symmetric. A regression that drops the
    // `{ apiBaseUrl }` thread would silently re-open the leak on the refresh path.
    configExtra = { base_url_override: "https://crm.example.com" };
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);
    expect(lastProbeOptions?.apiBaseUrl).toBe("https://crm.example.com");
  });

  it("passes NO apiBaseUrl when the stored config has no base_url_override (fail-safe withhold)", async () => {
    // The fixture config has no base_url_override → the gate host is unknown, so the
    // re-probe must withhold the credential (probeSpec receives no apiBaseUrl).
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);
    expect(lastProbeOptions?.apiBaseUrl).toBeUndefined();
  });

  it("maps a deferred oauth2 row to a 400 with the oauth2-specific message (no UPDATE)", async () => {
    authResultOverride = { ok: false, rawAuthKind: "oauth2" };
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("bad_request");
    expect(body.message).toContain("oauth2");
    // Failed auth resolution short-circuits before the snapshot UPDATE + eviction.
    expect(db.calls.find(([sql]) => sql.includes("UPDATE"))).toBeUndefined();
    expect(invalidateGraphCacheSpy).not.toHaveBeenCalled();
  });

  it("maps a drifted (non-oauth2) auth kind to a 400 with a generic fix-config message", async () => {
    authResultOverride = { ok: false, rawAuthKind: "weird-kind" };
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("weird-kind"); // names the offending value
    expect(body.message).not.toContain("oauth2"); // NOT the oauth2 remediation
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
  return db.calls.find(([sql]) => sql.includes("UPDATE"));
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

describe("admin-openapi-datasources — env scope (group_id, #3044)", () => {
  it("GET detail surfaces groupId from config (null when ungrouped)", async () => {
    const ungrouped = (await (await adminOpenApiDatasources.request("/ds-1")).json()) as {
      groupId: string | null;
    };
    expect(ungrouped.groupId).toBeNull();

    configExtra = { group_id: "prod" };
    const scoped = (await (await adminOpenApiDatasources.request("/ds-1")).json()) as {
      groupId: string | null;
    };
    expect(scoped.groupId).toBe("prod");
  });

  it("PATCH assigns a group_id, writing only group_id (never auth_value)", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ groupId: "prod" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { groupId: string | null }).toMatchObject({ groupId: "prod" });
    const update = findConfigUpdate();
    expect(update?.[0]).toContain("jsonb_build_object('group_id'");
    expect(update?.[0]).not.toContain("auth_value");
    expect(update?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, "prod"]);
  });

  it("PATCH clears the scope back to workspace-global by binding null", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ groupId: null }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { groupId: string | null }).toMatchObject({ groupId: null });
    // The merge binds null → JSON null → read back as workspace-global.
    expect(findConfigUpdate()?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, null]);
  });

  it("PATCH treats a whitespace-only group id as a clear (null), never a literal scope", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ groupId: "   " }),
    });
    expect(res.status).toBe(200);
    expect(findConfigUpdate()?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, null]);
  });

  it("PATCH can set representation mode and group scope together", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ representationMode: "semantic-yaml", groupId: "eu" }),
    });
    expect(res.status).toBe(200);
    const update = findConfigUpdate();
    expect(update?.[0]).toContain("representation_mode");
    expect(update?.[0]).toContain("group_id");
    expect(update?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, "semantic-yaml", "eu"]);
  });

  it("PATCH rejects a group_id that doesn't exist in the workspace — no UPDATE", async () => {
    mockGroupVerdict = "not_found";
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ groupId: "typo-env" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_connection_group");
    // The bad assignment never reached the database.
    expect(findConfigUpdate()).toBeUndefined();
  });

  it("PATCH does NOT gate a clear-to-workspace-global on group existence", async () => {
    // Clearing (groupId: null) must always work — even if the group-existence
    // check would say "not_found" for some value, null is never validated.
    mockGroupVerdict = "not_found";
    const res = await adminOpenApiDatasources.request("/ds-1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ groupId: null }),
    });
    expect(res.status).toBe(200);
    expect(findConfigUpdate()?.[1]).toEqual([FIXTURE.owner, "ds-1", CATALOG_ID, null]);
  });
});

// ── Breaking-change drift signal (#2979) ─────────────────────────────────────

/** A persisted breaking-change alert as it'd sit in `config.openapi_drift_alert`. */
const DRIFT_ALERT = {
  raisedAt: "2026-05-31T01:00:00.000Z",
  previousProbedAt: "2026-05-30T00:00:00.000Z",
  currentProbedAt: "2026-05-31T00:00:00.000Z",
  breakingCount: 1,
  reasons: [{ kind: "operation_removed", operationId: "getThing", detail: "Operation \"getThing\" was removed" }],
  counts: {
    operationsAdded: 0,
    operationsRemoved: 1,
    operationsChanged: 0,
    schemasAdded: 0,
    schemasRemoved: 0,
    schemasChanged: 0,
    fieldsAdded: 0,
    fieldsRemoved: 0,
    fieldsRetyped: 0,
  },
  acknowledgedAt: null as string | null,
};

describe("admin-openapi-datasources — breaking-drift signal projection (#2979)", () => {
  it("GET detail surfaces driftAlert when the install carries one", async () => {
    configExtra = { openapi_drift_alert: DRIFT_ALERT };
    const body = (await (await adminOpenApiDatasources.request("/ds-1")).json()) as {
      driftAlert: { breakingCount: number; acknowledgedAt: string | null; reasons: unknown[] } | null;
    };
    expect(body.driftAlert).not.toBeNull();
    expect(body.driftAlert?.breakingCount).toBe(1);
    expect(body.driftAlert?.acknowledgedAt).toBeNull();
    expect(body.driftAlert?.reasons).toHaveLength(1);
  });

  it("GET detail projects driftAlert to null when the field is absent or malformed", async () => {
    // Absent (the fixture default) → null.
    const noAlert = (await (await adminOpenApiDatasources.request("/ds-1")).json()) as { driftAlert: unknown };
    expect(noAlert.driftAlert).toBeNull();

    // A malformed record (missing the load-bearing raisedAt) → null, never garbage.
    configExtra = { openapi_drift_alert: { currentProbedAt: "x" } };
    const malformed = (await (await adminOpenApiDatasources.request("/ds-1")).json()) as { driftAlert: unknown };
    expect(malformed.driftAlert).toBeNull();
  });
});

describe("admin-openapi-datasources — acknowledge-drift endpoint (#2979)", () => {
  it("stamps acknowledgedAt via jsonb_set, scoped to the workspace", async () => {
    const res = await adminOpenApiDatasources.request("/ds-1/acknowledge-drift", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { acknowledged: boolean }).toEqual({ acknowledged: true });

    const update = db.calls.find(([sql]) => sql.includes("UPDATE") && sql.includes("jsonb_set"));
    expect(update).toBeDefined();
    expect(update![0]).toContain("openapi_drift_alert,acknowledgedAt");
    expect(update![0]).toContain("workspace_id = $1");
    expect(update![0]).not.toContain("auth_value");
    // [orgId, installId, catalogId, <iso acknowledgedAt>]
    expect(update![1][0]).toBe(FIXTURE.owner);
    expect(update![1][1]).toBe("ds-1");
    expect(update![1][2]).toBe(CATALOG_ID);
    expect(typeof update![1][3]).toBe("string");
  });

  it("404s acknowledge for a workspace that does not own the install (no UPDATE)", async () => {
    CURRENT_ORG = "org-attacker";
    const res = await adminOpenApiDatasources.request("/ds-1/acknowledge-drift", { method: "POST" });
    expect(res.status).toBe(404);
    expect(db.calls.find(([sql]) => sql.includes("jsonb_set"))).toBeUndefined();
  });

  it("404s acknowledge for a nonexistent install", async () => {
    const res = await adminOpenApiDatasources.request("/does-not-exist/acknowledge-drift", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("admin-openapi-datasources — manual rediscover drift lifecycle (#2979)", () => {
  it("CLEARS the standing signal on a clean manual refresh (writes openapi_drift_alert null)", async () => {
    // The fixture's prior snapshot has empty paths; the mocked re-probe returns an
    // empty graph → the diff is `unchanged` (clean) → manual refresh CLEARS the pill.
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);
    const update = db.calls.find(([sql]) => sql.includes("UPDATE") && sql.includes("openapi_snapshot"));
    expect(update).toBeDefined();
    expect(update![0]).toContain("openapi_drift_alert");
    // No watermark on the manual path, so the alert is bound at $6 → JSON null clear.
    expect(update![1]).toHaveLength(6);
    expect(update![1][5]).toBeNull();
  });

  it("does NOT raise a persisted pill on a breaking manual refresh (admin sees the inline diff)", async () => {
    // Prior snapshot declares an operation; the empty re-probe makes the diff
    // "1 operation removed" = BREAKING. A MANUAL refresh must LEAVE the persisted
    // signal alone (no openapi_drift_alert in the merge) — only the scheduler raises.
    configExtra = {
      openapi_snapshot: {
        probedAt: "2026-05-28T00:00:00.000Z",
        title: "Widget API",
        version: "1.0.0",
        openapiVersion: "3.1.0",
        operationCount: 1,
        doc: {
          openapi: "3.1.0",
          info: { title: "Widget API", version: "1.0.0" },
          paths: {
            "/things/{id}": {
              get: {
                operationId: "getThing",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      },
    };
    const res = await adminOpenApiDatasources.request("/ds-1/rediscover", { method: "POST" });
    expect(res.status).toBe(200);
    const update = db.calls.find(([sql]) => sql.includes("UPDATE") && sql.includes("openapi_snapshot"));
    expect(update).toBeDefined();
    expect(update![0]).not.toContain("openapi_drift_alert"); // LEAVE — no pill raised
    expect(update![1]).toHaveLength(5); // snapshot + diff only, no alert param
  });
});
