/**
 * Config-block deprecation, phase 1 (#4545; schema removal is phase 2, #4551).
 *
 * A config-file `cache:` block is IGNORED with a loud boot warning — the
 * Query Cache's knobs now live in the settings registry (ATLAS_CACHE_*). This
 * pins: (1) the warning fires when a `cache:` block is present, (2) the block
 * is dropped from the resolved config (never spread), (3) no warning + no
 * `cache` on a config without the block.
 *
 * Logger spy installed via `mock.module` before the dynamic `../config`
 * import (same pattern as config-pool-defaults-warning.test.ts).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

type LogCall = { level: string; payload: unknown; message: string };
const logCalls: LogCall[] = [];

void mock.module("@atlas/api/lib/logger", () => ({
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

const { validateAndResolve } = await import("../config");

function findCacheDeprecationWarning() {
  return logCalls.find(
    (c) => c.level === "warn" && typeof c.message === "string" && c.message.includes("`cache:` block is deprecated"),
  );
}

describe("config-block deprecation: cache (#4545 phase 1)", () => {
  beforeEach(() => {
    logCalls.length = 0;
  });

  it("warns loudly and IGNORES a config-file `cache:` block", () => {
    const resolved = validateAndResolve({
      cache: { enabled: false, ttl: 1234, maxSize: 7 },
    });

    // The block's values are ignored — never spread into the resolved config.
    expect(resolved).not.toHaveProperty("cache");

    // A loud, actionable boot warning fires.
    const warning = findCacheDeprecationWarning();
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("IGNORED");
    // Points the operator at both migration targets.
    expect(warning!.message).toContain("Admin");
    expect(warning!.message).toContain("ATLAS_CACHE_");
  });

  it("does not warn (and has no cache) when no `cache:` block is present", () => {
    const resolved = validateAndResolve({});
    expect(resolved).not.toHaveProperty("cache");
    expect(findCacheDeprecationWarning()).toBeUndefined();
  });
});
