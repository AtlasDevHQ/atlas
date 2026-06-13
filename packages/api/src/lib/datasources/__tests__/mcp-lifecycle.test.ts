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

// ── Mocks for the DB / registry primitives `listDatasources` calls ────

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
mock.module("@atlas/api/lib/db/connection", () => ({
  connections: {
    describe: () => describeRows,
    healthCheck: mock(async () => ({ status: "healthy", latencyMs: 1, checkedAt: new Date(0) })),
    has: (id: string) => id !== "archived-ds",
  },
}));

// `readFilter` is the pure status clause; the literal value is irrelevant to
// these tests (internalQuery is mocked) — just return a stable fragment.
mock.module("@atlas/api/lib/content-mode", () => ({
  makeService: () => ({
    readFilter: () => Effect.succeed("wp.status = 'published'"),
  }),
  CONTENT_MODE_TABLES: [],
}));

// Mock every value export — `workspace-installer` (transitively imported by
// `runDatasourceInstaller`) also pulls `resolveDatasourcePoolConfig` +
// `BUILTIN_DATASOURCE_CATALOG_SLUGS` from this module.
mock.module("@atlas/api/lib/db/datasource-pool-resolver", () => ({
  catalogSlugToDbType: (slug: string) => {
    if (slug === "postgres") return "postgres";
    throw new Error(`unknown slug ${slug}`);
  },
  resolveDatasourcePoolConfig: mock(() => ({})),
  BUILTIN_DATASOURCE_CATALOG_SLUGS: ["postgres", "mysql"],
}));

const { listDatasources, runDatasourceInstaller } = await import("../mcp-lifecycle.js");

beforeEach(() => {
  mockInternalQuery.mockClear();
  mockHasInternalDB.mockClear();
  internalRows = [];
  describeRows = [];
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
