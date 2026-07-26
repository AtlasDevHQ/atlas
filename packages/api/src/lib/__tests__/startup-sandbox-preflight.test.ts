/**
 * #4824 — the startup sandbox pre-flight must name the backend the process
 * ACTUALLY uses, and must name the same one `/api/health` reports.
 *
 * The bug: the pre-flight dispatch asked "are we running ON Vercel"
 * (`ATLAS_RUNTIME` / `VERCEL`) rather than "are we USING Vercel Sandbox". Since
 * #2383 a Railway host reaches Vercel Sandbox with `VERCEL_TOKEN` plus a
 * team/project id from env — or, since #3706, from `sandbox.vercel` in
 * atlas.config.ts. That shape sets none of the host-detection vars, so boot
 * fell through to nsjail auto-detect, found no
 * binary, and logged "no process isolation" on every Railway deploy while
 * health correctly reported `vercel-sandbox`. Execution was fine; only the log
 * lied — and it lied in the exact string a security review greps for.
 *
 * These tests drive the REAL `lib/tools/explore` module (not a stub) so the
 * parity assertions compare the pre-flight against the genuine
 * `getExploreBackendType()` that `/api/health` calls, rather than against a
 * mock that could agree with anything.
 *
 * `explore`'s `_nsjailFailed` / `_sidecarFailed` flags are monotonic in
 * production, so several cases here would otherwise leak degradation into the
 * ones after them — and the failure mode is a still-passing test that silently
 * stopped proving anything. `beforeEach` clears them via
 * `_resetSandboxFailureFlagsForTest()`, so NO case depends on test order.
 *
 * The mocked `fs.accessSync` throws for every candidate, so explore's own nsjail
 * binary detection is false on any host, including a dev box with nsjail
 * installed. The `ATLAS_SANDBOX=nsjail` cases short-circuit that detection via
 * the env pin (`useNsjail()` returns true for the pin without probing PATH).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import type { ExploreBackendType } from "@atlas/api/lib/tools/explore";
import { createConnectionMock } from "@atlas/api/testing/connection";
import { mockIsSupportedProvider, mockGetMissingProviderConfig } from "./provider-config-mock";

// ---------------------------------------------------------------------------
// Log capture — startup.ts binds its logger at module load, so this mock must
// be installed before the dynamic import below.
// ---------------------------------------------------------------------------

interface LogCall {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly args: readonly unknown[];
}

const logCalls: LogCall[] = [];

function record(level: LogCall["level"]) {
  return (...args: unknown[]) => {
    logCalls.push({ level, args });
  };
}

const captureLogger = {
  debug: record("debug"),
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
  child: () => captureLogger,
};

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => captureLogger,
  getLogger: () => captureLogger,
  getRequestContext: () => undefined,
}));

// ---------------------------------------------------------------------------
// Heavy I/O mocks so validateEnvironment() reaches the sandbox pre-flight
// without touching a database or the filesystem.
// ---------------------------------------------------------------------------

// findNsjailBinary() walks PATH with accessSync(candidate, constants.X_OK). This
// stub throws ENOENT for every candidate, so detection is null regardless of
// host — the empty PATH in beforeEach is belt-and-braces, not the mechanism.
// Supplying `constants` matters anyway: without it the probe throws a TypeError
// that its catch swallows as "not found", which looks identical but tests
// nothing about the code under test.
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

// The nsjail binary probe the pre-flight drives, controlled per-test. This is a
// SEPARATE seam from explore's own `useNsjail()` detection, which stays real and
// resolves false via the empty PATH — so a test can hand the pre-flight a binary
// without also convincing explore that nsjail is available.
let mockNsjailBinaryPath: string | null = null;
let mockCapabilityResult: { ok: boolean; error?: string } = { ok: true };
let nsjailProbeRan = false;

void mock.module("@atlas/api/lib/tools/explore-nsjail", () => ({
  findNsjailBinary: () => mockNsjailBinaryPath,
  isNsjailAvailable: () => mockNsjailBinaryPath !== null,
  testNsjailCapabilities: async () => {
    nsjailProbeRan = true;
    return mockCapabilityResult;
  },
  createNsjailBackend: async () => {
    throw new Error("not used in this test");
  },
}));

const { validateEnvironment, resetStartupCache } = await import("@atlas/api/lib/startup");
const { getExploreBackendType, snapshotExploreSandboxEnv, _resetSandboxFailureFlagsForTest } =
  await import("@atlas/api/lib/tools/explore");
const { _setConfigForTest, _resetConfig, configFromEnv } = await import(
  "@atlas/api/lib/config"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SANDBOX_VARS = [
  "ATLAS_RUNTIME",
  "VERCEL",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
  "ATLAS_SANDBOX",
  "ATLAS_SANDBOX_URL",
  "ATLAS_SANDBOX_PRIORITY",
  "ATLAS_NSJAIL_PATH",
] as const;

/** The single "Explore tool: …" line the pre-flight emits, or undefined. */
function exploreBackendLine(): LogCall | undefined {
  return logCalls.find((c) =>
    c.args.some((a) => typeof a === "string" && a.startsWith("Explore tool:")),
  );
}

