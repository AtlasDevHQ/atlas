/**
 * StagingClamp — pure unit tests (staging slice 4, #2910).
 *
 * Contract under test: `clampOutbound(region, sendable)` is the single
 * outbound-rewrite chokepoint for the `staging` deploy region. It MUST be
 * identity for every prod region and MUST redirect email recipients to the
 * staging sink so a staging soak can never email a real-looking address
 * (Resend sender-reputation risk, PRD user story 13).
 *
 * The 7 canonical cases come straight from the PRD "Testing Decisions"
 * section. Two further cases lock the documented-env-var override and the
 * future-transform passthrough seam.
 *
 * Prior art: `packages/api/src/api/__tests__/cors-origin.test.ts` — pure
 * allowlist tests that fail iff a prod-vs-staging policy is violated, not
 * iff a refactor moved the implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clampOutbound } from "@atlas/api/lib/staging/clamp";

/** Documented default sink when STAGING_MAIL_SINK is unset (PRD). */
const DEFAULT_SINK = "staging-mail@useatlas.dev";

// --- Fixtures -------------------------------------------------------------

/** A rich email payload bound for a real customer address. */
function emailWithRealTo() {
  return {
    to: "real.customer@example.com",
    subject: "Your Q3 revenue report",
    body: "<p>Revenue is up 12%.</p>",
    from: "Atlas <noreply@useatlas.dev>",
    headers: { "X-Atlas-Trace": "trace-abc123", "Reply-To": "team@useatlas.dev" },
  };
}

/** Edge case: a payload whose recipient is the empty string. */
function emailWithEmptyTo() {
  return {
    to: "",
    subject: "Empty recipient",
    body: "<p>still has a body</p>",
    from: "Atlas <noreply@useatlas.dev>",
  };
}

/** A multi-recipient payload — `to` is an array of addresses. */
function emailWithArrayTo() {
  return {
    to: ["alice@example.com", "bob@example.com", "carol@example.com"],
    subject: "Team digest",
    body: "<p>Weekly digest.</p>",
    from: "Atlas <noreply@useatlas.dev>",
  };
}

// --- Hermetic env control -------------------------------------------------
// The sink env var is the ONE documented input beyond `region`. Save and
// restore it around every test so the default-sink cases are deterministic
// regardless of the surrounding shell/CI environment, and so the override
// case cannot leak into siblings. (Not module-scope mutation — permitted.)

let savedSink: string | undefined;

beforeEach(() => {
  savedSink = process.env.STAGING_MAIL_SINK;
  delete process.env.STAGING_MAIL_SINK;
});

afterEach(() => {
  if (savedSink === undefined) delete process.env.STAGING_MAIL_SINK;
  else process.env.STAGING_MAIL_SINK = savedSink;
});

describe("clampOutbound — prod regions are identity transforms", () => {
  // Cases 1–3: us / eu / apac never rewrite outbound payloads.
  for (const region of ["us", "eu", "apac"] as const) {
    it(`returns the email unchanged for region "${region}"`, () => {
      const email = emailWithRealTo();
      const result = clampOutbound(region, email);
      // Identity: same reference, no copy, no allocation off the hot path.
      expect(result).toBe(email);
      expect(result.to).toBe("real.customer@example.com");
    });
  }
});

describe("clampOutbound — staging redirects email to the sink", () => {
  // Case 4: staging rewrites `to` to the sink.
  it("rewrites `to` to the default sink", () => {
    const result = clampOutbound("staging", emailWithRealTo());
    expect(result.to).toBe(DEFAULT_SINK);
  });

  // Case 5: every non-recipient field is preserved verbatim.
  it("preserves subject, body, from, and custom headers", () => {
    const original = emailWithRealTo();
    const result = clampOutbound("staging", original);

    expect(result.subject).toBe(original.subject);
    expect(result.body).toBe(original.body);
    expect(result.from).toBe(original.from);
    expect(result.headers).toEqual(original.headers);

    // Purity: the input is not mutated — its `to` is still the real address.
    expect(original.to).toBe("real.customer@example.com");
  });

  // Case 6: an empty `to` is rewritten, not crashed past.
  it("rewrites an empty `to` to the sink without crashing", () => {
    const result = clampOutbound("staging", emailWithEmptyTo());
    expect(result.to).toBe(DEFAULT_SINK);
    expect(result.subject).toBe("Empty recipient");
  });

  // Case 7: an array `to` collapses to the single sink address.
  it("rewrites an array `to` to a single sink address", () => {
    const result = clampOutbound("staging", emailWithArrayTo());
    // `clampOutbound`'s `(T) => T` signature keeps `to`'s declared `string[]`
    // type, but at runtime the array collapses to a single sink string —
    // read through `unknown` to assert the real runtime value honestly.
    const to: unknown = result.to;
    expect(to).toBe(DEFAULT_SINK);
    // Not an array of one — a single address string.
    expect(Array.isArray(to)).toBe(false);
  });
});

describe("clampOutbound — documented sink env var", () => {
  it("honors STAGING_MAIL_SINK when set", () => {
    process.env.STAGING_MAIL_SINK = "soak-inbox@staging.useatlas.dev";
    const result = clampOutbound("staging", emailWithRealTo());
    expect(result.to).toBe("soak-inbox@staging.useatlas.dev");
  });
});

describe("clampOutbound — future-transform seam", () => {
  // No transform is registered for non-email payloads yet (Stripe customer
  // mirroring, Slack webhook overrides are out of scope today). Such a
  // payload must pass through untouched rather than be misclassified as an
  // email and have a spurious `to` written onto it.
  it("passes a non-email payload through unchanged on staging", () => {
    const stripeCustomer = { customerId: "cus_123", email: "real.customer@example.com" };
    const result = clampOutbound("staging", stripeCustomer);
    expect(result).toBe(stripeCustomer);
    expect(result.email).toBe("real.customer@example.com");
  });

  it("does not crash on a primitive payload", () => {
    expect(clampOutbound("staging", "not-an-object")).toBe("not-an-object");
    expect(clampOutbound("staging", 42)).toBe(42);
    expect(clampOutbound("staging", null)).toBe(null);
  });
});
