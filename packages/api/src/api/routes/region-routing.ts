/**
 * Region-routing endpoints for the returning-user login front-door (ADR-0024 §3,
 * #3973).
 *
 * A returning user must resolve email→region BEFORE any session exists, because
 * under regional identity isolation their `user` row lives only in their
 * region's DB (`api.useatlas.dev` 401s a non-US workspace). The resolution is
 * done by a region-agnostic edge front-door on `app.useatlas.dev` (NOT on any
 * regional API — no regional API may carry a dual global identity role) that
 * fans out a hashed-email existence probe to every region in parallel. These
 * are the two endpoints that front-door consumes; every regional API serves
 * them identically (the map is the same config in all regions; each probe only
 * answers about its own DB):
 *
 *   GET  /api/v1/auth/region-map   — the region→apiUrl map (selectable regions
 *        with a configured apiUrl), so the front-door knows where to fan out.
 *   POST /api/v1/auth/region-probe — a hashed-email existence probe answering
 *        "does sha256(lower(email)) exist in THIS region's user table?" with a
 *        boolean.
 *
 * Security — the probe IS an account-existence oracle, exactly like any
 * forgot-password flow. We do not pretend otherwise; we mitigate it:
 *   1. It accepts ONLY a hash (64-hex sha256), never the raw email, so it can
 *      confirm a guessed address but can never be used to harvest the email
 *      list out of a region.
 *   2. It returns ONLY a boolean.
 *   3. It is per-IP rate-limited (the regional backstop against direct abuse;
 *      the front-door additionally rate-limits per real client IP — see
 *      packages/web/src/app/api/login/resolve-region/route.ts).
 *   4. There is NO global email→region storage — the front-door computes the
 *      hash transiently per request, and each region only ever checks its own
 *      `user` table. The match runs in-database via the pgcrypto functional
 *      index from migration 0151, so plaintext emails never leave Postgres.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Effect } from "effect";
import { runEffect } from "@atlas/api/lib/effect/hono";
import { ResidencyResolver } from "@atlas/api/lib/effect/services";
import { ResidencyError } from "@atlas/api/lib/residency/errors";
import { isRegionSelectable } from "@atlas/api/lib/residency/picker";
import { validationHook } from "./validation-hook";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getClientIP } from "@atlas/api/lib/auth/middleware";
import {
  createPublicRateLimiter,
  PUBLIC_RATE_LIMIT_CONSTANTS,
  warnIfTrustProxyMissingForPublicShare,
} from "@atlas/api/lib/public-rate-limit";
import { createLogger } from "@atlas/api/lib/logger";
import { ErrorSchema } from "./shared-schemas";
import type { RegionRoutingMap, RegionRoutingMapEntry } from "@useatlas/types";
import type { ResidencyConfig } from "@atlas/api/lib/config";

const log = createLogger("region-routing");

/**
 * sha256 over an email is 32 bytes → 64 lowercase hex chars. The probe accepts
 * ONLY this shape — anything else (a raw email, an upper-case digest, a
 * truncated value) is a 422 before any DB work. Lower-case-only is deliberate:
 * the front-door hex-encodes lower-case, and the pgcrypto index stores
 * lower-case hex, so a case-mismatched hash would silently never match.
 */
const EMAIL_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Per-IP ceiling for the probe (requests / minute). Matches the public-share
 * limiter ceiling (conversations.ts) — generous enough that the front-door's
 * server-side fan-out (which arrives from the web tier's IP, so all legit
 * logins share one bucket at launch scale) is never throttled, while still
 * bounding a direct single-IP enumeration attacker. The real per-user oracle
 * control lives at the front-door, keyed on the actual client IP.
 */
const PROBE_RATE_MAX = 60;

const probeRateLimiter = createPublicRateLimiter({ maxRpm: PROBE_RATE_MAX });

/** Evict expired probe rate-limit buckets — called by the SchedulerLayer fiber. */
export function regionProbeRateSweepTick(): void {
  probeRateLimiter.cleanup();
}

