/**
 * Tests for the inlined #1983 SaaS pool-defaults boot warning.
 *
 * The warning lives in `applyDeployMode()` in `lib/config.ts`, alongside
 * the #1978 deploy-mode silent-downgrade warning. It fires when:
 *
 *   - resolved deployMode === "saas", AND
 *   - either no `pool.perOrg` block is configured (env-var deploy with
 *     no per-org pool isolation), OR `pool.perOrg.maxConnections` is
 *     at the dev-tier floor (10).
 *
 * Self-hosted is silent regardless. The warning carries the `#1983`
 * marker + `pool-defaults` label so an operator can grep boot logs and
 * find the contract.
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
    // The "no per-org config" sub-state should be visible in the payload
    // so an operator can disambiguate from the "at-floor" sub-state.
    expect((warning!.payload as Record<string, unknown>).perOrgConfigured).toBe(false);
  });

  it("emits CRITICAL when SaaS + pool.perOrg.maxConnections at the dev floor", async () => {
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
          maxConnections: 10,
          idleTimeoutMs: 30000,
          maxOrgs: 50,
          warmupProbes: 2,
          drainThreshold: 5,
        },
      },
      source: "file",
    });

    const warning = findPoolWarning();
    expect(warning).toBeDefined();
    expect((warning!.payload as Record<string, unknown>).perOrgConfigured).toBe(true);
    expect((warning!.payload as Record<string, unknown>).maxConnections).toBe(10);
  });

  it("does NOT emit when SaaS + pool.perOrg.maxConnections above dev floor", async () => {
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
  });

  it("does NOT emit when self-hosted regardless of pool config", async () => {
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
  });
});
