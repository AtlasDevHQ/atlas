/**
 * Tests for {@link OpenApiGenericFormInstallHandler} (PRD #2868 slice 2, #2926).
 *
 * Mirrors `obsidian-form-handler.test.ts`: validation rejection emits
 * {@link FormInstallValidationError} with per-field detail; the happy path probes
 * the spec, caches the snapshot, encrypts ONLY `auth_value` (AC3), and inserts a
 * multi-instance `datasource`-pillar `workspace_plugins` row. The spec probe is
 * driven by an injected `fetchImpl` so the test never touches the network.
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

const WSID = "ws-openapi-1" as WorkspaceId;

type HandlerCtor = typeof import("../openapi-generic-form-handler").OpenApiGenericFormInstallHandler;
type FormErrCtor = typeof import("../email-form-handler").FormInstallValidationError;
let OpenApiGenericFormInstallHandler!: HandlerCtor;
let FormInstallValidationError!: FormErrCtor;

beforeAll(async () => {
  OpenApiGenericFormInstallHandler = (await import("../openapi-generic-form-handler")).OpenApiGenericFormInstallHandler;
  FormInstallValidationError = (await import("../email-form-handler")).FormInstallValidationError;
});

const ORIGINAL_ENV = { ...process.env };

/** A tiny OpenAPI 3.1 doc the injected fetch returns for the probe. */
const SPEC = {
  openapi: "3.1.0",
  info: { title: "Widget API", version: "2.0.0" },
  servers: [{ url: "https://widgets.example.com/api" }],
  paths: {
    "/widgets": { get: { operationId: "listWidgets", responses: { "200": { description: "OK" } } } },
  },
};

/** A `fetch` that serves SPEC for any URL, capturing the headers it was called with. */
function makeProbeFetch(): { fetchImpl: typeof globalThis.fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    calls.push({ url, headers });
    return new Response(JSON.stringify(SPEC), { status: 200, headers: { "content-type": "application/json" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fetch stub
  }) as any;
  return { fetchImpl, calls };
}

function setKeys(): void {
  process.env.ATLAS_ENCRYPTION_KEYS = "v1:test-key-for-openapi-handler-unit-tests-long-enough-32b";
  delete process.env.ATLAS_ENCRYPTION_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.ATLAS_DEPLOY_MODE;
  _resetEncryptionKeyCache();
}

function validForm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi_url: "https://widgets.example.com/openapi.json",
    auth_kind: "bearer",
    auth_value: "secret-bearer-token",
    ...overrides,
  };
}

beforeEach(() => {
  setKeys();
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

function newHandler(overrides: { idGenerator?: () => string; now?: () => string; fetchImpl?: typeof globalThis.fetch } = {}) {
  const probe = overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : makeProbeFetch();
  const fetchImpl = overrides.fetchImpl ?? (probe as ReturnType<typeof makeProbeFetch>).fetchImpl;
  return new OpenApiGenericFormInstallHandler({
    idGenerator: overrides.idGenerator ?? (() => "install-1"),
    now: overrides.now ?? (() => "2026-05-29T00:00:00.000Z"),
    fetchImpl,
  });
}

// ── Validation ──────────────────────────────────────────────────────────────

describe("OpenApiGenericFormInstallHandler — validation", () => {
  it("rejects a missing openapi_url", async () => {
    const handler = newHandler();
    await expect(handler.validateConfig(WSID, { auth_kind: "none" })).rejects.toBeInstanceOf(
      FormInstallValidationError,
    );
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("rejects a malformed openapi_url", async () => {
    const handler = newHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ openapi_url: "not-a-url" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<typeof FormInstallValidationError>).fieldErrors.openapi_url).toBeDefined();
  });

  it("rejects oauth2 (deferred to slice 6) with a field error", async () => {
    const handler = newHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ auth_kind: "oauth2" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<typeof FormInstallValidationError>).fieldErrors.auth_kind).toBeDefined();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });

  it("requires auth_value for a credential-bearing kind", async () => {
    const handler = newHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, { openapi_url: "https://x.com/o.json", auth_kind: "bearer" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<typeof FormInstallValidationError>).fieldErrors.auth_value).toBeDefined();
  });

  it("requires auth_header_name for apikey-header", async () => {
    const handler = newHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ auth_kind: "apikey-header", auth_value: "k" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<typeof FormInstallValidationError>).fieldErrors.auth_header_name).toBeDefined();
  });

  it("rejects a non-array write_allowlist JSON", async () => {
    const handler = newHandler();
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm({ write_allowlist: "{\"not\":\"an array\"}" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<typeof FormInstallValidationError>).fieldErrors.write_allowlist).toBeDefined();
  });

  it("surfaces a probe failure as a field error on openapi_url (no row written)", async () => {
    const failFetch = (async () => new Response("nope", { status: 502 })) as unknown as typeof globalThis.fetch;
    const handler = newHandler({ fetchImpl: failFetch });
    let caught: unknown;
    try {
      await handler.validateConfig(WSID, validForm());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FormInstallValidationError);
    expect((caught as InstanceType<typeof FormInstallValidationError>).fieldErrors.openapi_url).toBeDefined();
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});

