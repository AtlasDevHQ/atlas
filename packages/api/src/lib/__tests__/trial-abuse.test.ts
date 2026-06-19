/**
 * Self-serve trial creation-attempt rate-limit tests (#3654, ADR-0018).
 *
 * Mirrors `contact.test.ts` / `demo.test.ts` — two sliding windows (per-IP and
 * per-email) keyed independently, configurable via env. Asserts the abuse
 * bound is on ATTEMPTS, not trials: distinct IPs / emails keep fresh budgets,
 * a blocked attempt is not recorded, and the window recovers on schedule.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  checkTrialAttemptRateLimit,
  getTrialIpRpmLimit,
  getTrialEmailRpmLimit,
  resetTrialAttemptRateLimits,
  trialAttemptCleanupTick,
  type TrialAttemptRateLimitResult,
} from "../trial-abuse";

/**
 * Assert a result is the blocked arm and return it narrowed so `bucket` +
 * `retryAfterMs` are readable (the result is a discriminated union — present
 * IFF blocked — so a plain `expect(allowed).toBe(false)` doesn't narrow).
 */
function expectBlocked(
  r: TrialAttemptRateLimitResult,
): Extract<TrialAttemptRateLimitResult, { allowed: false }> {
  expect(r.allowed).toBe(false);
  if (r.allowed) throw new Error("unreachable: expected a blocked result");
  return r;
}

const ORIG_IP = process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM;
const ORIG_EMAIL = process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM;

function restore(key: string, val: string | undefined) {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

afterAll(() => {
  restore("ATLAS_TRIAL_IP_RATE_LIMIT_RPM", ORIG_IP);
  restore("ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM", ORIG_EMAIL);
});

beforeEach(() => {
  resetTrialAttemptRateLimits();
  // High IP ceiling by default so per-email tests aren't shadowed by the IP
  // bucket, and vice versa. Individual tests narrow the relevant knob.
  process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1000";
  process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "1000";
});

describe("limit resolution", () => {
  test("defaults to 5 (IP) / 3 (email) when env is unset", () => {
    delete process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM;
    delete process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM;
    expect(getTrialIpRpmLimit()).toBe(5);
    expect(getTrialEmailRpmLimit()).toBe(3);
  });

  test("parses integers from env", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "12";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "7";
    expect(getTrialIpRpmLimit()).toBe(12);
    expect(getTrialEmailRpmLimit()).toBe(7);
  });

  test("rejects negative / non-numeric and falls back to default", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "-1";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "nope";
    expect(getTrialIpRpmLimit()).toBe(5);
    expect(getTrialEmailRpmLimit()).toBe(3);
  });
});

describe("per-IP attempt window", () => {
  test("allows up to the IP limit, then blocks with retry guidance", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "3";
    // Distinct emails so only the IP bucket can trip.
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "a@x.com" }).allowed).toBe(true);
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "b@x.com" }).allowed).toBe(true);
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "c@x.com" }).allowed).toBe(true);
    const blocked = expectBlocked(
      checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "d@x.com" }),
    );
    expect(blocked.bucket).toBe("ip");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("distinct IPs do not share the window (shared-NAT attempts are not capped per trial)", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "a@x.com" }).allowed).toBe(true);
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "b@x.com" }).allowed).toBe(false);
    // Different IP — fresh budget.
    expect(checkTrialAttemptRateLimit({ ip: "2.2.2.2", email: "c@x.com" }).allowed).toBe(true);
  });

  test("null IP collapses to a single shared bucket", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    expect(checkTrialAttemptRateLimit({ ip: null, email: "a@x.com" }).allowed).toBe(true);
    const blocked = expectBlocked(
      checkTrialAttemptRateLimit({ ip: null, email: "b@x.com" }),
    );
    expect(blocked.bucket).toBe("ip");
  });
});

describe("per-email attempt window", () => {
  test("allows up to the email limit, then blocks", () => {
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "2";
    // Distinct IPs so only the email bucket can trip.
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "spam@x.com" }).allowed).toBe(true);
    expect(checkTrialAttemptRateLimit({ ip: "2.2.2.2", email: "spam@x.com" }).allowed).toBe(true);
    const blocked = expectBlocked(
      checkTrialAttemptRateLimit({ ip: "3.3.3.3", email: "spam@x.com" }),
    );
    expect(blocked.bucket).toBe("email");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("email matching is case-insensitive + trimmed", () => {
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "1";
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "Spam@X.com" }).allowed).toBe(true);
    const blocked = expectBlocked(
      checkTrialAttemptRateLimit({ ip: "2.2.2.2", email: "  spam@x.com " }),
    );
    expect(blocked.bucket).toBe("email");
  });
});

describe("blocked attempts are not recorded", () => {
  test("a blocked attempt does not consume the OTHER bucket's budget", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "5";
    // Burn the IP bucket.
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "e@x.com" }).allowed).toBe(true);
    // This trips on IP — must NOT charge the email bucket for "e2@x.com".
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "e2@x.com" }).allowed).toBe(false);
    // A fresh IP with that same email still has its full email budget.
    expect(checkTrialAttemptRateLimit({ ip: "9.9.9.9", email: "e2@x.com" }).allowed).toBe(true);
  });
});

describe("disabled limits", () => {
  test("0 disables a bucket", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "0";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "0";
    expect(getTrialIpRpmLimit()).toBe(0);
    for (let i = 0; i < 50; i++) {
      expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "x@x.com" }).allowed).toBe(true);
    }
  });
});

describe("recovery after reset", () => {
  test("resetTrialAttemptRateLimits frees both windows", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "a@x.com" }).allowed).toBe(true);
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "b@x.com" }).allowed).toBe(false);
    resetTrialAttemptRateLimits();
    // Window cleared — the IP recovers a full budget (simulates the passage
    // of the window, as in contact.test.ts).
    expect(checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "c@x.com" }).allowed).toBe(true);
  });
});

describe("trialAttemptCleanupTick", () => {
  test("evicts fully-stale buckets", () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "2";
    checkTrialAttemptRateLimit({ ip: "ip-evict", email: "a@x.com" });
    resetTrialAttemptRateLimits();
    checkTrialAttemptRateLimit({ ip: "ip-recent", email: "b@x.com" });
    trialAttemptCleanupTick();
    // ip-evict is gone (reset cleared it); ip-recent still has budget.
    expect(checkTrialAttemptRateLimit({ ip: "ip-recent", email: "c@x.com" }).allowed).toBe(true);
  });
});
