/**
 * #4824 — when the backend cannot be resolved at all, boot must NOT fall back
 * to asserting "no process isolation".
 *
 * `logResolvedExploreBackend()` wraps its resolution in a try/catch. The
 * tempting "helpful" edit is to log the just-bash line from that catch so boot
 * always says something — which reintroduces #4824 by a new route: a failure to
 * RESOLVE the backend is not evidence that the deployment is unsandboxed, and
 * that string is what a security review greps for.
 *
 * Its own file because it needs `lib/tools/explore` to throw on import, which
 * is incompatible with the sibling suites that drive the real module.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { mockIsSupportedProvider, mockGetMissingProviderConfig } from "./provider-config-mock";

const logCalls: unknown[][] = [];
const record = () => (...args: unknown[]) => {
  logCalls.push(args);
};
const captureLogger = {
  debug: record(),
  info: record(),
  warn: record(),
  error: record(),
  child: () => captureLogger,
};

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => captureLogger,
  getLogger: () => captureLogger,
  getRequestContext: () => undefined,
}));

void mock.module("fs", () => ({
  existsSync: () => false,
  readdirSync: () => ["orders.yml"],
  constants: { F_OK: 0, W_OK: 2, R_OK: 4, X_OK: 1 },
  accessSync: () => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  },
}));

void mock.module("@atlas/api/lib/db/connection", () =>
  createConnectionMock({
    resolveDatasourceUrl: () => process.env.ATLAS_DATASOURCE_URL || null,
  }),
);

void mock.module("@atlas/api/lib/providers", () => ({
  getDefaultProvider: () => "anthropic",
  isSupportedProvider: mockIsSupportedProvider,
  getMissingProviderConfig: mockGetMissingProviderConfig,
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
  isNsjailAvailable: () => false,
  testNsjailCapabilities: async () => ({ ok: true }),
  createNsjailBackend: async () => {
    throw new Error("not used in this test");
  },
}));

// The resolution seam itself fails — e.g. a malformed sandbox.priority, or a
// module-init failure anywhere in explore's transitive graph.
void mock.module("@atlas/api/lib/tools/explore", () => ({
  get getExploreBackendType(): never {
    throw new Error("explore module failed to initialize");
  },
  get BACKEND_ISOLATION(): never {
    throw new Error("explore module failed to initialize");
  },
  markNsjailFailed: () => {},
  markSidecarFailed: () => {},
  getActiveSandboxPluginId: () => null,
  invalidateExploreBackend: () => {},
  snapshotExploreSandboxEnv: () => ({}),
}));

const { validateEnvironment, resetStartupCache, getStartupWarnings } = await import(
  "@atlas/api/lib/startup"
);
const { _resetConfig } = await import("@atlas/api/lib/config");

describe("unresolvable explore backend (#4824)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    _resetConfig();
    resetStartupCache();
    logCalls.length = 0;
    process.env.PATH = "";
    delete process.env.ATLAS_SANDBOX;
    delete process.env.ATLAS_SANDBOX_URL;
    delete process.env.ATLAS_RUNTIME;
    delete process.env.VERCEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetConfig();
    resetStartupCache();
  });

  it("does not claim 'no process isolation' when the backend cannot be resolved", async () => {
    await validateEnvironment();

    expect(
      logCalls.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("no process isolation")),
      ),
    ).toBe(false);
    expect(
      logCalls.some((args) =>
        args.some((a) => typeof a === "string" && a.startsWith("Explore tool:")),
      ),
    ).toBe(false);
  });

  it("surfaces the unknown posture as a startup warning", async () => {
    await validateEnvironment();

    // Silence would be worse than a wrong line: /api/health resolves the backend
    // through the same seam, so this failure breaks its reporting too.
    expect(
      getStartupWarnings().some(
        (w) => w.includes("Could not resolve") && w.includes("UNKNOWN"),
      ),
    ).toBe(true);
  });
});
