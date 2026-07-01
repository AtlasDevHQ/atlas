/**
 * Lib-layer tests for the datasource MCP lifecycle helpers
 * (`lib/datasources/mcp-lifecycle.ts`).
 *
 * Two enforcement points the MCP tools depend on:
 *   1. `listDatasources` is allowlist-shaped — it maps ONLY the
 *      credential-free columns onto `DatasourceSummary`, so even a row that
 *      carries a stray secret can't leak (#3513 "list never returns
 *      plaintext credentials").
 *   2. `runDatasourceInstaller` maps the `WorkspaceInstaller` Effect's
 *      result/Cause onto the context-free outcome the MCP tools render —
 *      tagged errors → typed `{ status, code }`, defects → re-throw.
 */

import { describe, expect, it, mock, beforeEach } from "bun:test";
import { Effect } from "effect";
import {
  InvalidInstallIdError,
  InstallNotFoundError,
} from "@atlas/api/lib/effect/errors";
import { createConnectionMock } from "../../../__mocks__/connection";

// ── Mocks for the DB / registry primitives `listDatasources` calls ────
//
// `@atlas/api/lib/content-mode` is NOT mocked — its `makeService` / `readFilter`
// are pure (no I/O) so the real module runs hermetically and exercises the real
// status-clause logic. `internalQuery` is mocked, so the resolved clause's exact
// text is irrelevant to these tests.

let internalRows: Array<Record<string, unknown>> = [];
const mockInternalQuery = mock<(...a: unknown[]) => Promise<unknown>>(
  async () => internalRows,
);
const mockHasInternalDB = mock<() => boolean>(() => true);

// ── Transactional client mock for `publishWorkspaceDrafts` (#4126) ─────
// `runPublishPhases` is real/unmocked (pure dispatch over `tx.query(...)`),
// so the simple-table promote SQL needs real `{ rowCount }` responses —
// mirrors `api/__tests__/admin-publish.test.ts`'s harness for the SAME
// registry call. The exotic `semantic_entities` adapter is exercised
// through stubbed `applyTombstones`/`promoteDraftEntities` below instead of
// real SQL — their own logic is already covered by admin-publish.test.ts.
interface PublishClientQuery {
  sql: string;
  params?: unknown[];
}
let publishClientQueries: PublishClientQuery[] = [];
let publishClientReleased = false;
let publishClientReleaseArg: unknown;
let publishQueryHandler: (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number }> = async () => ({ rows: [] });

function makePublishMockClient() {
  return {
    query: async (sql: string, params?: unknown[]) => {
      publishClientQueries.push({ sql, params });
      return publishQueryHandler(sql, params);
    },
    release: (err?: unknown) => {
      publishClientReleased = true;
      publishClientReleaseArg = err;
    },
  };
}
const mockGetInternalDB = mock(() => ({ connect: async () => makePublishMockClient() }));
let reconcileCalls: string[] = [];
let reconcileHandler: (
  orgId: string,
) => Promise<{ registered: number; deregistered: number }> = async () => ({
  registered: 0,
  deregistered: 0,
});
const mockReconcileWorkspaceDatasources = mock(async (orgId: string) => {
  reconcileCalls.push(orgId);
  return reconcileHandler(orgId);
});

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mockHasInternalDB,
  getInternalDB: mockGetInternalDB,
  reconcileWorkspaceDatasources: mockReconcileWorkspaceDatasources,
}));

// `promoteSemanticEntities` (the exotic content-mode adapter) composes these
// two real helpers — stub them to canned counts so `publishWorkspaceDrafts`
// tests assert the publish-phases WIRING without re-proving entities SQL.
let tombstonesAppliedFixture = 0;
let entitiesPromotedFixture = 0;
const mockApplyTombstones = mock(async () => tombstonesAppliedFixture);
const mockPromoteDraftEntities = mock(async () => entitiesPromotedFixture);
mock.module("@atlas/api/lib/semantic/entities", () => ({
  applyTombstones: mockApplyTombstones,
  promoteDraftEntities: mockPromoteDraftEntities,
}));

