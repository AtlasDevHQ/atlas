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

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mockHasInternalDB,
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
mock.module("@atlas/api/lib/plugins/secrets", () => ({
  parseConfigSchema: () => ({ state: "parsed", fields: [] }),
  decryptSecretFields: (config: Record<string, unknown>) => config,
  encryptSecretFields: (config: Record<string, unknown>) => config,
  maskSecretFields: (config: Record<string, unknown>) => config,
}));

const { listDatasources, runDatasourceInstaller, provisionDatasource, loadDatasourceProfileTarget } =
  await import("../mcp-lifecycle.js");

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
  mockHasInternalDB.mockReturnValue(true);
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
      url: SECRET_URL,
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
      url: SECRET_URL,
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
    await provisionDatasource("org_1", { catalogSlug: "postgres", installId: "new-pg", url: SECRET_URL })
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
      url: SECRET_URL,
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
      url: SECRET_URL,
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
      url: SECRET_URL,
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

describe("loadDatasourceProfileTarget", () => {
  it("returns not_found for an unknown install", async () => {
    internalRows = [];
    const res = await loadDatasourceProfileTarget("org_1", "nope");
    expect(res.kind).toBe("not_found");
  });

  it("returns the decrypted target (with the install's group scope) for a postgres install", async () => {
    internalRows = [
      { catalog_id: "cat_pg", catalog_slug: "postgres", config: { url: "enc:v1:…" }, config_schema: [], group_id: "prod" },
    ];
    poolConfigResult = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "analytics" };
    const res = await loadDatasourceProfileTarget("org_1", "pg");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.target.dbType).toBe("postgres");
      expect(res.target.url).toBe("postgres://u:p@h/db");
      expect(res.target.schema).toBe("analytics");
      // #3546 — the group scope drives where persisted drafts land.
      expect(res.target.connectionGroupId).toBe("prod");
    }
  });

  it("normalizes a missing/empty group_id to null connectionGroupId (flat default scope)", async () => {
    internalRows = [
      { catalog_id: "cat_pg", catalog_slug: "postgres", config: { url: "enc:v1:…" }, config_schema: [], group_id: null },
    ];
    poolConfigResult = { dbType: "postgres", url: "postgres://u:p@h/db", schema: "public" };
    const res = await loadDatasourceProfileTarget("org_1", "pg");
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.target.connectionGroupId).toBeNull();
  });

  it("returns unsupported for a non-profilable dbType", async () => {
    internalRows = [
      { catalog_id: "cat_ch", catalog_slug: "clickhouse", config: {}, config_schema: [] },
    ];
    poolConfigResult = { dbType: "clickhouse", url: "clickhouse://h/db" };
    const res = await loadDatasourceProfileTarget("org_1", "ch");
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") expect(res.dbType).toBe("clickhouse");
  });
});
