/**
 * Self-serve trial creation-attempt rate-limit tests (#3654, ADR-0018).
 *
 * Mirrors `contact.test.ts` / `demo.test.ts` — two sliding windows (per-IP and
 * per-email) keyed independently, configurable via env. Asserts the abuse
 * bound is on ATTEMPTS, not trials: distinct IPs / emails keep fresh budgets,
 * a blocked attempt is not recorded, and the window recovers on schedule.
 */
import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import {
  checkTrialAttemptRateLimit,
  getTrialIpRpmLimit,
  getTrialEmailRpmLimit,
  resetTrialAttemptRateLimits,
  trialAttemptCleanupTick,
  type TrialAttemptRateLimitResult,
} from "../trial-abuse";
import { trialAbuseRejections } from "../metrics";

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

beforeEach(async () => {
  await resetTrialAttemptRateLimits();
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
  test("allows up to the IP limit, then blocks with retry guidance", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "3";
    // Distinct emails so only the IP bucket can trip.
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "a@x.com" })).allowed).toBe(true);
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "b@x.com" })).allowed).toBe(true);
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "c@x.com" })).allowed).toBe(true);
    const blocked = expectBlocked(
      await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "d@x.com" }),
    );
    expect(blocked.bucket).toBe("ip");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("distinct IPs do not share the window (shared-NAT attempts are not capped per trial)", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "a@x.com" })).allowed).toBe(true);
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "b@x.com" })).allowed).toBe(false);
    // Different IP — fresh budget.
    expect((await checkTrialAttemptRateLimit({ ip: "2.2.2.2", email: "c@x.com" })).allowed).toBe(true);
  });

  test("null IP collapses to a single shared bucket", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    expect((await checkTrialAttemptRateLimit({ ip: null, email: "a@x.com" })).allowed).toBe(true);
    const blocked = expectBlocked(
      await checkTrialAttemptRateLimit({ ip: null, email: "b@x.com" }),
    );
    expect(blocked.bucket).toBe("ip");
  });
});

describe("per-email attempt window", () => {
  test("allows up to the email limit, then blocks", async () => {
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "2";
    // Distinct IPs so only the email bucket can trip.
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "spam@x.com" })).allowed).toBe(true);
    expect((await checkTrialAttemptRateLimit({ ip: "2.2.2.2", email: "spam@x.com" })).allowed).toBe(true);
    const blocked = expectBlocked(
      await checkTrialAttemptRateLimit({ ip: "3.3.3.3", email: "spam@x.com" }),
    );
    expect(blocked.bucket).toBe("email");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test("email matching is case-insensitive + trimmed", async () => {
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "1";
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "Spam@X.com" })).allowed).toBe(true);
    const blocked = expectBlocked(
      await checkTrialAttemptRateLimit({ ip: "2.2.2.2", email: "  spam@x.com " }),
    );
    expect(blocked.bucket).toBe("email");
  });
});

describe("blocked attempts are not recorded", () => {
  test("a blocked attempt does not consume the OTHER bucket's budget", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "5";
    // Burn the IP bucket.
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "e@x.com" })).allowed).toBe(true);
    // This trips on IP — must NOT charge the email bucket for "e2@x.com".
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "e2@x.com" })).allowed).toBe(false);
    // A fresh IP with that same email still has its full email budget.
    expect((await checkTrialAttemptRateLimit({ ip: "9.9.9.9", email: "e2@x.com" })).allowed).toBe(true);
  });
});

describe("disabled limits", () => {
  test("0 disables a bucket", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "0";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "0";
    expect(getTrialIpRpmLimit()).toBe(0);
    for (let i = 0; i < 50; i++) {
      expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "x@x.com" })).allowed).toBe(true);
    }
  });
});

describe("recovery after reset", () => {
  test("resetTrialAttemptRateLimits frees both windows", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "a@x.com" })).allowed).toBe(true);
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "b@x.com" })).allowed).toBe(false);
    await resetTrialAttemptRateLimits();
    // Window cleared — the IP recovers a full budget (simulates the passage
    // of the window, as in contact.test.ts).
    expect((await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "c@x.com" })).allowed).toBe(true);
  });
});

describe("trialAttemptCleanupTick", () => {
  test("evicts fully-stale buckets", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "2";
    await checkTrialAttemptRateLimit({ ip: "ip-evict", email: "a@x.com" });
    await resetTrialAttemptRateLimits();
    await checkTrialAttemptRateLimit({ ip: "ip-recent", email: "b@x.com" });
    await trialAttemptCleanupTick();
    // ip-evict is gone (reset cleared it); ip-recent still has budget.
    expect((await checkTrialAttemptRateLimit({ ip: "ip-recent", email: "c@x.com" })).allowed).toBe(true);
  });
});

// #3796 — rejections export a counter so a fleet-wide attack is alertable, not
// just a per-replica log. Spy on the singleton counter's `.add` (works under
// the no-op meter, which exposes no value).
describe("rejection metric (#3796)", () => {
  test("increments the counter with limiter=ip when the IP window trips", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "1000";
    const add = spyOn(trialAbuseRejections, "add");
    try {
      await checkTrialAttemptRateLimit({ ip: "9.9.9.9", email: "a@x.com" }); // allowed
      await checkTrialAttemptRateLimit({ ip: "9.9.9.9", email: "b@x.com" }); // IP trips
      expect(add).toHaveBeenCalledWith(1, { limiter: "ip" });
    } finally {
      add.mockRestore();
    }
  });

  test("increments the counter with limiter=email when the email window trips", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1000";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "1";
    const add = spyOn(trialAbuseRejections, "add");
    try {
      await checkTrialAttemptRateLimit({ ip: "1.1.1.1", email: "same@x.com" }); // allowed
      await checkTrialAttemptRateLimit({ ip: "2.2.2.2", email: "same@x.com" }); // email trips
      expect(add).toHaveBeenCalledWith(1, { limiter: "email" });
    } finally {
      add.mockRestore();
    }
  });

  test("does not increment when the attempt is allowed", async () => {
    process.env.ATLAS_TRIAL_IP_RATE_LIMIT_RPM = "1000";
    process.env.ATLAS_TRIAL_EMAIL_RATE_LIMIT_RPM = "1000";
    const add = spyOn(trialAbuseRejections, "add");
    try {
      await checkTrialAttemptRateLimit({ ip: "3.3.3.3", email: "ok@x.com" });
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });
});