/** Sweep interval for the probe rate limiter. Exported for SchedulerLayer. */
export const REGION_PROBE_RATE_SWEEP_INTERVAL_MS = PUBLIC_RATE_LIMIT_CONSTANTS.WINDOW_MS;

/** @internal test-only — drop all probe rate-limit state between tests. */
export function _resetRegionProbeRateLimit(): void {
  probeRateLimiter.reset();
}

// ---------------------------------------------------------------------------
// Region map projection (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Project the configured regions to the front-door's routing map: selectable
 * regions (excludes the internal `staging` arm, #3948) that also carry a
 * configured `apiUrl` (a region with no apiUrl can't be probed or routed to).
 * Single-pass `flatMap` so the apiUrl-present guard and use share one scope —
 * the `apiUrl` narrows to `string` with no cast.
 */
export function projectRegionMap(
  regions: ResidencyConfig["regions"],
  defaultRegion: string,
): RegionRoutingMapEntry[] {
  return Object.entries(regions).flatMap(([id, cfg]) => {
    if (!isRegionSelectable(cfg) || typeof cfg.apiUrl !== "string" || cfg.apiUrl.length === 0) {
      return [];
    }
    return [{ id, label: cfg.label, apiUrl: cfg.apiUrl, isDefault: id === defaultRegion }];
  });
}

// ---------------------------------------------------------------------------
// Hashed-email existence check (the oracle core)
// ---------------------------------------------------------------------------

/**
 * Whether THIS region's `user` table holds an account whose
 * `sha256(lower(email))` equals `emailHash`. The match runs entirely in
 * Postgres against the pgcrypto functional index (migration 0151) — the API
 * never loads or sees the plaintext emails, and the expression here MUST stay
 * verbatim-identical to the index expression or the planner falls back to a
 * seq scan.
 */
export async function emailHashExists(emailHash: string): Promise<boolean> {
  const rows = await internalQuery<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM "user"
       WHERE encode(digest(lower(email), 'sha256'), 'hex') = $1
     ) AS "exists"`,
    [emailHash],
  );
  return rows[0]?.exists === true;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RegionProbeBodySchema = z
  .object({
    emailHash: z
      .string()
      .regex(EMAIL_HASH_RE, "emailHash must be a lowercase hex sha256 (64 chars)")
      .openapi({ example: "a".repeat(64), description: "sha256(lower(email)) as 64-char lowercase hex" }),
  })
  .openapi("RegionProbeBody");

const RegionProbeResponseSchema = z
  .object({ exists: z.boolean() })
  .openapi("RegionProbeResponse");

// OpenAPI doc schema for the region-map response. Built with @hono/zod-openapi's
// `z` (it carries `.openapi()`, which @useatlas/schemas' plain-zod schema does
// not), and `satisfies z.ZodType<RegionRoutingMap>` so it stays locked to the
// SSOT *type* in @useatlas/types — a field rename fails the build. The runtime
// validation of the SAME wire shape lives in @useatlas/schemas
// (`RegionRoutingMapSchema`), which the web front-door uses to Zod-parse the
// fetched map; both ends pin to the one `RegionRoutingMap` type.
const RegionMapEntrySchema = z
  .object({
    id: z.string(),
    label: z.string(),
    apiUrl: z.string(),
    isDefault: z.boolean(),
  })
  .openapi("RegionRoutingMapEntry");

const RegionMapResponseSchema = z
  .object({
    configured: z.boolean(),
    defaultRegion: z.string(),
    regions: z.array(RegionMapEntrySchema),
  })
  .openapi("RegionRoutingMap") satisfies z.ZodType<RegionRoutingMap>;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// `requestId` Variable so the public region-map handler can seed one for 500
// correlation (no auth middleware runs on these pre-auth routes to set it).
const regionRouting = new OpenAPIHono<{ Variables: { requestId: string } }>({
  defaultHook: validationHook,
});

const regionMapRoute = createRoute({
  method: "get",
  path: "/region-map",
  tags: ["Auth"],
  summary: "Region routing map for the login front-door",
  description:
    "Public, pre-auth. Returns the selectable regions and their API bases so the " +
    "login front-door knows which regions to fan a hashed-email existence probe " +
    "out to. `configured: false` when residency is not configured (self-hosted or " +
    "single-region) — the front-door then skips the fan-out entirely.",
  responses: {
    200: {
      description: "Region routing map",
      content: { "application/json": { schema: RegionMapResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const regionProbeRoute = createRoute({
  method: "post",
  path: "/region-probe",
  tags: ["Auth"],
  summary: "Hashed-email existence probe (per region)",
  description:
    "Public, pre-auth, rate-limited. Answers whether an account with " +
    "`sha256(lower(email))` exists in THIS region's identity store, as a boolean. " +
    "Accepts ONLY the hash, never the raw email. It is an account-existence " +
    "oracle (like forgot-password) — mitigated by hash-only input, boolean-only " +
    "output, and per-IP rate-limiting.",
  request: {
    body: {
      content: { "application/json": { schema: RegionProbeBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Existence result",
      content: { "application/json": { schema: RegionProbeResponseSchema } },
    },
    404: {
      description: "Front-door routing not available (non-managed auth / no internal DB)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error (emailHash not a 64-char lowercase hex)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    429: {
      description: "Rate limited",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// GET /region-map — the front-door's routing map (public, EE-gated config read).
regionRouting.openapi(regionMapRoute, async (c) => {
  // This is a public pre-auth route with no requestId middleware, so seed one
  // (parity with POST /region-probe) — otherwise runEffect's generic 500 path
  // would log + return `requestId: "unknown"`, defeating log↔response correlation.
  c.set("requestId", crypto.randomUUID());
  return runEffect(
    c,
    Effect.gen(function* () {
      if (detectAuthMode() !== "managed") {
        return c.json({ configured: false, defaultRegion: "none", regions: [] }, 200);
      }
      const mod = yield* ResidencyResolver;
      if (!mod.available) {
        return c.json({ configured: false, defaultRegion: "none", regions: [] }, 200);
      }
      try {
        const defaultRegion = mod.getDefaultRegion();
        const regions = projectRegionMap(mod.getConfiguredRegions(), defaultRegion);
        return c.json({ configured: regions.length > 0, defaultRegion, regions }, 200);
      } catch (err) {
        if (err instanceof ResidencyError && err.code === "not_configured") {
          return c.json({ configured: false, defaultRegion: "none", regions: [] }, 200);
        }
        throw err;
      }
    }),
    { label: "get region map" },
  );
});

// POST /region-probe — hashed-email existence oracle (public, rate-limited).
regionRouting.openapi(regionProbeRoute, async (c) => {
  const requestId = crypto.randomUUID();

  // The probe reads the Better Auth `user` table, which only exists in managed
  // auth mode. The front-door is a managed-SaaS concept; a self-hosted instance
  // has no fan-out, so 404 here rather than leaking a misleading boolean.
  if (detectAuthMode() !== "managed" || !hasInternalDB()) {
    return c.json(
      { error: "not_available", message: "Region routing is not available on this deployment.", requestId },
      404,
    );
  }

  warnIfTrustProxyMissingForPublicShare();
  const ip = getClientIP(c.req.raw);
  if (!probeRateLimiter.check(ip)) {
    // `ip === null` means the request landed in the shared anonymous bucket —
    // surface that so a 429 spike can be correlated with a missing
    // ATLAS_TRUST_PROXY rather than genuine per-IP abuse.
    log.warn({ requestId, ip, anonymous: ip === null }, "Region probe rate limited");
    return c.json(
      { error: "rate_limited", message: "Too many requests. Please wait before trying again.", requestId },
      429,
    );
  }

  const { emailHash } = c.req.valid("json");

  try {
    const exists = await emailHashExists(emailHash);
    return c.json({ exists }, 200);
  } catch (err) {
    log.error(
      { requestId, err: err instanceof Error ? err.message : String(err) },
      "Region probe existence check failed",
    );
    return c.json(
      { error: "internal_error", message: "Region probe failed. Please try again.", requestId },
      500,
    );
  }
});

export { regionRouting };
