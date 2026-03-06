import { describe, it, expect, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { resetAuthModeCache } from "@atlas/api/lib/auth/detect";

// ---------------------------------------------------------------------------
// Mock heavy I/O modules so validateEnvironment() skips DB/filesystem checks
// and we can focus on auth diagnostics.
// ---------------------------------------------------------------------------

// Mock fs — semantic layer check passes, container detection skipped
mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => ["orders.yml"],
}));

// Mock db/connection — avoid real DB imports
mock.module("@atlas/api/lib/db/connection", () => ({
  detectDBType: () => "postgres",
  resolveDatasourceUrl: () => process.env.ATLAS_DATASOURCE_URL || null,
}));

mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
}));

// Mock explore-nsjail — controllable sandbox capability check
let mockNsjailBinaryPath: string | null = null;
let mockCapabilityResult: { ok: boolean; error?: string } = { ok: true };

mock.module("@atlas/api/lib/tools/explore-nsjail", () => ({
  findNsjailBinary: () => mockNsjailBinaryPath,
  testNsjailCapabilities: async () => mockCapabilityResult,
  isNsjailAvailable: () => mockNsjailBinaryPath !== null,
}));

// Mock explore — track markNsjailFailed and markSidecarFailed calls
let mockMarkNsjailFailedCalled = false;
let mockMarkSidecarFailedCalled = false;