let describeRows: Array<unknown> = [];
// Controllable connection-registry surface for the provisioning pre-flight.
let registryHas = new Set<string>();
let healthResult: { status: string; latencyMs: number; message?: string; checkedAt: Date } | null = {
  status: "healthy",
  latencyMs: 1,
  checkedAt: new Date(0),
};
let healthThrows: Error | null = null;
const registerSpy = mock<(id: string, cfg: unknown) => void>(() => {});
const unregisterSpy = mock<(id: string) => boolean>(() => true);
const healthCheckSpy = mock<(id: string) => Promise<unknown>>(async () => {
  if (healthThrows) throw healthThrows;
  return healthResult;
});
// Full-module connection mock (every export shaped) with only the registry
// methods this suite drives overridden — the blessed `createConnectionMock`
// pattern, not a hand-rolled partial mock.
mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    connections: {
      describe: () => describeRows,
      healthCheck: healthCheckSpy,
      has: (id: string) => registryHas.has(id),
      register: registerSpy,
      unregister: unregisterSpy,
    },
  }),
);

// Mock every value export — `workspace-installer` (transitively imported by
// `runDatasourceInstaller`) also pulls `resolveDatasourcePoolConfig` +
// `BUILTIN_DATASOURCE_CATALOG_SLUGS` from this module.
let poolConfigResult: unknown = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "public" };
mock.module("@atlas/api/lib/db/datasource-pool-resolver", () => ({
  catalogSlugToDbType: (slug: string) => {
    if (slug === "postgres") return "postgres";
    throw new Error(`unknown slug ${slug}`);
  },
  resolveDatasourcePoolConfig: mock(() => poolConfigResult),
  BUILTIN_DATASOURCE_CATALOG_SLUGS: ["postgres", "mysql"],
}));

// `loadDatasourceProfileTarget` parses the catalog schema + decrypts config.
// Plaintext passthrough is enough — the dbType/url come from the resolver mock.
// Spread the real module so every export (restoreMaskedSecrets, …) the form-
// install handler graph named-imports stays present; override only the few this
// suite drives.
const realSecrets = await import("@atlas/api/lib/plugins/secrets");
mock.module("@atlas/api/lib/plugins/secrets", () => ({
  ...realSecrets,
  // Echo a config_schema array verbatim as parsed fields so
  // `loadProvisionConfigFields` can be exercised; non-array → empty (matches
  // the prior `config_schema: []` profile-target cases).
  parseConfigSchema: (s: unknown) => ({ state: "parsed", fields: Array.isArray(s) ? s : [] }),
  decryptSecretFields: (config: Record<string, unknown>) => config,
  encryptSecretFields: (config: Record<string, unknown>) => config,
  maskSecretFields: (config: Record<string, unknown>) => config,
}));

// Controllable plugin lookup so the `createFromConfig` path in
// `resolveLiveConnection` can be exercised without registering real plugins.
// Defaults to `undefined` ("no plugin registered" — the real lookup's result in
// a bare test env), so the existing no-plugin assertions stay valid; a test sets
// `pluginConnection` to inject a built connection with a specific introspection
// surface. The rest of the bridge (probe/native predicates) stays real.
let pluginConnection: { createFromConfig?: (cfg: unknown) => unknown } | undefined = undefined;
const realBridge = await import("@atlas/api/lib/db/datasource-registry-bridge");
mock.module("@atlas/api/lib/db/datasource-registry-bridge", () => ({
  ...realBridge,
  findDatasourcePluginConnection: mock(async () => pluginConnection),
}));

const {
  listDatasources,
  runDatasourceInstaller,
  provisionDatasource,
  resolveLiveConnection,
  loadProvisionConfigFields,
  publishWorkspaceDrafts,
} = await import("../mcp-lifecycle.js");

beforeEach(() => {
  mockInternalQuery.mockClear();
  mockHasInternalDB.mockClear();
  registerSpy.mockClear();
  unregisterSpy.mockClear();
  healthCheckSpy.mockClear();
  internalRows = [];
  describeRows = [];
  registryHas = new Set();
  healthResult = { status: "healthy", latencyMs: 1, checkedAt: new Date(0) };
  healthThrows = null;
  poolConfigResult = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "public" };
  pluginConnection = undefined;
  mockHasInternalDB.mockReturnValue(true);
  publishClientQueries = [];
  publishClientReleased = false;
  publishClientReleaseArg = undefined;
  publishQueryHandler = async () => ({ rows: [] });
  reconcileCalls = [];
  reconcileHandler = async () => ({ registered: 0, deregistered: 0 });
  tombstonesAppliedFixture = 0;
  entitiesPromotedFixture = 0;
});

