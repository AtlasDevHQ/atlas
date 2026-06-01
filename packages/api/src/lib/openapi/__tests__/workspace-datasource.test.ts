/**
 * Tests for the slice-2 DB-backed REST datasource resolver
 * (`workspace-datasource.ts`, #2926). The query is injected (`deps.query`) so the
 * resolver is exercised without a DB — no `mock.module()`. Covers: multi-instance
 * resolution, per-install representation-mode (default + override), auth shapes,
 * base-url override, and the per-install fail-soft skip paths.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resolveWorkspaceRestDatasources,
  resolveWorkspaceRestDatasourcesOrThrow,
  resolveWorkspacePrimaryRestDatasource,
  defaultQuery,
  RestDatasourceReconnectError,
  RestDatasourceFocusUnusableError,
  type OpenApiInstallRow,
} from "../workspace-datasource";
import { buildOperationGraph } from "../spec";
import { buildSnapshot, __resetSnapshotGraphCacheForTests } from "../probe";
import { __resetSharedSpecCacheForTests, sharedSpecCacheStats } from "../shared-spec-cache";
import { MOCK_OPENAPI_SPEC } from "@atlas/api/testing/openapi-datasource";
import { OPENAPI_GENERIC_CATALOG_ID, type OpenApiSnapshot } from "../catalog";
import { REST_DATASOURCE_CATALOG_IDS, STRIPE_DATA_CANDIDATE } from "../data-candidates";

const graph = buildOperationGraph(MOCK_OPENAPI_SPEC);

function snapshot(probedAt = "2026-05-29T00:00:00.000Z"): OpenApiSnapshot {
  return buildSnapshot(MOCK_OPENAPI_SPEC, graph, probedAt);
}

/** A decrypted-shaped install config (auth_value plaintext — decrypt passes it through). */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi_url: "https://widgets.example.com/openapi.json",
    auth_kind: "bearer",
    auth_value: "plaintext-token",
    display_name: "Widgets",
    representation_mode: "operation-graph",
    openapi_snapshot: snapshot(),
    ...overrides,
  };
}

const queryReturning = (rows: OpenApiInstallRow[]) => async () => rows;

beforeEach(() => {
  __resetSnapshotGraphCacheForTests();
  __resetSharedSpecCacheForTests();
});
afterEach(() => {
  __resetSnapshotGraphCacheForTests();
  __resetSharedSpecCacheForTests();
});

