/**
 * Better Auth catch-all route.
 *
 * Uses Better Auth's fetch-native handler (Request/Response, no framework adapter).
 * Dynamic imports ensure better-auth is never loaded when not in managed mode.
 * Returns 404 for all auth routes when managed mode is not active.
 */

import { Hono, type Context } from "hono";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { createLogger } from "@atlas/api/lib/logger";
import { normalizeSignupResponseBody } from "@atlas/api/lib/auth/signup-response";

const log = createLogger("auth-route");

/**
 * Full Better Auth signup path (mount `/api/auth` + route `/sign-up/email`)
 * that must be intercepted to close the F-P3 / #1792 enumeration oracle.
 * Only the success response for this exact path is rewritten — every other
 * auth route streams through untouched.
 *
 * Matched with strict `===` rather than `endsWith` so an unrelated sub-path
 * like `/api/auth/plugin/sign-up/email` can't accidentally slip into the
 * rewrite branch. Better Auth owns the `/sign-up/email` segment, so any
 * such path would 404 and the 2xx guard would catch it — but the explicit
 * match makes the scope contract visible to a future reader and removes
 * one layer of reliance on defense-in-depth.
 */
const SIGNUP_EMAIL_PATH = "/api/auth/sign-up/email";

/**
 * Custom header Better Auth reads for rate-limit IP bucketing.
 *
 * Set only by this middleware from the Bun socket address (or a proxied
 * X-Forwarded-For when ATLAS_TRUST_PROXY=true). Any inbound value on the
 * header is stripped first so end users can't spoof the IP bucket.
 *
 * The other half of the pairing lives in `buildAdvancedConfig` in
 * `packages/api/src/lib/auth/server.ts`, which tells Better Auth to
 * read ONLY this header for client IPs — without that pin, Better
 * Auth would also accept X-Forwarded-For directly and reopen F-06.
 */
const CLIENT_IP_HEADER = "x-atlas-client-ip";

const auth = new Hono();

auth.all("/*", async (c) => {
  if (detectAuthMode() !== "managed") {
    return c.json(
      { error: "not_found", message: "Auth routes are not enabled" },
      404,
    );
  }

  try {
    const { getAuthInstance } = await import("@atlas/api/lib/auth/server");
    const authInstance = getAuthInstance();
    const authRequest = withClientIpHeader(c);
    const upstream = await authInstance.handler(authRequest);
    const response = await maybeNormalizeSignupResponse(c, upstream);

    // Better Auth returns a raw Response, bypassing Hono's response
    // pipeline. Copy CORS headers set by the upstream middleware so
    // cross-origin requests (app.useatlas.dev → api.useatlas.dev) work.
    const corsOrigin = c.res.headers.get("Access-Control-Allow-Origin");
    if (corsOrigin) {
      response.headers.set("Access-Control-Allow-Origin", corsOrigin);
      const corsCreds = c.res.headers.get("Access-Control-Allow-Credentials");
      if (corsCreds) response.headers.set("Access-Control-Allow-Credentials", corsCreds);
      const corsExpose = c.res.headers.get("Access-Control-Expose-Headers");
      if (corsExpose) response.headers.set("Access-Control-Expose-Headers", corsExpose);
    }

    return response;
  } catch (err) {
    log.error(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        url: c.req.url,
      },
      "Auth route handler failed",
    );
    return c.json(
      {
        error: "auth_service_error",
        message: "Authentication service unavailable",
      },
      503,
    );
  }
});

/**
 * When the upstream Better Auth response is a success envelope for
 * `/sign-up/email`, rewrite it so `user.image` is always present (as
 * `null`) regardless of whether the signup body supplied one.
 *
 * Closes F-P3 / #1792 — the real-vs-synthetic response asymmetry that
 * let a client distinguish new from existing emails by checking
 * `"image" in body.user`. The transformation is a no-op for every
 * other auth route, every non-2xx status, and every non-JSON body.
 *
 * Scope-guards (any one failing = pass-through unchanged):
 *   1. Path must be exactly `/api/auth/sign-up/email`. Signup is the
 *      only route where Better Auth emits the synthetic-existing
 *      envelope, and strict equality keeps the rewrite out of any
 *      plugin-registered sibling routes that happen to share the
 *      trailing segment.
 *   2. Status must be 2xx. Error envelopes (400/422/429/500) follow a
 *      different schema and rewriting them could corrupt legitimate
 *      error payloads.
 *   3. Content-Type must be `application/json`. Non-JSON bodies
 *      (redirect HTML, empty 204s) are passed through.
 *   4. Body must parse as JSON. A parse failure logs warn and returns
 *      the original response untouched — an unparseable body cannot be
 *      the `/sign-up/email` JSON envelope this workaround targets, so
 *      forwarding Better Auth's (untampered) output is correct and
 *      safe. The log exists so operators see if Better Auth ever
 *      changes the response shape and the normalizer stops applying.
 *
 * The rewrite preserves every upstream header (including Set-Cookie
 * for verification tokens) because it copies `upstream.headers` into
 * the new Response; only the body bytes change.
 *
 * Rip this workaround out once better-auth/better-auth#9346 lands a
 * symmetric `parseUserOutput` upstream.
 */
