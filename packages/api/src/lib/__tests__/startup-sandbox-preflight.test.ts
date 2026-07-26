/**
 * #4824 — the startup sandbox pre-flight must name the backend the process
 * ACTUALLY uses, and must name the same one `/api/health` reports.
 *
 * The bug: the pre-flight dispatch asked "are we running ON Vercel"
 * (`ATLAS_RUNTIME` / `VERCEL`) rather than "are we USING Vercel Sandbox". Since
 * #3706, a Railway host reaches Vercel Sandbox through `VERCEL_TEAM_ID` /
 * `VERCEL_PROJECT_ID` / `VERCEL_TOKEN` — a shape that sets none of the
 * host-detection vars, so boot fell through to nsjail auto-detect, found no
 * binary, and logged "no process isolation" on every Railway deploy while
 * health correctly reported `vercel-sandbox`. Execution was fine; only the log
 * lied — and it lied in the exact string a security review greps for.
 *
 * These tests drive the REAL `lib/tools/explore` module (not a stub) so the
 * parity assertions compare the pre-flight against the genuine
 * `getExploreBackendType()` that `/api/health` calls, rather than against a
 * mock that could agree with anything.
 *
 * ── Ordering is load-bearing ────────────────────────────────────────────────
 * `explore`'s `_nsjailFailed` flag is monotonic (false → true, no reset export)
 * and `_nsjailAvailable` caches on first read. The suite therefore runs every
 * case that needs a clean nsjail chain BEFORE the final degradation case, which
 * deliberately trips `markNsjailFailed()`. `PATH` is cleared in `beforeEach` so
 * explore's own binary detection is deterministically false on any host.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
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

// The nsjail binary probe the pre-flight drives. Controlled per-test; explore's
// own detection stays real (and false, via an empty PATH).
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
const { getExploreBackendType, snapshotExploreSandboxEnv } = await import(
  "@atlas/api/lib/tools/explore"
);
const { _setConfigForTest, _resetConfig } = await import("@atlas/api/lib/config");

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
function loggedBackend(): string | undefined {
  const line = exploreBackendLine();
  if (!line) return undefined;
  const meta = line.args[0];
  if (meta && typeof meta === "object" && "backend" in meta) {
    return String((meta as { backend: unknown }).backend);
  }
  return undefined;
}

/** True when boot asserted the deployment has no process isolation. */
function claimedNoIsolation(): boolean {
  return logCalls.some((c) =>
    c.args.some((a) => typeof a === "string" && a.includes("no process isolation")),
  );
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
    _setConfigForTest({ sandbox: { priority: ["vercel-sandbox"] } } as never);

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
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

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

  // ── AC4 — boot and /api/health cannot disagree ────────────────────────────

  it("agrees with getExploreBackendType() across every env shape", async () => {
    const shapes: ReadonlyArray<{ name: string; env: Record<string, string> }> = [
      { name: "bare", env: {} },
      { name: "on-Vercel", env: { ATLAS_RUNTIME: "vercel" } },
      {
        name: "Railway + Vercel creds",
        env: {
          VERCEL_TEAM_ID: "team_test",
          VERCEL_PROJECT_ID: "prj_test",
          VERCEL_TOKEN: "tok_test",
        },
      },
      { name: "sidecar", env: { ATLAS_SANDBOX_URL: "http://sidecar.test" } },
      { name: "explicit nsjail", env: { ATLAS_SANDBOX: "nsjail" } },
    ];

    for (const shape of shapes) {
      for (const v of SANDBOX_VARS) delete process.env[v];
      Object.assign(process.env, shape.env);
      // Keep the nsjail and sidecar probes healthy so this case measures
      // agreement, not degradation.
      mockNsjailBinaryPath = shape.env.ATLAS_SANDBOX === "nsjail" ? "/usr/local/bin/nsjail" : null;
      mockCapabilityResult = { ok: true };
      globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

      await runPreFlight();

      expect(loggedBackend(), `pre-flight named a backend for ${shape.name}`).toBeDefined();
      expect(loggedBackend(), `boot vs health disagree for ${shape.name}`).toBe(
        getExploreBackendType(),
      );
    }
  });

  // ── The trap: skipping the probe silently corrupts the health surface ─────
  //
  // MUST RUN LAST — this case trips the monotonic `_nsjailFailed` flag.

  it("still probes nsjail (feeding health) even when Vercel Sandbox wins", async () => {
    // A Railway host that happens to ship an nsjail binary whose namespaces do
    // not work. vercel-sandbox wins the priority chain regardless, so the naive
    // fix — "the resolved backend isn't nsjail, skip the probe" — would never
    // call markNsjailFailed(). `/api/health` would then advertise nsjail as an
    // available backend on a host where it demonstrably cannot start.
    process.env.VERCEL_TEAM_ID = "team_test";
    process.env.VERCEL_PROJECT_ID = "prj_test";
    process.env.VERCEL_TOKEN = "tok_test";
    mockNsjailBinaryPath = "/usr/local/bin/nsjail";
    mockCapabilityResult = { ok: false, error: "clone failed: EPERM" };

    expect(snapshotExploreSandboxEnv().nsjailFailed).toBe(false);

    await runPreFlight();

    // The probe ran and recorded the failure — this is the assertion the naive
    // "skip the probe" fix fails.
    expect(nsjailProbeRan).toBe(true);
    expect(snapshotExploreSandboxEnv().nsjailFailed).toBe(true);

    // …and the log still names the backend that actually won.
    expect(loggedBackend()).toBe("vercel-sandbox");
    expect(claimedNoIsolation()).toBe(false);
  });
});
