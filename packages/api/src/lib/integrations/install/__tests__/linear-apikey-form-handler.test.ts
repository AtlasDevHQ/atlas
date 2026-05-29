/**
 * Tests for {@link LinearApiKeyFormInstallHandler} (#2750).
 *
 * Mirrors {@link ./email-form-handler.test.ts}; Linear-API-key-specific
 * pins:
 *
 *   - Only the `api_key` field is `secret: true` and round-trips through
 *     `encryptSecretFields`; `workspace_name` stays plaintext.
 *   - INSERT uses the post-0092 explicit `pillar='action'` + `install_id`
 *     shape with the partial unique index conflict target. Pin so a
 *     refactor that drops back to the pre-0092 trigger-derived shape
 *     surfaces immediately.
 *   - SaaS keyset gate refuses to persist plaintext when
 *     `ATLAS_DEPLOY_MODE=saas` and no encryption keyset is set.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
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

const WSID = "ws-linear-apikey-1" as WorkspaceId;

type HandlerCtor = typeof import("../linear-apikey-form-handler").LinearApiKeyFormInstallHandler;
type ValidationErrCtor = typeof import("../linear-apikey-form-handler").FormInstallValidationError;
let LinearApiKeyFormInstallHandler!: HandlerCtor;
let FormInstallValidationError!: ValidationErrCtor;

beforeAll(async () => {
  const mod = await import("../linear-apikey-form-handler");
  LinearApiKeyFormInstallHandler = mod.LinearApiKeyFormInstallHandler;
  FormInstallValidationError = mod.FormInstallValidationError;
});

const ORIGINAL_ENV = { ...process.env };

function setKeys(value: string): void {
  process.env.ATLAS_ENCRYPTION_KEYS = value;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

function validForm(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    api_key: "lin_api_test_secret_abc123",
    workspace_name: "Acme Linear",
    ...overrides,
  };
}

beforeEach(() => {
  setKeys("v1:test-key-for-linear-apikey-handler-unit-tests-must-be-long-enough");
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("LinearApiKeyFormInstallHandler.validateConfig — input validation", () => {
  it("rejects missing api_key with FormInstallValidationError", async () => {
    const handler = new LinearApiKeyFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, { workspace_name: "Acme" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.api_key).toBeDefined();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects api_key with characters Linear never uses", async () => {
    const handler = new LinearApiKeyFormInstallHandler();
    await expect(
      handler.validateConfig(WSID, validForm({ api_key: "has spaces and special chars!" })),
    ).rejects.toBeInstanceOf(FormInstallValidationError);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("accepts a missing workspace_name (optional)", async () => {
    const handler = new LinearApiKeyFormInstallHandler();
    const result = await handler.validateConfig(WSID, { api_key: "lin_api_only_key" });
    expect(result.credentialWritten).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path — encryption round-trip + INSERT shape
// ---------------------------------------------------------------------------

describe("LinearApiKeyFormInstallHandler.validateConfig — happy path", () => {
  it("encrypts only the api_key field and persists workspace_name plaintext", async () => {
    const handler = new LinearApiKeyFormInstallHandler();

    await handler.validateConfig(WSID, validForm());

    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockInternalQuery.mock.calls[0];
    const configJson = (params as unknown[]).find(
      (p) => typeof p === "string" && p.startsWith("{"),
    ) as string | undefined;
    expect(configJson).toBeDefined();
    const persisted = JSON.parse(configJson!) as Record<string, unknown>;

    // api_key is encrypted at rest — should NOT round-trip as plaintext.
    expect(persisted.api_key).toBeTypeOf("string");
    expect(persisted.api_key).not.toBe("lin_api_test_secret_abc123");
    expect(persisted.api_key as string).toMatch(/^enc:/);
    // Decrypt to verify the round-trip.
    expect(decryptSecret(persisted.api_key as string)).toBe("lin_api_test_secret_abc123");

    // workspace_name stays plaintext — admin UI reads need no decrypt.
    expect(persisted.workspace_name).toBe("Acme Linear");
  });

  it("INSERT names pillar='action' and install_id explicitly (post-0092 shape)", async () => {
    const handler = new LinearApiKeyFormInstallHandler();
    await handler.validateConfig(WSID, validForm());

    const [sql] = mockInternalQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/install_id/);
    expect(sql).toMatch(/pillar/);
    expect(sql).toMatch(/'action'/);
    expect(sql).toMatch(/ON CONFLICT.*workspace_id.*catalog_id.*WHERE.*pillar.*DO UPDATE/s);
    // Catalog id must be `catalog:linear-apikey` — the dispatch key.
    const params = mockInternalQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain("catalog:linear-apikey");
  });

  it("returns the persisted id on ON CONFLICT (re-install keeps the original row id)", async () => {
    // Simulate a re-install: the candidate id we'd insert is "fresh-id"
    // but the DB row's existing id is "preexisting-id". RETURNING id on
    // an UPSERT returns the row's actual id, NOT the candidate — so the
    // handler must surface "preexisting-id". Pins that installRecord.id
    // flows from the RETURNING row decoupled from candidateId; brings
    // this file to parity with the email/obsidian/webhook/twenty tests
    // so a silent revert to `persistedId = candidateId` (the bug #2808
    // removed) is caught here, not just in the empty-rowset cases below.
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("RETURNING id")) return [{ id: "preexisting-id" }];
      return [];
    });
    const handler = new LinearApiKeyFormInstallHandler({ idGenerator: () => "fresh-id" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord.id).toBe("preexisting-id");
  });
});

// ---------------------------------------------------------------------------
// RETURNING-id invariant — fail loud when the upsert emits no row (#2808)
// ---------------------------------------------------------------------------

describe("LinearApiKeyFormInstallHandler.validateConfig — RETURNING invariant", () => {
  it("throws when the upsert returns no row (driver/RLS/rewrite anomaly)", async () => {
    // INSERT ... ON CONFLICT ... DO UPDATE RETURNING is guaranteed by
    // Postgres to emit one row. If the mock returns [] (a structural
    // anomaly), the handler must surface a 500 rather than silently
    // fall back to candidateId — the fallback returned a WRONG id on
    // the DO UPDATE path and corrupted downstream lookups.
    mockInternalQuery.mockImplementation(async () => []);
    const handler = new LinearApiKeyFormInstallHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(
      /upsert returned no id/,
    );
  });

  it("throws when the returned id is an empty string", async () => {
    mockInternalQuery.mockImplementation(async () => [{ id: "" }]);
    const handler = new LinearApiKeyFormInstallHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(
      /upsert returned no id/,
    );
  });
});

// ---------------------------------------------------------------------------
// SaaS keyset gate — fail-closed on missing encryption keyset
// ---------------------------------------------------------------------------

describe("LinearApiKeyFormInstallHandler.validateConfig — SaaS keyset gate", () => {
  it("refuses to persist when SaaS + no keyset (would leak plaintext)", async () => {
    // Mirror the EmailFormInstallHandler posture — a misconfigured SaaS
    // deploy must fail closed at the credential boundary rather than
    // silently passing the api_key through as plaintext.
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();

    const handler = new LinearApiKeyFormInstallHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(
      /Encryption keyset unavailable/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