// ── Persistence + encryption (AC2 / AC3) ─────────────────────────────────────

describe("OpenApiGenericFormInstallHandler — persistence + encryption", () => {
  it("inserts a multi-instance datasource row with a fresh install_id", async () => {
    const handler = newHandler({ idGenerator: () => "ds-uuid-1" });
    const result = await handler.validateConfig(WSID, validForm());
    expect(result.installRecord).toEqual({ id: "ds-uuid-1", workspaceId: WSID, catalogId: "openapi-generic" });
    expect(result.credentialWritten).toBe(true);
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockInternalQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO workspace_plugins");
    expect(sql).toContain("'datasource'");
    expect(sql).toContain("'draft'");
    // id AND install_id are the same fresh uuid ($1 used for both columns).
    expect((params as unknown[])[0]).toBe("ds-uuid-1");
    expect((params as unknown[])[1]).toBe(WSID);
    expect((params as unknown[])[2]).toBe("catalog:openapi-generic");
  });

  it("encrypts auth_value at rest (never plaintext in config) and round-trips", async () => {
    const handler = newHandler();
    await handler.validateConfig(WSID, validForm({ auth_value: "super-secret-token" }));
    const [, params] = mockInternalQuery.mock.calls[0];
    const stored = JSON.parse((params as unknown[])[3] as string) as Record<string, unknown>;

    expect(typeof stored.auth_value).toBe("string");
    expect(stored.auth_value as string).toMatch(/^enc:v1:/);
    expect(stored.auth_value).not.toBe("super-secret-token");
    expect(decryptSecret(stored.auth_value as string)).toBe("super-secret-token");

    // Non-secret fields stay plaintext (grep-able ops).
    expect(stored.openapi_url).toBe("https://widgets.example.com/openapi.json");
    expect(stored.auth_kind).toBe("bearer");
  });

  it("caches the probed snapshot and defaults to the bake-off-winning mode", async () => {
    const handler = newHandler({ now: () => "2026-05-29T12:00:00.000Z" });
    await handler.validateConfig(WSID, validForm());
    const [, params] = mockInternalQuery.mock.calls[0];
    const stored = JSON.parse((params as unknown[])[3] as string) as Record<string, unknown>;

    expect(stored.representation_mode).toBe("operation-graph");
    const snapshot = stored.openapi_snapshot as { title: string; operationCount: number; probedAt: string; doc: unknown };
    expect(snapshot.title).toBe("Widget API");
    expect(snapshot.operationCount).toBe(1);
    expect(snapshot.probedAt).toBe("2026-05-29T12:00:00.000Z");
    expect(snapshot.doc).toBeDefined();
  });

  it("sends the bearer credential when probing the spec", async () => {
    const probe = makeProbeFetch();
    const handler = new OpenApiGenericFormInstallHandler({
      idGenerator: () => "x",
      now: () => "2026-05-29T00:00:00.000Z",
      fetchImpl: probe.fetchImpl,
    });
    await handler.validateConfig(WSID, validForm({ auth_value: "probe-token" }));
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].headers.Authorization).toBe("Bearer probe-token");
  });

  it("refuses to persist in SaaS mode without an encryption keyset", async () => {
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    _resetEncryptionKeyCache();
    const handler = newHandler();
    await expect(handler.validateConfig(WSID, validForm())).rejects.toThrow(/Encryption keyset unavailable/);
    expect(mockInternalQuery).not.toHaveBeenCalled();
  });
});