export async function maybeNormalizeSignupResponse(
  c: Context,
  upstream: Response,
): Promise<Response> {
  if (c.req.path !== SIGNUP_EMAIL_PATH) return upstream;
  if (upstream.status < 200 || upstream.status >= 300) return upstream;
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return upstream;

  const raw = await upstream.clone().text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err: errorMessage(err), path: c.req.path, status: upstream.status },
      "Signup response advertised application/json but did not parse — "
        + "skipping F-P3 normalization and forwarding upstream body unchanged.",
    );
    return upstream;
  }

  const normalized = normalizeSignupResponseBody(parsed);
  // Fast path: the real body already had `user.image` (e.g. the
  // caller supplied one, or we're on the synthetic branch). Return
  // the original Response so we don't burn an allocation on an
  // identical serialization.
  if (normalized === parsed) return upstream;

  // The rewritten body is longer by one `"image":null,` key — the
  // upstream Content-Length (if set) is now stale and would make a
  // strict client truncate the trailing bytes. Drop it and let the
  // runtime recompute on send.
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");

  return new Response(JSON.stringify(normalized), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * Resolve the real client IP and attach it to {@link CLIENT_IP_HEADER}
 * on a cloned Request before handing to Better Auth. Strips any inbound
 * value of the header to prevent spoofing.
 *
 * Resolution order:
 *   1. When {@link shouldTrustProxyHeaders} is on: first entry of
 *      X-Forwarded-For, then X-Real-IP. This is what runs in Railway /
 *      Vercel / nginx — those platforms set X-Forwarded-For on every
 *      request and Vercel is auto-detected even without the env var
 *      because `fetch(req)` on their edge never carries a Bun socket.
 *   2. Otherwise: the Bun socket-level peer address via `hono/bun`'s
 *      getConnInfo. This is what runs in local dev and single-node
 *      Docker deployments.
 *
 * Whichever source yields an IP, the port suffix (IPv4 `1.2.3.4:5678`,
 * bracketed IPv6 `[::1]:5678`) is stripped — leaving it in would let
 * one attacker's connections occupy distinct rate-limit buckets per
 * ephemeral source port, silently defeating the quota.
 *
 * When no source yields an IP, the header is left unset and Better
 * Auth skips rate limiting for that request (logging a warn). That is
 * preferable to writing `"unknown"` — a shared bucket would let one
 * attacker exhaust the quota for every unrelated request.
 *
 * Exported for testing: this is the trust boundary for F-06 and the
 * unit tests pin the spoof-strip, trust-proxy toggle, multi-hop XFF,
 * IPv6, and missing-socket cases.
 */
export function withClientIpHeader(c: Context): Request {
  const original = c.req.raw;
  const incoming = new Headers(original.headers);
  incoming.delete(CLIENT_IP_HEADER);

  const trustProxy = shouldTrustProxyHeaders(process.env);

  let clientIp: string | undefined;
  if (trustProxy) {
    const xff = original.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) clientIp = first;
    }
    if (!clientIp) {
      const realIp = original.headers.get("x-real-ip")?.trim();
      if (realIp) clientIp = realIp;
    }
  }
  if (!clientIp) {
    // Resolve the Bun socket IP via `server.requestIP(req)`. We
    // replicate `hono/bun`'s getConnInfo inline rather than importing
    // it — that module references the `Bun` global at evaluation
    // time, which breaks the Next.js standalone example's build
    // (Next tries to collect page data under a Node runtime where
    // Bun is not defined). The inline version has zero Bun-global
    // dependency and runs as a no-op in non-Bun environments.
    //
    // When the auth catch-all runs without a server context
    // (Next.js standalone on Vercel, the Hono test harness calling
    // app.fetch(req) with no 2nd arg), `c.env` is undefined or lacks
    // `requestIP`, and we leave `clientIp` unset so Better Auth
    // skips rate limiting for that request.
    const server = resolveBunServer(c.env);
    if (server) {
      try {
        const info = server.requestIP(c.req.raw);
        if (info?.address) clientIp = info.address;
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Could not resolve socket client IP — Better Auth rate limiter will skip this request. "
            + "If running behind a proxy, set ATLAS_TRUST_PROXY=true so X-Forwarded-For is consulted.",
        );
      }
    }
  }

  if (clientIp) {
    const normalized = stripPortSuffix(clientIp);
    if (normalized) incoming.set(CLIENT_IP_HEADER, normalized);
  }

  // A Request body is a one-shot stream; `new Request(original, { headers })`
  // re-uses the original body reference, which is what we want.
  return new Request(original, { headers: incoming });
}

