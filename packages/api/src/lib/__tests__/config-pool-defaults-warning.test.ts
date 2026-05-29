/**
 * Tests for the SaaS pool-sizing boot log (#1983, recalibrated by #2943).
 *
 * The log lives in `applyDeployMode()` in `lib/config.ts`, alongside the
 * #1978 deploy-mode silent-downgrade warning. Severity depends on intent:
 *
 *   - resolved deployMode === "saas" AND no `pool.perOrg` block → CRITICAL
 *     `error` (the genuine forgot-to-size mistake; isolation is off).
 *   - resolved deployMode === "saas" AND `pool.perOrg` explicitly set →
 *     INFO, regardless of `maxConnections` value (an explicit value is an
 *     intentional sizing decision, not a misconfiguration — #2943 stopped
 *     this from firing CRITICAL on every boot of the deliberately-sized
 *     prod config).
 *   - self-hosted → silent (no log at all).
 *
 * The CRITICAL carries `#1983` + `reason: "pool-defaults"`; the INFO
 * carries `#2943` + `reason: "pool-sizing"` so operators can grep either.
 *
 * Spy is installed via `mock.module("@atlas/api/lib/logger", ...)`
 * before the dynamic `await import("../config")`.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { resolve } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";

type LogCall = {
  level: "error" | "warn" | "info" | "debug";
  payload: unknown;
  message: string;
};
const logCalls: LogCall[] = [];

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    error: (payload: unknown, message: string) => logCalls.push({ level: "error", payload, message }),
    warn: (payload: unknown, message: string) => logCalls.push({ level: "warn", payload, message }),
    info: (payload: unknown, message: string) => logCalls.push({ level: "info", payload, message }),
    debug: (payload: unknown, message: string) => logCalls.push({ level: "debug", payload, message }),
  }),
  getLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, level: "info" }),
  setLogLevel: () => true,
  getRequestContext: () => undefined,
}));

const { loadConfig, _resetConfig } = await import("../config");

const TMP_BASE = resolve(__dirname, "tmp-pool-defaults-warning");
let testCounter = 0;

function ensureTmpDir(label: string): string {
  const dir = resolve(TMP_BASE, label);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTmp() {
  if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
}

/**
 * Find the CRITICAL pool-defaults log emission. Returns undefined if
 * absent so callers can both assert presence and use it to inspect
 * payload fields.
 */
function findPoolWarning() {
  return logCalls
    .filter((c) => c.level === "error")
    .find((c) => c.message.includes("CRITICAL") && c.message.includes("#1983"));
}

/**
 * Find the INFO pool-sizing emission (the #2943 explicit-config path).
 * Returns undefined if absent.
 */
function findPoolInfo() {
  return logCalls
    .filter((c) => c.level === "info")
    .find((c) => (c.payload as Record<string, unknown> | undefined)?.reason === "pool-sizing");
}

describe("applyDeployMode: pool-defaults SaaS warning (#1983)", () => {
  let savedDeployMode: string | undefined;

  beforeEach(() => {
    _resetConfig();
    logCalls.length = 0;
    savedDeployMode = process.env.ATLAS_DEPLOY_MODE;
    delete process.env.ATLAS_DEPLOY_MODE;
    testCounter++;
  });

  afterEach(() => {
    _resetConfig();
    if (savedDeployMode !== undefined) process.env.ATLAS_DEPLOY_MODE = savedDeployMode;
    else delete process.env.ATLAS_DEPLOY_MODE;
    cleanTmp();
  });

  // SaaS resolution requires @atlas/ee + ATLAS_ENTERPRISE_ENABLED=true,
  // which we don't have in tests — `resolveDeployMode` silently
  // downgrades to self-hosted there. So the warnings under test fire
  // only when *resolved* deployMode is saas. We cannot easily reach
  // that state from the test harness; instead we exercise the
  // "self-hosted resolved" path and assert that the pool warning
  // stays SILENT (negative case is the only assertion we can make
  // without running with @atlas/ee). The positive (warning-fires)
  // assertion is covered by a unit test on the warn helper itself
  // — see below.

  it("does NOT log CRITICAL pool warning when resolved deployMode is self-hosted", async () => {
    const dir = ensureTmpDir(`self-hosted-${testCounter}`);
    writeFileSync(resolve(dir, "atlas.config.ts"), `export default {};`);

    await loadConfig(dir);

    expect(findPoolWarning()).toBeUndefined();
  });

  it("does NOT log CRITICAL pool warning when self-hosted has explicit small pool", async () => {
    const dir = ensureTmpDir(`self-hosted-explicit-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { pool: { perOrg: { maxConnections: 5 } } };`,
    );

    await loadConfig(dir);

    expect(findPoolWarning()).toBeUndefined();
  });
});

