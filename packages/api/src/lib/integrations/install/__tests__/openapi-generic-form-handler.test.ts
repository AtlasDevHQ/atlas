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

// Capture the handler's structured logger so we can assert the non-fatal
// plaintext-credential warning fires (#3012 AC1). Mock EVERY value export of
// the logger module — a partial mock.module() trips "Export not found" on a
// transitive import (CLAUDE.md). Types are erased and need no mock.
const mockLogWarn: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogInfo: Mock<(...args: unknown[]) => void> = mock(() => {});
const mockLogger = {
  warn: mockLogWarn,
  info: mockLogInfo,
  debug: () => {},
  error: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  child: () => mockLogger,
};
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => mockLogger,
  getLogger: () => mockLogger,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  getRequestContext: () => undefined,
  setLogLevel: () => true,
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (obj: Record<string, unknown>) => obj,
  hashShareToken: (token: string) => token.slice(0, 16),
  redactPaths: [] as string[],
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler"] as const,
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
  mockLogWarn.mockClear();
  mockLogInfo.mockClear();
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

  it("sends the bearer credential when the spec host matches the API host (base_url_override)", async () => {
    const probe = makeProbeFetch();
    const handler = new OpenApiGenericFormInstallHandler({
      idGenerator: () => "x",
      now: () => "2026-05-29T00:00:00.000Z",
      fetchImpl: probe.fetchImpl,
    });
    // The credential is attached only when the spec is on the API host (#3034) — a
    // same-host base_url_override (Twenty's posture) makes the gate send it.
    await handler.validateConfig(
      WSID,
      validForm({ auth_value: "probe-token", base_url_override: "https://widgets.example.com/v1" }),
    );
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].headers.Authorization).toBe("Bearer probe-token");
  });

  it("withholds the credential from the spec fetch when no base_url_override is given (#3034)", async () => {
    // Without a base_url_override the API host is unknown at probe time, so the
    // gate fails safe and never sends the workspace credential to the spec host.
    const probe = makeProbeFetch();
    const handler = new OpenApiGenericFormInstallHandler({
      idGenerator: () => "x",
      now: () => "2026-05-29T00:00:00.000Z",
      fetchImpl: probe.fetchImpl,
    });
    await handler.validateConfig(WSID, validForm({ auth_value: "probe-token" }));
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].headers.Authorization).toBeUndefined();
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

// ── Plaintext-credential warning (#3012) ─────────────────────────────────────

describe("OpenApiGenericFormInstallHandler — plaintext-credential warning", () => {
  it("warns (non-fatal) when persisting a credential in a prod-like env with no keyset", async () => {
    // Self-hosted prod-like (NODE_ENV=production, NOT saas) with no keyset: the
    // SaaS hard-fail gate doesn't apply, so the install proceeds — but the
    // operator must be warned that auth_value lands in plaintext at rest.
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_DEPLOY_MODE;
    process.env.NODE_ENV = "production";
    _resetEncryptionKeyCache();

    const handler = newHandler();
    const result = await handler.validateConfig(WSID, validForm());

    // Non-fatal: the row is still written (dev passthrough is intentional parity).
    expect(result.installRecord.id).toBe("install-1");
    expect(mockInternalQuery).toHaveBeenCalledTimes(1);

    // ...but the credential-boundary warning fired, mirroring the boot-time alarm.
    const warned = mockLogWarn.mock.calls.some(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("stored in plaintext"),
    );
    expect(warned).toBe(true);
  });

  it("does not warn when an encryption keyset is configured", async () => {
    // setKeys() (beforeEach) already set ATLAS_ENCRYPTION_KEYS; prod-like but safe.
    process.env.NODE_ENV = "production";
    _resetEncryptionKeyCache();

    const handler = newHandler();
    await handler.validateConfig(WSID, validForm());

    const warnedPlaintext = mockLogWarn.mock.calls.some(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("stored in plaintext"),
    );
    expect(warnedPlaintext).toBe(false);
  });

  it("does not warn for a credential-less install (auth_kind 'none'), even prod-like with no keyset", async () => {
    // The guard is `data.auth_value && isPlaintextCredentialRisk()` — no credential
    // means nothing lands in plaintext, so the warning must stay silent.
    delete process.env.ATLAS_ENCRYPTION_KEYS;
    delete process.env.ATLAS_ENCRYPTION_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_DEPLOY_MODE;
    process.env.NODE_ENV = "production";
    _resetEncryptionKeyCache();

    const handler = newHandler();
    const result = await handler.validateConfig(WSID, validForm({ auth_kind: "none", auth_value: undefined }));

    expect(result.credentialWritten).toBe(false);
    const warnedPlaintext = mockLogWarn.mock.calls.some(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("stored in plaintext"),
    );
    expect(warnedPlaintext).toBe(false);
  });
});

// ── base_url_override SSRF guard (#3006) ──────────────────────────────────────

describe("OpenApiGenericFormInstallHandler — base_url_override SSRF guard", () => {
  it("rejects an internal base_url_override by default — in non-SaaS mode (guard is ON everywhere now)", async () => {
    // setKeys() (beforeEach) already deletes ATLAS_DEPLOY_MODE → self-hosted. The
    // pre-#3006 guard only fired on SaaS; it now fires in every mode unless opted out.
    const handler = newHandler();
    const result = handler.validateConfig(WSID, validForm({ base_url_override: "https://10.0.0.5/v1" }));
    await expect(result).rejects.toBeInstanceOf(FormInstallValidationError);
    await expect(result).rejects.toHaveProperty("fieldErrors.base_url_override");
    expect(mockInternalQuery).not.toHaveBeenCalled(); // install aborted before the insert
  });

  it("accepts an internal base_url_override when the operator opts out (ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS=true)", async () => {
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
    const handler = newHandler();
    const { installRecord } = await handler.validateConfig(
      WSID,
      validForm({ base_url_override: "https://10.0.0.5/v1" }),
    );
    expect(installRecord.id).toBe("install-1");
    expect(mockInternalQuery).toHaveBeenCalled(); // install proceeded to the insert
  });

  it("rejects a PUBLIC but non-HTTPS base_url_override (cleartext-credential downgrade)", async () => {
    // zod's OptionalUrlSchema allows http(s); the egress guard is the only thing
    // that rejects a plaintext-scheme public host — a credential-downgrade risk
    // (the agent would later send a credentialed request in the clear).
    delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    const handler = newHandler();
    const result = handler.validateConfig(WSID, validForm({ base_url_override: "http://public.example.com/v1" }));
    await expect(result).rejects.toBeInstanceOf(FormInstallValidationError);
    await expect(result).rejects.toHaveProperty("fieldErrors.base_url_override");
    expect(mockInternalQuery).not.toHaveBeenCalled(); // aborted before the insert
  });
});
