/**
 * #3705 — MCP session-store tuning knobs promoted into the settings registry.
 *
 * `sessionIdleTimeoutMs` and `maxHeldStreamAgeMs` were env-only. The hosted
 * MCP transport mounts on the per-region API server, which loads (and, in
 * SaaS, periodically refreshes) the settings cache — so these now resolve
 * through the platform settings registry: DB override > env > default.
 *
 * Seeds the real settings cache via `setSetting` + the `_resetPool` mock-pool
 * pattern (same as the @atlas/api precedence tests) rather than mocking
 * `getSettingAuto`, so the full resolution path is exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { setSetting, _resetSettingsCache } from "@atlas/api/lib/settings";
import { _resetPool, type InternalPool } from "@atlas/api/lib/db/internal";
import { sessionIdleTimeoutMs, maxHeldStreamAgeMs } from "../session-store.js";

const mockPool: InternalPool = {
  query: async () => ({ rows: [] }),
  async connect() {
    return { query: async () => ({ rows: [] }), release() {} };
  },
  end: async () => {},
  on: () => {},
};

const ENV_KEYS = [
  "ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS",
  "ATLAS_MCP_MAX_HELD_STREAM_AGE_MS",
] as const;

const origEnv = new Map<string, string | undefined>();
const origDbUrl = process.env.DATABASE_URL;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    origEnv.set(k, process.env[k]);
    delete process.env[k];
  }
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  _resetPool(mockPool);
  _resetSettingsCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = origEnv.get(k);
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  if (origDbUrl !== undefined) process.env.DATABASE_URL = origDbUrl;
  else delete process.env.DATABASE_URL;
  _resetPool(null);
  _resetSettingsCache();
});

describe("sessionIdleTimeoutMs — registry precedence (#3705)", () => {
  it("defaults to 30 minutes when nothing is set", () => {
    expect(sessionIdleTimeoutMs()).toBe(30 * 60 * 1000);
  });

  it("platform DB override wins over the env var", async () => {
    process.env.ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS = "600000";
    await setSetting("ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS", "120000", "test");
    expect(sessionIdleTimeoutMs()).toBe(120000);
  });

  it("a DB override below the 1-minute floor falls back to the default", async () => {
    await setSetting("ATLAS_MCP_SESSION_IDLE_TIMEOUT_MS", "1000", "test");
    expect(sessionIdleTimeoutMs()).toBe(30 * 60 * 1000);
  });
});

describe("maxHeldStreamAgeMs — registry precedence (#3705)", () => {
  it("defaults to 2 hours when nothing is set", () => {
    expect(maxHeldStreamAgeMs()).toBe(2 * 60 * 60 * 1000);
  });

  it("platform DB override wins over the env var", async () => {
    process.env.ATLAS_MCP_MAX_HELD_STREAM_AGE_MS = "999999";
    await setSetting("ATLAS_MCP_MAX_HELD_STREAM_AGE_MS", "1000", "test");
    expect(maxHeldStreamAgeMs()).toBe(1000);
  });

  it("0 is a valid override (disables age-based reclaim)", async () => {
    await setSetting("ATLAS_MCP_MAX_HELD_STREAM_AGE_MS", "0", "test");
    expect(maxHeldStreamAgeMs()).toBe(0);
  });
});
