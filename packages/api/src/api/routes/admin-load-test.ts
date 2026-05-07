/**
 * Platform-admin endpoint to mint short-lived MCP load-test JWTs (#2135).
 *
 * Mounted at `POST /api/v1/admin/load-test/mcp-token`. Hard prereq for the
 * CI MCP load-test workflow in #2129 — the token returned here is what k6
 * carries in `Authorization: Bearer ...` against `/mcp/{workspace_id}/sse`.
 *
 * Why a bespoke route instead of the OAuth 2.1 path:
 * The OAuth surface (DCR + auth-code + PKCE) is the right shape for an
 * actual MCP client (Claude Desktop, Cursor) but the wrong shape for CI
 * — every re-run pollutes prod with another DCR client + user, and the
 * 5-step ceremony has 4 places it can wedge at 2 AM. This endpoint
 * mints directly against the same JWKS Better Auth's `jwt()` plugin
 * publishes, so the issued token verifies through the exact same
 * `verifyAccessToken` path real OAuth tokens do — there is no
 * "load-test only" verifier branch.
 *
 * See `lib/auth/load-test-tokens.ts` for the minting logic; this file
 * only handles HTTP shape, validation, rate limiting, and audit.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createPlatformRouter } from "./admin-router";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { hasInternalDB } from "@atlas/api/lib/db/internal";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createLogger } from "@atlas/api/lib/logger";
import { getConfig } from "@atlas/api/lib/config";
import { getApiRegion } from "@atlas/api/lib/residency/misrouting";
import { logAdminActionAwait, ADMIN_ACTIONS, errorMessage } from "@atlas/api/lib/audit";
import {
  mintLoadTestToken,
  JwksNotInitializedError,
  LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS,
  LOAD_TEST_TOKEN_MAX_TTL_SECONDS,
  LOAD_TEST_TOKEN_MIN_TTL_SECONDS,
} from "@atlas/api/lib/auth/load-test-tokens";

const log = createLogger("admin-load-test");

// ── Per-endpoint rate limiter ───────────────────────────────────────
//
// The shared admin RPM bucket would let a runaway loop in CI mint
// thousands of tokens before tripping the global gate. A 10/min/admin
// in-memory bucket scoped to this route is enough headroom for the
// real workflow (one mint per CI job, maybe a few retries) without
// giving a compromised admin a credential firehose.
//
// In-memory state is fine: the rate limit is per-process, and the
// blast radius if a region restarts is one extra ten-token burst per
// admin per minute. Persisting this would force a DB-failure-sensitive
// path on a credential-issuance route — strictly worse.

const LOAD_TEST_RATE_LIMIT_MAX = 10;
const LOAD_TEST_RATE_LIMIT_WINDOW_MS = 60_000;

interface RateBucket {
  /** Sorted ascending; entries older than `now - window` are evicted on each check. */
  timestamps: number[];
}

const loadTestRateBuckets = new Map<string, RateBucket>();

interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

function checkLoadTestRateLimit(actorId: string, now: number): RateLimitDecision {
  const cutoff = now - LOAD_TEST_RATE_LIMIT_WINDOW_MS;
  let bucket = loadTestRateBuckets.get(actorId);
  if (!bucket) {
    bucket = { timestamps: [] };
    loadTestRateBuckets.set(actorId, bucket);
  }
  // Evict stale entries — slice in place for O(n) where n is the surviving count.
  const firstValid = bucket.timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) bucket.timestamps.splice(0, firstValid);
  else if (firstValid === -1) bucket.timestamps.length = 0;

  if (bucket.timestamps.length < LOAD_TEST_RATE_LIMIT_MAX) {
    bucket.timestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }
  // The oldest surviving timestamp determines when a slot opens.
  const oldest = bucket.timestamps[0]!;
  const retryAfterMs = Math.max(1, oldest + LOAD_TEST_RATE_LIMIT_WINDOW_MS - now);
  return { allowed: false, retryAfterMs };
}

/** @internal — test-only. Reset the per-route bucket between cases. */
export function _resetLoadTestRateLimit(): void {
  loadTestRateBuckets.clear();
  _loadTestClockOverride = null;
}

/**
 * Test-only clock seam. The rate limiter reads `clock()` instead of
 * `Date.now()` directly so tests can fast-forward past the 60s window
 * without `setTimeout`-style flakiness. Production never sets this.
 */
let _loadTestClockOverride: (() => number) | null = null;

