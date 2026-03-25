/**
 * Onboarding API routes for self-serve signup flow.
 *
 * Mounted at /api/v1/onboarding. Requires managed auth (session-based).
 * These routes power the post-signup wizard: test a database connection
 * and finalize workspace setup (persist connection scoped to the user's org).
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { validationHook } from "./validation-hook";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger } from "@atlas/api/lib/logger";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, encryptUrl } from "@atlas/api/lib/db/internal";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const log = createLogger("onboarding");

/** Valid connection ID: lowercase alphanumeric, hyphens, underscores, 1-64 chars. Must not start with underscore (reserved for internal IDs). */
const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------


const TestConnectionRequestSchema = z.object({
  url: z.string().min(1, "Database URL is required."),
});

const TestConnectionResponseSchema = z.object({
  status: z.string(),
  latencyMs: z.number(),
  dbType: z.string(),
  maskedUrl: z.string(),
});

const CompleteOnboardingRequestSchema = z.object({
  url: z.string().min(1, "Database URL is required."),
  connectionId: z.string().optional(),
});

const CompleteOnboardingResponseSchema = z.object({
  connectionId: z.string(),
  dbType: z.string(),
  maskedUrl: z.string(),
});

const SocialProvidersResponseSchema = z.object({
  providers: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const socialProvidersRoute = createRoute({
  method: "get",
  path: "/social-providers",
  tags: ["Onboarding"],
  summary: "List enabled social login providers",
  description:
    "Returns which OAuth providers (Google, GitHub, Microsoft) are configured so the signup page can render the correct buttons. Public endpoint — no authentication required.",
  responses: {
    200: {
      description: "List of enabled social providers",
      content: { "application/json": { schema: SocialProvidersResponseSchema } },
    },
  },
});

const testConnectionRoute = createRoute({
  method: "post",
  path: "/test-connection",
  tags: ["Onboarding"],
  summary: "Test a database connection",
  description:
    "Validates the URL scheme, creates a temporary connection, runs a health check, and returns the result. " +
    "The connection is not persisted. Requires managed auth mode and an authenticated session.",
  request: {
    body: {
      content: { "application/json": { schema: TestConnectionRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Connection test result",
      content: { "application/json": { schema: TestConnectionResponseSchema } },
    },
    400: {
      description: "Invalid URL scheme or connection test failed",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Onboarding requires managed auth mode",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const completeOnboardingRoute = createRoute({
  method: "post",
  path: "/complete",
  tags: ["Onboarding"],
  summary: "Complete workspace setup",
  description:
    "Finalizes onboarding by testing the connection, encrypting the URL, and persisting it to the internal database " +
    "scoped to the user's active organization. Resets the semantic layer whitelist cache so new tables become queryable immediately.",
  request: {
    body: {
      content: { "application/json": { schema: CompleteOnboardingRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Connection saved and workspace setup complete",
      content: { "application/json": { schema: CompleteOnboardingResponseSchema } },
    },
    400: {
      description: "Invalid URL, connection test failed, or no active organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Onboarding requires managed auth mode and DATABASE_URL",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Connection ID already in use by another organization",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error (invalid request body)",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({ details: z.array(z.unknown()).optional() }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    500: {
      description: "Failed to encrypt or save connection",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const onboarding = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

// Normalize JSON parse errors. Only catch SyntaxError (malformed JSON); let
// other 400s (e.g. Zod query/path param validation) propagate with their message.
onboarding.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    if (err.status === 400) {
      if (err.cause instanceof SyntaxError) {
        log.warn("Malformed JSON body in request");
        return c.json({ error: "invalid_request", message: "Invalid JSON body." }, 400);
      }
      return c.json({ error: "invalid_request", message: err.message || "Bad request." }, 400);
    }
  }
  throw err;
});

// ---------------------------------------------------------------------------
// GET /social-providers — returns which social login providers are enabled
// (public — no auth middleware)
// ---------------------------------------------------------------------------

onboarding.openapi(socialProvidersRoute, (c) => {
  const providers: string[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) providers.push("google");
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) providers.push("github");
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) providers.push("microsoft");
  return c.json({ providers }, 200);
});

// ---------------------------------------------------------------------------
// Apply auth middleware to all routes registered after this point
// ---------------------------------------------------------------------------

onboarding.use("/test-connection", standardAuth);
onboarding.use("/test-connection", requestContext);
onboarding.use("/complete", standardAuth);
onboarding.use("/complete", requestContext);
onboarding.use("/tour-status", standardAuth);
onboarding.use("/tour-status", requestContext);
onboarding.use("/tour-complete", standardAuth);
onboarding.use("/tour-complete", requestContext);
onboarding.use("/tour-reset", standardAuth);
onboarding.use("/tour-reset", requestContext);

// ---------------------------------------------------------------------------
// POST /test-connection — test a datasource URL without persisting
// ---------------------------------------------------------------------------

onboarding.openapi(
  testConnectionRoute,
  async (c) => {
    const requestId = c.get("requestId");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Onboarding requires managed auth mode.", requestId }, 404);
    }

    const { url } = c.req.valid("json");

    // Validate URL scheme
    let dbType: string;
    try {
      dbType = detectDBType(url);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Invalid database URL scheme");
      return c.json({
        error: "invalid_url",
        message: "Unsupported database URL scheme. Use postgresql:// or mysql://.",
      }, 400);
    }

    // Register a temporary connection, test it, then always clean up
    const tempId = `_onboard_${Date.now()}`;
    try {
      connections.register(tempId, { url });
      const result = await connections.healthCheck(tempId);
      return c.json({
        status: result.status,
        latencyMs: result.latencyMs,
        dbType,
        maskedUrl: maskConnectionUrl(url),
      }, 200);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Connection test failed");
      return c.json({
        error: "connection_failed",
        message: "Connection test failed. Check the URL, credentials, and that the database is reachable.",
      }, 400);
    } finally {
      if (connections.has(tempId)) {
        connections.unregister(tempId);
      }
    }
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /complete — finalize workspace setup
// ---------------------------------------------------------------------------

onboarding.openapi(
  completeOnboardingRoute,
  async (c) => {
    const requestId = c.get("requestId");
    const authResult = c.get("authResult");

    if (detectAuthMode() !== "managed") {
      return c.json({ error: "not_available", message: "Onboarding requires managed auth mode.", requestId }, 404);
    }

    if (!hasInternalDB()) {
      return c.json({ error: "not_available", message: "Onboarding requires an internal database (DATABASE_URL).", requestId }, 404);
    }

    const orgId = authResult.user?.activeOrganizationId;
    if (!orgId) {
      return c.json({ error: "no_organization", message: "No active organization. Create a workspace first." }, 400);
    }

    const { url, connectionId: rawConnectionId } = c.req.valid("json");

    const id = typeof rawConnectionId === "string" && rawConnectionId.trim()
      ? rawConnectionId.trim()
      : "default";

    // Validate connectionId format (skip for default)
    if (id !== "default" && !CONNECTION_ID_PATTERN.test(id)) {
      return c.json({
        error: "invalid_request",
        message: "Connection ID must be 2-64 lowercase alphanumeric characters, hyphens, or underscores.",
      }, 400);
    }

    // Validate URL scheme
    let dbType: string;
    try {
      dbType = detectDBType(url);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Invalid database URL scheme");
      return c.json({
        error: "invalid_url",
        message: "Unsupported database URL scheme. Use postgresql:// or mysql://.",
      }, 400);
    }

    // Test the connection before persisting
    const tempId = `_onboard_complete_${Date.now()}`;
    try {
      connections.register(tempId, { url });
      await connections.healthCheck(tempId);
    } catch (err) {
      if (connections.has(tempId)) connections.unregister(tempId);
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Connection test failed during onboarding");
      return c.json({
        error: "connection_failed",
        message: "Connection test failed. Check the URL, credentials, and that the database is reachable.",
      }, 400);
    } finally {
      if (connections.has(tempId)) connections.unregister(tempId);
    }

    // Encrypt and persist to internal DB
    let encryptedUrl: string;
    try {
      encryptedUrl = encryptUrl(url);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to encrypt connection URL during onboarding");
      return c.json({ error: "encryption_failed", message: "Failed to encrypt connection URL.", requestId }, 500);
    }

    // Org-scoped upsert: only update if the existing row belongs to the same org
    try {
      const result = await internalQuery<{ id: string }>(
        `INSERT INTO connections (id, url, type, description, org_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET url = $2, type = $3, org_id = $5, updated_at = NOW()
         WHERE connections.org_id = $5 OR connections.org_id IS NULL
         RETURNING id`,
        [id, encryptedUrl, dbType, `${dbType} datasource`, orgId],
      );
      if (result.length === 0) {
        return c.json({
          error: "conflict",
          message: `Connection ID "${id}" is already in use by another organization.`,
        }, 409);
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Failed to persist onboarding connection");
      return c.json({ error: "internal_error", message: "Failed to save connection.", requestId }, 500);
    }

    // Register the connection in the runtime registry
    try {
      if (connections.has(id)) connections.unregister(id);
      connections.register(id, { url, description: `${dbType} datasource` });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Connection saved but runtime registration failed — will load on next restart");
    }

    _resetWhitelists();

    log.info({ requestId, connectionId: id, orgId, dbType, userId: authResult.user?.id }, "Onboarding complete — connection saved");

    // Trigger onboarding milestone: database connected (fire-and-forget)
    // AtlasUser.label is the user's email in managed auth mode.
    if (authResult.user?.id && authResult.user.label?.includes("@")) {
      try {
        const { onDatabaseConnected } = await import("@atlas/api/lib/email/hooks");
        onDatabaseConnected({
          userId: authResult.user.id,
          email: authResult.user.label,
          orgId,
        });
      } catch (err) {
        log.debug({ err: err instanceof Error ? err.message : String(err) }, "Onboarding email hook not available");
      }
    }

    return c.json({
      connectionId: id,
      dbType,
      maskedUrl: maskConnectionUrl(url),
    }, 201);
  },
  (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", message: "Invalid request body.", details: result.error.issues },
        422,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Tour status & completion
// ---------------------------------------------------------------------------

const TourStatusResponseSchema = z.object({
  tourCompleted: z.boolean(),
  tourCompletedAt: z.string().nullable(),
});

const tourStatusRoute = createRoute({
  method: "get",
  path: "/tour-status",
  tags: ["Onboarding"],
  summary: "Get guided tour completion status",
  description:
    "Returns whether the authenticated user has completed the guided tour. " +
    "Used on app load to decide whether to auto-start the tour.",
  responses: {
    200: {
      description: "Tour completion status",
      content: { "application/json": { schema: TourStatusResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Requires managed auth mode and internal database",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const tourCompleteRoute = createRoute({
  method: "post",
  path: "/tour-complete",
  tags: ["Onboarding"],
  summary: "Mark guided tour as completed",
  description:
    "Records that the authenticated user has completed (or dismissed) the guided tour. " +
    "Idempotent — calling multiple times is safe.",
  responses: {
    200: {
      description: "Tour marked as completed",
      content: { "application/json": { schema: TourStatusResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Requires managed auth mode and internal database",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const tourResetRoute = createRoute({
  method: "post",
  path: "/tour-reset",
  tags: ["Onboarding"],
  summary: "Reset guided tour so it can be replayed",
  description:
    "Clears the tour completion timestamp for the authenticated user, allowing " +
    "the guided tour to be triggered again.",
  responses: {
    200: {
      description: "Tour reset successfully",
      content: { "application/json": { schema: TourStatusResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: {
      description: "Requires managed auth mode and internal database",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// GET /tour-status
// ---------------------------------------------------------------------------

onboarding.openapi(tourStatusRoute, async (c) => runHandler(c, "fetch tour status", async () => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Tour tracking requires managed auth mode.", requestId }, 404);
  }
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Tour tracking requires an internal database (DATABASE_URL).", requestId }, 404);
  }

  const userId = authResult.user?.id;
  if (!userId) {
    return c.json({ error: "auth_error", message: "No user ID in session.", requestId }, 401);
  }

  const rows = await internalQuery<{ tour_completed_at: string | null }>(
    `SELECT tour_completed_at FROM user_onboarding WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  return c.json({
    tourCompleted: !!row?.tour_completed_at,
    tourCompletedAt: row?.tour_completed_at ?? null,
  }, 200);
}));

// ---------------------------------------------------------------------------
// POST /tour-complete
// ---------------------------------------------------------------------------

onboarding.openapi(tourCompleteRoute, async (c) => runHandler(c, "save tour completion", async () => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Tour tracking requires managed auth mode.", requestId }, 404);
  }
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Tour tracking requires an internal database (DATABASE_URL).", requestId }, 404);
  }

  const userId = authResult.user?.id;
  if (!userId) {
    return c.json({ error: "auth_error", message: "No user ID in session.", requestId }, 401);
  }

  const now = new Date().toISOString();
  await internalQuery(
    `INSERT INTO user_onboarding (user_id, tour_completed_at)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET tour_completed_at = $2`,
    [userId, now],
  );
  log.info({ requestId, userId }, "Tour marked as completed");
  return c.json({ tourCompleted: true, tourCompletedAt: now }, 200);
}));

// ---------------------------------------------------------------------------
// POST /tour-reset
// ---------------------------------------------------------------------------

onboarding.openapi(tourResetRoute, async (c) => runHandler(c, "reset tour", async () => {
  const requestId = c.get("requestId");
  const authResult = c.get("authResult");

  if (detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Tour tracking requires managed auth mode.", requestId }, 404);
  }
  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Tour tracking requires an internal database (DATABASE_URL).", requestId }, 404);
  }

  const userId = authResult.user?.id;
  if (!userId) {
    return c.json({ error: "auth_error", message: "No user ID in session.", requestId }, 401);
  }

  await internalQuery(
    `UPDATE user_onboarding SET tour_completed_at = NULL WHERE user_id = $1`,
    [userId],
  );
  log.info({ requestId, userId }, "Tour reset for replay");
  return c.json({ tourCompleted: false, tourCompletedAt: null }, 200);
}));

export { onboarding };
