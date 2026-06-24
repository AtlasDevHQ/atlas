import { describe, expect, test, afterEach } from "bun:test";

// #3931 — configurable demo model. getDemoModelId / resolveDemoAiModel read
// process.env + the settings registry at call time, so no module-level mocking
// is needed — set/restore the vars each test touches.
const { getDemoModelId, demoRunAgentModelParams } = await import("@atlas/api/lib/demo");

// ---------------------------------------------------------------------------
// Env snapshot — capture/restore only the vars these tests touch
// ---------------------------------------------------------------------------

const origDemoModel = process.env.ATLAS_DEMO_MODEL;
const origProvider = process.env.ATLAS_PROVIDER;
const origModel = process.env.ATLAS_MODEL;
const origVercel = process.env.VERCEL;
const origDeployMode = process.env.ATLAS_DEPLOY_MODE;
const origGatewayKey = process.env.AI_GATEWAY_API_KEY;

function restore(key: string, orig: string | undefined): void {
  if (orig !== undefined) process.env[key] = orig;
  else delete process.env[key];
}

afterEach(() => {
  restore("ATLAS_DEMO_MODEL", origDemoModel);
  restore("ATLAS_PROVIDER", origProvider);
  restore("ATLAS_MODEL", origModel);
  restore("VERCEL", origVercel);
  restore("ATLAS_DEPLOY_MODE", origDeployMode);
  restore("AI_GATEWAY_API_KEY", origGatewayKey);
});

// ---------------------------------------------------------------------------
// getDemoModelId — pure model-id resolution (no SDK client built)
// ---------------------------------------------------------------------------

describe("getDemoModelId", () => {
  test("unset + gateway provider → Haiku gateway model", () => {
    delete process.env.ATLAS_DEMO_MODEL;
    process.env.ATLAS_PROVIDER = "gateway";
    expect(getDemoModelId()).toBe("anthropic/claude-haiku-4.5");
  });

  test("unset + gateway via SaaS deploy mode (no explicit provider) → Haiku", () => {
    delete process.env.ATLAS_DEMO_MODEL;
    delete process.env.ATLAS_PROVIDER;
    delete process.env.VERCEL;
    process.env.ATLAS_DEPLOY_MODE = "saas";
    expect(getDemoModelId()).toBe("anthropic/claude-haiku-4.5");
  });

  test("unset + non-gateway provider → null (platform default, no self-hosted regression)", () => {
    delete process.env.ATLAS_DEMO_MODEL;
    process.env.ATLAS_PROVIDER = "anthropic";
    expect(getDemoModelId()).toBeNull();
  });

  test("unset + no provider, no SaaS markers → null (self-hosted default is anthropic)", () => {
    delete process.env.ATLAS_DEMO_MODEL;
    delete process.env.ATLAS_PROVIDER;
    delete process.env.VERCEL;
    delete process.env.ATLAS_DEPLOY_MODE;
    expect(getDemoModelId()).toBeNull();
  });

  test("ATLAS_DEMO_MODEL set → returned verbatim, overriding the provider default", () => {
    process.env.ATLAS_DEMO_MODEL = "anthropic/claude-sonnet-4.6";
    process.env.ATLAS_PROVIDER = "gateway";
    expect(getDemoModelId()).toBe("anthropic/claude-sonnet-4.6");
  });

  test("ATLAS_DEMO_MODEL set → honored even on a non-gateway provider", () => {
    process.env.ATLAS_DEMO_MODEL = "claude-haiku-4-5";
    process.env.ATLAS_PROVIDER = "anthropic";
    expect(getDemoModelId()).toBe("claude-haiku-4-5");
  });

  test("blank / whitespace-only ATLAS_DEMO_MODEL is treated as unset", () => {
    process.env.ATLAS_DEMO_MODEL = "   ";
    process.env.ATLAS_PROVIDER = "anthropic";
    expect(getDemoModelId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// demoRunAgentModelParams — the runAgent({ aiModel? }) fragment the demo route
// spreads. Directly covers the inject-or-omit wiring (acceptance: demo turns
// use the configured model via runAgent({ aiModel }); token_usage reflects it).
// ---------------------------------------------------------------------------

describe("demoRunAgentModelParams", () => {
  test("gateway default → { aiModel } with the Haiku gateway model + gateway providerType", () => {
    delete process.env.ATLAS_DEMO_MODEL;
    process.env.ATLAS_PROVIDER = "gateway";
    process.env.AI_GATEWAY_API_KEY = "test-key"; // buildModel asserts presence, not validity

    const params = demoRunAgentModelParams();
    expect(params.aiModel).toBeDefined();
    expect(params.aiModel?.modelId).toBe("anthropic/claude-haiku-4.5");
    expect(params.aiModel?.providerType).toBe("gateway");
  });

  test("explicit ATLAS_DEMO_MODEL on gateway → { aiModel } with that model id", () => {
    process.env.ATLAS_DEMO_MODEL = "anthropic/claude-sonnet-4.6";
    process.env.ATLAS_PROVIDER = "gateway";
    process.env.AI_GATEWAY_API_KEY = "test-key";

    const params = demoRunAgentModelParams();
    expect(params.aiModel?.modelId).toBe("anthropic/claude-sonnet-4.6");
    expect(params.aiModel?.providerType).toBe("gateway");
  });

  test("non-gateway + unset → {} (no aiModel key; runAgent resolves the platform default)", () => {
    delete process.env.ATLAS_DEMO_MODEL;
    process.env.ATLAS_PROVIDER = "anthropic";

    const params = demoRunAgentModelParams();
    // Key genuinely absent (not present-as-undefined) so runAgent falls
    // through to its own platform-default resolution.
    expect("aiModel" in params).toBe(false);
  });
});
