/**
 * Tests for the shared form-install persistence spine —
 * {@link persistFormInstall} + {@link assertSaasEncryptionKeyset} +
 * {@link buildFormInstallUpsertSql}.
 *
 * The spine owns the behavior the six single-instance form handlers
 * (Email / Webhook / Obsidian / Linear API-key / GitHub PAT / Twenty)
 * used to each carry a copy of: SaaS keyset gate, selective-field
 * encryption, the post-0092 `workspace_plugins` upsert, the
 * returned-id invariant, and the optional lazy-loader evict. Each
 * behavior is pinned ONCE here; the per-handler tests keep covering
 * their parse-and-validate remainder (and the full path through the
 * spine, since they mock the same `db/internal` seam).
 *
 * SQL-shape note: the upsert must name `install_id` + `pillar` and
 * spell the partial-index predicate on the conflict target — the
 * pre-spine Email/Webhook/Obsidian copies used the pre-0092 shape and
 * failed against the live schema with 42P10 (no arbiter index). The
 * real-Postgres execution of {@link buildFormInstallUpsertSql} lives
 * in `db/__tests__/migrate-pg.test.ts`; here we pin the string shape
 * so a regression is visible without a live Postgres.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import type { ConfigSchema } from "@atlas/api/lib/plugins/secrets";
import type { WorkspaceId } from "@useatlas/types";

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  },
);

mock.module("@atlas/api/lib/db/internal", () => ({
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
let assertSaasEncryptionKeyset!: SpineModule["assertSaasEncryptionKeyset"];
let buildFormInstallUpsertSql!: SpineModule["buildFormInstallUpsertSql"];

beforeAll(async () => {
  const mod = await import("../persist-form-install");
  persistFormInstall = mod.persistFormInstall;
  assertSaasEncryptionKeyset = mod.assertSaasEncryptionKeyset;
  buildFormInstallUpsertSql = mod.buildFormInstallUpsertSql;
});

const ORIGINAL_ENV = { ...process.env };

// Logger stub — capture calls so log-or-rethrow behavior is assertable.
function makeLog() {
  const calls: Array<{ level: string; msg: string }> = [];
  const log = {
    error: (_obj: unknown, msg: string) => calls.push({ level: "error", msg }),
    warn: (_obj: unknown, msg: string) => calls.push({ level: "warn", msg }),
    info: (_obj: unknown, msg: string) => calls.push({ level: "info", msg }),
    debug: () => {},
  } as unknown as Parameters<typeof persistFormInstall>[0]["log"];
  return { log, calls };
}

function baseParams(overrides: Partial<Parameters<typeof persistFormInstall>[0]> = {}) {
  const { log } = makeLog();
  return {
    workspaceId: WSID,
    catalogId: "catalog:spine-test",
    catalogSlug: "spine-test",
    displayName: "Spine Test",
    log,
    config: { host: "example.com", token: "plaintext-token-xyz" },
    secretFieldsSchema: SECRET_SCHEMA,
    plaintextSecretLabel: "token",
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
    // The refusal names the credential field (breadcrumb, never the value).
    expect(calls.some((c) => c.level === "error" && c.msg.includes("plaintext token"))).toBe(true);
  });

  it("standalone gate throws under SaaS + keyless (Twenty gates its credential-table write)", () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();
    const { log } = makeLog();
    expect(() => assertSaasEncryptionKeyset(log, WSID, "api_key")).toThrow(
      /Encryption keyset unavailable/,
    );
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
      baseParams({ config: {}, secretFieldsSchema: undefined }),
    );
    const [, params] = mockInternalQuery.mock.calls[0];
    expect(JSON.parse((params as unknown[])[3] as string)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Upsert shape + returned-id invariant
// ---------------------------------------------------------------------------

describe("persistFormInstall — workspace_plugins upsert", () => {
  it("uses the post-0092 shape: explicit install_id + pillar='action' + partial-index conflict target", async () => {
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
    expect(p[2]).toBe("catalog:spine-test");
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
// Post-persist evict hook
// ---------------------------------------------------------------------------

describe("persistFormInstall — lazy-loader evict", () => {
  it("evicts the (workspace, catalog) plugin cache when evictAfterPersist is set", async () => {
    await persistFormInstall(baseParams({ evictAfterPersist: true }));
    expect(evictMock).toHaveBeenCalledWith(WSID, "catalog:spine-test");
  });

  it("does not evict by default", async () => {
    await persistFormInstall(baseParams());
    expect(evictMock).not.toHaveBeenCalled();
  });

  it("an evict failure warns but never fails the install (DB row already persisted)", async () => {
    evictMock.mockImplementation(() => Promise.reject(new Error("teardown blew up")));
    const { log, calls } = makeLog();
    const result = await persistFormInstall(baseParams({ log, evictAfterPersist: true }));
    expect(result.id).toBe("candidate-1");
    expect(
      calls.some((c) => c.level === "warn" && c.msg.includes("Spine Test install upsert")),
    ).toBe(true);
  });

  it("evict runs after the upsert, never on the failure path", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("boom")));
    await expect(persistFormInstall(baseParams({ evictAfterPersist: true }))).rejects.toThrow(
      "boom",
    );
    expect(evictMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SQL builder — both variants stay parseable-by-inspection here; the real-PG
// execution lives in db/__tests__/migrate-pg.test.ts.
// ---------------------------------------------------------------------------

describe("buildFormInstallUpsertSql", () => {
  it("both variants target the partial singleton index and RETURNING id", () => {
    for (const updateConfig of [true, false]) {
      const sql = buildFormInstallUpsertSql(updateConfig);
      expect(sql).toContain("ON CONFLICT (workspace_id, catalog_id) WHERE pillar IN ('chat', 'action')");
      expect(sql).toContain("RETURNING id");
      expect(sql).toContain("'action'");
    }
  });
});
