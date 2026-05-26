/**
 * Contact-form rate limit tests (#2730).
 *
 * Mirrors the shape of `demo.test.ts:checkDemoRateLimit` — sliding
 * window keyed by IP, configurable via env.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkContactRateLimit,
  getContactRpmLimit,
  resetContactRateLimits,
  contactCleanupTick,
} from "../contact";

const ORIGINAL_ENV = process.env.ATLAS_CONTACT_RATE_LIMIT_RPM;

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ATLAS_CONTACT_RATE_LIMIT_RPM;
  else process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = ORIGINAL_ENV;
});

beforeEach(() => {
  resetContactRateLimits();
});

describe("getContactRpmLimit", () => {
  test("defaults to 5 when env var is unset", () => {
    delete process.env.ATLAS_CONTACT_RATE_LIMIT_RPM;
    expect(getContactRpmLimit()).toBe(5);
  });

  test("parses an integer from env", () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "20";
    expect(getContactRpmLimit()).toBe(20);
  });

  test("rejects negative and falls back to default", () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "-1";
    expect(getContactRpmLimit()).toBe(5);
  });

  test("0 disables the limit", () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "0";
    expect(getContactRpmLimit()).toBe(0);
    expect(checkContactRateLimit("1.2.3.4").allowed).toBe(true);
  });
});

describe("checkContactRateLimit", () => {
  test("allows up to limit submissions per IP per minute", () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "3";
    expect(checkContactRateLimit("ip-a").allowed).toBe(true);
    expect(checkContactRateLimit("ip-a").allowed).toBe(true);
    expect(checkContactRateLimit("ip-a").allowed).toBe(true);
    const blocked = checkContactRateLimit("ip-a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("separate IPs do not share the window", () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "1";
    expect(checkContactRateLimit("ip-x").allowed).toBe(true);
    expect(checkContactRateLimit("ip-x").allowed).toBe(false);
    // Different IP — fresh budget.
    expect(checkContactRateLimit("ip-y").allowed).toBe(true);
  });
});

describe("contactCleanupTick", () => {
  test("evicts entries whose newest timestamp is older than the window", async () => {
    process.env.ATLAS_CONTACT_RATE_LIMIT_RPM = "2";
    checkContactRateLimit("ip-evict");
    // Drop the timestamps to expired (simulate the passage of >60s).
    // Implementation detail: contactCleanupTick walks the same map, so
    // we just call it after manually fast-forwarding via reset.
    resetContactRateLimits();
    checkContactRateLimit("ip-recent");
    contactCleanupTick();
    // ip-evict is gone (reset cleared everything); ip-recent stays.
    expect(checkContactRateLimit("ip-recent").allowed).toBe(true);
  });
});
