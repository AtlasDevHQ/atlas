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

// Catalog mock: keep tests offline and let each case shape the response.
let mockCatalogModels: { id: string }[] = [{ id: "anthropic/claude-opus-4.6" }];
const getGatewayCatalogMock = mock(async () => ({
  models: mockCatalogModels,
  fetchedAt: "2026-05-10T00:00:00.000Z",
  fallback: false,
}));
mock.module("@atlas/api/lib/gateway-catalog", () => ({
  getGatewayCatalog: getGatewayCatalogMock,
}));

// Import after mocks
const {
  getWorkspaceModelConfig,
  getWorkspaceModelConfigRaw,
  setWorkspaceModelConfig,
  deleteWorkspaceModelConfig,
  testModelConfig,
  reconcileModelDeprecation,
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
    expect(result!.apiKeyStatus).toBe("masked");
    expect(result!.orgId).toBe("org-1");
  });

  it("gateway provider with NULL api_key_encrypted surfaces apiKeyStatus='platform_credits'", async () => {
    ee.queueMockRows([
      makeRow({
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
        api_key_encrypted: null,
      }),
    ]);
    const result = await run(getWorkspaceModelConfig("org-1"));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gateway");
    expect(result!.apiKeyMasked).toBeNull();
    expect(result!.apiKeyStatus).toBe("platform_credits");
  });

  it("decryption failure surfaces apiKeyStatus='decrypt_failed' (not a fake mask)", async () => {
    ee.queueMockRows([makeRow({ api_key_encrypted: "corrupt-ciphertext-not-decryptable" })]);
    ee.setDecryptThrows(true);
    const result = await run(getWorkspaceModelConfig("org-1"));
    expect(result).not.toBeNull();
    expect(result!.apiKeyStatus).toBe("decrypt_failed");
    expect(result!.apiKeyMasked).toBeNull();
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

  it("gateway provider with NULL api_key_encrypted returns apiKey=null (platform credits)", async () => {
    ee.queueMockRows([
      makeRow({
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
        api_key_encrypted: null,
      }),
    ]);
    const result = await run(getWorkspaceModelConfigRaw("org-1"));
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gateway");
    expect(result!.apiKey).toBeNull();
  });

  it("decryption failure surfaces a ModelConfigDecryptError instead of silent null fallback", async () => {
    ee.queueMockRows([makeRow({ api_key_encrypted: "corrupt-not-decryptable" })]);
    ee.setDecryptThrows(true);
    // Effect.runPromise wraps tagged errors in a FiberFailure; pull the
    // unwrapped cause via Effect.runPromiseExit + Exit.causeOption to assert
    // on the underlying tag.
    const { Exit, Cause } = await import("effect");
    const exit = await Effect.runPromiseExit(getWorkspaceModelConfigRaw("org-1"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failures = Cause.failures(exit.cause);
      const arr = [...failures];
      expect(arr.some((e) => (e as { _tag?: string })._tag === "ModelConfigDecryptError")).toBe(
        true,
      );
    }
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

  it("F-47: INSERT carries api_key_key_version and stamps the active version when apiKey is set", async () => {
    // Pins the F-47 INSERT/UPDATE shape — a regression that dropped
    // `api_key_key_version` from the column list (or swapped the $N
    // ordering) would silently let rows land at the wrong version and
    // break the post-rotation ops queries.
    ee.queueMockRows([makeRow()]);
    await run(setWorkspaceModelConfig("org-1", {
      provider: "anthropic",
      model: "claude-opus-4-6",
      apiKey: "sk-ant-test1234",
    }));
    const { sql, params } = ee.capturedQueries[0];
    // Column list + ON CONFLICT SET both name the key-version column.
    expect(sql).toContain("api_key_key_version");
    expect(sql).toMatch(/ON CONFLICT[\s\S]*api_key_key_version\s*=\s*COALESCE\(\$6/);
    // $4 = encryptedKey, $6 = keyVersion (active version, 1 in tests
    // with no ATLAS_ENCRYPTION_KEYS set).
    expect(params[3]).toBe("encrypted:sk-ant-test1234");
    expect(params[5]).toBe(1);
  });

  it("F-47: when apiKey is omitted, both api_key_encrypted AND api_key_key_version are preserved via COALESCE", async () => {
    // The load-bearing COALESCE pair: on a metadata-only edit (apiKey
    // undefined), the stored ciphertext is kept, AND the companion
    // key_version column is kept alongside. Swapping one without the
    // other would break post-rotation decryption because the version
    // column would disagree with the ciphertext's enc:v<N>: prefix.
    // The PR body explicitly called this out as the risky case — this
    // test pins the behavior.
    //
    // First batch satisfies the transition guard (existing healthy row);
    // second batch is the UPSERT's RETURNING.
    ee.queueMockRows([makeRow()], [makeRow()]);
    await run(setWorkspaceModelConfig("org-1", {
      provider: "anthropic",
      model: "claude-opus-4-7",
      // apiKey intentionally omitted
    }));
    // capturedQueries[0] = transition-guard SELECT; [1] = the UPSERT.
    const { sql, params } = ee.capturedQueries[1];
    // Both columns COALESCE to the existing row when $4/$6 are null.
    expect(sql).toMatch(/api_key_encrypted\s*=\s*COALESCE\(\$4/);
    expect(sql).toMatch(/api_key_key_version\s*=\s*COALESCE\(\$6/);
    // VALUES also preserves both via the SELECT-subquery fallback so a
    // fresh INSERT (no existing row) still lands a legal key_version.
    expect(sql).toContain("SELECT api_key_encrypted FROM workspace_model_config");
    expect(sql).toContain("SELECT api_key_key_version FROM workspace_model_config");
    expect(params[3]).toBeNull();
    expect(params[5]).toBeNull();
  });

  it("transition guard: omitting apiKey for non-gateway provider with no healthy existing row rejects", async () => {
    // Existing row is gateway-on-platform-credits (no key to preserve).
    // Switching to anthropic without a key must fail with a clean
    // ModelConfigError instead of letting the DB CHECK fire.
    ee.queueMockRows([
      makeRow({ provider: "gateway", api_key_encrypted: null }),
    ]);
    await expect(
      run(
        setWorkspaceModelConfig("org-1", {
          provider: "anthropic",
          model: "claude-opus-4-6",
        }),
      ),
    ).rejects.toThrow(/API key is required/);
  });

  it("gateway provider with no apiKey + no existing row succeeds (platform credits, no transition guard)", async () => {
    // For provider=gateway the transition guard does NOT fire (it only
    // guards non-gateway → null-key transitions), so the only query is
    // the UPSERT itself.
    ee.queueMockRows([
      makeRow({ provider: "gateway", api_key_encrypted: null, model: "anthropic/claude-opus-4.6" }),
    ]);
    const result = await run(
      setWorkspaceModelConfig("org-1", {
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
      }),
    );
    expect(result.provider).toBe("gateway");
    expect(result.apiKeyStatus).toBe("platform_credits");
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
    const err = new ModelConfigError({ message: "test error", code: "validation" });
    expect(err.code).toBe("validation");
    expect(err.message).toBe("test error");
    expect(err.name).toBe("ModelConfigError");
    expect(err._tag).toBe("ModelConfigError");
  });
});

describe("testModelConfig — gateway branch", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    ee.reset();
    mockCatalogModels = [
      { id: "anthropic/claude-opus-4.6" },
      { id: "openai/gpt-4o" },
    ];
    getGatewayCatalogMock.mockClear();
    globalThis.fetch = realFetch;
  });

  it("rejects when the model id is not in the gateway catalog", async () => {
    const result = await run(
      testModelConfig({
        provider: "gateway",
        model: "made-up/not-real",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("not in the gateway catalog");
    expect(getGatewayCatalogMock).toHaveBeenCalledTimes(1);
  });

  it("succeeds on platform credits when model is in catalog and no apiKey supplied", async () => {
    // No fetch should be made — platform-credit path is catalog-only.
    let authedCalls = 0;
    globalThis.fetch = (async () => {
      authedCalls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await run(
      testModelConfig({
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
      }),
    );
    expect(result.success).toBe(true);
    expect(result.modelName).toBe("anthropic/claude-opus-4.6");
    expect(authedCalls).toBe(0); // No authenticated probe — saved a credit
  });

  it("BYOT apiKey: hits the authed completions endpoint after catalog passes", async () => {
    let authedCalled = false;
    let observedAuthHeader: string | null = null;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/v1/chat/completions")) {
        authedCalled = true;
        observedAuthHeader =
          (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null;
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }) as unknown as typeof fetch;

    const result = await run(
      testModelConfig({
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
        apiKey: "vck_test_byot",
      }),
    );
    expect(result.success).toBe(true);
    expect(authedCalled).toBe(true);
    expect(observedAuthHeader as string | null).toBe("Bearer vck_test_byot");
  });

  it("BYOT apiKey: surfaces 401 from the gateway when the key is bad", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await run(
      testModelConfig({
        provider: "gateway",
        model: "anthropic/claude-opus-4.6",
        apiKey: "vck_wrong",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid API key");
  });

  it("non-gateway provider without apiKey rejects with a validation error", async () => {
    await expect(
      run(
        testModelConfig({
          provider: "anthropic",
          model: "claude-opus-4-6",
        }),
      ),
    ).rejects.toThrow(/API key is required/);
  });
});

describe("reconcileModelDeprecation", () => {
  function catalogModel(id: string, provider = "anthropic") {
    return {
      id,
      name: id,
      provider,
      type: "language" as const,
      contextWindow: null,
      maxOutputTokens: null,
      inputPrice: null,
      outputPrice: null,
      recommended: false,
    };
  }

  beforeEach(() => {
    ee.reset();
  });

  it("returns healthy without writing when no internal DB is configured", async () => {
    ee.setHasInternalDB(false);
    const out = await run(
      reconcileModelDeprecation(
        "org-1",
        "claude-opus-4-6",
        "anthropic",
        [catalogModel("claude-opus-4-6")],
      ),
    );
    expect(out).toEqual({ status: "healthy", suggestion: null });
    expect(ee.capturedQueries).toHaveLength(0);
  });

  it("saved model present → flips deprecated row back to healthy (with model guard)", async () => {
    ee.queueMockRows([]); // UPDATE returns no rows
    const out = await run(
      reconcileModelDeprecation(
        "org-1",
        "claude-opus-4-6",
        "anthropic",
        [catalogModel("claude-opus-4-6")],
      ),
    );
    expect(out).toEqual({ status: "healthy", suggestion: null });
    expect(ee.capturedQueries).toHaveLength(1);
    const q = ee.capturedQueries[0];
    expect(q.sql).toMatch(/UPDATE workspace_model_config/);
    expect(q.sql).toMatch(/SET model_status = 'healthy'/);
    // CRITICAL: scope by (org_id, model) so a concurrent save isn't clobbered.
    expect(q.sql).toMatch(/WHERE org_id = \$1 AND model = \$2 AND model_status = 'deprecated'/);
    expect(q.params).toEqual(["org-1", "claude-opus-4-6"]);
  });

  it("saved model missing + suggestion found → writes deprecated with suggestion", async () => {
    ee.queueMockRows([]);
    const out = await run(
      reconcileModelDeprecation(
        "org-1",
        "claude-3-opus-20240229",
        "anthropic",
        [catalogModel("claude-opus-4-6")],
      ),
    );
    expect(out.status).toBe("deprecated");
    expect(out.suggestion).toBe("claude-opus-4-6");
    const q = ee.capturedQueries[0];
    expect(q.sql).toMatch(/SET model_status = 'deprecated'/);
    // CRITICAL: scope by (org_id, model) so a fresh save isn't clobbered.
    expect(q.sql).toMatch(/WHERE org_id = \$1 AND model = \$2/);
    expect(q.params).toEqual(["org-1", "claude-3-opus-20240229", "claude-opus-4-6"]);
  });

  it("saved model missing + no confident match → writes deprecated with null suggestion", async () => {
    ee.queueMockRows([]);
    const out = await run(
      reconcileModelDeprecation(
        "org-1",
        "text-davinci-003",
        "openai",
        [catalogModel("gpt-4o", "openai"), catalogModel("gpt-4o-mini", "openai")],
      ),
    );
    expect(out.status).toBe("deprecated");
    expect(out.suggestion).toBeNull();
    const q = ee.capturedQueries[0];
    expect(q.params).toEqual(["org-1", "text-davinci-003", null]);
  });

  it("empty catalog → writes deprecated with null suggestion (no match possible)", async () => {
    ee.queueMockRows([]);
    const out = await run(
      reconcileModelDeprecation("org-1", "anything", "anthropic", []),
    );
    expect(out.status).toBe("deprecated");
    expect(out.suggestion).toBeNull();
  });

  it("does not write when reconciliation logic completes — only UPDATEs the matching model row", async () => {
    // Even when the catalog has every model, the healthy-branch UPDATE
    // fires (idempotent). Confirms we never silently skip writes.
    ee.queueMockRows([]);
    await run(
      reconcileModelDeprecation(
        "org-1",
        "claude-opus-4-6",
        "anthropic",
        [catalogModel("claude-opus-4-6")],
      ),
    );
    expect(ee.capturedQueries).toHaveLength(1);
  });

  it("reconcile UPDATE scopes by (org_id, model) to survive concurrent saves", async () => {
    // Two reconcile calls — one healthy, one deprecated — both must
    // include the savedModelId in the WHERE so a save that changed
    // `model` mid-flight isn't clobbered.
    ee.queueMockRows([]);
    await run(
      reconcileModelDeprecation(
        "org-1",
        "claude-opus-4-6",
        "anthropic",
        [catalogModel("claude-opus-4-6")],
      ),
    );
    const healthyUpdate = ee.capturedQueries[0];
    expect(healthyUpdate.sql).toMatch(/AND model = \$2/);

    ee.reset();
    ee.queueMockRows([]);
    await run(
      reconcileModelDeprecation(
        "org-1",
        "claude-3-opus-20240229",
        "anthropic",
        [catalogModel("claude-opus-4-6")],
      ),
    );
    const deprecatedUpdate = ee.capturedQueries[0];
    expect(deprecatedUpdate.sql).toMatch(/AND model = \$2/);
  });
});

describe("bedrock encrypt/decrypt round-trip", () => {
  beforeEach(() => {
    ee.reset();
  });

  it("setWorkspaceModelConfig encrypts the JSON bundle before INSERT", async () => {
    const bundle = JSON.stringify({
      accessKeyId: "AKIA-EXAMPLE",
      secretAccessKey: "secret-example-123",
    });
    ee.queueMockRows([
      {
        id: "cfg-1",
        org_id: "org-1",
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        api_key_encrypted: `encrypted:${bundle}`,
        base_url: null,
        bedrock_region: "us-east-1",
        model_status: "healthy",
        model_suggested_replacement: null,
        created_at: "2026-05-11T00:00:00Z",
        updated_at: "2026-05-11T00:00:00Z",
      },
    ]);
    await run(
      setWorkspaceModelConfig("org-1", {
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        apiKey: bundle,
        bedrockRegion: "us-east-1",
      }),
    );
    const upsert = ee.capturedQueries.find((q) =>
      q.sql.includes("INSERT INTO workspace_model_config"),
    );
    expect(upsert).toBeDefined();
    // The mock's encryptSecret prefixes with "encrypted:" — confirms the
    // bundle was passed through the encryption helper, not stored raw.
    const encryptedParam = upsert!.params[3] as string;
    expect(encryptedParam.startsWith("encrypted:")).toBe(true);
    // And the secret half is inside the encrypted blob (the mock is
    // identity-after-prefix, so this proves the bundle was serialized).
    expect(encryptedParam).toContain("secret-example-123");
    // The audit-log path NEVER stores the raw apiKey in the captured
    // query params (params[3] is the ciphertext, not the plaintext).
  });

  it("rowToConfig masks the accessKeyId tail and never the secretAccessKey", async () => {
    const bundle = JSON.stringify({
      accessKeyId: "AKIA-EXAMPLE-XYZW",
      secretAccessKey: "secret-that-must-never-leak",
    });
    ee.queueMockRows([
      {
        id: "cfg-1",
        org_id: "org-1",
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        api_key_encrypted: `encrypted:${bundle}`,
        base_url: null,
        bedrock_region: "us-east-1",
        model_status: "healthy",
        model_suggested_replacement: null,
        created_at: "2026-05-11T00:00:00Z",
        updated_at: "2026-05-11T00:00:00Z",
      },
    ]);
    const cfg = await run(getWorkspaceModelConfig("org-1"));
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKeyStatus).toBe("masked");
    // Mask is the accessKeyId tail (last 4 of "AKIA-EXAMPLE-XYZW").
    expect(cfg!.apiKeyMasked).toBe("*************XYZW");
    // The secret half must NEVER appear on the wire shape.
    expect(JSON.stringify(cfg)).not.toContain("secret-that-must-never-leak");
  });

  it("malformed bedrock bundle inside ciphertext surfaces as decrypt_failed", async () => {
    // Bundle decrypts cleanly (mock identity-after-prefix), but the
    // JSON inside is missing secretAccessKey — should NOT report
    // `masked` with a "****" placeholder.
    ee.queueMockRows([
      {
        id: "cfg-1",
        org_id: "org-1",
        provider: "bedrock",
        model: "anthropic.claude-opus-4-v1:0",
        api_key_encrypted: `encrypted:${JSON.stringify({ accessKeyId: "AKIA" })}`,
        base_url: null,
        bedrock_region: "us-east-1",
        model_status: "healthy",
        model_suggested_replacement: null,
        created_at: "2026-05-11T00:00:00Z",
        updated_at: "2026-05-11T00:00:00Z",
      },
    ]);
    const cfg = await run(getWorkspaceModelConfig("org-1"));
    expect(cfg!.apiKeyStatus).toBe("decrypt_failed");
    expect(cfg!.apiKeyMasked).toBeNull();
  });
});
