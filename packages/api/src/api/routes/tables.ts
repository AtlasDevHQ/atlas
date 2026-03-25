/**
 * Public tables API route.
 *
 * Mounted at /api/v1/tables. Available to all authenticated users (not admin-gated).
 * Returns a simplified view of semantic layer entities with column details,
 * enabling SDK consumers to discover queryable tables.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { validationHook } from "./validation-hook";
import { z } from "zod";
import { getSemanticRoot, discoverTables } from "@atlas/api/lib/semantic/files";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const TablesResponseSchema = z.object({
  tables: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()).optional(),
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
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    403: {
      description: "Forbidden — insufficient permissions",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
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

export const tables = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });

tables.use(standardAuth);
tables.use(requestContext);

// GET / — list all tables with columns
tables.openapi(tablesRoute, async (c) => runHandler(c, "load table list", async () => {
  const root = getSemanticRoot();
  const result = discoverTables(root);
  return c.json({
    tables: result.tables,
    ...(result.warnings.length > 0 && { warnings: result.warnings }),
  }, 200);
}));
