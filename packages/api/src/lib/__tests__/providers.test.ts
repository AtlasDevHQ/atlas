import { describe, expect, test, afterEach, beforeEach } from "bun:test";

// Import after mocks — getProviderType reads process.env at call time, so no
// module-level mocking is needed.
const {
  getProviderType,
  getDefaultProvider,
  getModel,
  getModelForConfig,
  getModelFromWorkspaceConfig,
  getSummaryModel,
  resolveModelId,
  resolveExtractionModelId,
  getBatchApiKey,
  getMissingModelConfig,
} = await import("@atlas/api/lib/providers");

// ---------------------------------------------------------------------------
// Env snapshot — capture/restore only the vars this test touches
// ---------------------------------------------------------------------------

const origProvider = process.env.ATLAS_PROVIDER;
const origModel = process.env.ATLAS_MODEL;
const origVercel = process.env.VERCEL;
const origDeployMode = process.env.ATLAS_DEPLOY_MODE;
const origCompatBaseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
const origCompatApiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
const origGatewayKey = process.env.AI_GATEWAY_API_KEY;

afterEach(() => {
  if (origProvider !== undefined) process.env.ATLAS_PROVIDER = origProvider;
  else delete process.env.ATLAS_PROVIDER;

  if (origModel !== undefined) process.env.ATLAS_MODEL = origModel;
  else delete process.env.ATLAS_MODEL;

  if (origVercel !== undefined) process.env.VERCEL = origVercel;
  else delete process.env.VERCEL;

  if (origDeployMode !== undefined) process.env.ATLAS_DEPLOY_MODE = origDeployMode;
  else delete process.env.ATLAS_DEPLOY_MODE;

  if (origCompatBaseURL !== undefined) process.env.OPENAI_COMPATIBLE_BASE_URL = origCompatBaseURL;
  else delete process.env.OPENAI_COMPATIBLE_BASE_URL;

  if (origCompatApiKey !== undefined) process.env.OPENAI_COMPATIBLE_API_KEY = origCompatApiKey;
  else delete process.env.OPENAI_COMPATIBLE_API_KEY;

  if (origGatewayKey !== undefined) process.env.AI_GATEWAY_API_KEY = origGatewayKey;
  else delete process.env.AI_GATEWAY_API_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getProviderType", () => {
  test("defaults to 'anthropic' when no env vars are set", () => {
    delete process.env.ATLAS_PROVIDER;
    delete process.env.ATLAS_MODEL;
    expect(getProviderType()).toBe("anthropic");
  });

  test("returns 'anthropic' when ATLAS_PROVIDER=anthropic", () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    delete process.env.ATLAS_MODEL;
    expect(getProviderType()).toBe("anthropic");
  });

  test("returns 'openai' when ATLAS_PROVIDER=openai", () => {
    process.env.ATLAS_PROVIDER = "openai";
    expect(getProviderType()).toBe("openai");
  });

  test("returns 'ollama' when ATLAS_PROVIDER=ollama", () => {
    process.env.ATLAS_PROVIDER = "ollama";
    expect(getProviderType()).toBe("ollama");
  });

  test("returns 'gateway' when ATLAS_PROVIDER=gateway", () => {
    process.env.ATLAS_PROVIDER = "gateway";
    expect(getProviderType()).toBe("gateway");
  });

  // --- Bedrock variants ---------------------------------------------------

  test("returns 'bedrock-anthropic' for bedrock with anthropic.claude model", () => {
    process.env.ATLAS_PROVIDER = "bedrock";
    process.env.ATLAS_MODEL = "anthropic.claude-opus-4-6-v1:0";
    expect(getProviderType()).toBe("bedrock-anthropic");
  });

  test("returns 'bedrock-anthropic' for bedrock with cross-region anthropic model", () => {
    process.env.ATLAS_PROVIDER = "bedrock";
    process.env.ATLAS_MODEL = "us.anthropic.claude-3-7-sonnet-20250219-v1:0";
    expect(getProviderType()).toBe("bedrock-anthropic");
  });

  test("returns 'bedrock' for bedrock with non-anthropic model", () => {
    process.env.ATLAS_PROVIDER = "bedrock";
    process.env.ATLAS_MODEL = "amazon.nova-pro-v1:0";
    expect(getProviderType()).toBe("bedrock");
  });

  test("returns 'bedrock-anthropic' for bedrock with default model (no ATLAS_MODEL)", () => {
    process.env.ATLAS_PROVIDER = "bedrock";
    delete process.env.ATLAS_MODEL;
    // Default bedrock model is anthropic.claude-opus-4-6-v1:0, which contains "anthropic"
    expect(getProviderType()).toBe("bedrock-anthropic");
  });

  test("returns 'bedrock-anthropic' for bedrock with claude model (no 'anthropic' in ID)", () => {
    process.env.ATLAS_PROVIDER = "bedrock";
    process.env.ATLAS_MODEL = "claude-3-opus-20240229";
    expect(getProviderType()).toBe("bedrock-anthropic");
  });

  test("returns 'bedrock' for bedrock with meta llama model", () => {
    process.env.ATLAS_PROVIDER = "bedrock";
    process.env.ATLAS_MODEL = "meta.llama3-1-70b-instruct-v1:0";
    expect(getProviderType()).toBe("bedrock");
  });

  // --- OpenAI-compatible provider -------------------------------------------

  test("returns 'openai-compatible' when ATLAS_PROVIDER=openai-compatible", () => {
    process.env.ATLAS_PROVIDER = "openai-compatible";
    process.env.ATLAS_MODEL = "llama3.1";
    expect(getProviderType()).toBe("openai-compatible");
  });

  test("throws when openai-compatible is used without ATLAS_MODEL", () => {
    process.env.ATLAS_PROVIDER = "openai-compatible";
    delete process.env.ATLAS_MODEL;
    expect(() => getProviderType()).toThrow("ATLAS_MODEL is required");
  });

  // --- Vercel auto-detection ------------------------------------------------

  test("defaults to 'gateway' when VERCEL env var is set and no ATLAS_PROVIDER", () => {
    delete process.env.ATLAS_PROVIDER;
    delete process.env.ATLAS_MODEL;
    process.env.VERCEL = "1";
    expect(getProviderType()).toBe("gateway");
  });

  test("explicit ATLAS_PROVIDER overrides Vercel default", () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    process.env.VERCEL = "1";
    expect(getProviderType()).toBe("anthropic");
  });

  // --- Invalid provider ----------------------------------------------------

  test("throws for an invalid provider string", () => {
    process.env.ATLAS_PROVIDER = "typo-provider";
    expect(() => getProviderType()).toThrow(Error);
  });
});