/** The backend name the pre-flight log claims, read from its structured field. */
function loggedBackend(): ExploreBackendType | undefined {
  const meta = exploreBackendLine()?.args[0];
  if (meta && typeof meta === "object" && "backend" in meta && typeof meta.backend === "string") {
    return meta.backend as ExploreBackendType;
  }
  return undefined;
}

/** True when boot asserted the deployment has no process isolation. */
function claimedNoIsolation(): boolean {
  return logCalls.some((c) =>
    c.args.some((a) => typeof a === "string" && a.includes("no process isolation")),
  );
}

/**
 * A `typeof fetch`-compatible stub, built structurally rather than cast: the
 * lib typings carry `preconnect`, so a bare arrow fails the type gate and the
 * usual `as unknown as typeof fetch` would erase future signature changes.
 */
function healthyFetch(): typeof fetch {
  return Object.assign(async () => new Response(null, { status: 200 }), {
    preconnect: () => {},
  });
}

async function runPreFlight(): Promise<void> {
  resetStartupCache();
  logCalls.length = 0;
  nsjailProbeRan = false;
  await validateEnvironment();
}

describe("startup sandbox pre-flight names the resolved backend (#4824)", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetConfig();
    _resetSandboxFailureFlagsForTest();
    for (const v of SANDBOX_VARS) delete process.env[v];
    // nsjail binary deterministically absent for explore's own detection.
    process.env.PATH = "";
    mockNsjailBinaryPath = null;
    mockCapabilityResult = { ok: true };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    _resetConfig();
    resetStartupCache();
  });

  // ── AC1 — the reported bug ────────────────────────────────────────────────

  it("does NOT claim 'no process isolation' on a Railway-shaped Vercel Sandbox deploy", async () => {
    // Railway: Vercel Sandbox reached via env credentials, with none of the
    // on-Vercel host vars set and no nsjail binary anywhere.
    process.env.VERCEL_TEAM_ID = "team_test";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    process.env.VERCEL_TOKEN = "tok_test";

    await runPreFlight();

    expect(claimedNoIsolation()).toBe(false);
    expect(loggedBackend()).toBe("vercel-sandbox");
  });

  it("names vercel-sandbox under the deployed sandbox.priority pin", async () => {
    // Mirrors deploy/api/atlas.config.ts — the pin that makes this the shape
    // actually running on staging and all three prod regions.
    process.env.VERCEL_TEAM_ID = "team_test";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    process.env.VERCEL_TOKEN = "tok_test";
    // A real ResolvedConfig, not a cast-away partial: every required field keeps
    // its default so anything validateEnvironment() reads stays defined, and the
    // priority literal is still checked against SandboxBackendName.
    _setConfigForTest({
      ...configFromEnv(),
      sandbox: {
        priority: ["vercel-sandbox"],
        // Prod resolves team/project from config, not env — only VERCEL_TOKEN
        // is a per-service Railway secret. This mirrors that split.
        vercel: { teamId: "team_test", projectId: "prj_test" },
      },
    });

    await runPreFlight();

    expect(claimedNoIsolation()).toBe(false);
    expect(loggedBackend()).toBe("vercel-sandbox");
  });

  // ── AC2 — deleting the warning is the tempting wrong fix ──────────────────

  it("STILL warns 'no process isolation' on a genuine just-bash deployment", async () => {
    // Bare self-hosted box: no Vercel credentials, no sidecar, no nsjail.
    await runPreFlight();

    expect(loggedBackend()).toBe("just-bash");
    expect(claimedNoIsolation()).toBe(true);
  });

  // ── AC3 — the nsjail and sidecar paths keep working ───────────────────────

  it("names vercel-sandbox when running ON Vercel", async () => {
    process.env.ATLAS_RUNTIME = "vercel";

    await runPreFlight();

    expect(loggedBackend()).toBe("vercel-sandbox");
    expect(claimedNoIsolation()).toBe(false);
  });

  it("names sidecar when a healthy sidecar is configured", async () => {
    process.env.ATLAS_SANDBOX_URL = "http://sidecar.test";
    globalThis.fetch = healthyFetch();

    await runPreFlight();

    expect(loggedBackend()).toBe("sidecar");
    expect(claimedNoIsolation()).toBe(false);
  });

  it("names nsjail when ATLAS_SANDBOX=nsjail and capabilities pass", async () => {
    process.env.ATLAS_SANDBOX = "nsjail";
    mockNsjailBinaryPath = "/usr/local/bin/nsjail";
    mockCapabilityResult = { ok: true };

    await runPreFlight();

    expect(nsjailProbeRan).toBe(true);
    expect(loggedBackend()).toBe("nsjail");
    expect(claimedNoIsolation()).toBe(false);
  });

  it("names no backend at all when the nsjail pin cannot be satisfied", async () => {
    // ATLAS_SANDBOX=nsjail is hard-fail by contract: explore refuses to run
    // rather than degrading. Naming a backend would be wrong in BOTH directions
    // — "nsjail active" (it isn't; isBackendAvailable is `pin || useNsjail()`,
    // so the pin alone still reports available) and "just-bash" (the pin will
    // not degrade to it). The pre-flight must say the tool is unavailable.
    //
    // Critically, the pre-flight must NOT call markNsjailFailed() to force the
    // resolver's hand: planSandboxSelection only emits the hard-fail step while
    // `!nsjailFailed`, so setting the flag would DELETE the pin's hard-fail
    // contract and silently degrade the box to unsandboxed just-bash.
    process.env.ATLAS_SANDBOX = "nsjail";
    mockNsjailBinaryPath = null;

    await runPreFlight();

    expect(loggedBackend()).toBeUndefined();
    expect(claimedNoIsolation()).toBe(false);
    expect(
      logCalls.some((c) =>
        c.args.some((a) => typeof a === "string" && a.includes("Explore tool: unavailable")),
      ),
    ).toBe(true);
    // The hard-fail step must survive — this is the security-critical assertion.
    expect(snapshotExploreSandboxEnv().nsjailFailed).toBe(false);
  });

  // ── AC4 — boot and /api/health cannot disagree ────────────────────────────

  it("agrees with getExploreBackendType() across every env shape", async () => {
    // `expected` is not redundant with the agreement assertion. Without it the
    // loop compares getExploreBackendType() against itself and stays green even
    // if every shape silently collapsed to just-bash — agreement is cheap, and
    // agreement on the WRONG value is exactly the failure this file exists to
    // catch. Pinning the literal makes such a collapse a loud failure.
    const shapes: ReadonlyArray<{
      name: string;
      env: Record<string, string>;
      expected: ExploreBackendType;
    }> = [
      { name: "bare", env: {}, expected: "just-bash" },
      { name: "on-Vercel", env: { ATLAS_RUNTIME: "vercel" }, expected: "vercel-sandbox" },
      {
        name: "Railway + Vercel creds",
        env: {
          VERCEL_TEAM_ID: "team_test",
          VERCEL_PROJECT_ID: "prj_test",
          VERCEL_TOKEN: "tok_test",
        },
        expected: "vercel-sandbox",
      },
      {
        name: "sidecar",
        env: { ATLAS_SANDBOX_URL: "http://sidecar.test" },
        expected: "sidecar",
      },
      { name: "explicit nsjail", env: { ATLAS_SANDBOX: "nsjail" }, expected: "nsjail" },
    ];

    for (const shape of shapes) {
      for (const v of SANDBOX_VARS) delete process.env[v];
      Object.assign(process.env, shape.env);
      // Keep the nsjail and sidecar probes healthy so this case measures
      // agreement, not degradation.
      mockNsjailBinaryPath = shape.env.ATLAS_SANDBOX === "nsjail" ? "/usr/local/bin/nsjail" : null;
      mockCapabilityResult = { ok: true };
      globalThis.fetch = healthyFetch();

      await runPreFlight();

      expect(loggedBackend(), `pre-flight named the wrong backend for ${shape.name}`).toBe(
        shape.expected,
      );
      expect(getExploreBackendType(), `health resolved wrong for ${shape.name}`).toBe(
        shape.expected,
      );
    }
  });

  // ── The trap: skipping the probe silently corrupts the health surface ─────

  it("still probes nsjail (feeding health) even when Vercel Sandbox wins", async () => {
    // A Railway host that happens to ship an nsjail binary whose namespaces do
    // not work. vercel-sandbox wins the priority chain regardless, so the naive
    // fix — "the resolved backend isn't nsjail, skip the probe" — would never
    // call markNsjailFailed(). _nsjailFailed gates both tryCreateBackend and
    // isBackendAvailable, so leaving it unset means a host whose winning backend
    // fails to construct at request time falls through to a known-broken nsjail.
    process.env.VERCEL_TEAM_ID = "team_test";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    process.env.VERCEL_TOKEN = "tok_test";
    mockNsjailBinaryPath = "/usr/local/bin/nsjail";
    mockCapabilityResult = { ok: false, error: "clone failed: EPERM" };

    // Asserting the pre-condition is what makes the post-condition meaningful
    // rather than possibly-already-true.
    expect(snapshotExploreSandboxEnv().nsjailFailed).toBe(false);

    await runPreFlight();

    // The two assertions the naive "skip the probe" fix fails.
    expect(nsjailProbeRan).toBe(true);
    expect(snapshotExploreSandboxEnv().nsjailFailed).toBe(true);

    // …and the log still names the backend that actually won.
    expect(loggedBackend()).toBe("vercel-sandbox");
    expect(claimedNoIsolation()).toBe(false);
  });
});
