/**
 * Tests for admin workspace model-config route audit emission.
 *
 * The three write routes (PUT, DELETE, POST /test) each mutate or probe
 * BYOT credential material. The /test route is especially material —
 * without audit emission, an attacker with admin credentials can replay
 * stolen apiKeys against it and read the pass/fail from the response body
 * with zero forensic trail. These tests lock in the audit shape, including
 * the redaction invariant that apiKey / baseUrl values never leak into
 * metadata.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { Effect } from "effect";
import { createApiTestMocks } from "@atlas/api/testing/api-test-mocks";

// --- Unified mocks with admin user in org-1 ---

const mocks = createApiTestMocks({
  authUser: {
    id: "admin-1",
    mode: "managed",
    label: "admin@test.com",
    role: "admin",
    activeOrganizationId: "org-1",
  },
  authMode: "managed",
});

// --- Enterprise gate: flip the env var so the real `isEnterpriseEnabled`
// resolves true without reshaping the whole `@atlas/ee/index` surface. ---
process.env.ATLAS_ENTERPRISE_ENABLED = "true";

// --- EE model-routing mocks. Return Effect values matching the real
// signatures so `yield*` unwraps them in the handler. ---

class MockModelConfigError extends Error {
  public readonly _tag = "ModelConfigError" as const;
  public readonly code: "validation" | "not_found" | "test_failed";
  constructor(message: string, code: "validation" | "not_found" | "test_failed") {
    super(message);
    this.name = "ModelConfigError";
    this.code = code;
  }
}

class MockModelConfigDecryptError extends Error {
  public readonly _tag = "ModelConfigDecryptError" as const;
  public readonly configId: string;
  public readonly cause: string;
  constructor(args: { configId: string; cause: string }) {
    super(`Failed to decrypt key for ${args.configId}`);
    this.name = "ModelConfigDecryptError";
    this.configId = args.configId;
    this.cause = args.cause;
  }
}

const mockGetWorkspaceModelConfig: Mock<(orgId: string) => unknown> = mock(() =>
  Effect.succeed(null),
);
const mockGetWorkspaceModelConfigRaw: Mock<(orgId: string) => unknown> = mock(
  () => Effect.succeed(null),
);
const mockSetWorkspaceModelConfig: Mock<(...args: unknown[]) => unknown> = mock(
  () =>
    Effect.succeed({
      id: "cfg-1",
      orgId: "org-1",
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKeyMasked: "************7890",
      apiKeyStatus: "masked",
      baseUrl: null,
      createdAt: "2026-04-23T00:00:00Z",
      updatedAt: "2026-04-23T00:00:00Z",
    }),
);
const mockDeleteWorkspaceModelConfig: Mock<(orgId: string) => unknown> = mock(
  () => Effect.succeed(true),
);
const mockTestModelConfig: Mock<(...args: unknown[]) => unknown> = mock(() =>
  Effect.succeed({
    success: true,
    message: "Connection successful.",
    modelName: "claude-opus-4-6",
  }),
);

const mockReconcileModelDeprecation: Mock<(...args: unknown[]) => unknown> = mock(
  () => Effect.succeed({ status: "healthy" as const, suggestion: null }),
);

// Build a `RawWorkspaceModelConfig` from the legacy
// `{ provider, apiKey, bedrockRegion?, baseUrl }` test shape. The
// post-#2282 route consumes the typed `credentials` union — tests still
// describe the row in the old terms for readability, and this helper
// is the single place the union gets constructed for fixtures. For
// bedrock the bundle parses up-front; a malformed JSON apiKey yields
// `bundle: null`, which `extractCred` maps to `malformed_bedrock_bundle`.
function rawConfigFromLegacy(legacy: {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  bedrockRegion?: string | null;
}) {
  const baseUrl = legacy.baseUrl ?? null;
  const bedrockRegion = legacy.bedrockRegion ?? null;
  if (legacy.provider === "bedrock") {
    let bundle: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null =
      null;
    if (legacy.apiKey !== null) {
      try {
        const parsed = JSON.parse(legacy.apiKey) as Record<string, unknown>;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.accessKeyId === "string" &&
          typeof parsed.secretAccessKey === "string"
        ) {
          bundle = {
            accessKeyId: parsed.accessKeyId,
            secretAccessKey: parsed.secretAccessKey,
            ...(typeof parsed.sessionToken === "string" && parsed.sessionToken.length > 0
              ? { sessionToken: parsed.sessionToken }
              : {}),
          };
        }
      } catch {
        bundle = null;
      }
    }
    return {
      provider: "bedrock" as const,
      model: legacy.model,
      baseUrl,
      bedrockRegion,
      credentials: { provider: "bedrock" as const, bundle },
    };
  }
  if (legacy.provider === "gateway") {
    return {
      provider: "gateway" as const,
      model: legacy.model,
      baseUrl,
      bedrockRegion,
      credentials: { provider: "gateway" as const, apiKey: legacy.apiKey },
    };
  }
  return {
    provider: legacy.provider,
    model: legacy.model,
    baseUrl,
    bedrockRegion,
    credentials: { provider: legacy.provider, apiKey: legacy.apiKey ?? "" },
  };
}

mock.module("@atlas/ee/platform/model-routing", () => ({
  getWorkspaceModelConfig: mockGetWorkspaceModelConfig,
  getWorkspaceModelConfigRaw: mockGetWorkspaceModelConfigRaw,
  setWorkspaceModelConfig: mockSetWorkspaceModelConfig,
  deleteWorkspaceModelConfig: mockDeleteWorkspaceModelConfig,
  testModelConfig: mockTestModelConfig,
  reconcileModelDeprecation: mockReconcileModelDeprecation,
  ModelConfigError: MockModelConfigError,
  ModelConfigDecryptError: MockModelConfigDecryptError,
}));

// --- Audit capture: use the real ADMIN_ACTIONS catalog so route emissions
// bind to the canonical string values. ---

interface CapturedAuditEntry {
  actionType: string;
  targetType: string;
  targetId: string;
  status?: "success" | "failure";
  metadata?: Record<string, unknown>;
  scope?: "platform" | "workspace";
  ipAddress?: string | null;
}

const mockLogAdminAction: Mock<(entry: CapturedAuditEntry) => void> = mock(
  () => {},
);

mock.module("@atlas/api/lib/audit", async () => {
  const actual = await import("@atlas/api/lib/audit/actions");
  return {
    logAdminAction: mockLogAdminAction,
    logAdminActionAwait: mock(async () => {}),
    ADMIN_ACTIONS: actual.ADMIN_ACTIONS,
  };
});

// --- Anthropic catalog mocks. Real module is HTTP-bound; mock it so the
// /catalog?provider=anthropic route flow is unit-testable. Mirrors every
// named export the route currently imports (mock.module is all-or-nothing).
class MockAnthropicCatalogUnauthorized extends Error {
  readonly _tag = "AnthropicCatalogUnauthorized" as const;
  constructor(message: string) {
    super(message);
    this.name = "AnthropicCatalogUnauthorized";
  }
}
class MockAnthropicCatalogRateLimited extends Error {
  readonly _tag = "AnthropicCatalogRateLimited" as const;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "AnthropicCatalogRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
class MockAnthropicCatalogUnavailable extends Error {
  readonly _tag = "AnthropicCatalogUnavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "AnthropicCatalogUnavailable";
  }
}

const mockGetAnthropicCatalog: Mock<(...args: unknown[]) => unknown> = mock(
  async () => ({
    models: [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        type: "language",
        contextWindow: null,
        maxOutputTokens: null,
        inputPrice: null,
        outputPrice: null,
        recommended: true,
      },
    ],
    fetchedAt: "2026-05-11T00:00:00.000Z",
    source: "fresh" as const,
  }),
);
const mockInvalidateAnthropicCatalog: Mock<(orgId: string) => void> = mock(
  () => {},
);

mock.module("@atlas/api/lib/anthropic-catalog", () => ({
  getAnthropicCatalog: mockGetAnthropicCatalog,
  invalidateAnthropicCatalog: mockInvalidateAnthropicCatalog,
  AnthropicCatalogUnauthorized: MockAnthropicCatalogUnauthorized,
  AnthropicCatalogRateLimited: MockAnthropicCatalogRateLimited,
  AnthropicCatalogUnavailable: MockAnthropicCatalogUnavailable,
}));

// --- OpenAI catalog mocks (mirror Anthropic — same threat model + envelope). ---
class MockOpenAICatalogUnauthorized extends Error {
  readonly _tag = "OpenAICatalogUnauthorized" as const;
  constructor(message: string) {
    super(message);
    this.name = "OpenAICatalogUnauthorized";
  }
}
class MockOpenAICatalogRateLimited extends Error {
  readonly _tag = "OpenAICatalogRateLimited" as const;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "OpenAICatalogRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
class MockOpenAICatalogUnavailable extends Error {
  readonly _tag = "OpenAICatalogUnavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "OpenAICatalogUnavailable";
  }
}

const mockGetOpenAICatalog: Mock<(...args: unknown[]) => unknown> = mock(
  async () => ({
    models: [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        provider: "openai",
        type: "language",
        contextWindow: null,
        maxOutputTokens: null,
        inputPrice: null,
        outputPrice: null,
        recommended: true,
      },
    ],
    fetchedAt: "2026-05-11T00:00:00.000Z",
    source: "fresh" as const,
  }),
);
const mockInvalidateOpenAICatalog: Mock<(orgId: string) => void> = mock(
  () => {},
);

mock.module("@atlas/api/lib/openai-catalog", () => ({
  getOpenAICatalog: mockGetOpenAICatalog,
  invalidateOpenAICatalog: mockInvalidateOpenAICatalog,
  OpenAICatalogUnauthorized: MockOpenAICatalogUnauthorized,
  OpenAICatalogRateLimited: MockOpenAICatalogRateLimited,
  OpenAICatalogUnavailable: MockOpenAICatalogUnavailable,
}));

// --- Bedrock catalog mocks (mirror Anthropic + OpenAI; different cred shape). ---
class MockBedrockCatalogUnauthorized extends Error {
  readonly _tag = "BedrockCatalogUnauthorized" as const;
  constructor(message: string) {
    super(message);
    this.name = "BedrockCatalogUnauthorized";
  }
}
class MockBedrockCatalogRateLimited extends Error {
  readonly _tag = "BedrockCatalogRateLimited" as const;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "BedrockCatalogRateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
class MockBedrockCatalogUnavailable extends Error {
  readonly _tag = "BedrockCatalogUnavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "BedrockCatalogUnavailable";
  }
}

const mockGetBedrockCatalog: Mock<(...args: unknown[]) => unknown> = mock(
  async () => ({
    models: [
      {
        id: "anthropic.claude-opus-4-v1:0",
        name: "Claude Opus 4",
        provider: "anthropic",
        type: "language",
        contextWindow: null,
        maxOutputTokens: null,
        inputPrice: null,
        outputPrice: null,
        recommended: true,
      },
    ],
    fetchedAt: "2026-05-11T00:00:00.000Z",
    source: "fresh" as const,
    region: "us-east-1" as const,
  }),
);
const mockInvalidateBedrockCatalog: Mock<(orgId: string) => void> = mock(
  () => {},
);

mock.module("@atlas/api/lib/bedrock-catalog", () => ({
  getBedrockCatalog: mockGetBedrockCatalog,
  invalidateBedrockCatalog: mockInvalidateBedrockCatalog,
  BedrockCatalogUnauthorized: MockBedrockCatalogUnauthorized,
  BedrockCatalogRateLimited: MockBedrockCatalogRateLimited,
  BedrockCatalogUnavailable: MockBedrockCatalogUnavailable,
}));

// --- Import the app AFTER all mocks ---
const { app } = await import("../index");

afterAll(() => mocks.cleanup());

function adminRequest(method: string, path: string, body?: unknown): Request {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, opts);
}

function lastAuditCall(): CapturedAuditEntry {
  const calls = mockLogAdminAction.mock.calls;
  if (calls.length === 0) throw new Error("logAdminAction was not called");
  return calls[calls.length - 1]![0]!;
}

beforeEach(() => {
  mocks.hasInternalDB = true;
  mockLogAdminAction.mockClear();
  mockGetWorkspaceModelConfig.mockClear();
  mockGetWorkspaceModelConfigRaw.mockClear();
  mockSetWorkspaceModelConfig.mockClear();
  mockDeleteWorkspaceModelConfig.mockClear();
  mockTestModelConfig.mockClear();
  mockReconcileModelDeprecation.mockClear();
  mockReconcileModelDeprecation.mockImplementation(() =>
    Effect.succeed({ status: "healthy" as const, suggestion: null }),
  );

  mockGetWorkspaceModelConfig.mockImplementation(() => Effect.succeed(null));
  mockGetWorkspaceModelConfigRaw.mockImplementation(() => Effect.succeed(null));
  mockGetAnthropicCatalog.mockClear();
  mockInvalidateAnthropicCatalog.mockClear();
  mockGetAnthropicCatalog.mockImplementation(async () => ({
    models: [
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        type: "language",
        contextWindow: null,
        maxOutputTokens: null,
        inputPrice: null,
        outputPrice: null,
        recommended: true,
      },
    ],
    fetchedAt: "2026-05-11T00:00:00.000Z",
    source: "fresh" as const,
  }));
  mockGetOpenAICatalog.mockClear();
  mockInvalidateOpenAICatalog.mockClear();
  mockGetBedrockCatalog.mockClear();
  mockInvalidateBedrockCatalog.mockClear();
  mockGetBedrockCatalog.mockImplementation(async () => ({
    models: [
      {
        id: "anthropic.claude-opus-4-v1:0",
        name: "Claude Opus 4",
        provider: "anthropic",
        type: "language",
        contextWindow: null,
        maxOutputTokens: null,
        inputPrice: null,
        outputPrice: null,
        recommended: true,
      },
    ],
    fetchedAt: "2026-05-11T00:00:00.000Z",
    source: "fresh" as const,
    region: "us-east-1" as const,
  }));
  mockGetOpenAICatalog.mockImplementation(async () => ({
    models: [
      {
        id: "gpt-4o",
        name: "gpt-4o",
        provider: "openai",
        type: "language",
        contextWindow: null,
        maxOutputTokens: null,
        inputPrice: null,
        outputPrice: null,
        recommended: true,
      },
    ],
    fetchedAt: "2026-05-11T00:00:00.000Z",
    source: "fresh" as const,
  }));
  mockSetWorkspaceModelConfig.mockImplementation(() =>
    Effect.succeed({
      id: "cfg-1",
      orgId: "org-1",
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKeyMasked: "************7890",
      apiKeyStatus: "masked",
      baseUrl: null,
      createdAt: "2026-04-23T00:00:00Z",
      updatedAt: "2026-04-23T00:00:00Z",
    }),
  );
  mockDeleteWorkspaceModelConfig.mockImplementation(() => Effect.succeed(true));
  mockTestModelConfig.mockImplementation(() =>
    Effect.succeed({
      success: true,
      message: "Connection successful.",
      modelName: "claude-opus-4-6",
    }),
  );
});

// ---------------------------------------------------------------------------
// PUT /api/v1/admin/model-config
// ---------------------------------------------------------------------------

describe("audit emission — PUT /api/v1/admin/model-config", () => {
  it("emits model_config.update with provider/model + hasSecret marker", async () => {
    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-super-secret-live-value-99",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.update");
    expect(entry.targetType).toBe("model_config");
    expect(entry.scope ?? "workspace").toBe("workspace");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      hasSecret: true,
    });
  });

  it("never includes the apiKey value in metadata", async () => {
    const apiKey = "sk-ant-super-secret-live-value-99";
    await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey,
      }),
    );
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    const serialized = JSON.stringify(entry);
    // Redaction invariant: the live apiKey value MUST NOT appear anywhere.
    expect(serialized).not.toContain(apiKey);
    expect(entry.metadata).not.toHaveProperty("apiKey");
    expect(entry.metadata).not.toHaveProperty("password");
    expect(entry.metadata).not.toHaveProperty("secret");
    expect(entry.metadata).not.toHaveProperty("secretAccessKey");
  });

  it("does not leak baseUrl into audit metadata (self-hosted endpoint disclosure)", async () => {
    // Self-hosted OpenAI-compatible deployments supply `baseUrl`. Even if
    // it's not a "secret" by the strict definition, an internal URL in
    // the audit trail leaks infrastructure topology (VPN endpoints,
    // internal DNS names) — keep it out.
    const internalBaseUrl = "https://llm.internal.corp.example/v1";
    await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "custom",
        model: "custom-llm",
        apiKey: "sk-anything",
        baseUrl: internalBaseUrl,
      }),
    );
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(JSON.stringify(entry)).not.toContain(internalBaseUrl);
    expect(entry.metadata).not.toHaveProperty("baseUrl");
  });

  it("records hasSecret:false when apiKey is omitted (key-preservation path)", async () => {
    // Caller submits an update WITHOUT apiKey → server keeps the existing
    // encrypted key. The audit row must mark this case distinctly so
    // forensic queries can separate rotations from metadata-only edits.
    mockGetWorkspaceModelConfig.mockImplementation(() =>
      Effect.succeed({
        id: "cfg-1",
        orgId: "org-1",
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKeyMasked: "************7890",
        apiKeyStatus: "masked",
        baseUrl: null,
        createdAt: "2026-04-23T00:00:00Z",
        updatedAt: "2026-04-23T00:00:00Z",
      }),
    );

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "anthropic",
        model: "claude-opus-4-7",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-7",
      hasSecret: false,
    });
  });

  it("provider=gateway with no apiKey succeeds on initial create (platform credits)", async () => {
    // The route gates "API key required" by `body.provider !== "gateway"`.
    // Gateway-on-platform-credits is the one legitimate apiKey-less initial
    // create — if this regresses, SaaS users lose access to platform credits.
    mockGetWorkspaceModelConfig.mockImplementation(() => Effect.succeed(null));
    mockSetWorkspaceModelConfig.mockImplementation(() =>
      Effect.succeed({
        id: "cfg-1",
        orgId: "org-1",
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
        apiKeyMasked: null,
        apiKeyStatus: "platform_credits",
        baseUrl: null,
        createdAt: "2026-04-23T00:00:00Z",
        updatedAt: "2026-04-23T00:00:00Z",
      }),
    );

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
      }),
    );
    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({
      provider: "gateway",
      model: "anthropic/claude-opus-4.6",
      hasSecret: false,
    });
  });

  it("provider=anthropic with no apiKey on initial create returns 400 (BYOT contract)", async () => {
    mockGetWorkspaceModelConfig.mockImplementation(() => Effect.succeed(null));

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(res.status).toBe(400);
    // Pre-handler rejection — no audit row.
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("provider=anthropic with no apiKey rejects when existing config is gateway-on-platform-credits", async () => {
    // Provider-transition guard: existing row is gateway-null (no key to
    // preserve). Switching to anthropic without supplying a key would COALESCE
    // null forward and trip the chk_model_provider_key DB constraint with an
    // opaque 23514 — route must surface a clean 400 instead.
    mockGetWorkspaceModelConfig.mockImplementation(() =>
      Effect.succeed({
        id: "cfg-1",
        orgId: "org-1",
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
        apiKeyMasked: null,
        apiKeyStatus: "platform_credits",
        baseUrl: null,
        createdAt: "2026-04-23T00:00:00Z",
        updatedAt: "2026-04-23T00:00:00Z",
      }),
    );

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockSetWorkspaceModelConfig).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("emits model_config.update with status=failure when set throws", async () => {
    mockSetWorkspaceModelConfig.mockImplementation(() =>
      Effect.fail(new MockModelConfigError("encryption failed", "validation")),
    );

    const res = await app.fetch(
      adminRequest("PUT", "/api/v1/admin/model-config", {
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-oops",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.update");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      hasSecret: true,
    });
    expect(entry.metadata!.error).toContain("encryption failed");
    expect(JSON.stringify(entry)).not.toContain("sk-ant-oops");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/model-config
// ---------------------------------------------------------------------------

describe("audit emission — DELETE /api/v1/admin/model-config", () => {
  it("emits model_config.delete on success", async () => {
    const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/model-config"));
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.delete");
    expect(entry.targetType).toBe("model_config");
    expect(entry.scope ?? "workspace").toBe("workspace");
    expect(entry.status ?? "success").toBe("success");
    // DELETE metadata intentionally empty — the actor/org context already
    // identifies the target via the audit row's actor_id/org_id columns.
    expect(entry.metadata ?? {}).toEqual({});
  });

  it("does not emit audit when no config existed (404 short-circuit)", async () => {
    mockDeleteWorkspaceModelConfig.mockImplementation(() => Effect.succeed(false));
    const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/model-config"));
    expect(res.status).toBe(404);
    // No-op delete → no state change → no audit row. Matches the
    // pre-handler-rejection pattern used on unknown-target writes.
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("emits model_config.delete with status=failure when deleteWorkspaceModelConfig fails", async () => {
    mockDeleteWorkspaceModelConfig.mockImplementation(() =>
      Effect.fail(new MockModelConfigError("internal DB unreachable", "validation")),
    );
    const res = await app.fetch(adminRequest("DELETE", "/api/v1/admin/model-config"));
    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.delete");
    expect(entry.status).toBe("failure");
    expect(entry.metadata!.error).toContain("internal DB unreachable");
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/model-config/test
// ---------------------------------------------------------------------------

describe("audit emission — POST /api/v1/admin/model-config/test", () => {
  it("emits model_config.test with success:true on passing probe", async () => {
    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/model-config/test", {
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-live-key-for-test-oracle",
      }),
    );
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.test");
    expect(entry.targetType).toBe("model_config");
    expect(entry.scope ?? "workspace").toBe("workspace");
    expect(entry.status ?? "success").toBe("success");
    expect(entry.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      success: true,
    });
    // The credential-oracle threat: the apiKey value must NOT land in the
    // audit trail even though the handler reads it from the body.
    expect(JSON.stringify(entry)).not.toContain("sk-ant-live-key-for-test-oracle");
    expect(entry.metadata).not.toHaveProperty("apiKey");
  });

  it("emits model_config.test with success:false and status=failure on failing probe", async () => {
    // Deny-by-default for the /test route: without this emission an
    // attacker replays stolen keys and reads auth failures from the response
    // body. Make failing probes loud.
    mockTestModelConfig.mockImplementation(() =>
      Effect.succeed({
        success: false,
        message: "Connection test failed: invalid API key",
      }),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/model-config/test", {
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-stolen-and-revoked",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);

    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.test");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      success: false,
    });
    // Even on failure, the apiKey value must not leak.
    expect(JSON.stringify(entry)).not.toContain("sk-ant-stolen-and-revoked");
  });

  it("emits model_config.test with status=failure when validate rejects (422)", async () => {
    mockTestModelConfig.mockImplementation(() =>
      Effect.fail(new MockModelConfigError("invalid provider", "validation")),
    );

    const res = await app.fetch(
      adminRequest("POST", "/api/v1/admin/model-config/test", {
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-probe",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.test");
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(JSON.stringify(entry)).not.toContain("sk-ant-probe");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/model-config/catalog?provider=anthropic
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/model-config/catalog?provider=anthropic", () => {
  it("returns the workspace's anthropic catalog using the stored BYOT key", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-stored-key",
        baseUrl: null,
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: { id: string }[];
      fetchedAt: string;
      fallback: boolean;
    };
    expect(body.models).toHaveLength(1);
    expect(body.models[0].id).toBe("claude-opus-4-6");
    expect(body.fallback).toBe(false);
    // Verify the catalog was called with the workspace's stored key.
    expect(mockGetAnthropicCatalog).toHaveBeenCalledTimes(1);
    const args = mockGetAnthropicCatalog.mock.calls[0]! as unknown as [
      string,
      string,
      { refresh?: boolean } | undefined,
    ];
    expect(args[1]).toBe("sk-ant-stored-key");
    expect(args[2]).toEqual({ refresh: false });
  });

  it("passes ?refresh=1 through to bypass the cache", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-stored-key",
        baseUrl: null,
      })),
    );
    const res = await app.fetch(
      adminRequest(
        "GET",
        "/api/v1/admin/model-config/catalog?provider=anthropic&refresh=1",
      ),
    );
    expect(res.status).toBe(200);
    const args = mockGetAnthropicCatalog.mock.calls[0]! as unknown as [
      string,
      string,
      { refresh?: boolean } | undefined,
    ];
    expect(args[2]).toEqual({ refresh: true });
  });

  it("returns 400 missing_byot_key when no anthropic config exists", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() => Effect.succeed(null));
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_byot_key");
    // Do NOT emit a successful catalog-refresh audit when the precondition
    // fails — there's no key in play, so no credential-oracle risk.
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });

  it("returns 400 missing_byot_key when saved provider is not anthropic", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-openai-stored",
        baseUrl: null,
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_byot_key");
  });

  it("returns 422 decrypt_failed when the stored key cannot be decrypted", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.fail(
        new MockModelConfigDecryptError({
          configId: "cfg-1",
          cause: "wrong key version",
        }),
      ),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("decrypt_failed");
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(lastAuditCall().status).toBe("failure");
    expect(lastAuditCall().metadata).toMatchObject({
      provider: "anthropic",
      error: "decrypt_failed",
    });
  });

  it("returns 401 byot_key_invalid when Anthropic rejects the key", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-rotten",
        baseUrl: null,
      })),
    );
    mockGetAnthropicCatalog.mockImplementation(() => {
      throw new MockAnthropicCatalogUnauthorized("rejected by anthropic");
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_key_invalid");
    const entry = lastAuditCall();
    expect(entry.status).toBe("failure");
    expect(entry.metadata).toMatchObject({
      provider: "anthropic",
      error: "byot_key_invalid",
    });
    // The apiKey must never appear in any captured audit metadata.
    expect(JSON.stringify(entry)).not.toContain("sk-ant-rotten");
  });

  it("returns 429 with Retry-After when Anthropic rate-limits the workspace", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-stored",
        baseUrl: null,
      })),
    );
    mockGetAnthropicCatalog.mockImplementation(() => {
      throw new MockAnthropicCatalogRateLimited("slow down", 45);
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_provider_rate_limited");
  });

  it("returns 503 byot_provider_unavailable on upstream outage", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-stored",
        baseUrl: null,
      })),
    );
    mockGetAnthropicCatalog.mockImplementation(() => {
      throw new MockAnthropicCatalogUnavailable("anthropic returned 503");
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_provider_unavailable");
  });

  it("emits model_config.catalog_refresh on success with provider + modelCount + source", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-stored",
        baseUrl: null,
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=anthropic"),
    );
    expect(res.status).toBe(200);
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.catalog_refresh");
    expect(entry.targetType).toBe("model_config");
    expect(entry.metadata).toEqual({
      provider: "anthropic",
      modelCount: 1,
      source: "fresh",
    });
    // The apiKey must never appear in any captured audit metadata.
    expect(JSON.stringify(entry)).not.toContain("sk-ant-stored");
  });

  it("?provider=gateway and the default still return the gateway catalog (backward compat)", async () => {
    // Default path (no provider param) — should hit the gateway catalog flow,
    // not touch getWorkspaceModelConfigRaw or getAnthropicCatalog.
    const res = await app.fetch(adminRequest("GET", "/api/v1/admin/model-config/catalog"));
    // The real `getGatewayCatalog` is invoked here — it'll either reach the
    // gateway (test env: false) or fall back to the bundled subset. Either
    // way we get a 200 with `fallback: true|false`.
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { fallback: boolean };
      expect(typeof body.fallback).toBe("boolean");
    }
    expect(mockGetWorkspaceModelConfigRaw).not.toHaveBeenCalled();
    expect(mockGetAnthropicCatalog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/model-config/catalog?provider=openai (#2272)
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/model-config/catalog?provider=openai", () => {
  it("returns the workspace's openai catalog using the stored BYOT key", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-oai-stored",
        baseUrl: null,
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=openai"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: { id: string; provider: string }[];
      fallback: boolean;
    };
    expect(body.models[0].id).toBe("gpt-4o");
    expect(body.models[0].provider).toBe("openai");
    expect(body.fallback).toBe(false);
    expect(mockGetOpenAICatalog).toHaveBeenCalledTimes(1);
    const args = mockGetOpenAICatalog.mock.calls[0]! as unknown as [
      string,
      string,
      { refresh?: boolean } | undefined,
    ];
    expect(args[1]).toBe("sk-oai-stored");
    expect(args[2]).toEqual({ refresh: false });
  });

  it("returns 400 missing_byot_key when saved provider is not openai", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "anthropic",
        model: "claude-opus-4-6",
        apiKey: "sk-ant-stored",
        baseUrl: null,
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=openai"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("missing_byot_key");
    expect(body.message).toMatch(/openai/i);
  });

  it("returns 422 decrypt_failed when the stored openai key cannot be decrypted", async () => {
    // Parallel pin to the bedrock + anthropic decrypt-failure tests —
    // shared route path, easy to regress if only one provider
    // exercises it.
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.fail(
        new MockModelConfigDecryptError({
          configId: "cfg-openai-1",
          cause: "wrong key version",
        }),
      ),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=openai"),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("decrypt_failed");
    expect(lastAuditCall().metadata).toMatchObject({
      provider: "openai",
      error: "decrypt_failed",
    });
  });

  it("returns 401 byot_key_invalid when OpenAI rejects the key", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-oai-rotten",
        baseUrl: null,
      })),
    );
    mockGetOpenAICatalog.mockImplementation(() => {
      throw new MockOpenAICatalogUnauthorized("rejected by openai");
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=openai"),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_key_invalid");
    const entry = lastAuditCall();
    expect(entry.metadata).toMatchObject({ provider: "openai", error: "byot_key_invalid" });
    // apiKey must never appear in audit metadata.
    expect(JSON.stringify(entry)).not.toContain("sk-oai-rotten");
  });

  it("returns 429 with Retry-After when OpenAI rate-limits the workspace", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-oai-stored",
        baseUrl: null,
      })),
    );
    mockGetOpenAICatalog.mockImplementation(() => {
      throw new MockOpenAICatalogRateLimited("slow down", 90);
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=openai"),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("90");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_provider_rate_limited");
  });

  it("returns 503 byot_provider_unavailable on upstream outage", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-oai-stored",
        baseUrl: null,
      })),
    );
    mockGetOpenAICatalog.mockImplementation(() => {
      throw new MockOpenAICatalogUnavailable("openai returned 503");
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=openai"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_provider_unavailable");
  });

  it("emits model_config.catalog_refresh with provider:'openai' on success", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-oai-stored",
        baseUrl: null,
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=openai"),
    );
    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.catalog_refresh");
    expect(entry.metadata).toEqual({
      provider: "openai",
      modelCount: 1,
      source: "fresh",
    });
    expect(JSON.stringify(entry)).not.toContain("sk-oai-stored");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/model-config/catalog?provider=bedrock (#2273)
// ---------------------------------------------------------------------------

const BEDROCK_BUNDLE = JSON.stringify({
  accessKeyId: "AKIA-STORED",
  secretAccessKey: "secret-stored",
});

describe("GET /api/v1/admin/model-config/catalog?provider=bedrock", () => {
  it("returns the workspace's bedrock catalog using the stored IAM bundle + region", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: BEDROCK_BUNDLE,
        baseUrl: null,
        bedrockRegion: "us-east-1",
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: { id: string; provider: string }[];
      fallback: boolean;
    };
    expect(body.models[0].id).toBe("anthropic.claude-opus-4-v1:0");
    expect(body.fallback).toBe(false);
    expect(mockGetBedrockCatalog).toHaveBeenCalledTimes(1);
    const args = mockGetBedrockCatalog.mock.calls[0]! as unknown as [
      string,
      string,
      { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
      { refresh?: boolean } | undefined,
    ];
    expect(args[1]).toBe("us-east-1");
    expect(args[2].accessKeyId).toBe("AKIA-STORED");
    expect(args[2].secretAccessKey).toBe("secret-stored");
    expect(args[3]).toEqual({ refresh: false });
  });

  it("returns 400 missing_byot_key when no bedrock config exists", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() => Effect.succeed(null));
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_byot_key");
  });

  it("returns 400 missing_byot_key when region is missing on saved config", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: BEDROCK_BUNDLE,
        baseUrl: null,
        bedrockRegion: null,
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_byot_key");
  });

  it("returns 422 decrypt_failed when stored bundle is malformed JSON", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: "not-json",
        baseUrl: null,
        bedrockRegion: "us-east-1",
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    // The route now distinguishes malformed-bundle from true crypto
    // failures (which surface earlier via rowToConfig's apiKeyStatus =
    // 'decrypt_failed'). Bundle-shape failures map to `malformed_bedrock_bundle`.
    expect(body.error).toBe("malformed_bedrock_bundle");
  });

  it("returns 422 decrypt_failed when the stored bedrock key cannot be decrypted (distinct from malformed_bedrock_bundle)", async () => {
    // The bedrock catalog path shares the upstream decrypt-failure
    // handler with anthropic/openai (route lines around the
    // `Effect.catchTag("ModelConfigDecryptError", …)` pipe). Without a
    // bedrock-specific test, a regression that re-mapped bedrock
    // decrypt failures to `malformed_bedrock_bundle` would land
    // silently because the anthropic path is the only one that pins
    // `decrypt_failed`.
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.fail(
        new MockModelConfigDecryptError({
          configId: "cfg-bedrock-1",
          cause: "wrong key version",
        }),
      ),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("decrypt_failed");
    expect(mockLogAdminAction).toHaveBeenCalledTimes(1);
    expect(lastAuditCall().status).toBe("failure");
    expect(lastAuditCall().metadata).toMatchObject({
      provider: "bedrock",
      error: "decrypt_failed",
    });
  });

  it("returns 401 byot_key_invalid when AWS rejects the IAM creds", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: BEDROCK_BUNDLE,
        baseUrl: null,
        bedrockRegion: "us-east-1",
      })),
    );
    mockGetBedrockCatalog.mockImplementation(() => {
      throw new MockBedrockCatalogUnauthorized("AccessDeniedException");
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_key_invalid");
    // Audit row must NOT contain the secret access key.
    expect(JSON.stringify(lastAuditCall())).not.toContain("secret-stored");
  });

  it("returns 503 byot_provider_unavailable on AWS outage", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: BEDROCK_BUNDLE,
        baseUrl: null,
        bedrockRegion: "us-east-1",
      })),
    );
    mockGetBedrockCatalog.mockImplementation(() => {
      throw new MockBedrockCatalogUnavailable("aws region unreachable");
    });
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("byot_provider_unavailable");
  });

  it("emits model_config.catalog_refresh with provider:'bedrock' on success", async () => {
    mockGetWorkspaceModelConfigRaw.mockImplementation(() =>
      Effect.succeed(rawConfigFromLegacy({
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: BEDROCK_BUNDLE,
        baseUrl: null,
        bedrockRegion: "us-east-1",
      })),
    );
    const res = await app.fetch(
      adminRequest("GET", "/api/v1/admin/model-config/catalog?provider=bedrock"),
    );
    expect(res.status).toBe(200);
    const entry = lastAuditCall();
    expect(entry.actionType).toBe("model_config.catalog_refresh");
    expect(entry.metadata).toEqual({
      provider: "bedrock",
      modelCount: 1,
      source: "fresh",
    });
    // The secret access key must NEVER appear in audit metadata.
    expect(JSON.stringify(entry)).not.toContain("secret-stored");
  });
});