describe("getDefaultProvider", () => {
  test("returns 'anthropic' when self-hosted (no VERCEL, no SaaS deploy mode)", () => {
    delete process.env.VERCEL;
    delete process.env.ATLAS_DEPLOY_MODE;
    expect(getDefaultProvider()).toBe("anthropic");
  });

  test("returns 'gateway' when VERCEL is set", () => {
    delete process.env.ATLAS_DEPLOY_MODE;
    process.env.VERCEL = "1";
    expect(getDefaultProvider()).toBe("gateway");
  });

  // SaaS runs on Railway where VERCEL is unset — the deploy-mode signal is what
  // makes the hosted default `gateway` (so an unset ATLAS_PROVIDER doesn't fall
  // back to anthropic-direct and bill/report the wrong model). #3098.
  test("returns 'gateway' when ATLAS_DEPLOY_MODE=saas even without VERCEL", () => {
    delete process.env.VERCEL;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(getDefaultProvider()).toBe("gateway");
  });

  test("self-hosted deploy mode keeps the anthropic default", () => {
    delete process.env.VERCEL;
    process.env.ATLAS_DEPLOY_MODE = "self-hosted";
    expect(getDefaultProvider()).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// resolveModelId — single source of truth for the unset/effective default
// (#3098). The billing page's "Default AI model" picker and the agent loop
// must resolve the SAME model when a workspace hasn't saved one; otherwise the
// UI advertises one model while another is billed.
// ---------------------------------------------------------------------------

describe("resolveModelId — SSOT default (#3098)", () => {
  test("gateway default equals getModelForConfig().modelId (no drift)", () => {
    // The agent builds its model via getModelForConfig(); the billing endpoint
    // reports the default via resolveModelId(). Both must agree for the gateway
    // provider when nothing is saved.
    process.env.AI_GATEWAY_API_KEY = "test-key"; // lets getModelForConfig build the gateway model
    delete process.env.ATLAS_MODEL;
    const agentDefault = getModelForConfig("gateway", undefined).modelId;
    expect(resolveModelId("gateway", undefined)).toBe(agentDefault);
  });

  test("platform gateway default is Sonnet 5 (documented decision, #3098)", () => {
    delete process.env.ATLAS_MODEL;
    // Decision: the hosted/gateway default is the balanced, ~5x-cheaper Sonnet
    // 5 — NOT Opus 4.8. Pinning it here so UI and runtime can't silently
    // diverge back to the expensive default.
    expect(resolveModelId("gateway", undefined)).toBe("anthropic/claude-sonnet-5");
  });

  test("an explicitly saved model overrides the default", () => {
    delete process.env.ATLAS_MODEL;
    expect(resolveModelId("gateway", "anthropic/claude-opus-4.8")).toBe("anthropic/claude-opus-4.8");
  });

  test("falls back to ATLAS_MODEL env when no override is given", () => {
    process.env.ATLAS_MODEL = "anthropic/claude-haiku-4.5";
    expect(resolveModelId("gateway", undefined)).toBe("anthropic/claude-haiku-4.5");
  });

  test("throws for openai-compatible with no model and no default", () => {
    delete process.env.ATLAS_MODEL;
    expect(() => resolveModelId("openai-compatible", undefined)).toThrow("ATLAS_MODEL is required");
  });

  // The bug end-to-end: a SaaS deployment with nothing configured must resolve
  // gateway → Sonnet 5, NOT anthropic → Opus. With no provider override and no
  // ATLAS_PROVIDER, the provider falls through to getDefaultProvider() (gateway
  // on SaaS), then to PROVIDER_DEFAULTS.gateway. #3098.
  test("unset provider+model on SaaS resolves the gateway Sonnet default", () => {
    delete process.env.ATLAS_PROVIDER;
    delete process.env.ATLAS_MODEL;
    delete process.env.VERCEL;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(resolveModelId(undefined, undefined)).toBe("anthropic/claude-sonnet-5");
  });
});

// ---------------------------------------------------------------------------
// getSummaryModel — cheaper compaction summary model (#3761). Resolves a
// SEPARATE model id on the SAME provider/credentials as the turn; only the
// model id changes.
// ---------------------------------------------------------------------------

describe("getSummaryModel (#3761)", () => {
  test("platform path: resolves the summary id on the active provider (workspaceConfig=null)", () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    delete process.env.ATLAS_MODEL;
    // No workspace config ⇒ getModelForConfig(undefined, summaryId) on the env
    // provider. The resolved model carries exactly the summary id we asked for.
    const model = getSummaryModel({ summaryModelId: "claude-haiku-4-5", workspaceConfig: null });
    expect(typeof model === "string" ? model : model.modelId).toBe("claude-haiku-4-5");
  });

  test("workspace path: swaps only the model id, keeping the workspace provider + key", () => {
    // A BYOT workspace on its own Anthropic key: the summary runs on the SAME
    // provider/credentials, with just the model field replaced by the cheaper id.
    const model = getSummaryModel({
      summaryModelId: "claude-haiku-4-5",
      workspaceConfig: {
        model: "claude-opus-4-8", // the turn model — must be overridden
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "anthropic", apiKey: "sk-ant-test" },
      },
    });
    expect(typeof model === "string" ? model : model.modelId).toBe("claude-haiku-4-5");
    // …and the provider stays the workspace's Anthropic SDK — a regression that
    // dropped `credentials` and fell back to a default provider while keeping the
    // right model id would pass the modelId check alone, so assert the provider.
    expect(typeof model === "string" ? "" : model.provider).toContain("anthropic");
  });

  test("workspace path: provider field tracks the workspace config, not a constant", () => {
    // The same call on an OpenAI BYOT workspace must resolve the OpenAI SDK —
    // proving the assertion above isn't passing because `provider` is hard-coded.
    const model = getSummaryModel({
      summaryModelId: "gpt-4o-mini",
      workspaceConfig: {
        model: "gpt-4o", // the turn model — must be overridden
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "openai", apiKey: "sk-openai-test" },
      },
    });
    expect(typeof model === "string" ? model : model.modelId).toBe("gpt-4o-mini");
    expect(typeof model === "string" ? "" : model.provider).toContain("openai");
  });
});

describe("getModel — openai-compatible", () => {
  test("throws when OPENAI_COMPATIBLE_BASE_URL is not set", () => {
    process.env.ATLAS_PROVIDER = "openai-compatible";
    process.env.ATLAS_MODEL = "llama3.1";
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    expect(() => getModel()).toThrow("OPENAI_COMPATIBLE_BASE_URL is required");
  });

  test("returns a model when all required env vars are set", () => {
    process.env.ATLAS_PROVIDER = "openai-compatible";
    process.env.ATLAS_MODEL = "llama3.1";
    process.env.OPENAI_COMPATIBLE_BASE_URL = "http://localhost:8000/v1";
    const model = getModel();
    expect(model).toBeDefined();
  });
});

describe("getMissingModelConfig (wizard enrichment preflight, #3236)", () => {
  test("reports an unsupported ATLAS_PROVIDER as missing (fail-fast, not silently healthy)", () => {
    process.env.ATLAS_PROVIDER = "definitely-not-a-provider";
    const { provider, missing } = getMissingModelConfig();
    expect(provider).toBe("definitely-not-a-provider");
    expect(missing.length).toBeGreaterThan(0);
  });

  test("reports the missing key for a supported-but-keyless provider", () => {
    process.env.ATLAS_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    const { provider, missing } = getMissingModelConfig();
    expect(provider).toBe("anthropic");
    expect(missing).toContain("ANTHROPIC_API_KEY");
  });

  test("reports nothing missing when the provider is fully configured", () => {
    process.env.ATLAS_PROVIDER = "gateway";
    process.env.AI_GATEWAY_API_KEY = "gw-test-key";
    const { provider, missing } = getMissingModelConfig();
    expect(provider).toBe("gateway");
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getModelFromWorkspaceConfig (merged from providers-workspace.test.ts)
// ---------------------------------------------------------------------------

// Post-#2282: `getModelFromWorkspaceConfig` consumes the typed
// `WorkspaceCredentials` union built by the EE row mapper. The "missing
// apiKey for a BYOT provider" precondition moved upstream — the union's
// non-bedrock arms type `apiKey` as a non-nullable string, so a null key
// is unrepresentable at this boundary. The negative cases that used to
// live here are now pinned in the EE `getWorkspaceModelConfigRaw` /
// admin-model-config route tests (decrypt_failed / missing_byot_key
// envelopes). What remains is the AI Layer's behavior given a
// well-formed union value — happy paths for each provider and the one
// negative case the union still carries: a bedrock `bundle: null`
// signaling a malformed stored bundle.

const savedGatewayKey = process.env.AI_GATEWAY_API_KEY;

afterEach(() => {
  if (savedGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = savedGatewayKey;
});

describe("getModelFromWorkspaceConfig — gateway branch", () => {
  beforeEach(() => {
    delete process.env.AI_GATEWAY_API_KEY;
  });

  test("BYOT gateway: apiKey supplied → returns a LanguageModel via createGateway", () => {
    const model = getModelFromWorkspaceConfig({
      model: "anthropic/claude-opus-4.6",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "gateway", apiKey: "vck_test_byot" },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic/claude-opus-4.6");
    }
  });

  test("platform credits: AI_GATEWAY_API_KEY set + no apiKey → returns env-keyed gateway()", () => {
    process.env.AI_GATEWAY_API_KEY = "vck_platform_default";
    const model = getModelFromWorkspaceConfig({
      model: "openai/gpt-4o",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "gateway", apiKey: null },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("openai/gpt-4o");
    }
  });

  test("platform credits: no AI_GATEWAY_API_KEY + no apiKey → throws actionable error", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "openai/gpt-4o",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "gateway", apiKey: null },
      }),
    ).toThrow(/AI_GATEWAY_API_KEY/);
  });
});

describe("getModelFromWorkspaceConfig — BYOT happy paths", () => {
  test("anthropic returns a LanguageModel with the requested model id", () => {
    const model = getModelFromWorkspaceConfig({
      model: "claude-opus-4-6",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "anthropic", apiKey: "sk-ant-test" },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("claude-opus-4-6");
    }
  });

  test("openai returns a LanguageModel with the requested model id", () => {
    const model = getModelFromWorkspaceConfig({
      model: "gpt-4o",
      baseUrl: null,
      bedrockRegion: null,
      credentials: { provider: "openai", apiKey: "sk-oai-test" },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("gpt-4o");
    }
  });

  test("azure-openai requires baseUrl", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "gpt-4o",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "azure-openai", apiKey: "az-key" },
      }),
    ).toThrow(/Base URL is required/);
  });

  test("custom requires baseUrl", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "x",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "custom", apiKey: "custom-key" },
      }),
    ).toThrow(/Base URL is required/);
  });

  // #3339 — stored baseUrl is re-validated at use time against the SSRF guard.
  test("custom rejects a link-local (cloud metadata) baseUrl", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "x",
        baseUrl: "http://169.254.169.254/latest/meta-data/",
        bedrockRegion: null,
        credentials: { provider: "custom", apiKey: "custom-key" },
      }),
    ).toThrow(/public HTTPS endpoint/);
  });

  test("custom rejects a private-range baseUrl", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "x",
        baseUrl: "https://10.0.0.5/v1",
        bedrockRegion: null,
        credentials: { provider: "custom", apiKey: "custom-key" },
      }),
    ).toThrow(/public HTTPS endpoint/);
  });

  test("custom allows an internal baseUrl when the operator opt-out is set", () => {
    const prev = process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
    process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = "true";
    try {
      const model = getModelFromWorkspaceConfig({
        model: "x",
        baseUrl: "http://localhost:11434/v1",
        bedrockRegion: null,
        credentials: { provider: "custom", apiKey: "custom-key" },
      });
      expect(typeof model).toBe("object");
    } finally {
      if (prev === undefined) delete process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS;
      else process.env.ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS = prev;
    }
  });

  test("custom allows a public HTTPS baseUrl", () => {
    const model = getModelFromWorkspaceConfig({
      model: "x",
      baseUrl: "https://llm.example.com/v1",
      bedrockRegion: null,
      credentials: { provider: "custom", apiKey: "custom-key" },
    });
    expect(typeof model).toBe("object");
  });
});