describe("resolveWorkspaceRestDatasources", () => {
  it("resolves an install into a RestDatasource (graph + bearer auth + baseUrl)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config() }]),
    });
    expect(result).toHaveLength(1);
    const ds = result[0];
    expect(ds.id).toBe("ds-1");
    expect(ds.displayName).toBe("Widgets");
    expect(ds.graph.operations.has("listWidgets")).toBe(true);
    expect(ds.auth).toEqual({ kind: "bearer", token: "plaintext-token" });
    expect(ds.baseUrl).toBe("https://widgets.example.com/api"); // from servers[0].url
    expect(ds.representationMode).toBe("operation-graph");
  });

  it("honors the per-install representation-mode toggle (semantic-yaml)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config({ representation_mode: "semantic-yaml" }) }]),
    });
    expect(result[0].representationMode).toBe("semantic-yaml");
  });

  it("coerces an unknown representation-mode to the bake-off default", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config({ representation_mode: "bogus" }) }]),
    });
    expect(result[0].representationMode).toBe("operation-graph");
  });

  it("applies base_url_override over the spec servers", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-1", config: config({ base_url_override: "https://staging.example.com/v1/" }) },
      ]),
    });
    expect(result[0].baseUrl).toBe("https://staging.example.com/v1"); // trailing slash stripped
  });

  it("resolves a relative spec server against the spec URL", async () => {
    const relDoc = {
      openapi: "3.1.0",
      info: { title: "Rel", version: "1.0.0" },
      servers: [{ url: "/rest" }],
      paths: { "/things": { get: { operationId: "listThings", responses: { "200": { description: "OK" } } } } },
    };
    const relSnap = buildSnapshot(relDoc, buildOperationGraph(relDoc), "2026-05-29T06:00:00.000Z");
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-rel", config: config({ openapi_url: "https://api.example.com/openapi.json", openapi_snapshot: relSnap }) },
      ]),
    });
    expect(result[0].baseUrl).toBe("https://api.example.com/rest");
  });

  it("falls back to the spec URL origin when the doc declares no servers", async () => {
    const noSrvDoc = {
      openapi: "3.1.0",
      info: { title: "NoSrv", version: "1.0.0" },
      paths: { "/things": { get: { operationId: "listThings", responses: { "200": { description: "OK" } } } } },
    };
    const noSrvSnap = buildSnapshot(noSrvDoc, buildOperationGraph(noSrvDoc), "2026-05-29T07:00:00.000Z");
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-nosrv", config: config({ openapi_url: "https://api.example.com/v3/openapi.json", openapi_snapshot: noSrvSnap }) },
      ]),
    });
    expect(result[0].baseUrl).toBe("https://api.example.com");
  });

  it("builds apikey-header auth with the configured header name", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        {
          install_id: "ds-1",
          config: config({ auth_kind: "apikey-header", auth_value: "k123", auth_header_name: "X-My-Key" }),
        },
      ]),
    });
    expect(result[0].auth).toEqual({ kind: "apiKey", value: "k123", placement: { in: "header", name: "X-My-Key" } });
  });

  it("resolves multiple installs side by side (multi-instance)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "twenty", config: config({ display_name: "Twenty", openapi_snapshot: snapshot("2026-05-29T01:00:00.000Z") }) },
        { install_id: "stripe", config: config({ display_name: "Stripe", openapi_snapshot: snapshot("2026-05-29T02:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["twenty", "stripe"]);
    expect(result.map((d) => d.displayName)).toEqual(["Twenty", "Stripe"]);
  });

  it("skips an install with no cached snapshot (fail-soft), not the whole set", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "broken", config: config({ openapi_snapshot: undefined }) },
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-29T03:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });

  it("returns [] when the query throws (fail-soft)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: async () => {
        throw new Error("pg down");
      },
    });
    expect(result).toEqual([]);
  });

  it("skips an install with a malformed snapshot (drifted/older builder), not the whole set", async () => {
    // A snapshot missing required fields (here: no `title`) must be treated as
    // "no snapshot" by isValidSnapshot — not built into a RestDatasource with
    // undefined denormalized fields. The sibling healthy install survives.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "drifted", config: config({ openapi_snapshot: { probedAt: "t", version: "1", openapiVersion: "3.1.0", operationCount: 1, doc: {} } }) },
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-29T08:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });

  it("skips an install using the deferred oauth2 auth kind (slice 6), not the whole set", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "oauth", config: config({ auth_kind: "oauth2", openapi_snapshot: snapshot("2026-05-29T09:00:00.000Z") }) },
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-29T10:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });

  it("falls back to the snapshot title when display_name is absent", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "ds-1", config: config({ display_name: undefined }) }]),
    });
    expect(result[0].displayName).toBe("Mock Widget API");
  });

  it("carries a valid write_allowlist (JSON string) through to the datasource", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-1", config: config({ write_allowlist: '["createOneWidget","deleteOneWidget"]' }) },
      ]),
    });
    expect([...result[0].writeAllowlist].toSorted()).toEqual(["createOneWidget", "deleteOneWidget"]);
  });

  it("fails a malformed write_allowlist CLOSED (read-only, size 0) without sinking the install", async () => {
    // The exact regression guard #2929 asked for: a hostile/garbage allowlist
    // string must resolve to NO write access, not silently enable writes.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-1", config: config({ write_allowlist: "not json{" }) },
      ]),
    });
    expect(result).toHaveLength(1); // the datasource still resolves (reads work)…
    expect(result[0].writeAllowlist.size).toBe(0); // …but with zero writes enabled
  });

  it("skips an install with an unrecognized auth_kind (drifted row), not the whole set", async () => {
    // narrowSupportedAuthKind validates positive membership, so a garbage kind
    // skips here rather than reaching a buildResolvedAuth throw.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "garbage", config: config({ auth_kind: "totally-bogus", openapi_snapshot: snapshot("2026-05-29T11:00:00.000Z") }) },
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-29T12:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });
});

