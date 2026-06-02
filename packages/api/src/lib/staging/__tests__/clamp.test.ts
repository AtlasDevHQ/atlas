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
 * section. Further cases lock the documented-env-var override (default,
 * empty, and whitespace-only fallback), the recipient-classifier boundary
 * (including the empty-array edge), and the future-transform passthrough
 * seam.
 *
 * The fixtures carry `body` / `from` / `headers` to assert the
 * preserve-everything-else guarantee. Those field names track the PRD's
 * anticipated email shape — today's concrete `EmailMessage`
 * (`lib/email/delivery.ts`) is just `{ to, subject, html }`. Because the
 * clamp is intentionally structural (it only reads `to` and shallow-copies
 * the rest), exercising extra fields is exactly the point: any field the
 * delivery layer grows must ride through untouched.
 *
 * Prior art: `packages/api/src/api/__tests__/cors-origin.test.ts` — a
 * security policy-boundary test asserting an allow/deny contract (the origin
 * allowlist), though it does so over a mocked HTTP route rather than a pure
 * function.
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

/**
 * A payload exercising every recipient field (#2984). `to` is a single string,
 * `cc` an array, `bcc` a single string, `replyTo` an array — the four shapes a
 * nodemailer `SendMailOptions` (the #3095 agent SMTP path) can carry — so the
 * clamp's per-field shape preservation is asserted across both forms at once.
 */
function emailWithAllRecipientFields() {
  return {
    to: "primary.customer@example.com",
    cc: ["cc.one@example.com", "cc.two@example.com"],
    bcc: "hidden.customer@example.com",
    replyTo: ["reply.here@example.com"],
    subject: "Quarterly summary",
    body: "<p>Numbers attached.</p>",
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

  // Case 7: an array `to` is redirected to a one-element `[sink]` array. The
  // shape is preserved (an array stays an array), so `clampOutbound`'s
  // `(T) => T` signature is type-honest — a caller declaring `to: string[]`
  // gets a real `string[]` back, not a bare string masquerading as one.
  // There is still exactly one recipient: the sink.
  it("rewrites an array `to` to a one-element sink array", () => {
    const result = clampOutbound("staging", emailWithArrayTo());
    expect(result.to).toEqual([DEFAULT_SINK]);
    expect(Array.isArray(result.to)).toBe(true);
  });

  // Edge case: an empty-array `to` (`[]`) is still a recipient field
  // (`[].every(...)` is vacuously true), so it is redirected to `[sink]` like
  // any other array rather than passed through unclamped. This pins the
  // vacuous-`.every` behavior the staging branch silently relies on: a future
  // "harden" to `to.length > 0 && to.every(...)` would drop `[]` through the
  // clamp unredirected, and this test would catch it.
  it("rewrites an empty-array `to` to the one-element sink array", () => {
    const result = clampOutbound("staging", { to: [] as string[], subject: "empty array" });
    expect(result.to).toEqual([DEFAULT_SINK]);
    expect(result.subject).toBe("empty array");
  });
});

