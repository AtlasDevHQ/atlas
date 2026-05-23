/**
 * Tests for {@link WebhookFormInstallHandler} — second form-based
 * implementation under #2661.
 *
 * Mirrors `email-form-handler.test.ts` (slice 7 of #2649) — validation
 * rejection emits {@link FormInstallValidationError} with per-field
 * detail; happy path encrypts only `signing_secret` and round-trips
 * back to the same plaintext; `workspace_plugins` row upserts under
 * the canonical `catalog:webhook` id.
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

const WSID = "ws-webhook-1" as WorkspaceId;

type WebhookFormInstallHandlerCtor = typeof import("../webhook-form-handler").WebhookFormInstallHandler;
type FormInstallValidationErrorCtor = typeof import("../email-form-handler").FormInstallValidationError;
let WebhookFormInstallHandler!: WebhookFormInstallHandlerCtor;
let FormInstallValidationError!: FormInstallValidationErrorCtor;

beforeAll(async () => {
  const mod = await import("../webhook-form-handler");
  WebhookFormInstallHandler = mod.WebhookFormInstallHandler;
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
    url: "https://hooks.example.com/atlas",
    signing_secret: "super-secret-hmac-key",
    retry_policy: "exponential",
    ...overrides,
  };
}

beforeEach(() => {
  setKeys("v1:test-key-for-webhook-handler-unit-tests-must-be-long-enough");
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

describe("WebhookFormInstallHandler.validateConfig — input validation", () => {
  it("rejects entirely missing fields", async () => {
    const handler = new WebhookFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.url).toBeDefined();
    expect(errs.signing_secret).toBeDefined();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects a non-https URL — webhook destinations must be TLS", async () => {
    const handler = new WebhookFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ url: "http://hooks.example.com" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.url).toBeDefined();
  });

  it("rejects a malformed URL", async () => {
    const handler = new WebhookFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ url: "not-a-url" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
  });

  it("rejects an empty signing_secret", async () => {
    const handler = new WebhookFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ signing_secret: "" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.signing_secret).toBeDefined();
  });

  it("rejects an invalid retry_policy value", async () => {
    const handler = new WebhookFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ retry_policy: "bogus" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
  });

  it("accepts a config without retry_policy and defaults it to exponential", async () => {
    const handler = new WebhookFormInstallHandler({ idGenerator: () => "install-1" });
    await handler.validateConfig(WSID, { url: "https://hooks.example.com/atlas", signing_secret: "s" });
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockInternalQuery.mock.calls[0];
    const stored = JSON.parse((params as unknown[])[3] as string) as Record<string, unknown>;
    expect(stored.retry_policy).toBe("exponential");
  });
});

// ---------------------------------------------------------------------------
// Persistence + encryption round-trip
// ---------------------------------------------------------------------------

describe("WebhookFormInstallHandler.validateConfig — persistence", () => {
  it("upserts a workspace_plugins row with the canonical catalog:webhook id", async () => {
    const handler = new WebhookFormInstallHandler({ idGenerator: () => "install-test-1" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord).toEqual({
      id: "install-test-1",
      workspaceId: WSID,
      catalogId: "webhook",
    });
    expect(result.credentialWritten).toBe(true);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO workspace_plugins");
    expect(sql).toContain("ON CONFLICT");
    const paramsList = params as unknown[];
    expect(paramsList[0]).toBe("install-test-1");
    expect(paramsList[1]).toBe(WSID);
    expect(paramsList[2]).toBe("catalog:webhook");
  });

  it("encrypts only the signing_secret; url and retry_policy stay plaintext", async () => {
    const handler = new WebhookFormInstallHandler({ idGenerator: () => "install-test-2" });
    await handler.validateConfig(WSID, validForm({ signing_secret: "plaintext-secret-xyz" }));
    const [, params] = mockInternalQuery.mock.calls[0];
    const paramsList = params as unknown[];
    const stored = JSON.parse(paramsList[3] as string) as Record<string, unknown>;

    expect(stored.url).toBe("https://hooks.example.com/atlas");
    expect(stored.retry_policy).toBe("exponential");

    expect(typeof stored.signing_secret).toBe("string");
    expect(stored.signing_secret as string).toMatch(/^enc:v1:/);
    expect(stored.signing_secret).not.toBe("plaintext-secret-xyz");
    expect(decryptSecret(stored.signing_secret as string)).toBe("plaintext-secret-xyz");
  });

  it("does NOT persist when the upsert throws", async () => {
    mockInternalQuery.mockImplementation(() => Promise.reject(new Error("pg pool exhausted")));
    const handler = new WebhookFormInstallHandler({ idGenerator: () => "install-test-3" });
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
    const handler = new WebhookFormInstallHandler({ idGenerator: () => "fresh-id" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord.id).toBe("preexisting-id");
  });
});

// ---------------------------------------------------------------------------
// SaaS keyset gate
// ---------------------------------------------------------------------------

describe("WebhookFormInstallHandler — SaaS keyset gate", () => {
  it("refuses to persist when SaaS deploy has no encryption keyset", async () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();

    const handler = new WebhookFormInstallHandler({ idGenerator: () => "install-test-saas" });
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

// ---------------------------------------------------------------------------
// Cross-schema agreement — pins that the Zod schema, the secret-fields
// schema (encryptSecretFields routing), and the catalog `configSchema`
// in `deploy/api/atlas.config.ts` stay in lockstep. Mirrors the Email
// test at email-form-handler.test.ts:275-287.
// ---------------------------------------------------------------------------

describe("WebhookFormInstallHandler — cross-schema agreement", () => {
  it("WebhookFormDataSchema accepts exactly the canonical webhook field set", async () => {
    const mod = await import("../webhook-form-handler");
    const zodKeys = Object.keys(
      (mod.WebhookFormDataSchema as unknown as { shape: Record<string, unknown> }).shape,
    ).sort();
    const expected = ["retry_policy", "signing_secret", "url"];
    expect(zodKeys).toEqual(expected);
  });
});