describe("resolveWorkspaceRestDatasourcesOrThrow (strict)", () => {
  it("PROPAGATES a query failure so the caller can tell an outage from an empty workspace", async () => {
    await expect(
      resolveWorkspaceRestDatasourcesOrThrow("org-1", {
        query: async () => {
          throw new Error("pg down");
        },
      }),
    ).rejects.toThrow("pg down");
  });

  it("still skips a single broken install (does not throw on a per-install failure)", async () => {
    const result = await resolveWorkspaceRestDatasourcesOrThrow("org-1", {
      query: queryReturning([
        { install_id: "broken", config: config({ openapi_snapshot: undefined }) },
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-29T13:00:00.000Z") }) },
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });
});

describe("resolveWorkspaceRestDatasources — data-candidate quirk attachment (slice 6a, #3028)", () => {
  it("attaches the candidate's declarative quirk for a candidate-catalog install", async () => {
    // A stripe-data install row carries the candidate catalog id; the resolver
    // looks the candidate up in the code-resident registry and attaches its quirk
    // — the quirk is never stored in (or read from) the encrypted config.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "inst-stripe", catalog_id: "catalog:stripe-data", config: config() },
      ]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].quirk?.queryParamShaping).toEqual([{ param: "expand", bracketArray: true }]);
  });

  it("leaves quirk undefined for a plain openapi-generic install", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "inst-generic", catalog_id: OPENAPI_GENERIC_CATALOG_ID, config: config() },
      ]),
    });
    expect(result[0].quirk).toBeUndefined();
  });

  it("treats a row with no catalog_id as the generic datasource (no quirk)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ install_id: "inst-legacy", config: config() }]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].quirk).toBeUndefined();
  });

  it("attaches the candidate's readSafePostOperations for a notion-data install (#3035)", async () => {
    // notion-data declares `post-search` read-safe (Notion search is POST /v1/search,
    // a read). The resolver threads that code-resident declaration onto the
    // RestDatasource so the validator demotes it to a read on a default install.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "inst-notion", catalog_id: "catalog:notion-data", config: config() },
      ]),
    });
    expect(result).toHaveLength(1);
    expect([...(result[0].readSafePostOperations ?? [])]).toContain("post-search");
  });

  it("leaves readSafePostOperations undefined for a candidate that declares none (stripe-data)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "inst-stripe", catalog_id: "catalog:stripe-data", config: config() },
      ]),
    });
    expect(result[0].readSafePostOperations).toBeUndefined();
  });
});

