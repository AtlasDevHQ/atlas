import { describe, it, expect } from "bun:test";
import type { Context } from "hono";
import { maybeNormalizeSignupResponse } from "../routes/auth";

/**
 * Regression tests for the Hono-route wrapper that carries the F-P3 /
 * #1792 fix.
 *
 * The parity test in `lib/auth/__tests__/rate-limit-integration.test.ts`
 * drives a real Better Auth instance and applies the pure helper at
 * the test boundary — that assertion proves the oracle is closed, but
 * it bypasses the wrapper. These tests own the wrapper's scope guards
 * and Response-rebuild invariants:
 *
 *   1. Path guard — only `/sign-up/email` responses are rewritten.
 *   2. Status guard — non-2xx (error envelopes) flow through untouched.
 *   3. Content-type guard — non-JSON bodies flow through untouched.
 *   4. Parse-failure guard — JSON-advertised but malformed bodies flow
 *      through untouched (unparseable ≠ target envelope).
 *   5. Fast-path identity — when the helper is a no-op, the ORIGINAL
 *      Response reference is returned. A rebuild would strip
 *      `Content-Length` unnecessarily and burn an allocation per
 *      signup forever.
 *   6. Content-Length drop — when the body IS rewritten, the stale
 *      upstream `Content-Length` is dropped so a strict client proxy
 *      doesn't truncate the trailing bytes.
 */

/**
 * Minimal Hono `Context` stub — only `c.req.path` is read by
 * `maybeNormalizeSignupResponse`. Using a narrow fake keeps the tests
 * off the real Hono app (which would require a live Better Auth
 * instance to exercise the catch-all).
 */
function makeCtx(path: string): Context {
  return { req: { path } } as unknown as Context;
}

function jsonResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const serialized = JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json", ...init?.headers });
  return new Response(serialized, { status: init?.status ?? 200, headers });
}

describe("maybeNormalizeSignupResponse — scope guards", () => {
  it("returns the upstream Response ref unchanged for non-signup paths", async () => {
    // A future refactor that broadens the wrapper's scope (e.g. moved
    // into a catch-all middleware without path scoping) would fail
    // this test because `/sign-in/email` bodies would start getting
    // rewritten with fabricated `image: null` fields.
    const upstream = jsonResponse({ user: { email: "a@example.com" } });
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-in/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("does not match a sub-path that tail-ends with /sign-up/email", async () => {
    // Strict `===` equality (not `endsWith`) keeps a plugin-registered
    // path like `/api/auth/plugin/sign-up/email` out of the rewrite
    // branch. Better Auth would 404 such a path today and the 2xx
    // guard would catch it anyway — but the explicit match pins the
    // scope contract so a future Better Auth route-registration bug
    // can't silently reopen the rewrite on a sibling path.
    const upstream = jsonResponse({ user: { email: "a@example.com" } });
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/plugin/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged for non-2xx signup status", async () => {
    // Better Auth's error envelopes (422 USER_ALREADY_EXISTS, 429
    // RATE_LIMITED, 400 VALIDATION) have a different schema — rewriting
    // them could corrupt legitimate `error`/`code` fields and mask
    // operator-visible failure modes. The synthetic 200 envelope is
    // the only one we're trying to match shapes with.
    const upstream = jsonResponse({ user: { email: "a@example.com" } }, { status: 422 });
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged for non-JSON content-type", async () => {
    // A redirect-to-verification-URL implementation (text/html body)
    // would otherwise get text passed through JSON.parse and trip the
    // parse-failure guard — which is fine, but short-circuiting at the
    // content-type check saves a clone+text+parse cycle.
    const upstream = new Response("<html>...</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged when JSON body fails to parse", async () => {
    // Defensive: if Better Auth ever returns a malformed body with the
    // JSON content-type, the normalizer can't run — but the body can't
    // be our target envelope either, so pass-through is safe. The warn
    // log (not asserted here) exists for operator visibility.
    const upstream = new Response("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });

  it("returns the upstream Response ref unchanged when body already has user.image", async () => {
    // The fast-path: synthetic existing-email envelope already has
    // `image: null`, and a signup body that supplied `image` rounds
    // through the real path with it already present. Either way, the
    // pure helper returns the same reference and the wrapper must
    // return the ORIGINAL `upstream` Response — not a rebuilt one —
    // so we don't strip `Content-Length` or allocate on the hot path.
    const upstream = jsonResponse({
      user: { id: "u1", email: "a@example.com", image: null },
    });
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).toBe(upstream);
  });
});

describe("maybeNormalizeSignupResponse — rewrite path", () => {
  it("rewrites the body to include user.image: null when absent", async () => {
    const upstream = jsonResponse({
      user: { id: "u1", email: "a@example.com", name: "A", emailVerified: false },
    });
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).not.toBe(upstream);
    expect(result.status).toBe(200);

    const parsed = (await result.json()) as { user: Record<string, unknown> };
    expect(parsed.user.image).toBeNull();
    // Every sibling field survives the rewrite.
    expect(parsed.user.id).toBe("u1");
    expect(parsed.user.email).toBe("a@example.com");
    expect(parsed.user.name).toBe("A");
    expect(parsed.user.emailVerified).toBe(false);
  });

  it("drops stale Content-Length from the upstream headers on rewrite", async () => {
    // The rewritten body is strictly longer than the upstream (one
    // extra `"image":null,` key). If the original Content-Length is
    // carried over, a strict HTTP client would truncate the trailing
    // bytes and the `image` key might not even make it to the wire —
    // silently reopening the oracle. Drop the header so the runtime
    // recomputes on send.
    const upstream = jsonResponse(
      { user: { id: "u1", email: "a@example.com" } },
      { headers: { "content-length": "42" } },
    );
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result.headers.get("content-length")).toBeNull();
  });

  it("preserves non-Content-Length upstream headers on rewrite", async () => {
    // Set-Cookie carries Better Auth's verification-email session, and
    // any `Vary` / cache-control signaling must survive the rewrite.
    // A header copy bug here would break email verification flow.
    const upstream = jsonResponse(
      { user: { id: "u1", email: "a@example.com" } },
      {
        headers: {
          "set-cookie": "atlas-session=abc; HttpOnly; SameSite=Lax",
          "vary": "Origin",
          "cache-control": "no-store",
        },
      },
    );
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result.headers.get("set-cookie")).toContain("atlas-session=abc");
    expect(result.headers.get("vary")).toBe("Origin");
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("handles application/json; charset=utf-8 content-type", async () => {
    // Better Auth sends `application/json` with explicit charset in
    // some code paths. The `includes("application/json")` check has
    // to survive that — a stricter `===` would regress to pass-through
    // and skip the rewrite.
    const upstream = new Response(
      JSON.stringify({ user: { id: "u1", email: "a@example.com" } }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    );
    const result = await maybeNormalizeSignupResponse(
      makeCtx("/api/auth/sign-up/email"),
      upstream,
    );
    expect(result).not.toBe(upstream);
    const parsed = (await result.json()) as { user: Record<string, unknown> };
    expect(parsed.user.image).toBeNull();
  });
});