/** @internal — test-only. Pin the rate-limiter clock; pass `null` to release. */
export function _setLoadTestClockForTests(fn: (() => number) | null): void {
  _loadTestClockOverride = fn;
}

function clock(): number {
  return _loadTestClockOverride ? _loadTestClockOverride() : Date.now();
}

// ── Schemas ─────────────────────────────────────────────────────────

const MintTokenBodySchema = z
  .object({
    workspaceId: z.string().min(1, "workspaceId is required").openapi({
      description: "The Atlas organization id the minted token will be scoped to. The MCP path must match (`/mcp/{workspaceId}/sse`).",
    }),
    ttlSeconds: z.coerce
      .number()
      .int()
      .min(LOAD_TEST_TOKEN_MIN_TTL_SECONDS, `ttlSeconds must be ≥ ${LOAD_TEST_TOKEN_MIN_TTL_SECONDS}`)
      .max(LOAD_TEST_TOKEN_MAX_TTL_SECONDS, `ttlSeconds must be ≤ ${LOAD_TEST_TOKEN_MAX_TTL_SECONDS}`)
      .default(LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS)
      .optional()
      .openapi({
        description: `Token TTL in seconds. Server-side ceiling is ${LOAD_TEST_TOKEN_MAX_TTL_SECONDS}s; default ${LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS}s. Requests for larger values are rejected with 400 — the cap is not silently clamped.`,
      }),
    region: z.string().min(1).optional().openapi({
      description: "Region key (e.g. `us`, `eu`, `apac`) matching `residency.regions[*]` in atlas.config.ts. Defaults to this API instance's region when omitted. The token's audience is bound to the resolved region's API URL — verifying against a different regional MCP edge will fail closed.",
    }),
  })
  .openapi("MintMcpTokenRequest");

const MintTokenResponseSchema = z
  .object({
    bearer: z
      .string()
      .openapi({ description: "The signed JWT. Carry verbatim in `Authorization: Bearer <bearer>`. Must NEVER be embedded in logs or stored to disk." }),
    workspaceId: z.string(),
    audience: z.string().openapi({ description: "The audience claim burned into the token; matches the regional `/mcp` URL the verifier accepts." }),
    issuer: z.string().openapi({ description: "The issuer claim — `${regional-api}/api/auth`." }),
    expiresAt: z.string().openapi({ description: "ISO 8601 wall-clock expiry." }),
    sub: z.string().openapi({ description: "Synthetic subject — `loadtest:<workspaceId>:<random>`. Safe to log; appears in every audit row downstream." }),
    scope: z.string().openapi({ description: "Scope granted on the token. Always `mcp:read`." }),
  })
  .openapi("MintMcpTokenResponse");

// ── Region resolution ───────────────────────────────────────────────

interface RegionResolution {
  /** The resolved region label used in audit + response. Null when self-hosted. */
  region: string | null;
  /** Audience URL to stamp on the token (`${apiUrl}/mcp`). */
  audience: string;
  /** Issuer URL to stamp on the token (`${apiUrl}/api/auth`). */
  issuer: string;
}

/**
 * Resolve issuer + audience for the requested region.
 *
 * Three branches:
 *
 *   1. **Caller passed `region`** — must exist in `residency.regions`,
 *      and that entry must have an `apiUrl`. Otherwise 400 (the caller
 *      asked for something that doesn't exist; silent fallback would
 *      mint a token that fails verification at the wrong region).
 *   2. **No region passed, residency configured** — use the API
 *      instance's own region (`getApiRegion()`). This is the common
 *      single-region-CI case: caller says "mint me a token for here",
 *      audience matches the same region serving the request.
 *   3. **No residency configured** — self-hosted. Fall back to the
 *      request origin (same shape `hosted.ts:resourceAudience` reads).
 *      Self-hosted operators can load-test their single instance
 *      without setting up the regions map.
 */
