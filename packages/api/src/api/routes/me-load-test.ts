/**
 * Self-mint MCP load-test JWTs (#2135 follow-up).
 *
 * Mounted at `POST /api/v1/me/load-test/mcp-token`. The caller mints a
 * short-lived MCP-scoped bearer for THEIR OWN active workspace — no body
 * `workspaceId`, the route reads `authResult.user.activeOrganizationId`
 * directly. By construction, the caller cannot mint a token for a
 * workspace they don't own.
 *
 * Why /me instead of the original platform-admin endpoint:
 * Self-mint is functionally equivalent to a workspace member completing
 * the OAuth 2.1 ceremony against their own workspace — same scope,
 * same audience, same workspace claim. The only difference is bypassing
 * the consent ceremony. There's no security delta from a token a member
 * could already obtain through the front door, so gating it at the
 * platform-admin tier was over-secured.
 *
 * The original cross-tenant mint route was deleted alongside this PR —
 * it gave platform_admin a new MCP-via-tool-call data exfiltration path
 * (mint a token for any workspace, then run executeSQL against that
 * workspace's data). Audit + rate limit made it traceable, not
 * prevented. Per-workspace self-mint closes that surface entirely.
 *
 * The minting logic itself lives in `lib/auth/load-test-tokens.ts` and
 * is shared with any future variants — that module is the single source
 * of truth for the JWT shape the MCP edge verifier expects.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
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
import { validationHook } from "./validation-hook";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("me-load-test");

// ── Per-endpoint rate limiter ───────────────────────────────────────
//
// 10 mints/min per user id (`actorId = user.id`). Tight enough that a
// runaway loop in CI can't drain credentials before tripping; loose
// enough that retries + reasonable test cadence work. State is in
// memory and per process — concurrent CI jobs signed in as the same
// user share one bucket, and a region restart resets all buckets
// (worst case: one extra ten-token burst per caller per minute).

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
  const firstValid = bucket.timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) bucket.timestamps.splice(0, firstValid);
  else if (firstValid === -1) bucket.timestamps.length = 0;

  if (bucket.timestamps.length < LOAD_TEST_RATE_LIMIT_MAX) {
    bucket.timestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }
  const oldest = bucket.timestamps[0]!;
  const retryAfterMs = Math.max(1, oldest + LOAD_TEST_RATE_LIMIT_WINDOW_MS - now);
  return { allowed: false, retryAfterMs };
}

/** @internal — test-only. Reset the per-route bucket between cases. */
export function _resetLoadTestRateLimit(): void {
  loadTestRateBuckets.clear();
  _loadTestClockOverride = null;
}

let _loadTestClockOverride: (() => number) | null = null;

/** @internal — test-only. Pin the rate-limiter clock; pass `null` to release. */
export function _setLoadTestClockForTests(fn: (() => number) | null): void {
  _loadTestClockOverride = fn;
}

function clock(): number {
  return _loadTestClockOverride ? _loadTestClockOverride() : Date.now();
}

// ── Org allowlist ──────────────────────────────────────────────────
//
// SaaS hardening: even though /me self-mint is functionally
// equivalent to a workspace member completing the OAuth ceremony
// against their own workspace, we don't want to advertise an "easy
// scripted-MCP path" to every customer org. Most should keep using
// the OAuth flow (Claude Desktop, Cursor) which forces consent +
// rotation discipline. The allowlist gate keeps this endpoint
// reserved for the workspace(s) WE have explicitly designated for
// load testing or programmatic use.
//
// Behavior matrix:
//   - `ATLAS_LOADTEST_ALLOWED_ORGS` unset / empty → no restriction
//     (preserves self-hosted behavior — operators load-test their
//     own single instance without configuring an allowlist).
//   - Set with values → ONLY those workspace ids pass; everyone
//     else gets 404. We use 404 (not 403) so the endpoint is
//     invisible to customers — a 403 would confirm the route
//     exists and invite probing.
//
// Read on every request (no cache): `process.env.X` is a cheap
// hash lookup, and matching the rate-limiter pattern in this file
// keeps the surface uniform. An operator can edit the allowlist on
// Railway and the next request picks it up without a redeploy.

