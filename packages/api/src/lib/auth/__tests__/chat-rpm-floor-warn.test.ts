/**
 * #3687 — integration coverage for the SaaS prod-floor chat-RPM warn.
 *
 * The pure decision is unit-tested via `isLowSaasChatRpm` in `middleware.test.ts`.
 * This file exercises the WIRING in `getRpmLimitForBucket`: that an explicit
 * `ATLAS_RATE_LIMIT_RPM_CHAT` in (0, 5) on a SaaS region actually fires the
 * `log.warn`, that the `lastWarnedChatRpmFloorValue` dedup slot suppresses a
 * repeat for the same value, that `resetRateLimits()` clears that slot, and that
 * the resolved limit is still honored (warn, never throw).
 *
 * It lives in its own file because the logger must be mocked BEFORE the
 * module-under-test is imported (middleware captures `createLogger("auth")` at
 * module load) — the same mock-then-dynamic-import pattern as `saas-guards.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mock } from "bun:test";
import type { ResolvedConfig } from "@atlas/api/lib/config";

// ── logger capture ───────────────────────────────────────────────────
let capturedWarns: Array<{ obj: unknown; msg: unknown }> = [];
const recordWarn = (obj: unknown, msg?: unknown) => {
  capturedWarns.push({ obj, msg });
};
const noop = () => {};
const stubLogger = {
  warn: recordWarn,
  error: noop,
  info: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  level: "info",
  child: () => stubLogger,
};
// Full export surface mocked (mock-all-exports). Middleware only uses
// `createLogger`, but transitive imports may touch the rest at load time.
mock.module("@atlas/api/lib/logger", () => ({
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler"],
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getRequestContext: () => undefined,
  redactPaths: [],
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (o: unknown) => o,
  getLogger: () => stubLogger,
  createLogger: () => stubLogger,
  hashShareToken: (t: string) => t,
  setLogLevel: () => true,
}));

const { checkRateLimit, resetRateLimits } = await import("../middleware");
const { _setConfigForTest, _resetConfig } = await import("@atlas/api/lib/config");
const { _resetSettingsCache } = await import("@atlas/api/lib/settings");

function makeConfig(deployMode: ResolvedConfig["deployMode"]): ResolvedConfig {
  return {
    datasources: {},
    tools: ["explore", "executeSQL"],
    auth: "none",
    semanticLayer: "./semantic",
    maxTotalConnections: 100,
    source: "file",
    deployMode,
  };
}

function floorWarns(): Array<{ obj: unknown; msg: unknown }> {
  return capturedWarns.filter(
    (w) => typeof w.msg === "string" && (w.msg as string).includes("#3687"),
  );
}

describe("chat RPM prod-floor warn — getRpmLimitForBucket wiring (#3687)", () => {
  const origRpm = process.env.ATLAS_RATE_LIMIT_RPM;
  const origChatRpm = process.env.ATLAS_RATE_LIMIT_RPM_CHAT;

  beforeEach(() => {
    capturedWarns = [];
    resetRateLimits();
    _resetSettingsCache();
    // A non-zero base RPM is required, else `getRpmLimitForBucket` early-returns
    // 0 (rate-limiting disabled) before reaching the chat branch + warn.
    process.env.ATLAS_RATE_LIMIT_RPM = "100";
    delete process.env.ATLAS_RATE_LIMIT_RPM_CHAT;
  });

  afterEach(() => {
    if (origRpm !== undefined) process.env.ATLAS_RATE_LIMIT_RPM = origRpm;
    else delete process.env.ATLAS_RATE_LIMIT_RPM;
    if (origChatRpm !== undefined) process.env.ATLAS_RATE_LIMIT_RPM_CHAT = origChatRpm;
    else delete process.env.ATLAS_RATE_LIMIT_RPM_CHAT;
    _setConfigForTest(null);
    _resetConfig();
    resetRateLimits();
    _resetSettingsCache();
  });

  it("warns once on SaaS for an explicit (0,5) override and still honors the limit", () => {
    _setConfigForTest(makeConfig("saas"));
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "2";

    // First call: warn fires, and the ceiling is the explicit 2 (honored).
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(true);
    expect(checkRateLimit("u", { bucket: "chat" }).allowed).toBe(false); // 3rd > limit 2

    const warns = floorWarns();
    expect(warns.length).toBe(1);
    expect(warns[0].obj).toMatchObject({ value: "2", resolved: 2 });
  });

  it("dedups repeat warns for the same value, and re-warns after resetRateLimits()", () => {
    _setConfigForTest(makeConfig("saas"));
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "3";

    checkRateLimit("u", { bucket: "chat" });
    checkRateLimit("u", { bucket: "chat" });
    expect(floorWarns().length).toBe(1); // dedup slot suppresses the second

    // resetRateLimits() clears `lastWarnedChatRpmFloorValue`.
    resetRateLimits();
    capturedWarns = [];
    checkRateLimit("u", { bucket: "chat" });
    expect(floorWarns().length).toBe(1);
  });

  it("does NOT warn on self-hosted for the same low override", () => {
    _setConfigForTest(makeConfig("self-hosted"));
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "2";

    checkRateLimit("u", { bucket: "chat" });
    expect(floorWarns().length).toBe(0);
  });

  it("does NOT warn on SaaS when the explicit value is at/above the floor", () => {
    _setConfigForTest(makeConfig("saas"));
    process.env.ATLAS_RATE_LIMIT_RPM_CHAT = "5";

    checkRateLimit("u", { bucket: "chat" });
    expect(floorWarns().length).toBe(0);
  });
});