function resolveRegion(
  reqUrl: string,
  requestedRegion: string | undefined,
): { ok: true; result: RegionResolution } | { ok: false; error: string; message: string } {
  const config = getConfig();
  const regions = config?.residency?.regions;

  if (requestedRegion) {
    const entry = regions?.[requestedRegion];
    if (!entry) {
      return {
        ok: false,
        error: "unknown_region",
        message: `Region "${requestedRegion}" is not configured. Add it to residency.regions in atlas.config.ts, or omit the region parameter to default to this API's region.`,
      };
    }
    if (!entry.apiUrl) {
      return {
        ok: false,
        error: "region_missing_api_url",
        message: `Region "${requestedRegion}" is configured but does not declare an apiUrl. Set residency.regions["${requestedRegion}"].apiUrl in atlas.config.ts.`,
      };
    }
    return {
      ok: true,
      result: buildResolution(requestedRegion, entry.apiUrl),
    };
  }

  // Caller omitted region — default to this API's own region.
  const ownRegion = getApiRegion();
  if (ownRegion && regions?.[ownRegion]?.apiUrl) {
    return {
      ok: true,
      result: buildResolution(ownRegion, regions[ownRegion]!.apiUrl!),
    };
  }

  // Self-hosted fallback: derive from the request origin to match the
  // exact audience the local MCP verifier builds. `ATLAS_PUBLIC_API_URL`
  // and `BETTER_AUTH_URL` take precedence in `hosted.ts:resourceAudience`,
  // so we mirror that order here so the audience matches whatever the
  // verifier accepts on this instance.
  const base = (
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(reqUrl).origin
  ).replace(/\/+$/, "");
  return { ok: true, result: buildResolution(ownRegion, base) };
}

function buildResolution(region: string | null, apiUrl: string): RegionResolution {
  const trimmed = apiUrl.replace(/\/+$/, "");
  return {
    region,
    audience: `${trimmed}/mcp`,
    issuer: `${trimmed}/api/auth`,
  };
}

// ── Route ───────────────────────────────────────────────────────────

