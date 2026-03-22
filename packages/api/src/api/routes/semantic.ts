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
import {
  getSemanticRoot,
  isValidEntityName,
  readYamlFile,
  discoverEntities,
  findEntityFile,
} from "@atlas/api/lib/semantic-files";
import { authPreamble } from "./auth-preamble";

const log = createLogger("semantic-routes");

export const semantic = new Hono();

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
      const result = discoverEntities(root);
      const entities = result.entities.map(({ table, description, columnCount, joinCount, type }) => ({
        table, description, columnCount, joinCount, type,
      }));
      return c.json({
        entities,
        ...(result.warnings.length > 0 && { warnings: result.warnings }),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), root }, "Failed to discover entities");
      return c.json({ error: "internal_error", message: "Failed to load entity list.", requestId }, 500);
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
      return c.json({ error: "forbidden", message: "Access denied.", requestId }, 403);
    }

    try {
      const raw = readYamlFile(filePath);
      return c.json({ entity: raw });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), filePath, entityName: name }, "Failed to parse entity YAML file");
      return c.json({ error: "internal_error", message: `Failed to parse entity file for "${name}".`, requestId }, 500);
    }
  });
});
