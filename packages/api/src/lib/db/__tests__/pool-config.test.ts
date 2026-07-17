import { afterEach, describe, expect, test } from "bun:test";
import {
  CONNECT_TIMEOUT_DEFAULT_MS,
  CONNECT_TIMEOUT_MAX_MS,
  CONNECT_TIMEOUT_MIN_MS,
  getConnectTimeoutMs,
} from "@atlas/api/lib/db/pool-config";

describe("getConnectTimeoutMs (#4463)", () => {
  const original = process.env.ATLAS_CONNECT_TIMEOUT;
  afterEach(() => {
    if (original === undefined) delete process.env.ATLAS_CONNECT_TIMEOUT;
    else process.env.ATLAS_CONNECT_TIMEOUT = original;
  });

  test("defaults to CONNECT_TIMEOUT_DEFAULT_MS when unset", () => {
    delete process.env.ATLAS_CONNECT_TIMEOUT;
    expect(getConnectTimeoutMs()).toBe(CONNECT_TIMEOUT_DEFAULT_MS);
  });

  test("honours a valid override within bounds", () => {
    process.env.ATLAS_CONNECT_TIMEOUT = "7500";
    expect(getConnectTimeoutMs()).toBe(7500);
  });

  test("never returns 0 — a stray 0 falls back to the default, not pg's infinite-hang", () => {
    process.env.ATLAS_CONNECT_TIMEOUT = "0";
    expect(getConnectTimeoutMs()).toBe(CONNECT_TIMEOUT_DEFAULT_MS);
    expect(getConnectTimeoutMs()).toBeGreaterThan(0);
  });

  test("clamps a below-floor value up to the minimum", () => {
    process.env.ATLAS_CONNECT_TIMEOUT = "50";
    expect(getConnectTimeoutMs()).toBe(CONNECT_TIMEOUT_MIN_MS);
  });

  test("clamps an absurd value down to the maximum", () => {
    process.env.ATLAS_CONNECT_TIMEOUT = "999999999";
    expect(getConnectTimeoutMs()).toBe(CONNECT_TIMEOUT_MAX_MS);
  });

  test("falls back to the default for non-numeric or negative input", () => {
    process.env.ATLAS_CONNECT_TIMEOUT = "not-a-number";
    expect(getConnectTimeoutMs()).toBe(CONNECT_TIMEOUT_DEFAULT_MS);
    process.env.ATLAS_CONNECT_TIMEOUT = "-500";
    expect(getConnectTimeoutMs()).toBe(CONNECT_TIMEOUT_DEFAULT_MS);
  });
});
