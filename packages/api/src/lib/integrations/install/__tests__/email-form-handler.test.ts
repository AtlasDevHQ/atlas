/**
 * Tests for {@link EmailFormInstallHandler} — slice 7 of #2649 (issue #2660).
 *
 * Covers the contract documented on {@link FormBasedInstallHandler}:
 * validation rejection emits `EmailFormValidationError` with per-field
 * detail; happy path encrypts only the `password` field (secret-marked
 * in the inline schema) and round-trips back to the same plaintext;
 * `workspace_plugins` row is upserted under the canonical `catalog:email`
 * id.
 *
 * `mock.module()` shadows `lib/db/internal` so the upsert can be inspected
 * without a real Postgres pool. The encryption keyset is set via env so
 * `encryptSecretFields` exercises the real ciphertext path (not the
 * keyless passthrough) — pinning the round-trip property under prod-like
 * conditions.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import { decryptSecret } from "@atlas/api/lib/db/secret-encryption";
import type { WorkspaceId } from "@useatlas/types";

const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(() =>
  Promise.resolve([]),
);

mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const WSID = "ws-email-1" as WorkspaceId;

type EmailFormInstallHandlerCtor = typeof import("../email-form-handler").EmailFormInstallHandler;
type EmailFormValidationErrorCtor = typeof import("../email-form-handler").EmailFormValidationError;
let EmailFormInstallHandler!: EmailFormInstallHandlerCtor;
let EmailFormValidationError!: EmailFormValidationErrorCtor;

beforeAll(async () => {
  const mod = await import("../email-form-handler");
  EmailFormInstallHandler = mod.EmailFormInstallHandler;
  EmailFormValidationError = mod.EmailFormValidationError;
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
    host: "smtp.example.com",
    port: 587,
    username: "atlas@example.com",
    password: "super-secret-plaintext-pw",
    fromAddress: "Atlas <atlas@example.com>",
    secure: true,
    ...overrides,
  };
}

beforeEach(() => {
  // Real keyset so `encryptSecretFields` produces actual `enc:v1:`
  // ciphertext rather than a plaintext passthrough — the round-trip
  // assertion below would otherwise pass trivially.
  setKeys("v1:test-key-for-email-handler-unit-tests-must-be-long-enough");
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

describe("EmailFormInstallHandler.validateConfig — input validation", () => {
  it("rejects entirely missing fields with EmailFormValidationError", async () => {
    const handler = new EmailFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmailFormValidationError);
    const errs = (caught as InstanceType<typeof EmailFormValidationError>).fieldErrors;
    // Required field detection — at least the primary credentials must surface.
    expect(errs.host).toBeDefined();
    expect(errs.username).toBeDefined();
    expect(errs.password).toBeDefined();
    expect(errs.fromAddress).toBeDefined();
    // Never persisted on rejection.
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects an obviously malformed fromAddress", async () => {
    const handler = new EmailFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ fromAddress: "not-an-email" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmailFormValidationError);
    const errs = (caught as InstanceType<typeof EmailFormValidationError>).fieldErrors;
    expect(errs.fromAddress).toBeDefined();
  });

  it("rejects a port outside the legal 1–65535 range", async () => {
    const handler = new EmailFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ port: 0 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmailFormValidationError);
    const errs = (caught as InstanceType<typeof EmailFormValidationError>).fieldErrors;
    expect(errs.port).toBeDefined();
  });

  it("accepts a numeric port submitted as a string (form coercion)", async () => {
    const handler = new EmailFormInstallHandler({ idGenerator: () => "install-1" });
    await handler.validateConfig(WSID, validForm({ port: "465" }));
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });

  it("accepts a bare-email fromAddress (no display name)", async () => {
    const handler = new EmailFormInstallHandler({ idGenerator: () => "install-1" });
    await handler.validateConfig(WSID, validForm({ fromAddress: "atlas@example.com" }));
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Persistence + encryption round-trip
// ---------------------------------------------------------------------------

describe("EmailFormInstallHandler.validateConfig — persistence", () => {
  it("upserts a workspace_plugins row with the canonical catalog:email id", async () => {
    const handler = new EmailFormInstallHandler({ idGenerator: () => "install-test-1" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord).toEqual({
      id: "install-test-1",
      workspaceId: WSID,
      catalogId: "email",
    });
    expect(result.credentialWritten).toBe(true);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO workspace_plugins");
    expect(sql).toContain("ON CONFLICT");
    expect(params).toBeDefined();
    const paramsList = params as unknown[];
    expect(paramsList[0]).toBe("install-test-1");
    expect(paramsList[1]).toBe(WSID);
    expect(paramsList[2]).toBe("catalog:email");
  });

  it("encrypts only the password field; operational fields stay plaintext", async () => {
    const handler = new EmailFormInstallHandler({ idGenerator: () => "install-test-2" });
    await handler.validateConfig(WSID, validForm({ password: "plaintext-secret-xyz" }));
    const [, params] = mockInternalQuery.mock.calls[0];
    const paramsList = params as unknown[];
    const configJson = paramsList[3] as string;
    const stored = JSON.parse(configJson) as Record<string, unknown>;

    // Operational fields are stored as-is.
    expect(stored.host).toBe("smtp.example.com");
    expect(stored.port).toBe(587);
    expect(stored.username).toBe("atlas@example.com");
    expect(stored.fromAddress).toBe("Atlas <atlas@example.com>");
    expect(stored.secure).toBe(true);

    // Password is encrypted — carries the versioned prefix and is NOT
    // the plaintext we submitted.
    expect(typeof stored.password).toBe("string");
    expect(stored.password as string).toMatch(/^enc:v1:/);
    expect(stored.password).not.toBe("plaintext-secret-xyz");

    // Round-trip decrypt returns the original.
    expect(decryptSecret(stored.password as string)).toBe("plaintext-secret-xyz");
  });

  it("does NOT persist when the upsert throws", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg pool exhausted")));
    const handler = new EmailFormInstallHandler({ idGenerator: () => "install-test-3" });
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("pg pool exhausted");
  });
});
