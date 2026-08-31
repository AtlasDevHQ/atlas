import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resetAuthModeCache } from "@atlas/api/lib/auth/detect";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { mockIsSupportedProvider, mockGetMissingProviderConfig } from "./provider-config-mock";

// ---------------------------------------------------------------------------
// Mock heavy I/O modules so validateEnvironment() skips DB/filesystem checks
// and we can focus on action framework diagnostics (section 7).
// ---------------------------------------------------------------------------

void mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => ["orders.yml"],
}));

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    resolveDatasourceUrl: () => process.env.ATLAS_DATASOURCE_URL || null,
  }),
);

void mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
  // Required-config SSOT (#3200) — startup.ts's checkProviderApiKey consumes the
  // set-based check; shared fixture mirrors real providers.ts semantics.
  isSupportedProvider: mockIsSupportedProvider,
  getMissingProviderConfig: mockGetMissingProviderConfig,
  // PROVIDER_KEY_MAP retained for the display/signup-URL mirror (#3178).
  PROVIDER_KEY_MAP: {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    bedrock: "AWS_ACCESS_KEY_ID",
    ollama: "",
    gateway: "AI_GATEWAY_API_KEY",
  },
}));

void mock.module("@atlas/api/lib/tools/explore-nsjail", () => ({
  findNsjailBinary: () => null,
  testNsjailCapabilities: async () => ({ ok: true }),
  isNsjailAvailable: () => false,
}));

void mock.module("@atlas/api/lib/tools/explore", () => ({
  markNsjailFailed: () => {},
  markSidecarFailed: () => {},
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  invalidateExploreBackend: () => {},
}));

void mock.module("@atlas/api/lib/auth/migrate", () => ({
  getMigrationError: () => null,
}));

// No registry mock: startup.ts stopped importing `tools/registry` entirely
// when the validateActionCredentials diagnostic was deleted (ADR-0046
// cleanup), and a partial mock of a module nothing in the reachable graph
// imports is exactly the "mock all exports" trap lying in wait for the next
// import to walk into.

// Mock the config module so we can control getConfig()
let mockConfig: Record<string, unknown> | null = null;

void mock.module("@atlas/api/lib/config", () => ({
  getConfig: () => mockConfig,
  loadConfig: async () => {
    mockConfig = { source: "env" };
    return mockConfig;
  },
}));

const { validateEnvironment, getStartupWarnings, resetStartupCache } =
  await import("@atlas/api/lib/startup");

// ---------------------------------------------------------------------------
// Env snapshot — capture/restore only the vars this test touches
// ---------------------------------------------------------------------------

const MANAGED_VARS = [
  "ATLAS_DATASOURCE_URL",
  "DATABASE_URL",
  "ATLAS_API_KEY",
  "ATLAS_PROVIDER",
  "ATLAS_ACTIONS_ENABLED",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "ATLAS_AUTH_JWKS_URL",
  "ATLAS_AUTH_ISSUER",
  "ATLAS_AUTH_AUDIENCE",
  "ATLAS_SANDBOX",
  "ATLAS_SANDBOX_URL",
  "ATLAS_RUNTIME",
  "VERCEL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MANAGED_VARS) {
    saved[key] = process.env[key];
  }
  resetStartupCache();
  resetAuthModeCache();

  // Minimal env to pass unrelated checks (datasource, API key, semantic, etc.)
  // ATLAS_DATASOURCE_URL unset → just a warning, not an error
  delete process.env.ATLAS_DATASOURCE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.ATLAS_API_KEY;
  delete process.env.ATLAS_ACTIONS_ENABLED;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  delete process.env.ATLAS_AUTH_JWKS_URL;
  delete process.env.ATLAS_AUTH_ISSUER;
  delete process.env.ATLAS_AUTH_AUDIENCE;
  delete process.env.ATLAS_SANDBOX;
  delete process.env.ATLAS_SANDBOX_URL;
  delete process.env.ATLAS_RUNTIME;
  delete process.env.VERCEL;
  process.env.ATLAS_PROVIDER = "ollama"; // No API key required

  // Reset mock defaults
  mockConfig = null;
});

afterEach(() => {
  for (const key of MANAGED_VARS) {
    if (saved[key] !== undefined) process.env[key] = saved[key];
    else delete process.env[key];
  }
  resetStartupCache();
  resetAuthModeCache();
});