/**
 * Platform-neutral Bun server resolver. Mirrors `hono/bun`'s
 * `getBunServer` / `getConnInfo` without importing the Bun adapter —
 * the adapter's top-level code references the `Bun` global, which
 * throws `ReferenceError: Bun is not defined` during Next.js
 * standalone build when Next collects page data under a Node runtime.
 *
 * Returns `null` when `env` isn't a plausible Bun server (test
 * harness with no 2nd fetch arg, Next.js route handlers, Node-only
 * deploys). Returns a minimal interface otherwise so the caller can
 * extract `.address` without pulling in Bun-specific types.
 */
interface BunLikeServer {
  requestIP: (req: Request) => { address?: string; family?: string; port?: number } | null;
}
function resolveBunServer(env: unknown): BunLikeServer | null {
  if (typeof env !== "object" || env === null) return null;
  const candidate =
    "server" in env && typeof (env as Record<string, unknown>).server === "object"
      ? (env as Record<string, unknown>).server
      : env;
  if (
    candidate !== null
    && typeof candidate === "object"
    && typeof (candidate as { requestIP?: unknown }).requestIP === "function"
  ) {
    return candidate as BunLikeServer;
  }
  return null;
}

/**
 * Determine whether to trust proxy-set headers (X-Forwarded-For /
 * X-Real-IP) for the client IP.
 *
 * Trust is enabled when:
 *   - ATLAS_TRUST_PROXY is `"true"` or `"1"` (explicit operator opt-in), or
 *   - `VERCEL=1` is set (Vercel's edge always sets X-Forwarded-For and
 *     no Bun socket is available — without this auto-detect, rate
 *     limiting would silently no-op on Vercel deploys).
 *
 * Exported for testing.
 */
export function shouldTrustProxyHeaders(env: NodeJS.ProcessEnv): boolean {
  if (env.ATLAS_TRUST_PROXY === "true" || env.ATLAS_TRUST_PROXY === "1") return true;
  if (env.VERCEL === "1") return true;
  return false;
}

/**
 * Strip a trailing `:<port>` from an IP literal.
 *
 * Handled cases:
 *   - Bracketed IPv6 with port: `[::1]:5678`          → `::1`
 *   - IPv4 with numeric port:   `1.2.3.4:5678`        → `1.2.3.4`
 *
 * Left untouched:
 *   - Bare IPv6 (multiple colons): `::1`, `fe80::1%eth0`, `::ffff:1.2.3.4`
 *   - Non-numeric trailing segments: `host:something`, `1.2.3.4:abc`
 *     (these are not port suffixes and silently dropping them would
 *     hide a misconfiguration AND place the request in an unexpected
 *     rate-limit bucket).
 *
 * Only the exactly-one-colon-with-digits-after signature counts as
 * IPv4:port; anything else passes through unchanged.
 *
 * Exported for testing.
 */
export function stripPortSuffix(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Bracketed IPv6: [2001:db8::1]:54321 → 2001:db8::1
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) return trimmed.slice(1, end);
    return trimmed;
  }

  // IPv4 with port: exactly one colon AND the suffix is all digits.
  // Any multi-colon form (bare IPv6, zone-id, IPv4-mapped IPv6) has
  // colonCount > 1 so the heuristic leaves it alone.
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [host, portSuffix] = trimmed.split(":");
    if (portSuffix !== undefined && /^\d+$/.test(portSuffix)) return host;
  }

  return trimmed;
}

export { auth };