describe("resolveWorkspacePrimaryRestDatasource", () => {
  it("returns the first install, or null when none", async () => {
    expect(
      await resolveWorkspacePrimaryRestDatasource("org-1", { query: queryReturning([]) }),
    ).toBeNull();
    const primary = await resolveWorkspacePrimaryRestDatasource("org-1", {
      query: queryReturning([
        { install_id: "first", config: config() },
        { install_id: "second", config: config({ openapi_snapshot: snapshot("2026-05-29T05:00:00.000Z") }) },
      ]),
    });
    expect(primary?.id).toBe("first");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  defaultQuery tenant-scope clause (#3011 GAP 2)
//
//  Every test above injects `deps.query`, so the production `defaultQuery`
//  SQL — the only place the per-tenant scope is enforced — is NEVER exercised.
//  A regression that weakened any conjunct (dropping `pillar`, `status`, or
//  the `workspace_id`/`catalog_id` bind) is a cross-tenant datasource /
//  credential leak that would pass the whole suite unnoticed. Drive the real
//  SQL through the `exec` seam and pin both the scope clause and the param
//  order — the prod path (no `exec`) still runs `internalQuery` unchanged.
// ─────────────────────────────────────────────────────────────────────

describe("defaultQuery — tenant-scope clause", () => {
  it("scopes the SELECT to the caller's workspace + generic & data-candidate catalogs, non-archived datasources (#3011 / #3028)", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    await defaultQuery("org-CALLER", async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return [];
    });

    const flat = capturedSql.replace(/\s+/g, " ").trim();
    expect(flat).toContain("FROM workspace_plugins");
    // Each conjunct is load-bearing — dropping any one is a tenant-isolation hole.
    expect(flat).toContain("workspace_id = $1");
    expect(flat).toContain("catalog_id = ANY($2)");
    expect(flat).toContain("pillar = 'datasource'");
    expect(flat).toContain("status != 'archived'");
    // Assert the conjuncts as ONE contiguous AND-joined WHERE clause, not just
    // four independent substrings: the per-conjunct checks above pass even if a
    // regression swapped an `AND` for an `OR` (or moved a conjunct out of the
    // WHERE) — both of which are tenant-isolation holes. Pinning the full clause
    // catches the connective + membership, not only the presence, of each guard.
    expect(flat).toContain(
      "WHERE workspace_id = $1 AND catalog_id = ANY($2) AND pillar = 'datasource' AND status != 'archived'",
    );

    // Param ORDER is load-bearing: $1 is the caller's workspace (never client
    // input), $2 is the array of built-in REST catalog ids — the generic
    // datasource plus every data candidate (slice 6a, #3028). Pinned to the shared
    // `REST_DATASOURCE_CATALOG_IDS` constant (not a stale literal) so a future
    // reorder/extension of that source of truth can't silently drift this query
    // apart from the env-routing exclusion lists that share it (#3044).
    expect(capturedParams).toEqual([
      "org-CALLER",
      [...REST_DATASOURCE_CATALOG_IDS],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Cross-environment scope filtering (#3044, ADR-0010)
// ─────────────────────────────────────────────────────────────────────

describe("resolveWorkspaceRestDatasources — env scope (activeGroupId)", () => {
  const rows: OpenApiInstallRow[] = [
    { install_id: "ds-global", config: config({ display_name: "Global" }) }, // no group_id
    { install_id: "ds-prod", config: config({ display_name: "Prod", group_id: "prod" }) },
    { install_id: "ds-eu", config: config({ display_name: "EU", group_id: "eu" }) },
  ];

  it("populates groupId on the resolved datasource (and leaves it undefined for workspace-global)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
    });
    const byId = new Map(result.map((d) => [d.id, d]));
    expect(byId.get("ds-global")?.groupId).toBeUndefined();
    expect(byId.get("ds-prod")?.groupId).toBe("prod");
    expect(byId.get("ds-eu")?.groupId).toBe("eu");
  });

  it("omitted activeGroupId resolves every install (back-compat / confirm-replay path)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
    });
    expect(result.map((d) => d.id).sort()).toEqual(["ds-eu", "ds-global", "ds-prod"]);
  });

  it("a string activeGroupId keeps workspace-global + that group's datasources only", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      activeGroupId: "prod",
    });
    expect(result.map((d) => d.id).sort()).toEqual(["ds-global", "ds-prod"]);
    // The off-scope (eu) datasource is gone — a pinned chat can't reach it.
    expect(result.some((d) => d.id === "ds-eu")).toBe(false);
  });

  it("a null activeGroupId (no active group) keeps ONLY workspace-global datasources", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      activeGroupId: null,
    });
    expect(result.map((d) => d.id)).toEqual(["ds-global"]);
  });

  it("treats a blank / whitespace group_id as workspace-global", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-blank", config: config({ group_id: "   " }) },
      ]),
      activeGroupId: null,
    });
    expect(result.map((d) => d.id)).toEqual(["ds-blank"]);
    expect(result[0].groupId).toBeUndefined();
  });

  it("preserves the [] fail-soft contract when every datasource is scoped out", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-prod", config: config({ group_id: "prod" }) },
      ]),
      activeGroupId: "eu",
    });
    expect(result).toEqual([]);
  });

  it("the strict resolver returns [] (never throws) when every install is scoped out", async () => {
    // Scope filtering runs BEFORE build, so an out-of-scope workspace resolves to
    // an empty in-scope set without engaging the reconnect tally — the strict path
    // can't surface a false "reconnect needed" for datasources that simply belong
    // to another environment.
    const result = await resolveWorkspaceRestDatasourcesOrThrow("org-1", {
      query: queryReturning([
        { install_id: "ds-eu", config: config({ group_id: "eu" }) },
      ]),
      activeGroupId: "prod",
    });
    expect(result).toEqual([]);
  });

  it("the primary resolver honours activeGroupId (python egress lockstep)", async () => {
    const primary = await resolveWorkspacePrimaryRestDatasource("org-1", {
      query: queryReturning(rows),
      activeGroupId: "eu",
    });
    // Earliest in-scope install: ds-global (workspace-global) sorts before ds-eu by install order.
    expect(primary?.id).toBe("ds-global");
  });
});