// ---------------------------------------------------------------------------
// Helper — filter for action-specific diagnostic codes only
// ---------------------------------------------------------------------------

const ACTION_CODES = ["ACTIONS_REQUIRE_AUTH", "ACTIONS_MISSING_CREDENTIALS"];

function actionErrors(errors: { code: string; message: string }[]) {
  return errors.filter((e) => ACTION_CODES.includes(e.code));
}

function actionWarnings(warnings: readonly string[]) {
  return warnings.filter(
    (w) =>
      w.includes("Action framework") ||
      w.includes("auto-approve"),
  );
}

// ---------------------------------------------------------------------------
// ATLAS_ACTIONS_ENABLED not set — no action diagnostics
// ---------------------------------------------------------------------------

describe("action diagnostics — disabled (default)", () => {
  it("produces no action errors when ATLAS_ACTIONS_ENABLED is not set", async () => {
    delete process.env.ATLAS_ACTIONS_ENABLED;

    const errors = await validateEnvironment();
    expect(actionErrors(errors)).toEqual([]);
  });

  it("produces no action errors when ATLAS_ACTIONS_ENABLED is 'false'", async () => {
    process.env.ATLAS_ACTIONS_ENABLED = "false";

    const errors = await validateEnvironment();
    expect(actionErrors(errors)).toEqual([]);
  });

  it("produces no action warnings when ATLAS_ACTIONS_ENABLED is not set", async () => {
    delete process.env.ATLAS_ACTIONS_ENABLED;

    await validateEnvironment();
    expect(actionWarnings(getStartupWarnings())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ATLAS_ACTIONS_ENABLED=true with auth mode "none" → ACTIONS_REQUIRE_AUTH
// ---------------------------------------------------------------------------

describe("action diagnostics — actions require auth", () => {
  beforeEach(() => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    // Ensure auth mode is "none": no ATLAS_API_KEY, BETTER_AUTH_SECRET, or ATLAS_AUTH_JWKS_URL
    delete process.env.ATLAS_API_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_AUTH_JWKS_URL;
  });

  it("reports ACTIONS_REQUIRE_AUTH when auth mode is 'none'", async () => {
    const errors = await validateEnvironment();
    const authRequired = actionErrors(errors).find(
      (e) => e.code === "ACTIONS_REQUIRE_AUTH",
    );
    expect(authRequired).toBeDefined();
    expect(authRequired!.message).toContain("authentication");
  });

  it("ACTIONS_REQUIRE_AUTH message mentions all three auth options", async () => {
    const errors = await validateEnvironment();
    const authRequired = actionErrors(errors).find(
      (e) => e.code === "ACTIONS_REQUIRE_AUTH",
    );
    expect(authRequired).toBeDefined();
    expect(authRequired!.message).toContain("ATLAS_API_KEY");
    expect(authRequired!.message).toContain("BETTER_AUTH_SECRET");
    expect(authRequired!.message).toContain("ATLAS_AUTH_JWKS_URL");
  });
});

// ---------------------------------------------------------------------------
// ATLAS_ACTIONS_ENABLED=true with auth configured → no ACTIONS_REQUIRE_AUTH
// ---------------------------------------------------------------------------

describe("action diagnostics — auth satisfied", () => {
  beforeEach(() => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
  });

  it("no ACTIONS_REQUIRE_AUTH when ATLAS_API_KEY is set (simple-key)", async () => {
    process.env.ATLAS_API_KEY = "test-key-123";

    const errors = await validateEnvironment();
    expect(actionErrors(errors).some((e) => e.code === "ACTIONS_REQUIRE_AUTH")).toBe(false);
  });

  it("no ACTIONS_REQUIRE_AUTH when BETTER_AUTH_SECRET is set (managed)", async () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);

    const errors = await validateEnvironment();
    expect(actionErrors(errors).some((e) => e.code === "ACTIONS_REQUIRE_AUTH")).toBe(false);
  });

  it("no ACTIONS_REQUIRE_AUTH when ATLAS_AUTH_JWKS_URL is set (byot)", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://idp.example.com/.well-known/jwks.json";
    process.env.ATLAS_AUTH_ISSUER = "https://idp.example.com/";

    const errors = await validateEnvironment();
    expect(actionErrors(errors).some((e) => e.code === "ACTIONS_REQUIRE_AUTH")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ATLAS_ACTIONS_ENABLED=true — missing credentials for registered actions
// ---------------------------------------------------------------------------

// The "missing credentials" and "#3905 deploy-mode gate" describes lived here
// until ADR-0046's cleanup pass: they scripted validateActionCredentials(),
// the process-wide env diagnostic whose every live subject now declares
// `requiredCredentials: []`. The validator and its startup block are deleted
// — per-workspace configuration status is `getActionTargetStatus`'s job,
// covered in credentials/__tests__/resolver.test.ts.

// ---------------------------------------------------------------------------
// ATLAS_ACTIONS_ENABLED=true without DATABASE_URL — persistent tracking warning
// ---------------------------------------------------------------------------

describe("action diagnostics — DATABASE_URL warning", () => {
  beforeEach(() => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_API_KEY = "test-key-123"; // satisfy auth requirement
  });

  it("warns about in-memory storage when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some(
        (w) =>
          w.includes("Action framework requires DATABASE_URL") &&
          w.includes("in-memory storage"),
      ),
    ).toBe(true);
  });

  it("no action DATABASE_URL warning when DATABASE_URL is set", async () => {
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/atlas";

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some(
        (w) =>
          w.includes("Action framework requires DATABASE_URL") &&
          w.includes("in-memory storage"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ATLAS_ACTIONS_ENABLED=true — high-risk auto-approve warnings
// ---------------------------------------------------------------------------

describe("action diagnostics — high-risk auto-approve warnings", () => {
  beforeEach(() => {
    process.env.ATLAS_ACTIONS_ENABLED = "true";
    process.env.ATLAS_API_KEY = "test-key-123"; // satisfy auth requirement
  });

  it("warns when a high-risk action is configured for auto-approve", async () => {
    mockConfig = {
      actions: {
        "email:send": { approval: "auto" },
      },
    };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some(
        (w) => w.includes("email:send") && w.includes("auto-approve"),
      ),
    ).toBe(true);
  });

  it("warns when jira:create is configured for auto-approve", async () => {
    mockConfig = {
      actions: {
        "jira:create": { approval: "auto" },
      },
    };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some(
        (w) => w.includes("jira:create") && w.includes("auto-approve"),
      ),
    ).toBe(true);
  });

  it("warns when linear:create is configured for auto-approve", async () => {
    // #5554 — same risk class as `jira:create`: an external write, reversible
    // only on paper, manual by default. A target added to `ACTION_TARGETS`
    // without being added to `highRiskActions` would silently lose this
    // warning while its Jira twin kept it.
    mockConfig = {
      actions: {
        "linear:create": { approval: "auto" },
      },
    };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some(
        (w) => w.includes("linear:create") && w.includes("auto-approve"),
      ),
    ).toBe(true);
  });

  it("warns for multiple high-risk actions configured for auto-approve", async () => {
    mockConfig = {
      actions: {
        "email:send": { approval: "auto" },
        "jira:create": { approval: "auto" },
        "linear:create": { approval: "auto" },
        "salesforce:update": { approval: "auto" },
        "salesforce:create": { approval: "auto" },
      },
    };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.filter((w) => w.includes("auto-approve")).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it("no auto-approve warning when high-risk action uses manual approval", async () => {
    mockConfig = {
      actions: {
        "email:send": { approval: "manual" },
      },
    };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some(
        (w) => w.includes("email:send") && w.includes("auto-approve"),
      ),
    ).toBe(false);
  });

  it("no auto-approve warning when config has no actions section", async () => {
    mockConfig = {};

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("auto-approve")),
    ).toBe(false);
  });

  it("no auto-approve warning when config is null", async () => {
    mockConfig = null;

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("auto-approve")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge case: actions disabled does not trigger any action-specific checks
// ---------------------------------------------------------------------------

describe("action diagnostics — edge cases", () => {
  it("no action errors even with auth mode 'none' when actions are disabled", async () => {
    delete process.env.ATLAS_ACTIONS_ENABLED;
    delete process.env.ATLAS_API_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_AUTH_JWKS_URL;

    const errors = await validateEnvironment();
    expect(actionErrors(errors)).toEqual([]);
  });

  it("no action DATABASE_URL warning when actions are disabled", async () => {
    delete process.env.ATLAS_ACTIONS_ENABLED;
    delete process.env.DATABASE_URL;

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("Action framework requires DATABASE_URL")),
    ).toBe(false);
  });

});