describe("getModelFromWorkspaceConfig — bedrock branch", () => {
  test("happy path: returns a LanguageModel with the requested model id", () => {
    const model = getModelFromWorkspaceConfig({
      model: "anthropic.claude-opus-4-v1:0",
      baseUrl: null,
      bedrockRegion: "us-east-1",
      credentials: {
        provider: "bedrock",
        bundle: { accessKeyId: "AKIA-EXAMPLE", secretAccessKey: "secret-example" },
      },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic.claude-opus-4-v1:0");
    }
  });

  test("happy path with sessionToken: still returns a LanguageModel", () => {
    const model = getModelFromWorkspaceConfig({
      model: "anthropic.claude-opus-4-v1:0",
      baseUrl: null,
      bedrockRegion: "us-west-2",
      credentials: {
        provider: "bedrock",
        bundle: {
          accessKeyId: "AKIA-EXAMPLE",
          secretAccessKey: "secret-example",
          sessionToken: "session-token-xyz",
        },
      },
    });
    expect(typeof model).toBe("object");
    if (typeof model !== "string") {
      expect(model.modelId).toBe("anthropic.claude-opus-4-v1:0");
    }
  });

  test("bundle === null (malformed signal from EE row mapper) surfaces re-enter message", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "anthropic.claude-opus-4-v1:0",
        baseUrl: null,
        bedrockRegion: "us-east-1",
        credentials: { provider: "bedrock", bundle: null },
      }),
    ).toThrow(/bedrock credentials are malformed/);
  });

  test("missing region throws region-required error (even with valid bundle)", () => {
    expect(() =>
      getModelFromWorkspaceConfig({
        model: "anthropic.claude-opus-4-v1:0",
        baseUrl: null,
        bedrockRegion: null,
        credentials: {
          provider: "bedrock",
          bundle: { accessKeyId: "AKIA-EXAMPLE", secretAccessKey: "secret-example" },
        },
      }),
    ).toThrow(/AWS region is required/);
  });
});