describe("resolveWorkspaceRestDatasources — per-conversation exclude-set (#3066, S2a)", () => {
  const rows: OpenApiInstallRow[] = [
    { install_id: "ds-global", config: config({ display_name: "Global" }) }, // no group_id
    { install_id: "ds-prod", config: config({ display_name: "Prod", group_id: "prod" }) },
    { install_id: "ds-eu", config: config({ display_name: "EU", group_id: "eu" }) },
  ];

  it("omitted excluded resolves every install (default = all in scope / confirm-replay path)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
    });
    expect(result.map((d) => d.id).sort()).toEqual(["ds-eu", "ds-global", "ds-prod"]);
  });

  it("an empty excluded set excludes nothing", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      excluded: [],
    });
    expect(result.map((d) => d.id).sort()).toEqual(["ds-eu", "ds-global", "ds-prod"]);
  });

  it("drops every install whose id is in the exclude-set", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      excluded: ["ds-prod"],
    });
    expect(result.map((d) => d.id).sort()).toEqual(["ds-eu", "ds-global"]);
    expect(result.some((d) => d.id === "ds-prod")).toBe(false);
  });

  it("applies the exclude-set AFTER the activeGroupId scope filter", async () => {
    // ds-global + ds-prod are in scope for "prod"; excluding ds-prod leaves only ds-global.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      activeGroupId: "prod",
      excluded: ["ds-prod"],
    });
    expect(result.map((d) => d.id)).toEqual(["ds-global"]);
  });

  it("an excluded id that matches no install is a harmless no-op", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      excluded: ["ds-does-not-exist"],
    });
    expect(result.map((d) => d.id).sort()).toEqual(["ds-eu", "ds-global", "ds-prod"]);
  });

  it("preserves the [] fail-soft contract when every datasource is excluded", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      excluded: ["ds-global", "ds-prod", "ds-eu"],
    });
    expect(result).toEqual([]);
  });

  it("the strict resolver returns [] (never throws) when every install is excluded", async () => {
    // Exclusion runs BEFORE build, like the group-scope filter, so a fully-excluded
    // workspace resolves to an empty in-scope set without engaging the reconnect tally.
    const result = await resolveWorkspaceRestDatasourcesOrThrow("org-1", {
      query: queryReturning(rows),
      excluded: ["ds-global", "ds-prod", "ds-eu"],
    });
    expect(result).toEqual([]);
  });
});