describe("listDatasources", () => {
  it("maps only credential-free fields — a stray secret column never leaks", async () => {
    // Inject a hostile row carrying secret-shaped extras. The allowlist
    // mapper must drop them.
    internalRows = [
      {
        install_id: "prod-us",
        status: "published",
        group_id: "prod",
        catalog_slug: "postgres",
        // These must NOT appear in the output.
        url: "postgres://user:pass@host/db",
        password: "hunter2",
        config: { secret: "leaked" },
      },
    ];
    describeRows = [
      {
        id: "prod-us",
        dbType: "postgres",
        description: "Prod US",
        health: { status: "healthy", latencyMs: 9, checkedAt: new Date("2026-06-13T00:00:00.000Z") },
      },
    ];

    const out = await listDatasources("org_1", "published");
    expect(out).toHaveLength(1);
    const row = out[0];
    expect(row).toEqual({
      id: "prod-us",
      dbType: "postgres",
      description: "Prod US",
      status: "published",
      groupId: "prod",
      health: { status: "healthy", latencyMs: 9, checkedAt: "2026-06-13T00:00:00.000Z" },
    });
    // Hard guarantee: serialized output carries no credential.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("pass@host");
    expect(serialized).not.toContain("leaked");
  });

  it("falls back to catalogSlugToDbType + null health for an unregistered (archived) install", async () => {
    internalRows = [
      { install_id: "old-db", status: "archived", group_id: null, catalog_slug: "postgres" },
    ];
    describeRows = []; // not registered → describe() empty
    const out = await listDatasources("org_1", "published", { includeArchived: true });
    expect(out[0]).toEqual({
      id: "old-db",
      dbType: "postgres",
      description: null,
      status: "archived",
      groupId: null,
      health: null,
    });
  });

  it("degrades an unknown catalog slug to dbType 'unknown' rather than throwing", async () => {
    internalRows = [
      { install_id: "weird", status: "published", group_id: null, catalog_slug: "mystery" },
    ];
    const out = await listDatasources("org_1", "published");
    expect(out[0].dbType).toBe("unknown");
  });

  it("returns [] when no internal DB is configured", async () => {
    mockHasInternalDB.mockReturnValue(false);
    const out = await listDatasources("org_1", "published");
    expect(out).toEqual([]);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

describe("runDatasourceInstaller", () => {
  it("returns kind:ok with the Effect's success value", async () => {
    const outcome = await runDatasourceInstaller(() => Effect.succeed({ id: "x", status: "published" }));
    expect(outcome).toEqual({ kind: "ok", value: { id: "x", status: "published" } } as never);
  });

  it("maps a tagged InvalidInstallIdError → 400 bad_request", async () => {
    const outcome = await runDatasourceInstaller(() =>
      Effect.fail(
        new InvalidInstallIdError({
          message: 'install_id "default" is reserved',
          installId: "default",
          reason: "reserved",
        }),
      ),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.status).toBe(400);
      expect(outcome.code).toBe("bad_request");
      expect(outcome.message).toContain("reserved");
    }
  });

  it("maps a tagged InstallNotFoundError → 404 not_found", async () => {
    const outcome = await runDatasourceInstaller(() =>
      Effect.fail(
        new InstallNotFoundError({
          message: "install not found",
          workspaceId: "org_1",
          catalogSlug: "postgres",
        }),
      ),
    );
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.status).toBe(404);
  });

  it("re-throws on a defect (non-tagged failure) so the caller surfaces a 500", async () => {
    await expect(
      runDatasourceInstaller(() => Effect.die(new Error("DB pool exhausted"))),
    ).rejects.toThrow(/WorkspaceInstaller program died/);
  });
});

describe("provisionDatasource — validate-before-persist + secret discipline", () => {
  const SECRET_URL = "postgres://super:secret@db.internal:5432/prod";

  it("rejects an unsupported dbType without touching the registry", async () => {
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "snowflake",
      installId: "wh",
      config: { url: SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("unsupported");
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("rejects a duplicate install id (conflict) before the registry", async () => {
    // The duplicate-check query returns a row → already exists.
    internalRows = [{ catalog_slug: "postgres" }];
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "postgres",
      installId: "dupe",
      config: { url: SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.status).toBe(409);
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("probes an EPHEMERAL id (never the install id) and always rolls it back", async () => {
    internalRows = [];
    healthResult = { status: "healthy", latencyMs: 5, checkedAt: new Date(0) };
    // Health OK → reaches the installer; installDatasource isn't mocked here,
    // so the program will fail — but we only assert the pre-flight behaviour.
    await provisionDatasource("org_1", { catalogSlug: "postgres", installId: "new-pg", config: { url: SECRET_URL }, secretKeys: ["url"] })
      .catch(() => undefined);
    // Registered + unregistered exactly the same throwaway id, never "new-pg".
    const registeredId = registerSpy.mock.calls[0]?.[0] as string;
    expect(registeredId).toStartWith("__mcp_preflight_");
    expect(registeredId).not.toBe("new-pg");
    expect(unregisterSpy).toHaveBeenCalledWith(registeredId);
  });

  it("treats a first-attempt 'degraded' probe as a failure (not just 'unhealthy')", async () => {
    // healthCheck returns 'degraded' on the FIRST failed probe; the old
    // `=== 'unhealthy'` check let it through. Now any non-'healthy' fails.
    internalRows = [];
    healthResult = { status: "degraded", latencyMs: 0, message: "could not connect to host", checkedAt: new Date(0) };
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "postgres",
      installId: "new-pg",
      config: { url: SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("health_error");
    expect(unregisterSpy).toHaveBeenCalledTimes(1); // probe rolled back
  });

  it("rolls back the ephemeral pool and scrubs the secret when the probe is unhealthy", async () => {
    internalRows = [];
    healthResult = { status: "unhealthy", latencyMs: 0, message: "could not connect to host", checkedAt: new Date(0) };
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "postgres",
      installId: "new-pg",
      config: { url: SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("health_error");
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
    if (outcome.kind === "health_error") {
      expect(outcome.message).not.toContain("secret");
      expect(outcome.message).not.toContain(SECRET_URL);
    }
  });

  it("rolls back + scrubs when the probe throws (and strips embedded userinfo)", async () => {
    internalRows = [];
    healthThrows = new Error(`connect ECONNREFUSED for ${SECRET_URL}`);
    const outcome = await provisionDatasource("org_1", {
      catalogSlug: "postgres",
      installId: "new-pg",
      config: { url: SECRET_URL },
      secretKeys: ["url"],
    });
    expect(outcome.kind).toBe("health_error");
    expect(unregisterSpy).toHaveBeenCalledTimes(1);
    if (outcome.kind === "health_error") {
      expect(outcome.message).not.toContain(SECRET_URL);
      expect(outcome.message).not.toContain("super:secret");
      // Exact-url scrub replaces the whole DSN, '@'-password and all.
      expect(outcome.message).toContain("[redacted]");
    }
  });
});

describe("loadProvisionConfigFields", () => {
  it("maps the catalog config_schema to elicitation fields + secretKeys, excluding description + schema", async () => {
    // Mirrors a SQL catalog row: non-secret url + secret apiKey, plus a
    // description (tool-arg label) and a schema (search_path) field that must
    // NOT be elicited into the secure prompt — both are non-secret agent args.
    internalRows = [
      {
        config_schema: [
          { key: "url", type: "string", label: "Connection URL", required: true, description: "es://…" },
          { key: "apiKey", type: "string", label: "API Key", secret: true },
          { key: "schema", type: "string", label: "Schema" },
          { key: "description", type: "string", label: "Description" },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("elasticsearch");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.fields.map((f) => f.key)).toEqual(["url", "apiKey"]); // description + schema excluded
      expect(res.fields[0]).toEqual({ key: "url", label: "Connection URL", description: "es://…", required: true, secret: false });
      expect(res.fields[1].secret).toBe(true);
      expect(res.secretKeys).toEqual(["apiKey"]);
    }
  });

  it("excludes non-credential fields (display_name + write-governance) from the masked form", async () => {
    // Mirrors the openapi-generic catalog row: connection/auth fields are
    // elicited; display_name + write_allowlist + side_effecting_operations are
    // NOT (label / write-governance, not credentials).
    internalRows = [
      {
        config_schema: [
          { key: "openapi_url", type: "string", label: "OpenAPI spec URL", required: true },
          { key: "auth_kind", type: "select", label: "Authentication", required: true },
          { key: "auth_value", type: "string", label: "Credential", secret: true },
          { key: "auth_header_name", type: "string", label: "API key header name" },
          { key: "write_allowlist", type: "string", label: "Write allowlist (JSON)" },
          { key: "side_effecting_operations", type: "string", label: "Side-effecting GET operations (JSON)" },
          { key: "display_name", type: "string", label: "Display name" },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("openapi-generic");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      // auth_header_name (a connection/auth field) is kept; the label + the two
      // write-governance JSON fields are dropped.
      expect(res.fields.map((f) => f.key)).toEqual([
        "openapi_url",
        "auth_kind",
        "auth_value",
        "auth_header_name",
      ]);
      expect(res.secretKeys).toEqual(["auth_value"]);
    }
  });

  it("propagates a select field's options + default so the masked form renders a dropdown", async () => {
    // Mirrors the openapi-generic auth_kind: a required select with a default —
    // its enum + default must reach the elicitation field, not collapse to text.
    internalRows = [
      {
        config_schema: [
          { key: "openapi_url", type: "string", label: "OpenAPI spec URL", required: true },
          { key: "auth_kind", type: "select", label: "Authentication", required: true, options: ["bearer", "basic", "apikey"], default: "bearer" },
          { key: "auth_value", type: "string", label: "Credential", secret: true },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("openapi-generic");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const authKind = res.fields.find((f) => f.key === "auth_kind");
      expect(authKind?.options).toEqual(["bearer", "basic", "apikey"]);
      expect(authKind?.default).toBe("bearer");
      // A plain string field carries neither.
      const url = res.fields.find((f) => f.key === "openapi_url");
      expect(url?.options).toBeUndefined();
      expect(url?.default).toBeUndefined();
    }
  });

  it("normalizes {value,label} select options down to their stored values", async () => {
    // Progressive-auth catalogs (e.g. Elasticsearch authMode) carry labeled
    // options. The masked MCP elicitation collects values, so the {value,label}
    // pairs must map to a bare value list — not labels, not [object Object].
    internalRows = [
      {
        config_schema: [
          {
            key: "auth_kind",
            type: "select",
            label: "Authentication",
            required: true,
            options: [
              { value: "basic", label: "Username & password" },
              { value: "apikey", label: "API key" },
              { value: "none", label: "No auth" },
            ],
            default: "basic",
          },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("openapi-generic");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const authKind = res.fields.find((f) => f.key === "auth_kind");
      expect(authKind?.options).toEqual(["basic", "apikey", "none"]);
      expect(authKind?.default).toBe("basic");
    }
  });

  it("drops `required` from showWhen-gated fields (the flat MCP form can't gate)", async () => {
    // Progressive-auth schemas mark credentials required only under their
    // showWhen gate. The flat MCP elicitation has no conditional visibility, so
    // forwarding required:true would demand every auth branch's creds at once
    // and make any non-default mode impossible to provision. Gated fields must
    // surface optional; an ungated required field stays required.
    internalRows = [
      {
        config_schema: [
          {
            key: "authMode",
            type: "select",
            label: "Authentication",
            required: true,
            options: [
              { value: "basic", label: "Username & password" },
              { value: "apiKey", label: "API key" },
            ],
          },
          {
            key: "username",
            type: "string",
            label: "Username",
            required: true,
            showWhen: { field: "authMode", equals: ["basic"] },
          },
          {
            key: "apiKey",
            type: "string",
            label: "API key",
            required: true,
            secret: true,
            showWhen: { field: "authMode", equals: ["apiKey"] },
          },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("openapi-generic");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.fields.find((f) => f.key === "authMode")?.required).toBe(true);
      expect(res.fields.find((f) => f.key === "username")?.required).toBe(false);
      expect(res.fields.find((f) => f.key === "apiKey")?.required).toBe(false);
    }
  });

  it("filters a malformed null option entry instead of throwing on null.value", async () => {
    // A JSONB options array can carry a null (typeof null === "object"), so a
    // bare o.value would throw — the normalization must drop non-string results.
    internalRows = [
      {
        config_schema: [
          {
            key: "auth_kind",
            type: "select",
            label: "Authentication",
            options: ["bearer", null, { value: "basic", label: "Basic" }],
          },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("openapi-generic");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.fields.find((f) => f.key === "auth_kind")?.options).toEqual([
        "bearer",
        "basic",
      ]);
    }
  });

  it("returns not_found when the catalog row is missing", async () => {
    internalRows = [];
    const res = await loadProvisionConfigFields("nope");
    expect(res.kind).toBe("not_found");
  });
});

// ── #3579 part(b) — catalog credential fields carry secret:true ──────────
// Encryption-at-rest AND error-scrub both depend on the catalog config_schema
// `secret:true` flag (mcp-lifecycle.ts:434-465 builds `secretKeys` from it).
// This test pins the credential key names for each MCP-provisionable type so a
// future catalog edit can't silently drop `secret:true` and expose DSNs.

describe("loadProvisionConfigFields — credential fields carry secret:true (#3579)", () => {
  it("url field is secret for a url-shaped datasource (postgres/mysql/clickhouse/snowflake)", async () => {
    // All url-shaped types share the same config_schema shape: `url` is the
    // only credential and must be marked secret.
    internalRows = [
      {
        config_schema: [
          { key: "url", type: "string", label: "Connection URL", required: true, secret: true },
          { key: "schema", type: "string", label: "Schema" },
          { key: "description", type: "string", label: "Description" },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("postgres");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const urlField = res.fields.find((f) => f.key === "url");
      expect(urlField).toBeDefined();
      expect(urlField?.secret).toBe(true);
      expect(res.secretKeys).toContain("url");
    }
  });

  it("apiKey field is secret for apiKey-shaped datasources (e.g. Elasticsearch)", async () => {
    internalRows = [
      {
        config_schema: [
          { key: "url", type: "string", label: "Connection URL", required: true, secret: false },
          { key: "apiKey", type: "string", label: "API Key", required: false, secret: true },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("elasticsearch");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const apiKeyField = res.fields.find((f) => f.key === "apiKey");
      expect(apiKeyField?.secret).toBe(true);
      expect(res.secretKeys).toContain("apiKey");
      // Non-secret url must NOT appear in secretKeys.
      expect(res.secretKeys).not.toContain("url");
    }
  });

  it("auth_value field is secret for auth_value-shaped datasources (e.g. OpenAPI-generic)", async () => {
    internalRows = [
      {
        config_schema: [
          { key: "openapi_url", type: "string", label: "OpenAPI spec URL", required: true },
          { key: "auth_kind", type: "select", label: "Authentication", required: true },
          { key: "auth_value", type: "string", label: "Credential", secret: true },
        ],
      },
    ];
    const res = await loadProvisionConfigFields("openapi-generic");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      const authValueField = res.fields.find((f) => f.key === "auth_value");
      expect(authValueField?.secret).toBe(true);
      expect(res.secretKeys).toContain("auth_value");
    }
  });
});

describe("resolveLiveConnection (#3667)", () => {
  it("returns not_found for an unknown install", async () => {
    internalRows = [];
    const res = await resolveLiveConnection("org_1", "nope");
    expect(res.kind).toBe("not_found");
  });

  it("resolves a native postgres install to a live connection carrying the install's group scope", async () => {
    internalRows = [
      { catalog_id: "cat_pg", catalog_slug: "postgres", config: { url: "enc:v1:…" }, config_schema: [], group_id: "prod" },
    ];
    poolConfigResult = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "analytics" };
    const res = await resolveLiveConnection("org_1", "pg");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.connection.dbType).toBe("postgres");
      // Introspection is a capability of the resolved connection (no url/config surfaced).
      expect(typeof res.connection.profile).toBe("function");
      expect(typeof res.connection.listObjects).toBe("function");
      // #3546 — the group scope drives where persisted drafts land.
      expect(res.connection.connectionGroupId).toBe("prod");
    }
  });

  it("normalizes a missing/empty group_id to null connectionGroupId (flat default scope)", async () => {
    internalRows = [
      { catalog_id: "cat_pg", catalog_slug: "postgres", config: { url: "enc:v1:…" }, config_schema: [], group_id: null },
    ];
    poolConfigResult = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "public" };
    const res = await resolveLiveConnection("org_1", "pg");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.connection.connectionGroupId).toBeNull();
  });

  it("returns unsupported for a plugin dbType with no registered plugin (never a silent skip)", async () => {
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [] },
    ];
    poolConfigResult = { dbType: "clickhouse", url: "clickhouse://h/db" };
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") expect(res.dbType).toBe("clickhouse");
  });

  it("fails closed when a registered plugin's built connection has no profile (the relocated wizard-profiler gate)", async () => {
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [] },
    ];
    poolConfigResult = { dbType: "clickhouse", url: "clickhouse://h/db" };
    const closeSpy = mock(async () => {});
    // A query-only plugin: builds a connection, but no `profile` capability.
    pluginConnection = {
      createFromConfig: () => ({
        query: async () => ({ columns: [], rows: [] }),
        close: closeSpy,
        listObjects: async () => [],
      }),
    };
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("unsupported");
    // The throwaway built connection is torn down before bailing — no pool leak
    // on every profile attempt against a query-only plugin.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed (not a silent empty table list) when a built connection has profile but no listObjects", async () => {
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [] },
    ];
    poolConfigResult = { dbType: "clickhouse", url: "clickhouse://h/db" };
    const closeSpy = mock(async () => {});
    // Has `profile` but no `listObjects` — the table picker can't enumerate, so
    // this must be `unsupported`, NOT an "ok" connection that returns [] tables.
    pluginConnection = {
      createFromConfig: () => ({
        query: async () => ({ columns: [], rows: [] }),
        close: closeSpy,
        profile: async () => ({ profiles: [], errors: [] }),
      }),
    };
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("unsupported");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("resolves a plugin-built connection exposing both introspection methods to ok with the configured defaultSchema", async () => {
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [] },
    ];
    poolConfigResult = { dbType: "clickhouse", url: "clickhouse://h/db", schema: "analytics" };
    pluginConnection = {
      createFromConfig: () => ({
        query: async () => ({ columns: [], rows: [] }),
        close: async () => {},
        listObjects: async () => [],
        profile: async () => ({ profiles: [], errors: [] }),
      }),
    };
    const res = await resolveLiveConnection("org_1", "ch");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.connection.dbType).toBe("clickhouse");
      expect(typeof res.connection.profile).toBe("function");
      expect(typeof res.connection.listObjects).toBe("function");
      // The configured pool schema surfaces as defaultSchema for the wizard.
      expect(res.defaultSchema).toBe("analytics");
    }
  });
});

describe("publishWorkspaceDrafts (#4126)", () => {
  it("throws when there is no internal database", async () => {
    mockHasInternalDB.mockReturnValue(false);
    await expect(publishWorkspaceDrafts("org_1")).rejects.toThrow(/internal database/);
  });

  it("BEGINs, promotes every simple table + the exotic entities adapter, COMMITs, and shapes the counts", async () => {
    tombstonesAppliedFixture = 1;
    entitiesPromotedFixture = 2;
    publishQueryHandler = async (sql) => {
      if (/UPDATE\s+workspace_plugins\s+SET\s+status\s*=\s*'published'/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE\s+prompt_collections\s+SET\s+status\s*=\s*'published'/i.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (/UPDATE\s+query_suggestions\s+SET\s+status\s*=\s*'published'/i.test(sql)) {
        return { rows: [], rowCount: 3 };
      }
      return { rows: [] };
    };

    const result = await publishWorkspaceDrafts("org_1");

    // #4156 — shared PublishResult core: nested `deleted: { entities }`, not the
    // old flat `deletedEntities`.
    expect(result).toEqual({
      promoted: { connections: 1, entities: 2, prompts: 0, starterPrompts: 3 },
      deleted: { entities: 1 },
    });
    const sqlLog = publishClientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqlLog[0]).toBe("BEGIN");
    expect(sqlLog).toContain("COMMIT");
    expect(sqlLog.indexOf("COMMIT")).toBeGreaterThan(0);
    expect(publishClientReleased).toBe(true);
    expect(publishClientReleaseArg).toBeUndefined();
    // Best-effort hot-register runs post-commit (#3856 parity).
    expect(reconcileCalls).toEqual(["org_1"]);
  });

  it("rolls back, rethrows, and skips the reconcile on a phase failure", async () => {
    publishQueryHandler = async (sql) => {
      if (/UPDATE\s+workspace_plugins/i.test(sql)) throw new Error("boom");
      return { rows: [] };
    };

    await expect(publishWorkspaceDrafts("org_1")).rejects.toThrow();

    const sqlLog = publishClientQueries.map((q) => q.sql.trim().toUpperCase());
    expect(sqlLog).toContain("ROLLBACK");
    expect(sqlLog).not.toContain("COMMIT");
    expect(publishClientReleased).toBe(true);
    expect(reconcileCalls).toEqual([]);
  });

  it("a transient post-commit reconcile failure does not fail an already-committed publish", async () => {
    reconcileHandler = async () => {
      throw new Error("registry busy");
    };
    const result = await publishWorkspaceDrafts("org_1");
    expect(result.promoted).toEqual({ connections: 0, entities: 0, prompts: 0, starterPrompts: 0 });
  });
});
