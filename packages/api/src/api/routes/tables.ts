/**
 * Public tables API route.
 *
 * Mounted at /api/v1/tables. Available to all authenticated users (not admin-gated).
 * Returns a simplified view of semantic layer entities with column details,
 * enabling SDK consumers to discover queryable tables.
 *
 * The advertised set is the SAME set `validate-sql` / `executeSQL` enforce for
 * the resolved connection — a view of the per-connection (group-scoped)
 * whitelist (ADR-0012), never the global/demo entity list (#3898). An
 * unknown `connectionId` is a clear error, not a silent fallback to the
 * global list.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { validationHook } from "./validation-hook";
import { z } from "zod";
import { getSemanticRoot, discoverTables } from "@atlas/api/lib/semantic/files";
import { ensureOrgModeSemanticRoot } from "@atlas/api/lib/semantic/sync";
import { resolveAllowedTables, shouldUseOrgSemanticMirror } from "@atlas/api/lib/semantic/allowed-tables";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { connections, ConnectionNotRegisteredError } from "@atlas/api/lib/db/connection";
import { getRequestContext } from "@atlas/api/lib/logger";
import { ErrorSchema } from "./shared-schemas";
import { standardAuth, requestContext, type AuthEnv } from "./middleware";

const TablesResponseSchema = z.object({
  tables: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()).optional(),
});

const TablesQuerySchema = z.object({
  connectionId: z.string().min(1).optional().openapi({
    param: { name: "connectionId", in: "query" },
    description:
      "Connection (or group) to scope the table list to. Returns the same table set validate-sql / executeSQL enforce for that connection. An unknown id is a 404, not a fallback to the global list.",
    example: "clickhouse",
  }),
});


const tablesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Tables"],
  summary: "List queryable tables",
  description:
    "Returns a simplified view of semantic layer entities with column details, scoped to the connection's group whitelist (ADR-0012), enabling SDK consumers to discover queryable tables.",
  request: {
    query: TablesQuerySchema,
  },
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
    404: {
      description: "Connection not found for the request's workspace scope",
      content: { "application/json": { schema: ErrorSchema } },
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

// GET / — list tables with columns, scoped to the connection's group whitelist.
tables.openapi(tablesRoute, async (c) => {
  const { connectionId } = c.req.valid("query");

  return runHandler(c, "load table list", async () => {
    // Resolve the request's workspace scope, mirroring `validateSQL`: a
    // per-workspace plugin datasource lives in a per-(workspace, install_id)
    // pool, so the connection lookup AND the whitelist must follow the active
    // org or they validate against the wrong scope (#3109, #3857).
    const reqCtx = getRequestContext();
    const orgId = reqCtx?.user?.activeOrganizationId;
    // Pass the request's mode RAW to the whitelist resolution (via
    // resolveAllowedTables) so the advertised set matches `validateSQL` exactly,
    // which also threads the raw `atlasMode` (an undefined mode selects the
    // legacy cache, never published-only). A concrete mode is only needed to
    // pick the on-disk COLUMN mirror below, where it can't change membership.
    const atlasMode = reqCtx?.atlasMode;

    // Validate the connection up front. An explicit but unknown connectionId is
    // a clear 404 — never a silent fallback to the global/demo list (#3898). We
    // mirror validate-sql: a workspace-scoped lookup so per-workspace plugin
    // connections resolve.
    if (connectionId) {
      try {
        connections.getDBType(connectionId, orgId);
      } catch (err) {
        if (err instanceof ConnectionNotRegisteredError) {
          return c.json(
            {
              error: "connection_not_found",
              message: `Connection "${connectionId}" is not registered.`,
              requestId: reqCtx?.requestId,
            },
            404,
          );
        }
        throw err;
      }
    }

    // The connection group key the whitelist is partitioned by. `validateSQL`
    // passes the bare connectionId straight through; the resolvers default it
    // to "default" (the flat group).
    const groupKey = connectionId ?? "default";

    // When the whitelist is globally disabled, the enforcement layer accepts
    // any table — so the advertised list must match by being unfiltered too
    // (getSettingAuto so SaaS hot-reload is respected, same as validateSQL).
    const whitelistDisabled =
      (getSettingAuto("ATLAS_TABLE_WHITELIST") ?? process.env.ATLAS_TABLE_WHITELIST) === "false";

    // Resolve the SAME whitelist set the enforcement layer uses for this
    // connection, through the shared `resolveAllowedTables` (org-scoped vs
    // file-scoped, raw mode, internal-DB guard, fail-closed) that the schema
    // diff also reads — so `/tables` can never drift from what executeSQL
    // enforces. `undefined` means "whitelist disabled → return everything".
    const allowed = whitelistDisabled
      ? undefined
      : await resolveAllowedTables(groupKey, { orgId, atlasMode });

    // Column detail is read from the semantic root that backs this scope. The
    // `allowed` filter is the authority for membership; the root only supplies
    // columns. When the org whitelist came from the DB (org + internal DB), read
    // columns from the per-org mode mirror (lazily rebuilt from the DB by
    // `ensureOrgModeSemanticRoot`, cache-guarded, same primitive the explore
    // tool uses) so columns track the same source as membership. Everything else
    // (self-hosted, or org without an internal DB — where `resolveAllowedTables`
    // already fell back to the file whitelist) reads the base root.
    const root =
      orgId && shouldUseOrgSemanticMirror(orgId)
        ? await ensureOrgModeSemanticRoot(orgId, atlasMode ?? "published")
        : getSemanticRoot();
    const result = discoverTables(root, allowed);

    return c.json({
      tables: result.tables,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    }, 200);
  });
});