describe("resolveWorkspaceRestDatasources — REST-only focus (#3067, S2b)", () => {
  const rows: OpenApiInstallRow[] = [
    { install_id: "ds-global", config: config({ display_name: "Global" }) }, // no group_id
    { install_id: "ds-prod", config: config({ display_name: "Prod", group_id: "prod" }) },
    { install_id: "ds-eu", config: config({ display_name: "EU", group_id: "eu" }) },
  ];

  it("resolves ONLY the focus target", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      focus: "ds-prod",
    });
    expect(result.map((d) => d.id)).toEqual(["ds-prod"]);
  });

  it("short-circuits the activeGroupId scope filter (focus a group-scoped ds with a mismatched active group)", async () => {
    // ds-eu is scoped to "eu"; focusing it while the active group is "prod"
    // still resolves it — focus is an explicit single pick, group-scope is inert.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      activeGroupId: "prod",
      focus: "ds-eu",
    });
    expect(result.map((d) => d.id)).toEqual(["ds-eu"]);
  });

  it("short-circuits the exclude-set (focus a datasource that is also excluded)", async () => {
    // The exclude-set is inert while focused — focusing ds-prod resolves it
    // even though it's in the exclude-set.
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      excluded: ["ds-prod"],
      focus: "ds-prod",
    });
    expect(result.map((d) => d.id)).toEqual(["ds-prod"]);
  });

  it("returns [] when the focus target matches no install (fall-back-to-default signal)", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      focus: "ds-uninstalled",
    });
    expect(result).toEqual([]);
  });

  it("STRICT resolver throws RestDatasourceFocusUnusableError when the focus matches a present-but-unbuildable install (Codex P1)", async () => {
    // The focused row exists but builds to nothing for a non-reconnectable reason
    // (here a blocked/internal base URL the SSRF guard rejects). This must be
    // distinguishable from "uninstalled" so the focus path fails CLOSED instead
    // of the agent silently re-enabling SQL for a still-present datasource.
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    await expect(
      resolveWorkspaceRestDatasourcesOrThrow("org-1", {
        query: queryReturning([
          { install_id: "ds-blocked", config: config({ base_url_override: "https://10.0.0.5/v1" }) },
        ]),
        focus: "ds-blocked",
      }),
    ).rejects.toBeInstanceOf(RestDatasourceFocusUnusableError);
  });

  it("never-rejects resolver degrades a present-but-unbuildable focus to [] (python egress denies, never widens)", async () => {
    // The non-claiming path can't fail closed (no SQL tool to suspend), so it
    // returns [] — python egress then resolves a null primary and denies.
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-blocked", config: config({ base_url_override: "https://10.0.0.5/v1" }) },
      ]),
      focus: "ds-blocked",
    });
    expect(result).toEqual([]);
    const primary = await resolveWorkspacePrimaryRestDatasource("org-1", {
      query: queryReturning([
        { install_id: "ds-blocked", config: config({ base_url_override: "https://10.0.0.5/v1" }) },
      ]),
      focus: "ds-blocked",
    });
    expect(primary).toBeNull();
  });

  it("an empty-string focus is ignored (resolves the default scope, not 'focus on nothing')", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning(rows),
      focus: "",
    });
    expect(result.map((d) => d.id).sort()).toEqual(["ds-eu", "ds-global", "ds-prod"]);
  });

  it("the primary resolver honours focus (python egress lockstep)", async () => {
    const primary = await resolveWorkspacePrimaryRestDatasource("org-1", {
      query: queryReturning(rows),
      focus: "ds-eu",
    });
    expect(primary?.id).toBe("ds-eu");
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Resolve-time SSRF guard (#3006)
// ─────────────────────────────────────────────────────────────────────

describe("resolveWorkspaceRestDatasources — SSRF guard at resolve time", () => {
  // A snapshot whose spec declares an INTERNAL servers[0].url — the public-spec,
  // internal-server attack. `resolveBaseUrl` would derive a host-side base URL
  // pointed at cloud metadata; the resolver must skip the datasource (fail-soft).
  const internalSpec = { ...MOCK_OPENAPI_SPEC, servers: [{ url: "https://169.254.169.254" }] };
  const internalGraph = buildOperationGraph(internalSpec);
  function internalSnapshot(probedAt = "2026-05-29T00:00:00.000Z"): OpenApiSnapshot {
    return buildSnapshot(internalSpec, internalGraph, probedAt);
  }

  const ORIGINAL_FLAG = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    else process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = ORIGINAL_FLAG;
  });

  it("skips a datasource whose spec-derived servers[0].url is internal — but keeps its public siblings (fail-soft isolation)", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "internal", config: config({ openapi_snapshot: internalSnapshot() }) },
        { install_id: "public", config: config() }, // public servers[0].url
      ]),
    });
    expect(result.map((d) => d.id)).toEqual(["public"]); // internal dropped, public survives
  });

  it("skips a datasource whose base_url_override is internal", async () => {
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "ds-1", config: config({ base_url_override: "https://10.0.0.5/v1" }) },
      ]),
    });
    expect(result).toHaveLength(0);
  });

  it("resolves an internal datasource when the operator opts out (ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true)", async () => {
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        { install_id: "internal", config: config({ openapi_snapshot: internalSnapshot() }) },
      ]),
    });
    expect(result).toHaveLength(1);
    expect(result[0].baseUrl).toBe("https://169.254.169.254");
  });
});