// Unit test for the warn helper directly — bypasses the resolveDeployMode
// downgrade so we can assert positive emission. The helper is exported
// for testing; it only inspects `resolved.deployMode` + `resolved.pool`,
// which we synthesize directly.
describe("warnPoolDefaultsInSaaS (#1983) — direct helper unit test", () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  it("emits CRITICAL when SaaS + no pool.perOrg block", async () => {
    const { _warnPoolDefaultsInSaaS } = await import("../config");
    _warnPoolDefaultsInSaaS({
      deployMode: "saas",
      datasources: {},
      tools: [],
      auth: "auto",
      semanticLayer: "./semantic",
      maxTotalConnections: 100,
      source: "file",
    });

    const warning = findPoolWarning();
    expect(warning).toBeDefined();
    expect((warning!.payload as Record<string, unknown>).reason).toBe("pool-defaults");
    // The unset case is the only CRITICAL path — `perOrgConfigured: false`
    // distinguishes it from the explicit-config INFO path.
    expect((warning!.payload as Record<string, unknown>).perOrgConfigured).toBe(false);
    // And it must NOT also emit the explicit-config INFO.
    expect(findPoolInfo()).toBeUndefined();
  });

  it("emits INFO (not CRITICAL) when SaaS + pool.perOrg explicitly sized at the realistic prod value (5)", async () => {
    // This is the exact deploy/api/atlas.config.ts shape — the #2943
    // regression was that an intentional 5 fired a permanent CRITICAL.
    const { _warnPoolDefaultsInSaaS } = await import("../config");
    _warnPoolDefaultsInSaaS({
      deployMode: "saas",
      datasources: {},
      tools: [],
      auth: "auto",
      semanticLayer: "./semantic",
      maxTotalConnections: 100,
      pool: {
        perOrg: {
          maxConnections: 5,
          idleTimeoutMs: 30000,
          maxOrgs: 50,
          warmupProbes: 2,
          drainThreshold: 5,
        },
      },
      source: "file",
    });

    // No CRITICAL — an explicit value is an intentional sizing decision.
    expect(findPoolWarning()).toBeUndefined();
    // An INFO log surfaces the sizing for visibility.
    const info = findPoolInfo();
    expect(info).toBeDefined();
    expect((info!.payload as Record<string, unknown>).perOrgConfigured).toBe(true);
    expect((info!.payload as Record<string, unknown>).maxConnections).toBe(5);
  });

  it("emits INFO (not CRITICAL) when SaaS + pool.perOrg explicitly sized higher (50)", async () => {
    const { _warnPoolDefaultsInSaaS } = await import("../config");
    _warnPoolDefaultsInSaaS({
      deployMode: "saas",
      datasources: {},
      tools: [],
      auth: "auto",
      semanticLayer: "./semantic",
      maxTotalConnections: 100,
      pool: {
        perOrg: {
          maxConnections: 50,
          idleTimeoutMs: 30000,
          maxOrgs: 50,
          warmupProbes: 2,
          drainThreshold: 5,
        },
      },
      source: "file",
    });

    expect(findPoolWarning()).toBeUndefined();
    expect((findPoolInfo()!.payload as Record<string, unknown>).maxConnections).toBe(50);
  });

  it("emits nothing (neither CRITICAL nor INFO) when self-hosted regardless of pool config", async () => {
    const { _warnPoolDefaultsInSaaS } = await import("../config");
    _warnPoolDefaultsInSaaS({
      deployMode: "self-hosted",
      datasources: {},
      tools: [],
      auth: "auto",
      semanticLayer: "./semantic",
      maxTotalConnections: 100,
      // Even with no pool block, self-hosted is silent.
      source: "file",
    });

    expect(findPoolWarning()).toBeUndefined();
    expect(findPoolInfo()).toBeUndefined();
  });
});