const mintTokenRoute = createRoute({
  method: "post",
  path: "/mcp-token",
  tags: ["Platform Admin — Load Test"],
  summary: "Mint a short-lived MCP-scoped JWT for load testing",
  description: [
    "Mints a JWT signed by the regional Better Auth JWKS, scoped to `mcp:read` and bound to the requested workspace. ",
    "Intended for the CI load-test workflow (#2129) — k6 calls this once per run, then carries the bearer in `Authorization: Bearer <token>` against `/mcp/{workspaceId}/sse`. ",
    "TTL is capped at 3600s server-side; requests above the cap are rejected with 400. ",
    "The bearer must NEVER be logged or persisted; the audit row carries only `jti` for forensic correlation. ",
    "Region constraint: the token's audience is bound to one regional API. Calling this against `api.useatlas.dev` and using the bearer against `api-eu.useatlas.dev` will fail with 401 (audience mismatch).",
  ].join(""),
  request: {
    body: {
      content: { "application/json": { schema: MintTokenBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Token minted",
      content: { "application/json": { schema: MintTokenResponseSchema } },
    },
    400: { description: "Invalid body, ttl out of range, or unknown region", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    403: { description: "Caller is not platform_admin (or MFA not enrolled)", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured (no JWKS table to read)", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Per-endpoint mint rate exceeded (10/min/admin)", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal error during minting (e.g. JWK decryption failed)", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "JWKS table empty — hit any /api/auth/* endpoint on this region once to seed and retry", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const adminLoadTest = createPlatformRouter();

adminLoadTest.openapi(
  mintTokenRoute,
  async (c) => {
    return runHandler(c, "mint mcp load-test token", async () => {
      const requestId = c.get("requestId");
      const authResult = c.get("authResult");

      if (!hasInternalDB()) {
        return c.json(
          {
            error: "not_configured",
            message: "Internal database (DATABASE_URL) is not configured — no JWKS to mint against.",
            requestId,
          },
          404,
        );
      }

      // The platform-admin gate guarantees `authResult.user` is present
      // unless the deploy mode is "none" (local dev) — we use the user id
      // when present, fall back to a stable string when not, so the rate
      // limit bucket is consistent across requests.
      const actorId = authResult.user?.id ?? "no-auth-mode";

      const rate = checkLoadTestRateLimit(actorId, clock());
      if (!rate.allowed) {
        const retryAfterSeconds = Math.ceil(rate.retryAfterMs / 1000);
        return c.json(
          {
            error: "rate_limited",
            message: `Per-admin mint rate exceeded (${LOAD_TEST_RATE_LIMIT_MAX}/min). Retry in ${retryAfterSeconds}s.`,
            requestId,
          },
          429,
          { "Retry-After": String(retryAfterSeconds) },
        );
      }

      // Body has already passed the per-route hook below — use the
      // validated handle. `valid("json")` carries Zod's parsed result,
      // so optional fields (ttlSeconds, region) come through with their
      // schema defaults and types narrowed.
      const body = c.req.valid("json");
      const ttlSeconds = body.ttlSeconds ?? LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS;

      // ── Resolve region → audience/issuer ───────────────────────────
      const region = resolveRegion(c.req.url, body.region);
      if (!region.ok) {
        return c.json({ error: region.error, message: region.message, requestId }, 400);
      }

      // ── Mint ──────────────────────────────────────────────────────
      const secret = process.env.BETTER_AUTH_SECRET ?? null;
      let minted;
      try {
        minted = await mintLoadTestToken({
          workspaceId: body.workspaceId,
          ttlSeconds,
          issuer: region.result.issuer,
          audience: region.result.audience,
          secret,
        });
      } catch (err) {
        if (err instanceof JwksNotInitializedError) {
          return c.json({ error: err.code, message: err.message, requestId }, 503);
        }
        // Anything else is an unexpected mint failure (decryption,
        // bad-row data, jose import, internal-DB outage on the JWKS
        // read). Pass through `errorMessage()` to scrub `scheme://user:
        // pass@host` userinfo from pg / better-auth errors before any
        // of this lands in pino or the audit metadata column — the JWKS
        // read goes through internalQuery, so a connection-string in
        // the error string is a real hazard. The minter itself sanitizes
        // the JSON.parse-on-decrypted-content path (see unwrapPrivateJwk
        // in load-test-tokens.ts), so by the time we reach this catch
        // the error message no longer carries decrypted key fragments.
        const message = errorMessage(err);
        log.error(
          {
            err: message,
            requestId,
            workspaceId: body.workspaceId,
            region: region.result.region,
            actorId,
          },
          "Load-test mint failed unexpectedly",
        );
        // Best-effort failure audit so the attempt is still on record.
        // Awaited on success below; on failure, we await here too — a
        // hidden exception would otherwise lose the trail.
        try {
          await logAdminActionAwait({
            actionType: ADMIN_ACTIONS.load_test.mintMcpToken,
            targetType: "load_test",
            targetId: body.workspaceId,
            status: "failure",
            scope: "platform",
            metadata: {
              workspaceId: body.workspaceId,
              region: region.result.region,
              ttlSeconds,
              error: message,
            },
          });
        } catch (auditErr) {
          // Inner-catch enrichment: if the failure-path audit ALSO
          // throws (DB down mid-incident), the operator still needs
          // every pivot they would have had on the audit row —
          // workspaceId, region, actorId, plus the original mint error
          // — without the structured row to query. Without these
          // fields the line is groupable only by `requestId`, which is
          // the slowest possible search path on a hot incident page.
          log.error(
            {
              err: errorMessage(auditErr),
              requestId,
              workspaceId: body.workspaceId,
              region: region.result.region,
              actorId,
              originalMintError: message,
            },
            "Failed to write failure audit row for mint exception — manual audit reconciliation required",
          );
        }
        return c.json(
          {
            error: "mint_failed",
            message: "Failed to mint MCP load-test token. Check server logs and retry; if this persists, the JWKS row may be malformed.",
            requestId,
          },
          500,
        );
      }

      // ── Audit (awaited — credential issuance is the security control) ─
      // The bearer is intentionally NOT in metadata. `jti` is the
      // forensic correlation handle — every MCP session-init from a
      // load-test bearer surfaces the same `jti` in `mcp_session.start`
      // metadata, so reviewers can pivot from a suspicious session row
      // back to the mint that authorized it.
      await logAdminActionAwait({
        actionType: ADMIN_ACTIONS.load_test.mintMcpToken,
        targetType: "load_test",
        targetId: body.workspaceId,
        scope: "platform",
        metadata: {
          workspaceId: body.workspaceId,
          region: region.result.region,
          ttlSeconds,
          sub: minted.sub,
          jti: minted.jti,
          expiresAt: minted.expiresAt,
        },
      });

      return c.json(
        {
          bearer: minted.bearer,
          workspaceId: body.workspaceId,
          audience: minted.audience,
          issuer: minted.issuer,
          expiresAt: minted.expiresAt,
          sub: minted.sub,
          scope: minted.scope,
        },
        200,
      );
    });
  },
  // Per-route validation hook — overrides the platform router's default
  // (which returns 422). The issue spec requires 400 on body validation
  // failures so a misconfigured CI job doesn't have to special-case the
  // status code; surface the underlying Zod issue messages so the
  // operator sees the actionable line ("ttlSeconds must be ≤ 3600")
  // instead of a generic "validation failed".
  (result, c) => {
    if (result.success) return;
    const requestId = c.get("requestId");
    const message = result.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return c.json(
      { error: "invalid_body", message, requestId },
      400,
    );
  },
);

export { adminLoadTest };