// ── github-data (oauth-datasource): credential minted at resolve time ─────────
describe("resolveWorkspaceRestDatasources — github-data (oauth-datasource)", () => {
  const GITHUB_DOC = {
    openapi: "3.1.0",
    info: { title: "GitHub", version: "1.1.4" },
    servers: [{ url: "https://api.github.com" }],
    paths: {
      "/repos/{owner}/{repo}/pulls": {
        get: {
          operationId: "pulls/list",
          parameters: [
            { name: "owner", in: "path", required: true, schema: { type: "string" } },
            { name: "repo", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
  const githubSnapshot = () =>
    buildSnapshot(GITHUB_DOC, buildOperationGraph(GITHUB_DOC), "2026-05-30T00:00:00.000Z");

  /** A decrypted github-data install config — installation_id is plaintext here (decrypt passthrough). */
  function githubConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      openapi_url:
        "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
      auth_kind: "oauth2",
      installation_id: "987654321",
      display_name: "GitHub",
      representation_mode: "operation-graph",
      status: "ok",
      openapi_snapshot: githubSnapshot(),
      ...overrides,
    };
  }

  const githubRow = (overrides: Record<string, unknown> = {}): OpenApiInstallRow => ({
    install_id: "gh-1",
    catalog_id: "catalog:github-data",
    config: githubConfig(overrides),
  });

  it("mints an installation token and resolves it as bearer auth against api.github.com", async () => {
    const minted: string[] = [];
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([githubRow()]),
      mintInstallationToken: async (installationId) => {
        minted.push(installationId);
        return `ghs_for_${installationId}`;
      },
    });

    expect(result).toHaveLength(1);
    const ds = result[0];
    // The minter received the decrypted installation_id from THIS workspace's row.
    expect(minted).toEqual(["987654321"]);
    expect(ds.auth).toEqual({ kind: "bearer", token: "ghs_for_987654321" });
    expect(ds.baseUrl).toBe("https://api.github.com"); // from the spec's servers[0]
    expect(ds.graph.operations.has("pulls/list")).toBe(true);
    expect(ds.displayName).toBe("GitHub");
  });

  it("skips the github-data datasource when minting fails (fail-soft), not the whole set", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([
        githubRow(),
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-30T01:00:00.000Z") }) },
      ]),
      mintInstallationToken: async () => {
        throw new Error("App access revoked");
      },
    });
    // The healthy generic install survives; the un-mintable github-data is dropped.
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });

  it("skips a github-data row with no installation_id (drifted/corrupt), without minting", async () => {
    let called = false;
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([githubRow({ installation_id: undefined })]),
      mintInstallationToken: async () => {
        called = true;
        return "should-not-be-called";
      },
    });
    expect(result).toHaveLength(0);
    expect(called).toBe(false);
  });

  // ── reconnect-needed: present-but-unresolvable, distinct from "none" ────────
  it("STRICT resolver throws RestDatasourceReconnectError when the only datasource needs reconnect (mint fails)", async () => {
    // A user-facing caller (the executeRestOperation tool) must be able to tell
    // "your datasource needs reconnecting" apart from "no datasource connected".
    await expect(
      resolveWorkspaceRestDatasourcesOrThrow("org-1", {
        query: queryReturning([githubRow()]),
        mintInstallationToken: async () => {
          throw new Error("App access revoked");
        },
      }),
    ).rejects.toBeInstanceOf(RestDatasourceReconnectError);
  });

  it("STRICT resolver throws RestDatasourceReconnectError when the only datasource is missing its installation_id", async () => {
    await expect(
      resolveWorkspaceRestDatasourcesOrThrow("org-1", {
        query: queryReturning([githubRow({ installation_id: undefined })]),
        mintInstallationToken: async () => "unused",
      }),
    ).rejects.toBeInstanceOf(RestDatasourceReconnectError);
  });

  it("STRICT resolver does NOT throw when a healthy datasource coexists with a reconnect-needed one", async () => {
    // Partial success — the reconnect signal fires only when nothing usable remains.
    const result = await resolveWorkspaceRestDatasourcesOrThrow("org-1", {
      query: queryReturning([
        githubRow(),
        { install_id: "ok", config: config({ openapi_snapshot: snapshot("2026-05-30T02:00:00.000Z") }) },
      ]),
      mintInstallationToken: async () => {
        throw new Error("App access revoked");
      },
    });
    expect(result.map((d) => d.id)).toEqual(["ok"]);
  });

  it("never-rejects resolver degrades to [] (no throw) for a reconnect-needed-only workspace", async () => {
    const result = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([githubRow()]),
      mintInstallationToken: async () => {
        throw new Error("App access revoked");
      },
    });
    expect(result).toEqual([]);
  });
});

