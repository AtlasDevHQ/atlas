/**
 * Better Auth catch-all route.
 *
 * Uses Better Auth's fetch-native handler (Request/Response, no framework adapter).
 * Dynamic imports ensure better-auth is never loaded when not in managed mode.
 * Returns 404 for all auth routes when managed mode is not active.
 */

import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { createLogger } from "@atlas/api/lib/logger";

const log = createLogger("auth-route");

/**
 * Custom header Better Auth reads for rate-limit IP bucketing.
 *
 * Set only by this middleware from the Bun socket address (or a proxied
 * X-Forwarded-For when ATLAS_TRUST_PROXY=true). Any inbound value on the
 * header is stripped first so end users can't spoof the IP bucket.
 *
 * Paired with `advanced.ipAddress.ipAddressHeaders: ["x-atlas-client-ip"]`
 * in `getAuthInstance()` — Better Auth will skip rate limiting (log warn)
 * whenever this header is missing, which protects us if the middleware
 * chain is ever bypassed.
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
    const response = await authInstance.handler(authRequest);

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
    // `hono/bun`'s getConnInfo reads server.requestIP() via c.env.
    // It expects c.env to be the Bun server (or an object with a
    // `server` property). When the auth catch-all runs without a
    // server context — Next.js standalone on Vercel, the Hono test
    // harness calling app.fetch(req) with no 2nd arg — c.env is
    // undefined and `"server" in c.env` would throw a TypeError.
    // The pre-check avoids spamming the warn log for that expected
    // case; `getConnInfo` throwing for any other reason still
    // surfaces as a warn so a future adapter swap doesn't silently
    // disable rate limiting.
    const hasServerContext = typeof c.env === "object" && c.env !== null;
    if (hasServerContext) {
      try {
        const info = getConnInfo(c);
        if (info.remote?.address) clientIp = info.remote.address;
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
 * Strip a trailing `:<port>` from an IP literal. Handles bracketed
 * IPv6 (`[::1]:5678` → `::1`) and IPv4-with-port (`1.2.3.4:5678` →
 * `1.2.3.4`). A bare IPv6 address containing colons (e.g. `::1`) is
 * left untouched because it has no trailing port.
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

  // IPv4 with port: 1.2.3.4:54321 → 1.2.3.4. A single colon with digits
  // after is the signature; IPv6 addresses have multiple colons so this
  // check leaves them intact.
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [host] = trimmed.split(":");
    return host;
  }

  return trimmed;
}

export { auth };