mock.module("@atlas/api/lib/tools/explore", () => ({
  markNsjailFailed: () => { mockMarkNsjailFailedCalled = true; },
  markSidecarFailed: () => { mockMarkSidecarFailedCalled = true; },
  getExploreBackendType: () => "just-bash",
  getActiveSandboxPluginId: () => null,
  invalidateExploreBackend: () => {},
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

  // Set the minimum env so the first 5 checks pass (datasource, API key,
  // semantic layer, DB connectivity, internal DB). We only test auth checks.
  // ATLAS_DATASOURCE_URL unset → just a warning, not an error
  delete process.env.ATLAS_DATASOURCE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.ATLAS_API_KEY;
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

  // Reset sandbox mock defaults
  mockNsjailBinaryPath = null;
  mockCapabilityResult = { ok: true };
  mockMarkNsjailFailedCalled = false;
  mockMarkSidecarFailedCalled = false;
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
// Auth mode: none — no auth-specific diagnostics
// ---------------------------------------------------------------------------

describe("auth diagnostics — mode none", () => {
  it("produces no auth errors when no auth env vars are set", async () => {
    delete process.env.ATLAS_API_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_AUTH_JWKS_URL;
    delete process.env.ATLAS_AUTH_ISSUER;

    const errors = await validateEnvironment();
    const authCodes = errors
      .map((e) => e.code)
      .filter((c) =>
        ["WEAK_AUTH_SECRET", "INVALID_JWKS_URL", "MISSING_AUTH_ISSUER"].includes(c),
      );
    expect(authCodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Auth mode: simple-key — no auth-specific diagnostics
// ---------------------------------------------------------------------------

describe("auth diagnostics — mode simple-key", () => {
  it("produces no auth errors when ATLAS_API_KEY is set", async () => {
    process.env.ATLAS_API_KEY = "test-key-123";

    const errors = await validateEnvironment();
    const authCodes = errors
      .map((e) => e.code)
      .filter((c) =>
        ["WEAK_AUTH_SECRET", "INVALID_JWKS_URL", "MISSING_AUTH_ISSUER"].includes(c),
      );
    expect(authCodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Auth mode: managed — BETTER_AUTH_SECRET checks
// ---------------------------------------------------------------------------

describe("auth diagnostics — mode managed", () => {
  beforeEach(() => {
    delete process.env.ATLAS_API_KEY;
    delete process.env.ATLAS_AUTH_JWKS_URL;
    delete process.env.ATLAS_AUTH_ISSUER;
  });

  it("reports WEAK_AUTH_SECRET when secret is shorter than 32 chars", async () => {
    process.env.BETTER_AUTH_SECRET = "too-short";

    const errors = await validateEnvironment();
    const weak = errors.find((e) => e.code === "WEAK_AUTH_SECRET");
    expect(weak).toBeDefined();
    expect(weak!.message).toContain("32 characters");
  });

  it("reports WEAK_AUTH_SECRET when secret is exactly 31 chars", async () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(31);

    const errors = await validateEnvironment();
    expect(errors.some((e) => e.code === "WEAK_AUTH_SECRET")).toBe(true);
  });

  it("no WEAK_AUTH_SECRET when secret is exactly 32 chars", async () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);

    const errors = await validateEnvironment();
    expect(errors.some((e) => e.code === "WEAK_AUTH_SECRET")).toBe(false);
  });

  it("no WEAK_AUTH_SECRET when secret is longer than 32 chars", async () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(64);

    const errors = await validateEnvironment();
    expect(errors.some((e) => e.code === "WEAK_AUTH_SECRET")).toBe(false);
  });

  it("adds MISSING_AUTH_URL warning when BETTER_AUTH_URL not set", async () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    delete process.env.BETTER_AUTH_URL;

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(warnings.some((w) => w.includes("BETTER_AUTH_URL"))).toBe(true);
  });

  it("no MISSING_AUTH_URL warning when BETTER_AUTH_URL is set", async () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    process.env.BETTER_AUTH_URL = "https://atlas.example.com";

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(warnings.some((w) => w.includes("BETTER_AUTH_URL"))).toBe(false);
  });

  it("reports INTERNAL_DB_UNREACHABLE when DATABASE_URL is not set", async () => {
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    delete process.env.DATABASE_URL;

    const errors = await validateEnvironment();
    const dbErr = errors.find((e) => e.code === "INTERNAL_DB_UNREACHABLE");
    expect(dbErr).toBeDefined();
    expect(dbErr!.message).toContain("session storage");
  });
});

// ---------------------------------------------------------------------------
// Auth mode: byot — JWKS + issuer checks
// ---------------------------------------------------------------------------

describe("auth diagnostics — mode byot", () => {
  beforeEach(() => {
    delete process.env.ATLAS_API_KEY;
    delete process.env.BETTER_AUTH_SECRET;
  });

  it("reports INVALID_JWKS_URL when URL is not valid", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "not-a-url";
    process.env.ATLAS_AUTH_ISSUER = "https://idp.example.com/";

    const errors = await validateEnvironment();
    const invalid = errors.find((e) => e.code === "INVALID_JWKS_URL");
    expect(invalid).toBeDefined();
    expect(invalid!.message).toContain("not a valid URL");
  });

  it("no INVALID_JWKS_URL when URL is valid", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://idp.example.com/.well-known/jwks.json";
    process.env.ATLAS_AUTH_ISSUER = "https://idp.example.com/";

    const errors = await validateEnvironment();
    expect(errors.some((e) => e.code === "INVALID_JWKS_URL")).toBe(false);
  });

  it("reports MISSING_AUTH_ISSUER when ATLAS_AUTH_ISSUER not set", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://idp.example.com/.well-known/jwks.json";
    delete process.env.ATLAS_AUTH_ISSUER;

    const errors = await validateEnvironment();
    const missing = errors.find((e) => e.code === "MISSING_AUTH_ISSUER");
    expect(missing).toBeDefined();
    expect(missing!.message).toContain("ATLAS_AUTH_ISSUER");
  });

  it("no MISSING_AUTH_ISSUER when ATLAS_AUTH_ISSUER is set", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "https://idp.example.com/.well-known/jwks.json";
    process.env.ATLAS_AUTH_ISSUER = "https://idp.example.com/";

    const errors = await validateEnvironment();
    expect(errors.some((e) => e.code === "MISSING_AUTH_ISSUER")).toBe(false);
  });

  it("reports both INVALID_JWKS_URL and MISSING_AUTH_ISSUER when both are wrong", async () => {
    process.env.ATLAS_AUTH_JWKS_URL = "not-a-url";
    delete process.env.ATLAS_AUTH_ISSUER;

    const errors = await validateEnvironment();
    const codes = errors.map((e) => e.code);
    expect(codes).toContain("INVALID_JWKS_URL");
    expect(codes).toContain("MISSING_AUTH_ISSUER");
  });
});

// ---------------------------------------------------------------------------
// Orphaned auth env var warnings
// ---------------------------------------------------------------------------

describe("auth diagnostics — orphaned env var warnings", () => {
  beforeEach(() => {
    delete process.env.ATLAS_API_KEY;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.ATLAS_AUTH_JWKS_URL;
    delete process.env.ATLAS_AUTH_ISSUER;
    delete process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  });

  it("warns about orphaned ATLAS_AUTH_ISSUER when BYOT not active", async () => {
    process.env.ATLAS_AUTH_ISSUER = "https://idp.example.com/";
    // ATLAS_AUTH_JWKS_URL not set → auth mode is "none", not "byot"

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(warnings.some((w) => w.includes("BYOT auth mode is not active"))).toBe(true);
  });

  it("warns about orphaned BETTER_AUTH_URL when managed not active", async () => {
    process.env.BETTER_AUTH_URL = "https://atlas.example.com";
    // BETTER_AUTH_SECRET not set → auth mode is "none", not "managed"

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(warnings.some((w) => w.includes("managed auth mode is not active"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sandbox pre-flight diagnostics
// ---------------------------------------------------------------------------

describe("sandbox diagnostics", () => {
  beforeEach(() => {
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
  });

  it("no sandbox warning when nsjail found and capabilities pass", async () => {
    mockNsjailBinaryPath = "/usr/local/bin/nsjail";
    mockCapabilityResult = { ok: true };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(warnings.some((w) => w.includes("nsjail"))).toBe(false);
    expect(warnings.some((w) => w.includes("just-bash"))).toBe(false);
    expect(mockMarkNsjailFailedCalled).toBe(false);
  });

  it("warns when nsjail available but capabilities fail (auto-detected)", async () => {
    mockNsjailBinaryPath = "/usr/local/bin/nsjail";
    mockCapabilityResult = { ok: false, error: "clone failed: EPERM" };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("namespace creation failed") && w.includes("falling back to just-bash")),
    ).toBe(true);
    expect(mockMarkNsjailFailedCalled).toBe(true);
  });

  it("warns with explicit message when ATLAS_SANDBOX=nsjail and capabilities fail", async () => {
    process.env.ATLAS_SANDBOX = "nsjail";
    mockNsjailBinaryPath = "/usr/local/bin/nsjail";
    mockCapabilityResult = { ok: false, error: "clone failed: EPERM" };

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("nsjail explicitly requested") && w.includes("ATLAS_SANDBOX=")),
    ).toBe(true);
    expect(mockMarkNsjailFailedCalled).toBe(true);
  });

  it("warns when ATLAS_SANDBOX=nsjail but binary not found", async () => {
    process.env.ATLAS_SANDBOX = "nsjail";
    mockNsjailBinaryPath = null;

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("nsjail binary was not found")),
    ).toBe(true);
  });

  it("no sandbox warning on Vercel runtime", async () => {
    process.env.VERCEL = "1";
    mockNsjailBinaryPath = null; // no nsjail on Vercel

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(warnings.some((w) => w.includes("nsjail"))).toBe(false);
    expect(warnings.some((w) => w.includes("just-bash"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sidecar diagnostics
// ---------------------------------------------------------------------------

describe("sidecar diagnostics", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: Mock<typeof globalThis.fetch>;

  beforeEach(() => {
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
    // nsjail not available — sidecar path is reachable
    mockNsjailBinaryPath = null;

    mockFetch = mock() as unknown as Mock<typeof globalThis.fetch>;
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("no sidecar warning when ATLAS_SANDBOX_URL set and sidecar healthy", async () => {
    process.env.ATLAS_SANDBOX_URL = "http://sandbox-sidecar:8080";
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(warnings.some((w) => w.includes("Sidecar"))).toBe(false);
    expect(mockMarkSidecarFailedCalled).toBe(false);
  });

  it("warns when ATLAS_SANDBOX_URL set and sidecar returns HTTP 500", async () => {
    process.env.ATLAS_SANDBOX_URL = "http://sandbox-sidecar:8080";
    mockFetch.mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("Sidecar health check returned HTTP 500")),
    ).toBe(true);
    expect(mockMarkSidecarFailedCalled).toBe(true);
  });

  it("warns when ATLAS_SANDBOX_URL set and sidecar unreachable", async () => {
    process.env.ATLAS_SANDBOX_URL = "http://sandbox-sidecar:8080";
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8080"));

    await validateEnvironment();
    const warnings = getStartupWarnings();
    expect(
      warnings.some((w) => w.includes("Sidecar unreachable") && w.includes("ECONNREFUSED")),
    ).toBe(true);
    expect(mockMarkSidecarFailedCalled).toBe(true);
  });

  it("skips nsjail probe when ATLAS_SANDBOX_URL is set (no namespace warnings)", async () => {
    process.env.ATLAS_SANDBOX_URL = "http://sandbox-sidecar:8080";
    // nsjail binary is "available" — but should never be probed
    mockNsjailBinaryPath = "/usr/local/bin/nsjail";
    mockCapabilityResult = { ok: false, error: "clone failed: EPERM" };
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );

    await validateEnvironment();
    const warnings = getStartupWarnings();
    // No nsjail warnings — sidecar path was taken, nsjail was never probed
    expect(warnings.some((w) => w.includes("nsjail"))).toBe(false);
    expect(warnings.some((w) => w.includes("namespace"))).toBe(false);
    expect(mockMarkNsjailFailedCalled).toBe(false);
    expect(mockMarkSidecarFailedCalled).toBe(false);
  });

  it("does not attempt sidecar health check when ATLAS_SANDBOX_URL not set", async () => {
    delete process.env.ATLAS_SANDBOX_URL;

    await validateEnvironment();
    // fetch should not have been called for a sidecar health check
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockMarkSidecarFailedCalled).toBe(false);
  });
});
