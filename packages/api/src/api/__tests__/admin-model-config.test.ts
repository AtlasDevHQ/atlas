/**
 * Tests for admin workspace model-config route audit emission (F-30).
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

const mockGetWorkspaceModelConfig: Mock<(orgId: string) => unknown> = mock(() =>
  Effect.succeed(null),
);
const mockSetWorkspaceModelConfig: Mock<(...args: unknown[]) => unknown> = mock(
  () =>
    Effect.succeed({
      id: "cfg-1",
      orgId: "org-1",
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKeyMasked: "************7890",
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

mock.module("@atlas/ee/platform/model-routing", () => ({
  getWorkspaceModelConfig: mockGetWorkspaceModelConfig,
  setWorkspaceModelConfig: mockSetWorkspaceModelConfig,
  deleteWorkspaceModelConfig: mockDeleteWorkspaceModelConfig,
  testModelConfig: mockTestModelConfig,
  ModelConfigError: MockModelConfigError,
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
  mockSetWorkspaceModelConfig.mockClear();
  mockDeleteWorkspaceModelConfig.mockClear();
  mockTestModelConfig.mockClear();

  mockGetWorkspaceModelConfig.mockImplementation(() => Effect.succeed(null));
  mockSetWorkspaceModelConfig.mockImplementation(() =>
    Effect.succeed({
      id: "cfg-1",
      orgId: "org-1",
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKeyMasked: "************7890",
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
    // No-op delete → no state change → no audit row. This matches the
    // `plugin.enable` pre-handler-rejection pattern in F-22.
    expect(mockLogAdminAction).not.toHaveBeenCalled();
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
