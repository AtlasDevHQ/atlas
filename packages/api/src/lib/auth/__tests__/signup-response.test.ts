import { describe, it, expect } from "bun:test";
import { normalizeSignupResponseBody } from "../signup-response";

/**
 * Unit tests for the pure helper that backs the F-P3 / #1792 fix.
 *
 * The shape-guard branches are hot paths for the Hono-route wrapper:
 * every non-signup auth response flows through them. A regression that
 * accidentally mutates a non-user-shaped body would corrupt unrelated
 * Better Auth envelopes, so pin down the pass-through invariants here.
 *
 * The parity/integration coverage in `rate-limit-integration.test.ts`
 * proves the happy path against a real Better Auth instance; these
 * tests own the degenerate-input contract.
 */

describe("normalizeSignupResponseBody", () => {
  it("fills image / banExpires / banReason: null on a real-path body that omits them", () => {
    const body = {
      user: { id: "u1", email: "a@example.com", name: "A", emailVerified: false },
    };
    const result = normalizeSignupResponseBody(body) as {
      user: Record<string, unknown>;
    };
    // #1792 (image) + #3159 (banExpires/banReason moved to additionalFields):
    // every key the synthetic existing-email envelope materializes must be
    // present on the real path too, or key-presence leaks account existence.
    expect(result.user.image).toBeNull();
    expect(result.user.banExpires).toBeNull();
    expect(result.user.banReason).toBeNull();
    // Every pre-existing field must survive untouched.
    expect(result.user.id).toBe("u1");
    expect(result.user.email).toBe("a@example.com");
    expect(result.user.name).toBe("A");
    expect(result.user.emailVerified).toBe(false);
  });

  it("fills only the missing parity keys when some are already present (partial)", () => {
    // Realistic case: a signup body supplied `image`, so the real-path body has
    // `image` but still omits the null `banExpires`/`banReason` additionalFields.
    // The `.filter(missing)` branch must fill exactly those two and return a NEW
    // reference — a regression to the old `if ("image" in user) return body`
    // fast-path would skip them and reopen the oracle for image-supplying clients.
    const body = {
      user: { id: "u1", email: "a@example.com", image: "https://cdn/x.png" },
    };
    const result = normalizeSignupResponseBody(body) as { user: Record<string, unknown> };
    expect(result).not.toBe(body); // rewritten, not fast-pathed
    expect(result.user.image).toBe("https://cdn/x.png"); // existing value preserved
    expect(result.user.banExpires).toBeNull();
    expect(result.user.banReason).toBeNull();
  });

  it("preserves sibling keys on the envelope", () => {
    const body = {
      token: "verify-abc",
      user: { id: "u1", email: "a@example.com" },
    };
    const result = normalizeSignupResponseBody(body) as Record<string, unknown>;
    expect(result.token).toBe("verify-abc");
  });

  it("returns the same reference when every parity key is already present (fast path)", () => {
    // The synthetic existing-email branch always materializes all parity keys
    // (`image`/`banExpires`/`banReason`), so on that branch — and on an
    // already-normalized body — we must skip re-allocation so the Hono
    // wrapper's `===` fast-path avoids a pointless Response rebuild.
    const withNull = {
      user: { id: "u1", email: "a@example.com", image: null, banExpires: null, banReason: null },
    };
    expect(normalizeSignupResponseBody(withNull)).toBe(withNull);

    const withUrl = {
      user: {
        id: "u1",
        email: "a@example.com",
        image: "https://cdn/x.png",
        banExpires: null,
        banReason: null,
      },
    };
    expect(normalizeSignupResponseBody(withUrl)).toBe(withUrl);
  });

  it("is idempotent — second application is a no-op reference return", () => {
    // The pure helper's reference-equality contract is load-bearing for
    // the Hono wrapper's allocation skip. If a future change made the
    // first pass return a fresh object but the second pass also return
    // a fresh object, we'd allocate on every signup forever.
    const body = { user: { id: "u1", email: "a@example.com" } };
    const once = normalizeSignupResponseBody(body);
    const twice = normalizeSignupResponseBody(once);
    expect(twice).toBe(once);
  });

  it("passes through non-object bodies unchanged", () => {
    // Non-user-shaped bodies are the caller's responsibility to gate.
    // The helper itself must be a no-op so if the caller's path/status
    // guards regress, unrelated Better Auth responses aren't corrupted.
    expect(normalizeSignupResponseBody(null)).toBeNull();
    expect(normalizeSignupResponseBody(undefined)).toBeUndefined();
    expect(normalizeSignupResponseBody("string")).toBe("string");
    expect(normalizeSignupResponseBody(42)).toBe(42);
    expect(normalizeSignupResponseBody(true)).toBe(true);
  });

  it("passes through array bodies unchanged (reference preserved)", () => {
    const arr: unknown[] = [{ user: { email: "a@example.com" } }];
    expect(normalizeSignupResponseBody(arr)).toBe(arr);
  });

  it("passes through bodies with no user field", () => {
    // Better Auth error envelopes and many non-signup routes have no
    // `user` key. Guard against accidentally adding a fabricated user
    // object when the wrapper is (mistakenly) invoked on them.
    const errorEnvelope = { error: "RATE_LIMITED", code: "RATE_LIMITED" };
    expect(normalizeSignupResponseBody(errorEnvelope)).toBe(errorEnvelope);
  });

  it("passes through bodies where user is not a plain object", () => {
    // Every user-shape variant that isn't a plain object must skip the
    // rewrite. `null` (explicit signed-out envelope), array (malformed
    // upstream), primitive (defensive).
    const nullUser = { user: null };
    expect(normalizeSignupResponseBody(nullUser)).toBe(nullUser);

    const arrayUser = { user: ["not", "a", "user"] };
    expect(normalizeSignupResponseBody(arrayUser)).toBe(arrayUser);

    const stringUser = { user: "not-an-object" };
    expect(normalizeSignupResponseBody(stringUser)).toBe(stringUser);
  });

  it("does not touch nested objects under user beyond the image key", () => {
    // A future Better Auth version might nest e.g. `user.metadata.image`.
    // We only fill the top-level `user.image` — any nested image-shaped
    // key is left alone because the enumeration oracle is specifically
    // the top-level field.
    const body = {
      user: {
        id: "u1",
        email: "a@example.com",
        metadata: { image: "https://cdn/nested.png" },
      },
    };
    const result = normalizeSignupResponseBody(body) as {
      user: { image: unknown; metadata: { image: string } };
    };
    expect(result.user.image).toBeNull();
    expect(result.user.metadata.image).toBe("https://cdn/nested.png");
  });
});