function loadTestAllowlist(): ReadonlySet<string> | null {
  const raw = process.env.ATLAS_LOADTEST_ALLOWED_ORGS?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length === 0 ? null : new Set(ids);
}

// ── Schemas ─────────────────────────────────────────────────────────

const MintTokenBodySchema = z
  .object({
    ttlSeconds: z.coerce
      .number()
      .int()
      .min(LOAD_TEST_TOKEN_MIN_TTL_SECONDS, `ttlSeconds must be ≥ ${LOAD_TEST_TOKEN_MIN_TTL_SECONDS}`)
      .max(LOAD_TEST_TOKEN_MAX_TTL_SECONDS, `ttlSeconds must be ≤ ${LOAD_TEST_TOKEN_MAX_TTL_SECONDS}`)
      .default(LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS)
      .optional()
      .openapi({
        description: `Token TTL in seconds. Server-side ceiling is ${LOAD_TEST_TOKEN_MAX_TTL_SECONDS}s; default ${LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS}s. Requests for larger values are rejected with 400.`,
      }),
  })
  .openapi("MintMyMcpTokenRequest");

const MintTokenResponseSchema = z
  .object({
    bearer: z
      .string()
      .openapi({ description: "The signed JWT. Carry verbatim in `Authorization: Bearer <bearer>`. Must NEVER be embedded in logs or stored to disk." }),
    workspaceId: z.string().openapi({ description: "Resolved from the caller's session active organization." }),
    audience: z.string().openapi({ description: "The audience claim burned into the token; matches the regional `/mcp` URL the verifier accepts." }),
    issuer: z.string().openapi({ description: "The issuer claim — `${regional-api}/api/auth`." }),
    expiresAt: z.string().openapi({ description: "ISO 8601 wall-clock expiry." }),
    sub: z.string().openapi({ description: "Synthetic subject — `loadtest:<workspaceId>:<random>`. Safe to log." }),
    scope: z.string().openapi({ description: "Scope granted on the token. Always `mcp:read`." }),
  })
  .openapi("MintMyMcpTokenResponse");

// ── Region resolution ───────────────────────────────────────────────

interface RegionResolution {
  region: string | null;
  audience: string;
  issuer: string;
}

/**
 * Resolve issuer + audience for the API instance the request hit.
 *
 * Self-mint is always region-bound to the API instance the caller is
 * already talking to — there's no body parameter. If `residency.regions`
 * is configured and this instance has a region label, use that region's
 * `apiUrl`. Otherwise (self-hosted, or SaaS region without a regions
 * map), fall back to the request origin to match what
 * `hosted.ts:resourceAudience` reads at the verifier boundary.
 */
function resolveRegion(reqUrl: string): RegionResolution {
  const config = getConfig();
  const regions = config?.residency?.regions;
  const ownRegion = getApiRegion();

  if (ownRegion && regions?.[ownRegion]?.apiUrl) {
    const trimmed = regions[ownRegion]!.apiUrl!.replace(/\/+$/, "");
    return {
      region: ownRegion,
      audience: `${trimmed}/mcp`,
      issuer: `${trimmed}/api/auth`,
    };
  }

  // `ATLAS_PUBLIC_API_URL` and `BETTER_AUTH_URL` take precedence in
  // `hosted.ts:resourceAudience`, so we mirror that order here so the
  // audience matches whatever the verifier accepts on this instance.
  const base = (
    process.env.ATLAS_PUBLIC_API_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    new URL(reqUrl).origin
  ).replace(/\/+$/, "");
  return {
    region: ownRegion,
    audience: `${base}/mcp`,
    issuer: `${base}/api/auth`,
  };
}

// ── Route ───────────────────────────────────────────────────────────

