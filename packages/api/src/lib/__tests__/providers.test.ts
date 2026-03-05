import { describe, expect, test, afterEach } from "bun:test";

// Import after mocks — getProviderType reads process.env at call time, so no
// module-level mocking is needed.
const { getProviderType } = await import("@atlas/api/lib/providers");

// ---------------------------------------------------------------------------
// Env snapshot — capture/restore only the vars this test touches
// ---------------------------------------------------------------------------

const origProvider = process.env.ATLAS_PROVIDER;
const origModel = process.env.ATLAS_MODEL;

afterEach(() => {
  if (origProvider !== undefined) process.env.ATLAS_PROVIDER = origProvider;
  else delete process.env.ATLAS_PROVIDER;

  if (origModel !== undefined) process.env.ATLAS_MODEL = origModel;
  else delete process.env.ATLAS_MODEL;
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

  // --- Invalid provider ----------------------------------------------------

  test("throws for an invalid provider string", () => {
    process.env.ATLAS_PROVIDER = "typo-provider";
    expect(() => getProviderType()).toThrow(Error);
  });
});
