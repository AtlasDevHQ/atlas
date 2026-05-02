/**
 * Tests for the inlined #1978 config-file deploy-mode warning.
 *
 * The warning lives at the bottom of `applyDeployMode()` in
 * `lib/config.ts`. It originally lived in `lib/effect/saas-guards.ts`
 * but was inlined to break a Next.js App Router static-trace chain
 * (`config.ts → saas-guards.ts → layers.ts → telemetry.ts`) that broke
 * the create-atlas standalone scaffold build.
 *
 * The behavior under test is exactly the four-case truth table the
 * helper enumerated:
 *   - configFile=saas + resolved=self-hosted + env unset → CRITICAL log
 *   - resolved=saas (no downgrade)                       → silent
 *   - env=saas (handled by EnterpriseGuardLive at boot)  → silent
 *   - configFile=auto / undefined                        → silent
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

const TMP_BASE = resolve(__dirname, "tmp-deploy-mode-warning");
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

describe("applyDeployMode: config-file silent-downgrade warning (#1978)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    _resetConfig();
    logCalls.length = 0;
    savedEnv = process.env.ATLAS_DEPLOY_MODE;
    delete process.env.ATLAS_DEPLOY_MODE;
    testCounter++;
  });

  afterEach(() => {
    _resetConfig();
    if (savedEnv !== undefined) process.env.ATLAS_DEPLOY_MODE = savedEnv;
    else delete process.env.ATLAS_DEPLOY_MODE;
    cleanTmp();
  });

  // The load-bearing case: config file requested saas, resolved
  // downgraded to self-hosted (because @atlas/ee isn't installed in
  // tests), env is unset. Operator-visible signal must fire.
  it("emits CRITICAL error log when atlas.config.ts requests saas but resolved is self-hosted", async () => {
    const dir = ensureTmpDir(`saas-rejected-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { deployMode: "saas" };`,
    );

    await loadConfig(dir);

    const errorLogs = logCalls.filter((c) => c.level === "error");
    // The "CRITICAL" + "#1978" pair is the operator-grep signal.
    const critical = errorLogs.find((c) => c.message.includes("CRITICAL") && c.message.includes("#1978"));
    expect(critical).toBeDefined();
    expect((critical!.payload as Record<string, unknown>).source).toBe("atlas.config.ts");
    expect((critical!.payload as Record<string, unknown>).requested).toBe("saas");
  });

  // Negative cases — must NOT log so the warning stays meaningful.
  it("does NOT log CRITICAL when resolved is saas (no downgrade)", async () => {
    // Hard to simulate because resolved=saas requires @atlas/ee in the
    // test runtime. As a proxy, exercise the configFile=auto path
    // (resolved either way → no downgrade signal expected).
    const dir = ensureTmpDir(`saas-resolved-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { deployMode: "auto" };`,
    );

    await loadConfig(dir);

    const errorLogs = logCalls.filter((c) => c.level === "error" && c.message.includes("CRITICAL"));
    expect(errorLogs).toHaveLength(0);
  });

  it("does NOT log CRITICAL when env is set to saas (handled by EnterpriseGuardLive)", async () => {
    process.env.ATLAS_DEPLOY_MODE = "saas";
    const dir = ensureTmpDir(`env-saas-${testCounter}`);
    writeFileSync(
      resolve(dir, "atlas.config.ts"),
      `export default { deployMode: "saas" };`,
    );

    await loadConfig(dir);

    // The env-set case is fail-fast in EnterpriseGuardLive at boot;
    // the inlined warn helper deliberately stays silent here so the
    // CRITICAL log isn't doubled with the boot-time tagged error.
    const errorLogs = logCalls.filter((c) => c.level === "error" && c.message.includes("CRITICAL"));
    expect(errorLogs).toHaveLength(0);
  });

  it("does NOT log CRITICAL when config file did not request saas", async () => {
    const dir = ensureTmpDir(`auto-${testCounter}`);
    writeFileSync(resolve(dir, "atlas.config.ts"), `export default {};`);

    await loadConfig(dir);

    const errorLogs = logCalls.filter((c) => c.level === "error" && c.message.includes("CRITICAL"));
    expect(errorLogs).toHaveLength(0);
  });
});