describe("shared cross-workspace spec cache (#2970)", () => {
  /** A stripe-data (shareable data-candidate) install row for a workspace. */
  const stripeRow = (): OpenApiInstallRow => ({
    install_id: "stripe-1",
    catalog_id: STRIPE_DATA_CANDIDATE.catalogId,
    config: config(),
  });

  it("two workspaces on the same public candidate share ONE normalized graph", async () => {
    const a = await resolveWorkspaceRestDatasources("org-1", { query: queryReturning([stripeRow()]) });
    const b = await resolveWorkspaceRestDatasources("org-2", { query: queryReturning([stripeRow()]) });

    expect(a[0].graph.operations.has("listWidgets")).toBe(true);
    // Referential identity ⇒ the (large) document was normalized exactly once and
    // reused across both workspaces — the whole point of the shared cache.
    expect(b[0].graph).toBe(a[0].graph);
    // One identity, one catalog cached — not one entry per workspace.
    expect(sharedSpecCacheStats().identities).toBe(1);
    expect(sharedSpecCacheStats().catalogs).toBe(1);
  });

  it("a GENERIC install is NEVER shared — each workspace normalizes its own graph", async () => {
    const genericRow = (): OpenApiInstallRow => ({
      install_id: "gen-1",
      catalog_id: OPENAPI_GENERIC_CATALOG_ID,
      config: config(),
    });
    const a = await resolveWorkspaceRestDatasources("org-1", { query: queryReturning([genericRow()]) });
    const b = await resolveWorkspaceRestDatasources("org-2", { query: queryReturning([genericRow()]) });

    expect(a[0].graph.operations.has("listWidgets")).toBe(true);
    // Distinct objects: the per-install cache keys by (workspace, install, probedAt),
    // and a generic admin-supplied spec must never leak across tenants.
    expect(b[0].graph).not.toBe(a[0].graph);
    // The shared cache stayed empty — a generic install never enters it.
    expect(sharedSpecCacheStats().identities).toBe(0);
  });

  it("per-workspace base_url_override composes with the shared graph", async () => {
    const a = await resolveWorkspaceRestDatasources("org-1", {
      query: queryReturning([{ ...stripeRow(), config: config({ base_url_override: "https://eu.example.com/api" }) }]),
    });
    const b = await resolveWorkspaceRestDatasources("org-2", { query: queryReturning([stripeRow()]) });

    expect(a[0].graph).toBe(b[0].graph); // same shared graph
    expect(a[0].baseUrl).toBe("https://eu.example.com/api"); // but workspace-A's own override
    expect(b[0].baseUrl).toBe("https://widgets.example.com/api"); // workspace-B uses servers[0]
  });
});