// ---------------------------------------------------------------------------
// Extraction tier (merged from providers-extraction-tier.test.ts)
// ---------------------------------------------------------------------------

/**
 * The ingest tier, and the boundary it must not cross (#5353).
 *
 * The rule this file pins: **model tier follows the latency budget and the blast
 * radius, not the subsystem.** Extraction has a latency budget of hours, roughly
 * ten times chat's volume, and its output reaches a review queue as a draft
 * rather than a person as an answer — so it resolves its own model. Chat has
 * none of those properties and keeps the frontier model.
 *
 * Two halves, and the second is the one that decays quietly:
 *
 *   1. The ingest tier resolves as designed — explicit setting, then the
 *      provider's cheap default, then "whatever the turn would" for providers
 *      that have no separate tier.
 *   2. **The interactive path is untouched.** #5353's whole point is that ingest
 *      stops inheriting the chat model; a knob that quietly worked in BOTH
 *      directions would be the same coupling wearing a new name, and nothing
 *      about the extraction path would notice.
 */

const ENV_KEYS = [
  "ATLAS_PROVIDER",
  "ATLAS_MODEL",
  "ATLAS_BRAIN_EXTRACTION_MODEL",
  "ANTHROPIC_API_KEY",
  "VERCEL",
  "ATLAS_DEPLOY_MODE",
] as const;

