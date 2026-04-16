/**
 * Admin archive / restore connection endpoints — issue #1437.
 *
 * Two admin-only endpoints that take a single connection offline (or bring
 * it back) outside the publish flow:
 *
 * - POST /api/v1/admin/archive-connection flips a connection + its entities
 *   to `archived`. When the id is the reserved `__demo__`, built-in demo
 *   prompt collections for the org's `demo_industry` are cascaded too.
 * - POST /api/v1/admin/restore-connection reverses archive, bringing the
 *   connection + entities + (demo) prompts back to `published`.
 *
 * Primary use case: admins archive the onboarding `__demo__` after going
 * live, and restore it later when training new team members.
 *
 * Cascade semantics match the publish flow (see admin-publish.ts). The
 * heavy lifting lives in `archiveSingleConnection` / `restoreSingleConnection`
 * helpers in lib/semantic/entities.ts so both flows stay in lockstep.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { internalQuery, getInternalDB } from "@atlas/api/lib/db/internal";
import {
  DEMO_CONNECTION_ID,
  archiveSingleConnection,
  restoreSingleConnection,
  type ArchiveConnectionResult,
  type RestoreConnectionResult,
} from "@atlas/api/lib/semantic/entities";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-archive");

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const ConnectionIdBodySchema = z.object({
  connectionId: z.string().min(1, "connectionId is required"),
});

const ArchiveResponseSchema = z.object({
  archived: z.object({
    connection: z.boolean(),
    entities: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
  }),
});

const RestoreResponseSchema = z.object({
  restored: z.object({
    connection: z.boolean(),
    entities: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
  }),
});

type ArchiveResponse = z.infer<typeof ArchiveResponseSchema>;
type RestoreResponse = z.infer<typeof RestoreResponseSchema>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Read the org's `demo_industry` setting (if any). Failures are logged and
 * treated as "no industry" — the route proceeds without a demo prompt
 * cascade in that case.
 */
async function readDemoIndustry(
  orgId: string,
  requestId: string,
): Promise<string | null> {
  try {
    const rows = await internalQuery<{ value: string }>(
      `SELECT value FROM settings WHERE org_id = $1 AND key = 'demo_industry'`,
      [orgId],
    );
    return rows[0]?.value ?? null;
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        orgId,
        requestId,
      },
      "Failed to read demo_industry setting — demo prompt cascade skipped",
    );
    return null;
  }
}

/**
 * Map an archive helper result with cascade counts to the wire response.
 * `connection` is `true` only when the connection row itself flipped
 * (`archived` variant); `already_archived` reports `false` with the
 * reconciled cascade counts.
 */
function toArchiveResponse(
  result: { status: "archived" | "already_archived"; entities: number; prompts: number },
): ArchiveResponse {
  return {
    archived: {
      connection: result.status === "archived",
      entities: result.entities,
      prompts: result.prompts,
    },
  };
}

/**
 * Map a restore helper result to the wire response. Only invoked on the
 * `restored` variant — `not_found` / `not_archived` are handled as 404
 * before reaching here.
 */
