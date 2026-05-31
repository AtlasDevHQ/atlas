/**
 * Tests for the shared OpenAPI spec refresh scheduler (`openapi-spec-refresh.ts`,
 * #2970 Tier-1) — the periodic conditional-GET fiber over the cross-workspace
 * spec cache. Covers interval resolution, lifecycle (start/stop/double-start
 * guard), and a manual cycle over an empty cache (no network).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_SHARED_SPEC_REFRESH_INTERVAL_MS,
  getSharedSpecRefreshIntervalMs,
  startOpenApiSpecRefreshScheduler,
  stopOpenApiSpecRefreshScheduler,
  isOpenApiSpecRefreshSchedulerRunning,
  triggerOpenApiSpecRefreshCycle,
  _resetOpenApiSpecRefreshScheduler,
} from "../openapi-spec-refresh";
import { __resetSharedSpecCacheForTests } from "@atlas/api/lib/openapi/shared-spec-cache";

beforeEach(() => {
  _resetOpenApiSpecRefreshScheduler();
  __resetSharedSpecCacheForTests();
});
afterEach(() => {
  _resetOpenApiSpecRefreshScheduler();
  __resetSharedSpecCacheForTests();
});

describe("getSharedSpecRefreshIntervalMs", () => {
  const KEY = "ATLAS_OPENAPI_SPEC_REFRESH_INTERVAL_HOURS";
  function withEnv(value: string | undefined, fn: () => void): void {
    const prev = process.env[KEY];
    if (value === undefined) delete process.env[KEY];
    else process.env[KEY] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  it("defaults to 24h when unset", () => {
    withEnv(undefined, () => {
      expect(getSharedSpecRefreshIntervalMs()).toBe(DEFAULT_SHARED_SPEC_REFRESH_INTERVAL_MS);
    });
  });

  it("honors a positive custom hour count", () => {
    withEnv("6", () => expect(getSharedSpecRefreshIntervalMs()).toBe(6 * 60 * 60 * 1000));
  });

  it("falls back to the default on a non-positive or unparseable value", () => {
    withEnv("0", () => expect(getSharedSpecRefreshIntervalMs()).toBe(DEFAULT_SHARED_SPEC_REFRESH_INTERVAL_MS));
    withEnv("nonsense", () => expect(getSharedSpecRefreshIntervalMs()).toBe(DEFAULT_SHARED_SPEC_REFRESH_INTERVAL_MS));
  });
});

describe("lifecycle", () => {
  it("starts, reports running, and stops", () => {
    expect(isOpenApiSpecRefreshSchedulerRunning()).toBe(false);
    startOpenApiSpecRefreshScheduler(60_000);
    expect(isOpenApiSpecRefreshSchedulerRunning()).toBe(true);
    stopOpenApiSpecRefreshScheduler();
    expect(isOpenApiSpecRefreshSchedulerRunning()).toBe(false);
  });

  it("double-start is a no-op (single-running guard)", () => {
    startOpenApiSpecRefreshScheduler(60_000);
    startOpenApiSpecRefreshScheduler(60_000); // must not throw or double-register
    expect(isOpenApiSpecRefreshSchedulerRunning()).toBe(true);
    stopOpenApiSpecRefreshScheduler();
  });

  it("falls back to the configured interval on a non-positive override (no hot loop)", () => {
    // A 0 / negative / NaN interval would make setInterval fire continuously —
    // start must clamp to the validated default rather than spin the event loop.
    for (const bad of [0, -1000, Number.NaN]) {
      startOpenApiSpecRefreshScheduler(bad);
      expect(isOpenApiSpecRefreshSchedulerRunning()).toBe(true);
      stopOpenApiSpecRefreshScheduler();
      expect(isOpenApiSpecRefreshSchedulerRunning()).toBe(false);
    }
  });
});

describe("triggerOpenApiSpecRefreshCycle", () => {
  it("over an empty cache inspects nothing and makes no network call", async () => {
    const result = await triggerOpenApiSpecRefreshCycle();
    expect(result.inspected).toBe(0);
    expect(result.notModified).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.outcomes).toEqual([]);
  });
});
