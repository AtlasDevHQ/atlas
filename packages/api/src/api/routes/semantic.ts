/**
 * Public semantic layer API routes.
 *
 * Mounted at /api/v1/semantic. Available to all authenticated users (not admin-gated).
 * Provides read-only access to entity metadata, enabling the schema explorer UI.
 * Returns all entities defined in the semantic layer YAML files on disk.
 */

import * as path from "path";
import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import type { AuthResult } from "@atlas/api/lib/auth/types";
import {
  authenticateRequest,
  checkRateLimit,
  getClientIP,
} from "@atlas/api/lib/auth/middleware";
import {
  getSemanticRoot,
  isValidEntityName,
  readYamlFile,
  discoverEntities,
  findEntityFile,
} from "@atlas/api/lib/semantic-files";

const log = createLogger("semantic-routes");

export const semantic = new Hono();

// ---------------------------------------------------------------------------
// Auth preamble — standard auth (no admin role required).
// ---------------------------------------------------------------------------

/**
 * Authenticate the request and check rate limits. Returns
 * `{ error, status, headers? }` on failure (401/403/429/500)
 * or `{ authResult }` on success.
 */
async function authPreamble(req: Request, requestId: string) {
  let authResult: AuthResult;
  try {
    authResult = await authenticateRequest(req);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err : new Error(String(err)), requestId },
      "Auth dispatch failed",
    );
    return { error: { error: "auth_error", message: "Authentication system error" }, status: 500 as const };
  }
  if (!authResult.authenticated) {
    log.warn({ requestId, status: authResult.status }, "Authentication failed");
    return { error: { error: "auth_error", message: authResult.error }, status: authResult.status as 401 | 403 | 500 };
  }

  const ip = getClientIP(req);
  const rateLimitKey = authResult.user?.id ?? (ip ? `ip:${ip}` : "anon");
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    const retryAfterSeconds = Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000);
    return {
      error: { error: "rate_limited", message: "Too many requests. Please wait before trying again.", retryAfterSeconds },
      status: 429 as const,
      headers: { "Retry-After": String(retryAfterSeconds) },
    };
  }

  return { authResult };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /entities — list all entities (public summary: drops measureCount, connection, source)
semantic.get("/entities", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    try {
      const all = discoverEntities(root);
      const entities = all.map(({ table, description, columnCount, joinCount, type }) => ({
        table, description, columnCount, joinCount, type,
      }));
      return c.json({ entities });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to discover entities");
      return c.json({ error: "internal_error", message: "Failed to load entity list." }, 500);
    }
  });
});

// GET /entities/:name — full entity detail
semantic.get("/entities/:name", async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    return c.json(preamble.error, { status: preamble.status, headers: preamble.headers });
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const name = c.req.param("name");

    if (!isValidEntityName(name)) {
      log.warn({ requestId, name }, "Rejected invalid entity name");
      return c.json({ error: "invalid_request", message: "Invalid entity name." }, 400);
    }

    const root = getSemanticRoot();
    const filePath = findEntityFile(root, name);
    if (!filePath) {
      return c.json({ error: "not_found", message: `Entity "${name}" not found.` }, 404);
    }

    // Defense-in-depth: verify resolved path is within semantic root
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(root))) {
      log.error({ requestId, name, resolved, root }, "Resolved entity path escaped semantic root");
      return c.json({ error: "forbidden", message: "Access denied." }, 403);
    }

    try {
      const raw = readYamlFile(filePath);
      return c.json({ entity: raw });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), filePath, entityName: name }, "Failed to parse entity YAML file");
      return c.json({ error: "internal_error", message: `Failed to parse entity file for "${name}".` }, 500);
    }
  });
});
