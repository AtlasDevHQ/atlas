import { describe, expect, test, afterEach } from "bun:test";

// Import after mocks — getProviderType reads process.env at call time, so no
// module-level mocking is needed.
const { getProviderType, getDefaultProvider, getModel } = await import("@atlas/api/lib/providers");

// ---------------------------------------------------------------------------
// Env snapshot — capture/restore only the vars this test touches
// ---------------------------------------------------------------------------

const origProvider = process.env.ATLAS_PROVIDER;
const origModel = process.env.ATLAS_MODEL;
const origVercel = process.env.VERCEL;
const origCompatBaseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
const origCompatApiKey = process.env.OPENAI_COMPATIBLE_API_KEY;

afterEach(() => {
  if (origProvider !== undefined) process.env.ATLAS_PROVIDER = origProvider;
  else delete process.env.ATLAS_PROVIDER;

  if (origModel !== undefined) process.env.ATLAS_MODEL = origModel;
  else delete process.env.ATLAS_MODEL;

  if (origVercel !== undefined) process.env.VERCEL = origVercel;
  else delete process.env.VERCEL;

  if (origCompatBaseURL !== undefined) process.env.OPENAI_COMPATIBLE_BASE_URL = origCompatBaseURL;
  else delete process.env.OPENAI_COMPATIBLE_BASE_URL;

  if (origCompatApiKey !== undefined) process.env.OPENAI_COMPATIBLE_API_KEY = origCompatApiKey;
  else delete process.env.OPENAI_COMPATIBLE_API_KEY;
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
  test("returns 'anthropic' when VERCEL is not set", () => {
    delete process.env.VERCEL;
    expect(getDefaultProvider()).toBe("anthropic");
  });

  test("returns 'gateway' when VERCEL is set", () => {
    process.env.VERCEL = "1";
    expect(getDefaultProvider()).toBe("gateway");
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