const mintTokenRoute = createRoute({
  method: "post",
  path: "/mcp-token",
  tags: ["Me — Load Test"],
  // `hide: true` excludes this route from the OpenAPI spec emitted by
  // `bun run --filter @atlas/api openapi:extract`. The auto-generated
  // api-reference MDX in apps/docs/content/docs/api-reference/ skips
  // it too, so docs.useatlas.dev never lists it. Operators with the
  // allowlist set discover the endpoint via internal runbooks
  // (apps/docs/content/docs/platform-ops/mcp-load-test-tokens.mdx),
  // not via the public API reference. Self-hosted operators with no
  // allowlist still hit it the same way; it just isn't broadcast.
  hide: true,
  summary: "Mint a short-lived MCP-scoped JWT for the caller's own workspace",
  description: [
    "Mints a JWT signed by the regional Better Auth JWKS, scoped to `mcp:read` and bound to the caller's active workspace. ",
    "Functionally equivalent to a workspace member completing the OAuth 2.1 ceremony against their own workspace, but skipping the consent flow — useful for load tests, smoke tests, and any flow that needs an MCP bearer programmatically. ",
    "TTL is capped at 3600s server-side; requests above the cap are rejected with 400. ",
    "The bearer must NEVER be logged or persisted; the audit row carries only `jti` for forensic correlation. ",
    "The token's audience is bound to this regional API. Calling this against `mcp.useatlas.dev` and using the bearer against `mcp-eu.useatlas.dev` will fail with 401 (audience mismatch).",
  ].join(""),
  request: {
    body: {
      content: { "application/json": { schema: MintTokenBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Token minted",
      content: { "application/json": { schema: MintTokenResponseSchema } },
    },
    400: { description: "Invalid body, ttl out of range, or no active workspace on the session", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: AuthErrorSchema } } },
    404: { description: "Internal database not configured (no JWKS table to read)", content: { "application/json": { schema: ErrorSchema } } },
    429: { description: "Per-endpoint mint rate exceeded (10/min/caller)", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Internal error during minting", content: { "application/json": { schema: ErrorSchema } } },
    503: { description: "JWKS table empty — hit any /api/auth/* endpoint on this region once to seed and retry", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const meLoadTest = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

meLoadTest.use(standardAuth);
meLoadTest.use(requestContext);

meLoadTest.openapi(
  mintTokenRoute,
  async (c) => {
    return runHandler(c, "mint mcp load-test token (self)", async () => {
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

      // CSRF mitigation: this route is called only by scripts/CI that
      // hold a Bearer-format session token (Better Auth's `bearer()`
      // plugin returns one from `/api/auth/sign-in/email`). The web UI
      // never calls this endpoint. Rejecting cookie-only requests
      // closes the cross-site-form-POST class of CSRF outright — even
      // though SameSite=Lax cookies + a JSON Content-Type already
      // preflight-block the typical attack, defense-in-depth is cheap
      // here and the surface stays simple. A scripted caller without
      // an `Authorization` header is operating outside the documented
      // contract anyway.
      const authHeader = c.req.raw.headers.get("authorization");
      if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
        return c.json(
          {
            error: "bearer_required",
            message: "This endpoint requires `Authorization: Bearer <session-token>` (cookie-only auth is not accepted). Sign in via POST /api/auth/sign-in/email and use the returned token.",
            requestId,
          },
          401,
        );
      }

      const user = authResult.user;
      const workspaceId = user?.activeOrganizationId;
      if (!user || !workspaceId) {
        return c.json(
          {
            error: "no_active_workspace",
            message: "No active workspace on the session. Set an active org first (sign in via the web UI or call POST /api/auth/organization/set-active).",
            requestId,
          },
          400,
        );
      }

      // Allowlist check (SaaS hardening). When unset, every authenticated
      // workspace member can mint — the self-hosted-friendly default.
      // When set, ONLY listed workspace ids pass. Non-listed orgs see a
      // bare 404 with no JSON body — the same shape Hono emits for an
      // unmounted route — so probing customers can't even confirm the
      // endpoint exists. Don't audit on this rejection: the would-be
      // attacker should have no signal that the route is real.
      const allowlist = loadTestAllowlist();
      if (allowlist !== null && !allowlist.has(workspaceId)) {
        log.warn(
          { requestId, workspaceId, actorId: user.id },
          "Rejected /me/load-test mint — workspace not in ATLAS_LOADTEST_ALLOWED_ORGS",
        );
        // Bare-text 404 mimics Hono's default unmounted-route response
        // exactly — no JSON `error` field that would confirm "this
        // route exists, you're just not allowed." HTTPException is the
        // documented escape hatch from the OpenAPI handler's typed
        // return contract; the API's `app.onError` forwards it
        // verbatim (with CORS/security headers patched in). See
        // `packages/api/src/api/index.ts:506`.
        throw new HTTPException(404, {
          res: new Response("404 Not Found", {
            status: 404,
            headers: { "Content-Type": "text/plain; charset=UTF-8" },
          }),
        });
      }

      const actorId = user.id;
      const rate = checkLoadTestRateLimit(actorId, clock());
      if (!rate.allowed) {
        const retryAfterSeconds = Math.ceil(rate.retryAfterMs / 1000);
        return c.json(
          {
            error: "rate_limited",
            message: `Per-caller mint rate exceeded (${LOAD_TEST_RATE_LIMIT_MAX}/min). Retry in ${retryAfterSeconds}s.`,
            requestId,
          },
          429,
          { "Retry-After": String(retryAfterSeconds) },
        );
      }

      // Body is optional (no required fields) — defaults fire when absent.
      const body = c.req.valid("json") ?? {};
      const ttlSeconds = body.ttlSeconds ?? LOAD_TEST_TOKEN_DEFAULT_TTL_SECONDS;
      const region = resolveRegion(c.req.url);

      const secret = process.env.BETTER_AUTH_SECRET ?? null;
      let minted;
      try {
        minted = await mintLoadTestToken({
          workspaceId,
          ttlSeconds,
          issuer: region.issuer,
          audience: region.audience,
          secret,
        });
      } catch (err) {
        if (err instanceof JwksNotInitializedError) {
          return c.json({ error: err.code, message: err.message, requestId }, 503);
        }
        const message = errorMessage(err);
        log.error(
          {
            err: message,
            requestId,
            workspaceId,
            region: region.region,
            actorId,
          },
          "Self-mint load-test token failed unexpectedly",
        );
        try {
          await logAdminActionAwait({
            actionType: ADMIN_ACTIONS.load_test.mintMcpToken,
            targetType: "load_test",
            targetId: workspaceId,
            status: "failure",
            scope: "workspace",
            metadata: {
              workspaceId,
              region: region.region,
              ttlSeconds,
              error: message,
            },
          });
        } catch (auditErr) {
          log.error(
            {
              err: errorMessage(auditErr),
              requestId,
              workspaceId,
              region: region.region,
              actorId,
              originalMintError: message,
            },
            "Failed to write failure audit row for self-mint exception — manual audit reconciliation required",
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

      // Awaited — credential issuance is the security control. The
      // bearer is intentionally NOT in metadata; `jti` is the
      // forensic correlation handle.
      await logAdminActionAwait({
        actionType: ADMIN_ACTIONS.load_test.mintMcpToken,
        targetType: "load_test",
        targetId: workspaceId,
        scope: "workspace",
        metadata: {
          workspaceId,
          region: region.region,
          ttlSeconds,
          sub: minted.sub,
          jti: minted.jti,
          expiresAt: minted.expiresAt,
        },
      });

      return c.json(
        {
          bearer: minted.bearer,
          workspaceId,
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
  // 400 instead of the default 422 — caller (likely a CI script) sees
  // a familiar status code with the underlying Zod issue verbatim.
  (result, c) => {
    if (result.success) return;
    const requestId = c.get("requestId");
    const message = result.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return c.json({ error: "invalid_body", message, requestId }, 400);
  },
);

export { meLoadTest };
