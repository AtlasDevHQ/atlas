/**
 * Onboarding API routes for self-serve signup flow.
 *
 * Mounted at /api/v1/onboarding. Requires managed auth (session-based).
 * These routes power the post-signup wizard: test a database connection
 * and finalize workspace setup (persist connection scoped to the user's org).
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { authenticateRequest } from "@atlas/api/lib/auth/middleware";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { connections, detectDBType } from "@atlas/api/lib/db/connection";
import { hasInternalDB, internalQuery, encryptUrl } from "@atlas/api/lib/db/internal";
import { maskConnectionUrl } from "@atlas/api/lib/security";
import { _resetWhitelists } from "@atlas/api/lib/semantic";

const log = createLogger("onboarding");

const onboarding = new Hono();

/** Valid connection ID: lowercase alphanumeric, hyphens, underscores, 1-64 chars. Must not start with underscore (reserved for internal IDs). */
const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,62}[a-z0-9]$/;

/**
 * POST /test-connection — test a datasource URL without persisting.
 *
 * Requires an authenticated session (any role). Validates the URL scheme,
 * creates a temporary connection, runs a health check, then cleans up.
 * Returns connection health, latency, detected DB type, and a masked URL
 * (credentials redacted).
 */
onboarding.post("/test-connection", async (c) => {
  const requestId = crypto.randomUUID();

  if (detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Onboarding requires managed auth mode." }, 404);
  }

  let authResult;
  try {
    authResult = await authenticateRequest(c.req.raw);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Auth dispatch failed");
    return c.json({ error: "auth_error", message: "Authentication system error", requestId }, 500);
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    return c.json({ error: "auth_error", message: authResult.error, requestId }, authResult.status);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse test-connection request body");
      return null;
    });
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { url } = body as Record<string, unknown>;
    if (!url || typeof url !== "string") {
      return c.json({ error: "invalid_request", message: "Database URL is required." }, 400);
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
      });
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
  });
});

/**
 * POST /complete — finalize workspace setup.
 *
 * Persists the datasource connection to the internal DB, scoped to the
 * user's active organization. Requires managed auth with an active org,
 * plus an internal database (DATABASE_URL). After persisting, resets the
 * semantic layer whitelist cache so new tables become queryable immediately.
 */
onboarding.post("/complete", async (c) => {
  const requestId = crypto.randomUUID();

  if (detectAuthMode() !== "managed") {
    return c.json({ error: "not_available", message: "Onboarding requires managed auth mode." }, 404);
  }

  if (!hasInternalDB()) {
    return c.json({ error: "not_available", message: "Onboarding requires an internal database (DATABASE_URL)." }, 404);
  }

  let authResult;
  try {
    authResult = await authenticateRequest(c.req.raw);
  } catch (err) {
    log.error({ err: err instanceof Error ? err : new Error(String(err)), requestId }, "Auth dispatch failed");
    return c.json({ error: "auth_error", message: "Authentication system error", requestId }, 500);
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    return c.json({ error: "auth_error", message: authResult.error, requestId }, authResult.status);
  }

  const orgId = authResult.user?.activeOrganizationId;
  if (!orgId) {
    return c.json({ error: "no_organization", message: "No active organization. Create a workspace first." }, 400);
  }

  return withRequestContext({ requestId, user: authResult.user }, async () => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err), requestId }, "Failed to parse onboarding complete request body");
      return null;
    });
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", message: "Request body is required." }, 400);
    }

    const { url, connectionId } = body as Record<string, unknown>;
    if (!url || typeof url !== "string") {
      return c.json({ error: "invalid_request", message: "Database URL is required." }, 400);
    }

    const id = typeof connectionId === "string" && connectionId.trim()
      ? connectionId.trim()
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
    return c.json({
      connectionId: id,
      dbType,
      maskedUrl: maskConnectionUrl(url),
    }, 201);
  });
});

/**
 * GET /social-providers — returns which social login providers are enabled.
 *
 * Public endpoint (no auth required) so the signup page can render the
 * correct OAuth buttons.
 */
onboarding.get("/social-providers", (c) => {
  const providers: string[] = [];
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) providers.push("google");
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) providers.push("github");
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) providers.push("microsoft");
  return c.json({ providers });
});

export { onboarding };
