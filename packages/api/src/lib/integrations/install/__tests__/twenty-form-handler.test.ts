/**
 * Tests for {@link TwentyFormInstallHandler} — Slice 7 of 1.6.0 (#2732).
 *
 * Mirrors the webhook-form-handler test shape but exercises the
 * dedicated `twenty_integrations` credential table write rather than
 * the `workspace_plugins.config` JSONB. Both stores must update on
 * the happy path; SaaS-mode keyset gate + per-field validation
 * mirrors the EmailFormInstallHandler posture.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, mock, type Mock } from "bun:test";
import { _resetEncryptionKeyCache } from "@atlas/api/lib/db/encryption-keys";
import type { WorkspaceId } from "@useatlas/types";

// ── DB mocks ─────────────────────────────────────────────────────────
// Two query streams to assert on:
//   • `INSERT INTO twenty_integrations` — credential row (via the store).
//   • `INSERT INTO workspace_plugins`  — catalog install record.
const mockInternalQuery: Mock<(sql: string, params?: unknown[]) => Promise<unknown[]>> = mock(
  async (sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO twenty_integrations")) {
      return [
        {
          workspace_id: params?.[0],
          base_url: params?.[1],
          updated_at: "2026-05-26T00:00:00.000Z",
        },
      ];
    }
    if (sql.includes("INSERT INTO workspace_plugins") && sql.includes("RETURNING id")) {
      const id = (params?.[0] as string | undefined) ?? "unknown";
      return [{ id }];
    }
    return [];
  },
);

void mock.module("@atlas/api/lib/db/internal", () => ({
  internalQuery: mockInternalQuery,
  hasInternalDB: mock(() => true),
  getInternalDB: mock(() => ({ query: mock(() => Promise.resolve({ rows: [] })) })),
}));

const WSID = "ws-twenty-1" as WorkspaceId;

type TwentyFormInstallHandlerCtor =
  typeof import("../twenty-form-handler").TwentyFormInstallHandler;
type FormInstallValidationErrorCtor =
  typeof import("../email-form-handler").FormInstallValidationError;
let TwentyFormInstallHandler!: TwentyFormInstallHandlerCtor;
let FormInstallValidationError!: FormInstallValidationErrorCtor;

beforeAll(async () => {
  const mod = await import("../twenty-form-handler");
  TwentyFormInstallHandler = mod.TwentyFormInstallHandler;
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

function clearKeys(): void {
  delete process.env.ATLAS_ENCRYPTION_KEYS;
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  _resetEncryptionKeyCache();
}

function validForm(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    baseUrl: "https://crm.example.com",
    apiKey: "twenty-bearer-token-abc123",
    ...overrides,
  };
}

beforeEach(() => {
  setKeys("v1:test-key-for-twenty-handler-unit-tests-must-be-long-enough");
  delete process.env.ATLAS_DEPLOY_MODE;
  mockInternalQuery.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEncryptionKeyCache();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("TwentyFormInstallHandler.validateConfig — input validation", () => {
  it("rejects entirely missing fields", async () => {
    const handler = new TwentyFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.baseUrl).toBeDefined();
    expect(errs.apiKey).toBeDefined();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects an empty baseUrl — no Atlas-SaaS default is allowed", async () => {
    const handler = new TwentyFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ baseUrl: "" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    const errs = (caught as InstanceType<typeof FormInstallValidationError>).fieldErrors;
    expect(errs.baseUrl).toBeDefined();
  });

  it("rejects a malformed baseUrl", async () => {
    const handler = new TwentyFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ baseUrl: "not-a-url" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
  });

  it("rejects an unsupported URL scheme (e.g. ftp://)", async () => {
    const handler = new TwentyFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ baseUrl: "ftp://crm.example.com" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
  });

  it("accepts http baseUrl (Twenty self-hosted dev/private network)", async () => {
    const handler = new TwentyFormInstallHandler({ idGenerator: () => "fixed-id" });
    const result = await handler.validateConfig(
      WSID,
      validForm({ baseUrl: "http://localhost:3000" }),
    );
    expect(result.credentialWritten).toBe(true);
  });

  it("rejects an empty apiKey", async () => {
    const handler = new TwentyFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ apiKey: "" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
  });

  it("rejects unknown keys (.strict() schema)", async () => {
    const handler = new TwentyFormInstallHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ extra_field: "nope" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
  });
});

// ---------------------------------------------------------------------------
// SaaS keyset gate
// ---------------------------------------------------------------------------

describe("TwentyFormInstallHandler.validateConfig — SaaS keyset gate", () => {
  it("refuses to install in SaaS mode when no encryption keyset is configured", async () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    clearKeys();
    const handler = new TwentyFormInstallHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(
      /Encryption keyset unavailable/,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("permits install in SaaS mode WHEN a keyset is configured (happy path 2×2 cell)", async () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    // setKeys already ran in beforeEach — keyset is present.
    const handler = new TwentyFormInstallHandler({ idGenerator: () => "saas-ok" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.credentialWritten).toBe(true);
  });

  it("permits install in self-hosted mode even without a keyset (dev convenience)", async () => {
    delete process.env.ATLAS_DEPLOY_MODE;
    clearKeys();
    const handler = new TwentyFormInstallHandler({ idGenerator: () => "fixed-id" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.credentialWritten).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Happy path — dual-store write
// ---------------------------------------------------------------------------

describe("TwentyFormInstallHandler.validateConfig — happy path", () => {
  it("writes the encrypted api_key into twenty_integrations", async () => {
    const handler = new TwentyFormInstallHandler({ idGenerator: () => "fixed-id" });
    await handler.validateConfig(WSID, validForm());

    const calls = mockInternalQuery.mock.calls;
    const twentyInsert = calls.find((c) =>
      String(c[0]).includes("INSERT INTO twenty_integrations"),
    );
    expect(twentyInsert).toBeDefined();
    const params = twentyInsert![1] as unknown[];
    expect(params[0]).toBe(WSID);
    expect(params[1]).toBe("https://crm.example.com");
    // params[2] is the encrypted apiKey — assert it's prefixed enc:v
    // (round-trips through real `db/secret-encryption.ts`) AND that the
    // plaintext does not leak into the SQL params.
    const ciphertext = params[2] as string;
    expect(ciphertext.startsWith("enc:v")).toBe(true);
    expect(ciphertext).not.toContain("twenty-bearer-token-abc123");
  });

  it("upserts workspace_plugins with the catalog binding (no credentials in config)", async () => {
    const handler = new TwentyFormInstallHandler({ idGenerator: () => "candidate-id" });
    const result = await handler.validateConfig(WSID, validForm());

    const calls = mockInternalQuery.mock.calls;
    const pluginInsert = calls.find((c) =>
      String(c[0]).includes("INSERT INTO workspace_plugins"),
    );
    expect(pluginInsert).toBeDefined();
    const params = pluginInsert![1] as unknown[];
    expect(params[1]).toBe(WSID);
    expect(params[2]).toBe("catalog:twenty");
    // Config blob is empty — credentials are in twenty_integrations,
    // not workspace_plugins.config.
    expect(JSON.parse(params[3] as string)).toEqual({});
    expect(result.installRecord.catalogId).toBe("twenty");
    expect(result.installRecord.id).toBe("candidate-id");
    expect(result.credentialWritten).toBe(true);
  });

  it("uses the RETURNING id from workspace_plugins on conflict", async () => {
    // Simulate ON CONFLICT path returning a different (existing) id.
    mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO twenty_integrations")) {
        return [
          {
            workspace_id: params?.[0],
            base_url: params?.[1],
            updated_at: "2026-05-26T00:00:00.000Z",
          },
        ];
      }
      if (sql.includes("INSERT INTO workspace_plugins")) {
        return [{ id: "existing-row-id" }];
      }
      return [];
    });
    const handler = new TwentyFormInstallHandler({ idGenerator: () => "freshly-generated" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord.id).toBe("existing-row-id");
  });
});

// ---------------------------------------------------------------------------
// RETURNING-id invariant — fail loud when the workspace_plugins upsert
// emits no row (#2808). The twenty_integrations credential write lands
// first; only the catalog-binding upsert is driven into the anomaly path,
// so an anomaly here must surface as a 500 rather than silently falling
// back to candidateId (which returned a WRONG id on the DO UPDATE path).
// ---------------------------------------------------------------------------

describe("TwentyFormInstallHandler.validateConfig — RETURNING invariant", () => {
  // Credential row always lands so the handler reaches the catalog
  // upsert; the workspace_plugins branch is what we drive into the
  // anomaly path below.
  function twentyRow(params?: unknown[]): Record<string, unknown> {
    return {
      workspace_id: params?.[0],
      base_url: params?.[1],
      updated_at: "2026-05-26T00:00:00.000Z",
    };
  }

  it("throws when the workspace_plugins upsert returns no row", async () => {
    mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO twenty_integrations")) return [twentyRow(params)];
      return [];
    });
    const handler = new TwentyFormInstallHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(
      /upsert returned no id/,
    );
  });

  it("throws when the returned id is an empty string", async () => {
    mockInternalQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO twenty_integrations")) return [twentyRow(params)];
      if (sql.includes("INSERT INTO workspace_plugins")) return [{ id: "" }];
      return [];
    });
    const handler = new TwentyFormInstallHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(
      /upsert returned no id/,
    );
  });
});