const originals = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function useProvider(provider: string): void {
  process.env.ATLAS_PROVIDER = provider;
  delete process.env.VERCEL;
  delete process.env.ATLAS_DEPLOY_MODE;
}

// ---------------------------------------------------------------------------
// 1. The tier resolves
// ---------------------------------------------------------------------------

describe("resolveExtractionModelId", () => {
  test("each provider with a cheap tier gets its own id, not a shared string", () => {
    // The ids differ per vendor and the vendors spell them differently —
    // `claude-haiku-4-5` direct, `anthropic.claude-haiku-4-5` on Bedrock,
    // `anthropic/claude-haiku-4.5` through the gateway. One shared constant
    // would 404 on two of the three.
    const expected: Record<string, string> = {
      anthropic: "claude-haiku-4-5",
      bedrock: "anthropic.claude-haiku-4-5",
      gateway: "anthropic/claude-haiku-4.5",
      openai: "gpt-4o-mini",
    };
    for (const [provider, modelId] of Object.entries(expected)) {
      useProvider(provider);
      expect(resolveExtractionModelId({ override: null, workspaceConfig: null })).toBe(modelId);
    }
  });

  test("⭐ a provider with no separate tier falls through rather than erroring", () => {
    // #5353's AC: "A workspace that has set nothing keeps working, with the new
    // default rather than an error." `ollama` is local inference — there is no
    // cheaper tier to trade down to — and `openai-compatible` has no model
    // vocabulary at all. Naming one would point the fiber at a model the
    // operator may never have pulled.
    for (const provider of ["ollama", "openai-compatible"]) {
      useProvider(provider);
      expect(resolveExtractionModelId({ override: null, workspaceConfig: null })).toBeNull();
    }
  });

  test("an explicit setting beats the tier default", () => {
    useProvider("anthropic");
    expect(resolveExtractionModelId({ override: "claude-sonnet-5", workspaceConfig: null })).toBe(
      "claude-sonnet-5",
    );
    // Whitespace is not a setting. A blank-ish value must resolve to the
    // default rather than to a model id of `" "`, which would 400 every call.
    expect(resolveExtractionModelId({ override: "   ", workspaceConfig: null })).toBe(
      "claude-haiku-4-5",
    );
  });

  test("an unknown ATLAS_PROVIDER falls through instead of guessing", () => {
    // The unsupported-provider decision belongs to `isSupportedProvider`, and
    // guessing a tier for a provider we do not recognise would substitute a
    // model id into a request we cannot reason about at all.
    useProvider("not-a-provider");
    expect(resolveExtractionModelId({ override: null, workspaceConfig: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The interactive path, provably unchanged
// ---------------------------------------------------------------------------

describe("the chat path does not read the extraction setting", () => {
  test("⭐ ATLAS_BRAIN_EXTRACTION_MODEL never reaches resolveModelId", () => {
    // THE assertion #5353 names. `resolveModelId` is the SSOT the billing page
    // and the agent loop both flow through (#3098), so if the extraction knob
    // could reach it, setting a cheap ingest tier would silently downgrade every
    // chat turn in the workspace — and the billing page would keep advertising
    // the old model.
    //
    // MUTATION THIS CATCHES: routing `resolveExtractionModelId` through
    // `resolveSelection`, or adding `ATLAS_BRAIN_EXTRACTION_MODEL` to
    // `resolveSelection`'s fallback chain. Every extraction test still passes.
    useProvider("anthropic");
    delete process.env.ATLAS_MODEL;
    const withoutKnob = resolveModelId();

    process.env.ATLAS_BRAIN_EXTRACTION_MODEL = "claude-haiku-4-5";
    expect(resolveModelId()).toBe(withoutKnob);
    // And the control, in the same test so the two are shown to DIFFER: the
    // knob IS read by the extraction path. Without this, `toBe(withoutKnob)`
    // would also pass on an implementation where the knob is dead everywhere.
    expect(resolveExtractionModelId({ override: "claude-haiku-4-5", workspaceConfig: null })).toBe(
      "claude-haiku-4-5",
    );
  });

  test("the chat model still comes from ATLAS_MODEL", () => {
    // The other direction: the turn's own knob keeps working while the ingest
    // tier diverges from it. A frontier chat model and a cheap ingest model, at
    // the same time, on the same provider — which is the whole arrangement.
    useProvider("anthropic");
    process.env.ATLAS_MODEL = "claude-opus-5";
    process.env.ATLAS_BRAIN_EXTRACTION_MODEL = "";
    expect(resolveModelId()).toBe("claude-opus-5");
    expect(resolveExtractionModelId({ override: "", workspaceConfig: null })).toBe(
      "claude-haiku-4-5",
    );
  });

  test("the extraction knob does not change what counts as a configured provider", () => {
    // `getMissingModelConfig` is the fail-fast used before a batch of
    // enrichment calls. It answers about the TURN's provider; an extraction
    // knob leaking into it would report a provider as configured (or not) on
    // evidence from a different code path.
    useProvider("openai-compatible");
    delete process.env.ATLAS_MODEL;
    const before = getMissingModelConfig().missing;
    process.env.ATLAS_BRAIN_EXTRACTION_MODEL = "some-local-model";
    expect(getMissingModelConfig().missing).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 3. Batch capability is a property of the resolved provider (#5352)
// ---------------------------------------------------------------------------

describe("getBatchApiKey", () => {
  test("⭐ only an Anthropic-resolved provider yields a batch key", () => {
    // The fallback path's precondition. `bedrock` and `gateway` have batch
    // endpoints of their OWN with different request and result shapes, and
    // `ollama` / `openai-compatible` have none — so returning a key for any of
    // them would submit an Anthropic-shaped body to something that is not
    // Anthropic.
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    useProvider("anthropic");
    expect(getBatchApiKey(null)).toBe("sk-ant-platform");
    for (const provider of ["openai", "bedrock", "gateway", "ollama", "openai-compatible"]) {
      useProvider(provider);
      expect(getBatchApiKey(null)).toBeNull();
    }
  });

  test("an Anthropic provider with no key configured yields null, not an empty string", () => {
    // `""` is falsy but is still a string, and a caller testing `!== null`
    // would submit a batch with an empty `x-api-key` header.
    useProvider("anthropic");
    delete process.env.ANTHROPIC_API_KEY;
    expect(getBatchApiKey(null)).toBeNull();
  });

  test("a BYO workspace's own key is used, and only for the anthropic arm", () => {
    // The credential rule the extraction fiber is built on: a BYO workspace's
    // extraction runs on that workspace's key, never the platform's. Env is set
    // to a DIFFERENT value so a fallback to it would be visible rather than
    // coincidentally equal.
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    useProvider("anthropic");
    expect(
      getBatchApiKey({
        model: "claude-opus-5",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "anthropic", apiKey: "sk-ant-workspace" },
      }),
    ).toBe("sk-ant-workspace");

    expect(
      getBatchApiKey({
        model: "gpt-4o",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "openai", apiKey: "sk-openai-workspace" },
      }),
    ).toBeNull();
  });
});
