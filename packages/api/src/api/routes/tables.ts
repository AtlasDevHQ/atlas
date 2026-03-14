/**
 * Public tables API route.
 *
 * Mounted at /api/v1/tables. Available to all authenticated users (not admin-gated).
 * Returns a simplified view of semantic layer entities with column details,
 * enabling SDK consumers to discover queryable tables.
 */

import { Hono } from "hono";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { getSemanticRoot, discoverTables } from "@atlas/api/lib/semantic-files";
import { authPreamble } from "./auth-preamble";

const log = createLogger("tables-route");

export const tables = new Hono();

// GET / — list all tables with columns
tables.get("/", async (c) => {
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
      const result = discoverTables(root);
      return c.json({
        tables: result.tables,
        ...(result.warnings.length > 0 && { warnings: result.warnings }),
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), root, requestId }, "Failed to discover tables");
      return c.json({ error: "internal_error", message: "Failed to load table list." }, 500);
    }
  });
});
