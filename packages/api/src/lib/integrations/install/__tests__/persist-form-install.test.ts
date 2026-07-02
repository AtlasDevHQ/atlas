/**
 * Tests for the shared form-install persistence spine —
 * {@link persistFormInstall} + {@link assertSaasEncryptionKeyset} +
 * {@link parseFormInstall} + {@link buildFormInstallUpsertSql}.
 *
 * The spine owns the behavior the six single-instance form handlers
 * (Email / Webhook / Obsidian / Linear API-key / GitHub PAT / Twenty)
 * used to each carry a copy of: SaaS keyset gate, selective-field
 * encryption, the post-0092 `workspace_plugins` upsert, the
 * returned-id invariant, and the lazy-loader evict. Each behavior is
 * pinned ONCE here; the per-handler tests keep covering their
 * parse-and-validate remainder (and the full path through the spine,
 * since they mock the same `db/internal` seam).
 *
 * SQL-shape note: the upsert must name `install_id` + `pillar` and
 * spell the partial-index predicate on the conflict target — the
 * pre-spine Email/Webhook/Obsidian copies used the pre-0092 shape and
 * failed against the live schema with 42P10 (no arbiter index). The
 * real-Postgres execution of {@link buildFormInstallUpsertSql} lives
 * in `./persist-form-install-pg.test.ts`; here we pin the string shape
 * so a regression is visible without a live Postgres.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import type { ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";
import { z } from "zod";
import * as actualDbInternal from "@atlas/api/lib/db/internal";

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  },
);

// Mock all exports (CLAUDE.md partial-mock rule): spread the real module
// so every named export (MANAGED_AUTH_MIGRATIONS, _resetPool, …) stays
// importable, overriding only the three seams the spine touches.
mock.module("@atlas/api/lib/db/internal", () => ({
  ...actualDbInternal,
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const evictMock: Mock<(workspaceId: string, catalogId: string) => Promise<boolean>> = mock(
  async () => true,
);
// Mock all value exports (CLAUDE.md partial-mock rule) — classes ride
// along so `instanceof` call sites elsewhere keep working.
mock.module("@atlas/api/lib/plugins/lazy-loader", () => ({
  lazyPluginLoader: { evict: evictMock },
  LazyPluginLoader: class {},
  LazyPluginBuilderMissingError: class extends Error {},
  LazyPluginInstallNotFoundError: class extends Error {},
}));

const WSID = "ws-spine-1" as WorkspaceId;

const SECRET_SCHEMA: ConfigSchema = {
  state: "parsed",
  fields: [
    { key: "host", type: "string" },
    { key: "token", type: "string", secret: true },
  ],
};

type SpineModule = typeof import("../persist-form-install");
let persistFormInstall!: SpineModule["persistFormInstall"];
let persistInstallRecord!: SpineModule["persistInstallRecord"];
let assertSaasEncryptionKeyset!: SpineModule["assertSaasEncryptionKeyset"];
let buildFormInstallUpsertSql!: SpineModule["buildFormInstallUpsertSql"];
let parseFormInstall!: SpineModule["parseFormInstall"];
let FormInstallValidationError!: SpineModule["FormInstallValidationError"];

beforeAll(async () => {
  const mod = await import("../persist-form-install");
  persistFormInstall = mod.persistFormInstall;
  persistInstallRecord = mod.persistInstallRecord;
  assertSaasEncryptionKeyset = mod.assertSaasEncryptionKeyset;
  buildFormInstallUpsertSql = mod.buildFormInstallUpsertSql;
  parseFormInstall = mod.parseFormInstall;
  FormInstallValidationError = mod.FormInstallValidationError;
});

const ORIGINAL_ENV = { ...process.env };

// Logger stub — satisfies the spine's narrowed InstallLogger (Pick of
// error/warn) without casts, and captures calls so log-or-rethrow
// behavior is assertable.
function makeLog() {
  const calls: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const record =
    (level: string) =>
    (objOrMsg: unknown, msg?: string): void => {
      calls.push({
        level,
        msg: typeof objOrMsg === "string" ? objOrMsg : (msg ?? ""),
        fields: typeof objOrMsg === "object" && objOrMsg !== null
          ? (objOrMsg as Record<string, unknown>)
          : {},
      });
    };
  return { log: { error: record("error"), warn: record("warn") }, calls };
}

function baseParams(overrides: Partial<Parameters<typeof persistFormInstall>[0]> = {}) {
  const { log } = makeLog();
  return {
    workspaceId: WSID,
    catalogSlug: "spine-test",
    displayName: "Spine Test",
    log,
    config: { host: "example.com", token: "plaintext-token-xyz" },
    secretFieldsSchema: SECRET_SCHEMA,
    newId: () => "candidate-1",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-for-spine-unit-tests-must-be-long-enough";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ATLAS_DEPLOY_MODE;
  _resetEncryptionKeyCache();
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  });
  evictMock.mockClear();
  evictMock.mockImplementation(async () => true);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ---------------------------------------------------------------------------
// Parse step
// ---------------------------------------------------------------------------

describe("parseFormInstall", () => {
  const Schema = z.object({ name: z.string().min(1, "name is required") }).strict();

  it("returns the parsed data on success", () => {
    expect(parseFormInstall(Schema, { name: "ok" })).toEqual({ name: "ok" });
  });

  it("throws FormInstallValidationError with field detail on failure", () => {
    let caught: unknown;
    try {
      parseFormInstall(Schema, { name: "", extra: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const e = caught as InstanceType<typeof FormInstallValidationError>;
    expect(e.fieldErrors.name).toBeDefined();
    // .strict() unrecognized-key reports land in formErrors.
    expect(e.formErrors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SaaS keyset gate
// ---------------------------------------------------------------------------

describe("assertSaasEncryptionKeyset / spine keyset gate", () => {
  it("refuses to persist when SaaS deploy has no encryption keyset", async () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();

    const { log, calls } = makeLog();
    await expect(persistFormInstall(baseParams({ log }))).rejects.toThrow(
      /Encryption keyset unavailable in SaaS mode/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
    // The refusal names the credential field, DERIVED from the schema's
    // secret:true key (breadcrumb, never the value).
    expect(calls.some((c) => c.level === "error" && c.msg.includes("plaintext token"))).toBe(true);
  });

  it("an explicit plaintextSecretLabel overrides the derived one (Twenty's schema-less path)", async () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();

    const { log, calls } = makeLog();
    await expect(
      persistFormInstall(
        baseParams({ log, config: {}, secretFieldsSchema: undefined, plaintextSecretLabel: "api_key" }),
      ),
    ).rejects.toThrow(/Encryption keyset unavailable/);
    expect(calls.some((c) => c.msg.includes("plaintext api_key"))).toBe(true);
  });

  it("standalone gate throws under SaaS + keyless, sanitizing the label out of the message", () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();
    const { log, calls } = makeLog();
    // The label lands in the log MESSAGE — a config-derived value must
    // not be able to splice newlines/forged content into it.
    expect(() => assertSaasEncryptionKeyset(log, WSID, "x) — ok\nforged=1")).toThrow(
      /Encryption keyset unavailable/,
    );
    const refusal = calls.find((c) => c.level === "error");
    expect(refusal?.msg).not.toContain("\n");
    expect(refusal?.msg).not.toContain("forged=1");
  });

  it("extraLogFields ride along on the refusal log (OpenAPI per-candidate attribution)", () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();
    const { log, calls } = makeLog();
    expect(() => assertSaasEncryptionKeyset(log, WSID, "auth_value", { catalogSlug: "stripe-data" }))
      .toThrow(/Encryption keyset unavailable/);
    expect(calls[0]?.fields.catalogSlug).toBe("stripe-data");
  });

  it("self-hosted keyless deploys pass the gate (dev passthrough parity)", async () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    _resetEncryptionKeyCache();
    const result = await persistFormInstall(baseParams());
    expect(result.id).toBe("candidate-1");
  });
});

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

describe("persistFormInstall — selective-field encryption", () => {
  it("encrypts only secret-marked fields; operational fields stay plaintext", async () => {
    await persistFormInstall(baseParams());
    const [, params] = mockInternalQuery.mock.calls[0];
    const stored = JSON.parse((params as unknown[])[3] as string) as Record<string, unknown>;
    expect(stored.host).toBe("example.com");
    expect(stored.token as string).toMatch(/^enc:v1:/);
    expect(decryptSecret(stored.token as string)).toBe("plaintext-token-xyz");
  });

  it("persists config as-is when no secret schema is given (Twenty's {} stub)", async () => {
    await persistFormInstall(
      baseParams({ config: {}, secretFieldsSchema: undefined, plaintextSecretLabel: "api_key" }),
    );
    const [, params] = mockInternalQuery.mock.calls[0];
    expect(JSON.parse((params as unknown[])[3] as string)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Upsert shape + returned-id invariant
// ---------------------------------------------------------------------------

describe("persistFormInstall — workspace_plugins upsert", () => {
  it("uses the post-0092 shape and derives the catalog:<slug> FK from the slug", async () => {
    await persistFormInstall(baseParams());
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO workspace_plugins");
    expect(sql).toMatch(/install_id/);
    expect(sql).toMatch(/'action'/);
    // The WHERE predicate is load-bearing: only the partial unique
    // `workspace_plugins_singleton` remains post-0096, and Postgres
    // won't infer a partial index as arbiter without it (42P10).
    expect(sql).toMatch(/ON CONFLICT \(workspace_id, catalog_id\) WHERE pillar IN \('chat', 'action'\)/);
    expect(sql).toMatch(/SET config = EXCLUDED\.config/);
    const p = params as unknown[];
    expect(p[0]).toBe("candidate-1");
    expect(p[1]).toBe(WSID);
    // One param at the seam — the FK is derived, so a mismatched
    // catalogId/catalogSlug pair is unrepresentable.
    expect(p[2]).toBe("catalog:spine-test");
    // #4186 — installed_by rides the canonical shape. The form spine has
    // no acting user at its seam, so it always passes null.
    expect(p[4]).toBeNull();
  });

  it("threads installedBy to the upsert when the caller attributes the install (#4186 marketplace)", async () => {
    const { log } = makeLog();
    const persistedId = await persistInstallRecord({
      workspaceId: WSID,
      catalogId: "bare-uuid-catalog-row", // platform-admin CRUD rows are NOT catalog:<slug>
      displayName: "Marketplace Row",
      log,
      config: { host: "example.com" },
      newId: () => "candidate-mp",
      installedBy: "admin-7",
    });
    expect(persistedId).toBe("candidate-mp");
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("installed_by");
    const p = params as unknown[];
    expect(p[2]).toBe("bare-uuid-catalog-row");
    expect(p[4]).toBe("admin-7");
    // installed_by attributes the FIRST install only — the conflict SET
    // must never rewrite it on a re-install.
    expect(sql).not.toMatch(/DO UPDATE[\s\S]*installed_by/);
  });

  it("omits the config overwrite on conflict when updateConfigOnConflict is false", async () => {
    await persistFormInstall(baseParams({ updateConfigOnConflict: false }));
    const [sql] = mockInternalQuery.mock.calls[0];
    expect(sql).not.toMatch(/SET config = EXCLUDED\.config/);
    expect(sql).toMatch(/SET enabled = true/);
  });

  it("returns the persisted id on conflict (re-install keeps the original row id)", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("RETURNING id")) return [{ id: "preexisting-id" }];
      return [];
    });
    const result = await persistFormInstall(baseParams({ newId: () => "fresh-id" }));
    expect(result).toEqual({ id: "preexisting-id", workspaceId: WSID, catalogId: "spine-test" });
  });

  it("fails loud when the upsert returns no row (driver/RLS/rewrite anomaly)", async () => {
    mockInternalQuery.mockImplementation(async () => []);
    const { log, calls } = makeLog();
    await expect(persistFormInstall(baseParams({ log }))).rejects.toThrow(
      /upsert returned no id/,
    );
    expect(calls.some((c) => c.level === "error")).toBe(true);
  });

  it("fails loud when the returned id is an empty string", async () => {
    mockInternalQuery.mockImplementation(async () => [{ id: "" }]);
    await expect(persistFormInstall(baseParams())).rejects.toThrow(/upsert returned no id/);
  });

  it("logs the (overridable) failure message and rethrows when the upsert throws", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg pool exhausted")));
    const { log, calls } = makeLog();
    await expect(
      persistFormInstall(baseParams({ log, persistFailureMessage: "custom failure breadcrumb" })),
    ).rejects.toThrow("pg pool exhausted");
    expect(calls.some((c) => c.level === "error" && c.msg === "custom failure breadcrumb")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Post-persist evict
// ---------------------------------------------------------------------------

describe("persistFormInstall — lazy-loader evict", () => {
  it("always evicts the (workspace, catalog) plugin cache after a persist", async () => {
    await persistFormInstall(baseParams());
    expect(evictMock).toHaveBeenCalledWith(WSID, "catalog:spine-test");
  });

  it("an evict failure warns but never fails the install (DB row already persisted)", async () => {
    evictMock.mockImplementation(() => Promise.reject(new Error("teardown blew up")));
    const { log, calls } = makeLog();
    const result = await persistFormInstall(baseParams({ log }));
    expect(result.id).toBe("candidate-1");
    expect(
      calls.some((c) => c.level === "warn" && c.msg.includes("Spine Test install upsert")),
    ).toBe(true);
  });

  it("evict runs after the upsert, never on the failure path", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("boom")));
    await expect(persistFormInstall(baseParams())).rejects.toThrow("boom");
    expect(evictMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SQL builder — both knob variants and both pillars stay inspectable here;
// the real-PG execution lives in ./persist-form-install-pg.test.ts.
// ---------------------------------------------------------------------------

describe("buildFormInstallUpsertSql", () => {
  it("every variant targets the partial singleton index and RETURNING id", () => {
    for (const updateConfig of [true, false]) {
      for (const pillar of ["chat", "action"] as const) {
        const sql = buildFormInstallUpsertSql(updateConfig, pillar);
        expect(sql).toContain(
          "ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')",
        );
        expect(sql).toContain("RETURNING id");
        expect(sql).toContain(`'${pillar}'`);
        // #4186 — installed_by ($5) is part of the canonical shape.
        expect(sql).toContain("installed_by");
        expect(sql).toContain("$5");
      }
    }
  });

  it("defaults to the action pillar (the form spine's only value today)", () => {
    expect(buildFormInstallUpsertSql(true)).toContain("'action'");
  });
});