describe("clampOutbound — every recipient field is redirected (#2984)", () => {
  // The latent trap #2984 closes: with only `to` redirected, a payload carrying
  // `cc`/`bcc`/`replyTo` real addresses would deliver to them on staging while
  // `to` looked correctly clamped. Every recipient field must land on the sink.
  it("redirects to / cc / bcc / replyTo all to the sink, preserving each field's shape", () => {
    const original = emailWithAllRecipientFields();
    const result = clampOutbound("staging", original);

    // Single-string fields → sink string; array fields → one-element [sink].
    expect(result.to).toBe(DEFAULT_SINK);
    expect(result.bcc).toBe(DEFAULT_SINK);
    expect(result.cc).toEqual([DEFAULT_SINK]);
    expect(result.replyTo).toEqual([DEFAULT_SINK]);

    // No real address survives in ANY recipient field.
    const serialized = JSON.stringify({
      to: result.to,
      cc: result.cc,
      bcc: result.bcc,
      replyTo: result.replyTo,
    });
    expect(serialized).not.toContain("primary.customer@example.com");
    expect(serialized).not.toContain("cc.one@example.com");
    expect(serialized).not.toContain("hidden.customer@example.com");
    expect(serialized).not.toContain("reply.here@example.com");

    // Non-recipient fields ride through untouched; input is not mutated.
    expect(result.subject).toBe("Quarterly summary");
    expect(result.from).toBe("Atlas <noreply@useatlas.dev>");
    expect(original.cc).toEqual(["cc.one@example.com", "cc.two@example.com"]);
  });

  // A payload that omits `to` but carries `cc` must still be claimed and
  // redirected — classification keys on the whole recipient set, not just `to`,
  // so a `to`-less payload can't slip through and leak its `cc`.
  it("redirects cc even when `to` is absent", () => {
    const result = clampOutbound("staging", {
      cc: ["leak.cc@example.com"],
      subject: "no to field",
    });
    expect(result.cc).toEqual([DEFAULT_SINK]);
    expect(result.subject).toBe("no to field");
  });

  // Prod regions stay identity even with the extra recipient fields — the
  // identity fast-path returns the same reference, no per-field rewrite.
  it("is identity for prod regions across all recipient fields", () => {
    const email = emailWithAllRecipientFields();
    const result = clampOutbound("us", email);
    expect(result).toBe(email);
    expect(result.cc).toEqual(["cc.one@example.com", "cc.two@example.com"]);
    expect(result.bcc).toBe("hidden.customer@example.com");
  });

  // A recipient field present but NOT recipient-shaped (numeric `cc`) is left
  // untouched — only real address values are redirected, never mis-stamped.
  it("leaves a non-recipient-shaped cc untouched while still clamping `to`", () => {
    // A numeric `cc` is not a recipient field (`isRecipientField` false), so it
    // is left as-is — only real address values are redirected, never mis-stamped.
    const result = clampOutbound("staging", {
      to: "real@example.com",
      cc: 42,
      subject: "weird cc",
    });
    expect(result.to).toBe(DEFAULT_SINK);
    expect(result.cc).toBe(42);
  });
});

describe("clampOutbound — documented sink env var", () => {
  it("honors STAGING_MAIL_SINK when set", () => {
    process.env.STAGING_MAIL_SINK = "soak-inbox@staging.useatlas.dev";
    const result = clampOutbound("staging", emailWithRealTo());
    expect(result.to).toBe("soak-inbox@staging.useatlas.dev");
  });

  // The clamp resolves the sink with `||`, not `??`, on purpose: an
  // explicitly-empty STAGING_MAIL_SINK must fall back to the default rather
  // than blank the recipient (a blank `to` would error in the transport or
  // let mail escape). A regression to `??` would silently pass every other
  // test — this is the one that locks the anti-footgun.
  it("falls back to the default sink when STAGING_MAIL_SINK is empty", () => {
    process.env.STAGING_MAIL_SINK = "";
    const result = clampOutbound("staging", emailWithRealTo());
    expect(result.to).toBe(DEFAULT_SINK);
  });

  // A whitespace-only value is the empty-string footgun one step further: it
  // is truthy, so a bare `||` would stamp `" "` on as the recipient — a
  // blank-ish address that bounces silently or lets mail escape. `resolveMailSink`
  // `.trim()`s before the `||`, so whitespace collapses to the default.
  it("falls back to the default sink when STAGING_MAIL_SINK is whitespace-only", () => {
    process.env.STAGING_MAIL_SINK = "   ";
    const result = clampOutbound("staging", emailWithRealTo());
    expect(result.to).toBe(DEFAULT_SINK);
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

  // `isRecipientField` only classifies a `to` that is a string OR an array of
  // ALL strings. A `to` of the wrong type — a non-string scalar, or an array
  // with a non-string element — is NOT a recipient field, so the payload is
  // left untouched (no spurious sink stamped on it). This locks the
  // `typeof`/`.every` checks against a future loosening that would mis-stamp
  // a malformed payload.
  it("does not clamp a payload whose `to` is not a string-or-string[]", () => {
    const numericTo = { to: 42, subject: "weird" };
    expect(clampOutbound("staging", numericTo)).toBe(numericTo);

    const mixedArrayTo = { to: ["alice@example.com", 42], subject: "weird" };
    expect(clampOutbound("staging", mixedArrayTo)).toBe(mixedArrayTo);
  });
});
