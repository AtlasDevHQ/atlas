/**
 * Public tables API route.
 *
 * Mounted at /api/v1/tables. Available to all authenticated users (not admin-gated).
 * Returns a simplified view of semantic layer entities with column details,
 * enabling SDK consumers to discover queryable tables.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createLogger, withRequestContext } from "@atlas/api/lib/logger";
import { getSemanticRoot, discoverTables } from "@atlas/api/lib/semantic-files";
import { authPreamble } from "./auth-preamble";

const log = createLogger("tables-route");

const TablesResponseSchema = z.object({
  tables: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()).optional(),
});

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

const tablesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Tables"],
  summary: "List queryable tables",
  description:
    "Returns a simplified view of semantic layer entities with column details, enabling SDK consumers to discover queryable tables.",
  responses: {
    200: {
      description: "List of tables with columns",
      content: { "application/json": { schema: TablesResponseSchema } },
    },
    500: {
      description: "Internal server error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export const tables = new OpenAPIHono();

// GET / — list all tables with columns
tables.openapi(tablesRoute, async (c) => {
  const req = c.req.raw;
  const requestId = crypto.randomUUID();

  const preamble = await authPreamble(req, requestId);
  if ("error" in preamble) {
    // Auth errors use dynamic status codes that can't be statically typed in createRoute
    return c.json(preamble.error, preamble.status, preamble.headers) as never;
  }
  const { authResult } = preamble;

  return withRequestContext({ requestId, user: authResult.user }, () => {
    const root = getSemanticRoot();
    try {
      const result = discoverTables(root);
      return c.json({
        tables: result.tables,
        ...(result.warnings.length > 0 && { warnings: result.warnings }),
      }, 200);
    } catch (err) {
      log.error({ err: err instanceof Error ? err : new Error(String(err)), root, requestId }, "Failed to discover tables");
      return c.json({ error: "internal_error", message: "Failed to load table list." }, 500);
    }
  });
});