function toRestoreResponse(result: {
  entities: number;
  prompts: number;
}): RestoreResponse {
  return {
    restored: {
      connection: true,
      entities: result.entities,
      prompts: result.prompts,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const archiveRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Mode"],
  summary: "Archive a connection",
  description:
    "Flip a single connection's status to `archived` and cascade its " +
    "semantic entities to `archived`. When the id is the reserved " +
    "`__demo__` connection, built-in demo prompt collections matching the " +
    "org's `demo_industry` setting are also archived. " +
    "Archiving an already-archived connection returns `archived.connection = " +
    "false` and still runs the entity + demo-prompt cascades — any straggler " +
    "rows that were left at `published` get reconciled, and the response " +
    "reports the counts.",
  request: {
    body: {
      content: { "application/json": { schema: ConnectionIdBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Archive summary (cascade counts may be zero on no-op)",
      content: { "application/json": { schema: ArchiveResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description: "Connection not found (or internal DB not configured)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({
            details: z.array(z.unknown()).optional(),
          }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Archive failed — transaction rolled back",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const restoreRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Mode"],
  summary: "Restore an archived connection",
  description:
    "Flip an archived connection's status back to `published` and cascade " +
    "its semantic entities back to `published`. When the id is the " +
    "reserved `__demo__` connection, built-in demo prompt collections " +
    "matching the org's `demo_industry` setting are also restored. " +
    "Returns 404 when the connection does not exist or is not currently " +
    "archived.",
  request: {
    body: {
      content: { "application/json": { schema: ConnectionIdBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Restore summary",
      content: { "application/json": { schema: RestoreResponseSchema } },
    },
    401: {
      description: "Authentication required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    403: {
      description: "Forbidden — admin role required",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    404: {
      description:
        "Connection not found, not currently archived, or internal DB not configured",
      content: { "application/json": { schema: ErrorSchema } },
    },
    422: {
      description: "Validation error",
      content: {
        "application/json": {
          schema: ErrorSchema.extend({
            details: z.array(z.unknown()).optional(),
          }),
        },
      },
    },
    429: {
      description: "Rate limit exceeded",
      content: { "application/json": { schema: AuthErrorSchema } },
    },
    500: {
      description: "Restore failed — transaction rolled back",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------
//
// Each route below uses path `/` internally and mounts at a different admin
// prefix (`/archive-connection`, `/restore-connection`). A single router
// can't carry two `/`-path routes without collision, so we split — matches
// the existing `admin.route("/publish", adminPublish)` pattern.

const adminArchive = createAdminRouter();
adminArchive.use(requireOrgContext());

const adminRestore = createAdminRouter();
adminRestore.use(requireOrgContext());

adminArchive.openapi(archiveRoute, async (c) =>
  runHandler(c, "archive connection", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const authResult = c.get("authResult");
    const { connectionId } = c.req.valid("json");

    const demoIndustry =
      connectionId === DEMO_CONNECTION_ID
        ? await readDemoIndustry(orgId, requestId)
        : null;

    const pool = getInternalDB();
    const client = await pool.connect();
    let result: ArchiveConnectionResult;

    try {
      await client.query("BEGIN");
      result = await archiveSingleConnection(client, orgId, connectionId, {
        demoIndustry,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        log.warn(
          {
            err:
              rollbackErr instanceof Error
                ? rollbackErr.message
                : String(rollbackErr),
            orgId,
            connectionId,
            requestId,
          },
          "ROLLBACK failed after archive error",
        );
      });
      log.error(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          orgId,
          connectionId,
          requestId,
        },
        "Archive failed — transaction rolled back",
      );
      return c.json(
        {
          error: "archive_failed",
          message:
            "Archive failed — all changes rolled back. See server logs for details.",
          requestId,
        },
        500,
      );
    } finally {
      client.release();
    }

    // Exhaustive switch on the tagged result — adding a new variant to
    // ArchiveConnectionResult will fail the `never` default and force a
    // handler update here.
    switch (result.status) {
      case "not_found":
        return c.json(
          {
            error: "not_found",
            message: `Connection "${connectionId}" not found for this organization.`,
            requestId,
          },
          404,
        );

      case "archived":
      case "already_archived": {
        // Audit action splits on whether the connection row actually
        // flipped: `mode.archive` captures the state transition;
        // `mode.archive_reconcile` captures cascade-only reconciliation
        // on an already-archived connection. Compliance queries
        // counting `action_type = 'mode.archive'` stay clean.
        const isReconcile = result.status === "already_archived";
        logAdminAction({
          actionType: isReconcile
            ? ADMIN_ACTIONS.mode.archiveReconcile
            : ADMIN_ACTIONS.mode.archive,
          targetType: "mode",
          targetId: connectionId,
          ipAddress:
            c.req.header("x-forwarded-for") ??
            c.req.header("x-real-ip") ??
            null,
          metadata: {
            orgId,
            connectionId,
            cascadedEntities: result.entities,
            cascadedPrompts: result.prompts,
          },
        });
        log.info(
          {
            requestId,
            orgId,
            connectionId,
            actorId: authResult.user?.id,
            cascaded: {
              entities: result.entities,
              prompts: result.prompts,
            },
          },
          isReconcile
            ? "Connection already archived — cascade reconciled"
            : "Connection archived",
        );
        return c.json(toArchiveResponse(result), 200);
      }

      default: {
        const _exhaustive: never = result;
        throw new Error(
          `Unhandled archive result: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }),
);

adminRestore.openapi(restoreRoute, async (c) =>
  runHandler(c, "restore connection", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const authResult = c.get("authResult");
    const { connectionId } = c.req.valid("json");

    const demoIndustry =
      connectionId === DEMO_CONNECTION_ID
        ? await readDemoIndustry(orgId, requestId)
        : null;

    const pool = getInternalDB();
    const client = await pool.connect();
    let result: RestoreConnectionResult;

    try {
      await client.query("BEGIN");
      result = await restoreSingleConnection(client, orgId, connectionId, {
        demoIndustry,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
        log.warn(
          {
            err:
              rollbackErr instanceof Error
                ? rollbackErr.message
                : String(rollbackErr),
            orgId,
            connectionId,
            requestId,
          },
          "ROLLBACK failed after restore error",
        );
      });
      log.error(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          orgId,
          connectionId,
          requestId,
        },
        "Restore failed — transaction rolled back",
      );
      return c.json(
        {
          error: "restore_failed",
          message:
            "Restore failed — all changes rolled back. See server logs for details.",
          requestId,
        },
        500,
      );
    } finally {
      client.release();
    }

    // Exhaustive switch — adding a new RestoreConnectionResult variant
    // will fail the `never` default and force a handler update here.
    switch (result.status) {
      case "not_found":
        return c.json(
          {
            error: "not_found",
            message: `Connection "${connectionId}" not found for this organization.`,
            requestId,
          },
          404,
        );

      case "not_archived":
        return c.json(
          {
            error: "not_found",
            message: `Connection "${connectionId}" is not currently archived.`,
            requestId,
          },
          404,
        );

      case "restored": {
        logAdminAction({
          actionType: ADMIN_ACTIONS.mode.restore,
          targetType: "mode",
          targetId: connectionId,
          ipAddress:
            c.req.header("x-forwarded-for") ??
            c.req.header("x-real-ip") ??
            null,
          metadata: {
            orgId,
            connectionId,
            cascadedEntities: result.entities,
            cascadedPrompts: result.prompts,
          },
        });
        log.info(
          {
            requestId,
            orgId,
            connectionId,
            actorId: authResult.user?.id,
            restored: {
              entities: result.entities,
              prompts: result.prompts,
            },
          },
          "Connection restored",
        );
        return c.json(toRestoreResponse(result), 200);
      }

      default: {
        const _exhaustive: never = result;
        throw new Error(
          `Unhandled restore result: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }),
);

export { adminArchive, adminRestore };
