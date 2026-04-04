import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Effect } from "effect";
import { createEEMock } from "../__mocks__/internal";

// ── Mocks ───────────────────────────────────────────────────────────

const ee = createEEMock();

mock.module("../index", () => ee.enterpriseMock);
const hasDB = () => (ee.internalDBMock.hasInternalDB as () => boolean)();
mock.module("../lib/db-guard", () => ({
  requireInternalDB: (label: string, factory?: () => Error) => {
    if (!hasDB()) {
      if (factory) throw factory();
      throw new Error(`Internal database required for ${label}.`);
    }
  },
  requireInternalDBEffect: (label: string, factory?: () => Error) => {
    return hasDB()
      ? Effect.void
      : Effect.fail(factory?.() ?? new Error(`Internal database required for ${label}.`));
  },
}));
mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
mock.module("@atlas/api/lib/logger", () => ee.loggerMock);

// Import after mocks
const {
  getWorkspaceModelConfig,
  getWorkspaceModelConfigRaw,
  setWorkspaceModelConfig,
  deleteWorkspaceModelConfig,
  maskApiKey,
  ModelConfigError,
} = await import("./model-routing");

// ── Helpers ─────────────────────────────────────────────────────────

/** Run an Effect, converting failures to rejected promises for test assertions. */
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, never>);

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "cfg-123",
    org_id: "org-1",
    provider: "anthropic",
    model: "claude-opus-4-6",
    api_key_encrypted: "encrypted:sk-ant-test1234",
    base_url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("maskApiKey", () => {
  it("masks all but last 4 characters", () => {
    expect(maskApiKey("sk-ant-1234567890")).toBe("*************7890");
  });

  it("returns **** for short keys", () => {
    expect(maskApiKey("abc")).toBe("****");
    expect(maskApiKey("abcd")).toBe("****");
  });

  it("handles 5-character key", () => {
    expect(maskApiKey("12345")).toBe("*2345");
  });
});

describe("getWorkspaceModelConfig", () => {
  beforeEach(() => ee.reset());

  it("returns null when no config exists", async () => {
    ee.queueMockRows([]); // empty result
    const result = await run(getWorkspaceModelConfig("org-1"));
    expect(result).toBeNull();
  });

  it("returns config with masked API key", async () => {
    ee.queueMockRows([makeRow()]);
    const result = await run(getWorkspaceModelConfig("org-1"));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("anthropic");
    expect(result!.model).toBe("claude-opus-4-6");
    expect(result!.apiKeyMasked).toBe("***********1234");
    expect(result!.orgId).toBe("org-1");
  });

  it("throws when enterprise is not enabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(getWorkspaceModelConfig("org-1"))).rejects.toThrow("Enterprise features");
  });
});

describe("getWorkspaceModelConfigRaw", () => {
  beforeEach(() => ee.reset());

  it("returns null when no config exists", async () => {
    ee.queueMockRows([]); // empty result
    const result = await run(getWorkspaceModelConfigRaw("org-1"));
    expect(result).toBeNull();
  });

  it("returns raw config with decrypted API key", async () => {
    ee.queueMockRows([makeRow()]);
    const result = await run(getWorkspaceModelConfigRaw("org-1"));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("anthropic");
    expect(result!.model).toBe("claude-opus-4-6");
    expect(result!.apiKey).toBe("sk-ant-test1234");
  });

  it("does NOT enforce enterprise gate (called in hot path)", async () => {
    ee.setEnterpriseEnabled(false);
    ee.queueMockRows([]);
    // Should not throw even when enterprise is disabled
    const result = await run(getWorkspaceModelConfigRaw("org-1"));
    expect(result).toBeNull();
  });
});

describe("setWorkspaceModelConfig", () => {
  beforeEach(() => ee.reset());

  it("saves config with encrypted API key", async () => {
    ee.queueMockRows([makeRow()]);
    const result = await run(setWorkspaceModelConfig("org-1", {
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test1234",
    }));
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
    expect(ee.capturedQueries[0].sql).toContain("INSERT INTO workspace_model_config");
    // Verify the API key was encrypted before storage
    expect(ee.capturedQueries[0].params[3]).toBe("encrypted:sk-ant-test1234");
  });

  it("rejects invalid provider", async () => {
    await expect(
      run(setWorkspaceModelConfig("org-1", {
        provider: "invalid" as "anthropic",
        model: "test",
        apiKey: "key",
      })),
    ).rejects.toThrow("Invalid provider");
  });

  it("rejects empty model", async () => {
    await expect(
      run(setWorkspaceModelConfig("org-1", {
        provider: "anthropic",
        model: "",
        apiKey: "key",
      })),
    ).rejects.toThrow("Model name is required");
  });

  it("rejects empty API key", async () => {
    await expect(
      run(setWorkspaceModelConfig("org-1", {
        provider: "anthropic",
        model: "test",
        apiKey: "",
      })),
    ).rejects.toThrow("API key cannot be empty");
  });

  it("requires base URL for azure-openai", async () => {
    await expect(
      run(setWorkspaceModelConfig("org-1", {
        provider: "azure-openai",
        model: "gpt-4o",
        apiKey: "key",
      })),
    ).rejects.toThrow("Base URL is required");
  });

  it("requires base URL for custom", async () => {
    await expect(
      run(setWorkspaceModelConfig("org-1", {
        provider: "custom",
        model: "llama-3",
        apiKey: "key",
      })),
    ).rejects.toThrow("Base URL is required");
  });

  it("validates base URL format", async () => {
    await expect(
      run(setWorkspaceModelConfig("org-1", {
        provider: "custom",
        model: "llama-3",
        apiKey: "key",
        baseUrl: "not-a-url",
      })),
    ).rejects.toThrow("Invalid base URL");
  });

  it("accepts valid base URL for custom provider", async () => {
    ee.queueMockRows([makeRow({
      provider: "custom",
      model: "llama-3",
      base_url: "https://api.example.com/v1",
    })]);
    const result = await run(setWorkspaceModelConfig("org-1", {
      provider: "custom",
      model: "llama-3",
      apiKey: "key",
      baseUrl: "https://api.example.com/v1",
    }));
    expect(result.provider).toBe("custom");
    expect(result.baseUrl).toBe("https://api.example.com/v1");
  });

  it("throws when enterprise is not enabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(
      run(setWorkspaceModelConfig("org-1", {
        provider: "anthropic",
        model: "test",
        apiKey: "key",
      })),
    ).rejects.toThrow("Enterprise features");
  });
});

describe("deleteWorkspaceModelConfig", () => {
  beforeEach(() => ee.reset());

  it("returns true when config is deleted", async () => {
    ee.queueMockRows([{ id: "cfg-123" }]); // DELETE RETURNING result
    const result = await run(deleteWorkspaceModelConfig("org-1"));
    expect(result).toBe(true);
    expect(ee.capturedQueries[0].sql).toContain("DELETE FROM workspace_model_config");
  });

  it("returns false when no config exists", async () => {
    ee.queueMockRows([]); // empty DELETE RETURNING result
    const result = await run(deleteWorkspaceModelConfig("org-1"));
    expect(result).toBe(false);
  });

  it("throws when enterprise is not enabled", async () => {
    ee.setEnterpriseEnabled(false);
    await expect(run(deleteWorkspaceModelConfig("org-1"))).rejects.toThrow("Enterprise features");
  });
});

describe("ModelConfigError", () => {
  it("has the correct error code", () => {
    const err = new ModelConfigError("test error", "validation");
    expect(err.code).toBe("validation");
    expect(err.message).toBe("test error");
    expect(err.name).toBe("ModelConfigError");
  });
});
