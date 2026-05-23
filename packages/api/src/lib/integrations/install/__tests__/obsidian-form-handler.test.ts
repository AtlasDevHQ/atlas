/**
 * Tests for {@link ObsidianFormInstallHandler} — third form-based
 * implementation under #2661.
 *
 * Mirrors `email-form-handler.test.ts` (slice 7 of #2649) — validation
 * rejection emits {@link FormInstallValidationError} with per-field
 * detail; happy path encrypts only `api_key` and round-trips back to
 * the same plaintext; `workspace_plugins` row upserts under the
 * canonical `catalog:obsidian` id.
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

const WSID = "ws-obsidian-1" as WorkspaceId;

type ObsidianFormInstallHandlerCtor = typeof import("../obsidian-form-handler").ObsidianFormInstallHandler;
type FormInstallValidationErrorCtor = typeof import("../email-form-handler").FormInstallValidationError;
let ObsidianFormInstallHandler!: ObsidianFormInstallHandlerCtor;
let FormInstallValidationError!: FormInstallValidationErrorCtor;

beforeAll(async () => {
  const mod = await import("../obsidian-form-handler");
  ObsidianFormInstallHandler = mod.ObsidianFormInstallHandler;
  const errMod = await import("../email-form-handler");
  FormInstallValidationError = errMod.FormInstallValidationError;
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
    api_url: "http://127.0.0.1:27123",
    api_key: "obsidian-api-key-abc",
    ...overrides,
  };
}

beforeEach(() => {
  setKeys("v1:test-key-for-obsidian-handler-unit-tests-must-be-long-enough");
  mockInternalQuery.mockClear();
  mockInternalQuery.mockImplementation(() => Promise.resolve([]));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("ObsidianFormInstallHandler.validateConfig — input validation", () => {
  it("rejects entirely missing fields", async () => {
    const handler = new ObsidianFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.api_key).toBeDefined();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects a malformed api_url", async () => {
    const handler = new ObsidianFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ api_url: "not-a-url" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.api_url).toBeDefined();
  });

  it("rejects an empty api_key", async () => {
    const handler = new ObsidianFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ api_key: "" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.api_key).toBeDefined();
  });

  it("accepts a config without api_url and defaults to http://127.0.0.1:27123", async () => {
    const handler = new ObsidianFormInstallHandler({ idGenerator: () => "install-1" });
    await handler.validateConfig(WSID, { api_key: "abc" });
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockInternalQuery.mock.calls[0];
    const stored = JSON.parse((params as unknown[])[3] as string) as Record<string, unknown>;
    expect(stored.api_url).toBe("http://127.0.0.1:27123");
  });

  it("accepts a remote https vault URL", async () => {
    const handler = new ObsidianFormInstallHandler({ idGenerator: () => "install-1" });
    await handler.validateConfig(WSID, validForm({ api_url: "https://vault.example.com:27124" }));
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence + encryption round-trip
// ---------------------------------------------------------------------------

describe("ObsidianFormInstallHandler.validateConfig — persistence", () => {
  it("upserts a workspace_plugins row with the canonical catalog:obsidian id", async () => {
    const handler = new ObsidianFormInstallHandler({ idGenerator: () => "install-test-1" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord).toEqual({
      id: "install-test-1",
      workspaceId: WSID,
      catalogId: "obsidian",
    });
    expect(result.credentialWritten).toBe(true);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO workspace_plugins");
    expect(sql).toContain("ON CONFLICT");
    const paramsList = params as unknown[];
    expect(paramsList[0]).toBe("install-test-1");
    expect(paramsList[1]).toBe(WSID);
    expect(paramsList[2]).toBe("catalog:obsidian");
  });

  it("encrypts only api_key; api_url stays plaintext", async () => {
    const handler = new ObsidianFormInstallHandler({ idGenerator: () => "install-test-2" });
    await handler.validateConfig(WSID, validForm({ api_key: "plaintext-key-xyz" }));
    const [, params] = mockInternalQuery.mock.calls[0];
    const paramsList = params as unknown[];
    const stored = JSON.parse(paramsList[3] as string) as Record<string, unknown>;

    expect(stored.api_url).toBe("http://127.0.0.1:27123");

    expect(typeof stored.api_key).toBe("string");
    expect(stored.api_key as string).toMatch(/^enc:v1:/);
    expect(stored.api_key).not.toBe("plaintext-key-xyz");
    expect(decryptSecret(stored.api_key as string)).toBe("plaintext-key-xyz");
  });

  it("does NOT persist when the upsert throws", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg pool exhausted")));
    const handler = new ObsidianFormInstallHandler({ idGenerator: () => "install-test-3" });
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("pg pool exhausted");
  });

  it("returns the persisted id on ON CONFLICT (re-install keeps original row id)", async () => {
    mockInternalQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("RETURNING id")) return [{ id: "preexisting-id" }];
      return [];
    });
    const handler = new ObsidianFormInstallHandler({ idGenerator: () => "fresh-id" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord.id).toBe("preexisting-id");
  });
});

// ---------------------------------------------------------------------------
// SaaS keyset gate
// ---------------------------------------------------------------------------

describe("ObsidianFormInstallHandler — SaaS keyset gate", () => {
  it("refuses to persist when SaaS deploy has no encryption keyset", async () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();

    const handler = new ObsidianFormInstallHandler({ idGenerator: () => "install-test-saas" });
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Encryption keyset unavailable");
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
