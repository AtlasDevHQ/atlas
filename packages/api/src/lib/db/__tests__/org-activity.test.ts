/**
 * `markOrgActive` tests (#2377).
 *
 * Surface under test:
 *   - No-op guards: empty orgId, no internal DB, non-managed auth.
 *   - Per-org throttle: a second call inside the window issues no write;
 *     clearing the throttle (window elapsed) lets the next call write again.
 *   - Fire-and-forget: a synchronous `internalExecute` throw is swallowed.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

let mockInternalDB = true;
let mockAuthMode = "managed";
let executeCalls: Array<{ sql: string; params: unknown[] }> = [];
let executeShouldThrow = false;

mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => mockInternalDB,
  internalExecute: (sql: string, params: unknown[]) => {
    if (executeShouldThrow) throw new Error("pool init throw");
    executeCalls.push({ sql, params });
  },
}));

mock.module("@atlas/api/lib/auth/detect", () => ({
  detectAuthMode: () => mockAuthMode,
  getAuthModeSource: () => null,
  resetAuthModeCache: () => {},
}));

const { markOrgActive, _resetOrgActivityThrottleForTests } = await import("../org-activity");

function resetAll() {
  mockInternalDB = true;
  mockAuthMode = "managed";
  executeCalls = [];
  executeShouldThrow = false;
  _resetOrgActivityThrottleForTests();
}

describe("markOrgActive", () => {
  beforeEach(resetAll);

  it("stamps last_active_at for a managed-auth org with an internal DB", () => {
    markOrgActive("org-1");
    expect(executeCalls.length).toBe(1);
    expect(executeCalls[0].sql).toContain("UPDATE organization SET last_active_at = now()");
    expect(executeCalls[0].params).toEqual(["org-1"]);
  });

  it("no-ops on an empty / nullish orgId", () => {
    markOrgActive("");
    markOrgActive(undefined);
    markOrgActive(null);
    expect(executeCalls.length).toBe(0);
  });

  it("no-ops when the internal DB is unavailable", () => {
    mockInternalDB = false;
    markOrgActive("org-1");
    expect(executeCalls.length).toBe(0);
  });

  it("no-ops outside managed auth (organization table absent)", () => {
    for (const mode of ["none", "simple-key", "byot"]) {
      resetAll();
      mockAuthMode = mode;
      markOrgActive("org-1");
      expect(executeCalls.length).toBe(0);
    }
  });

  it("throttles repeat calls for the same org within the window", () => {
    markOrgActive("org-1");
    markOrgActive("org-1");
    markOrgActive("org-1");
    expect(executeCalls.length).toBe(1);
  });

  it("does not throttle distinct orgs against each other", () => {
    markOrgActive("org-1");
    markOrgActive("org-2");
    expect(executeCalls.map((c) => c.params[0])).toEqual(["org-1", "org-2"]);
  });

  it("writes again once the throttle is cleared (window elapsed)", () => {
    markOrgActive("org-1");
    expect(executeCalls.length).toBe(1);
    _resetOrgActivityThrottleForTests();
    markOrgActive("org-1");
    expect(executeCalls.length).toBe(2);
  });

  it("swallows a synchronous internalExecute throw (fire-and-forget)", () => {
    executeShouldThrow = true;
    expect(() => markOrgActive("org-1")).not.toThrow();
  });
});
