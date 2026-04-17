/**
 * Admin publish endpoint — atomic promotion of drafts to published.
 *
 * Mounted under /api/v1/admin/publish via admin.route(). Admin-only.
 *
 * Runs the 4-phase publish flow from PRD #1421 in a single transaction:
 * 1. Apply `draft_delete` tombstones (delete the targeted published rows,
 *    then delete the tombstones themselves).
 * 2. Delete published entity rows superseded by drafts (same entity key).
 * 3. Promote every draft content type to `published`, in order:
 *    3a. Entities (merged with phase 2 via `promoteDraftEntities()`).
 *    3b. Connections.
 *    3c. Prompt collections.
 *    3d. Starter-prompt suggestions (`query_suggestions`) — #1478.
 * 4. If `archiveConnections` is provided, archive those connections and
 *    cascade to their entities. When the archive list includes the reserved
 *    `__demo__` ID, also archive the built-in demo prompt collections whose
 *    industry matches the org's `demo_industry` setting.
 *
 * Any failure rolls back the entire transaction — no partial state.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { createLogger } from "@atlas/api/lib/logger";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { readDemoIndustry } from "@atlas/api/lib/demo-industry";
import {
  applyTombstones,
  promoteDraftEntities,
  archiveSingleConnection,
  DEMO_CONNECTION_ID,
} from "@atlas/api/lib/semantic/entities";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

const log = createLogger("admin-publish");

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const PublishRequestSchema = z.object({
  /**
   * Optional list of connection IDs to archive as part of the publish.
   * When set, each connection's status is flipped to `archived` and its
   * published entities cascade to `archived`. When the list includes the
   * reserved `__demo__` connection, built-in demo prompt collections for
   * the org's demo industry are also archived.
   */
  archiveConnections: z.array(z.string().min(1)).optional(),
});

const PublishResponseSchema = z.object({
  promoted: z.object({
    connections: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
    starterPrompts: z.number().int().nonnegative(),
  }),
  deleted: z.object({
    entities: z.number().int().nonnegative(),
  }),
  archived: z.object({
    connections: z.number().int().nonnegative(),
    entities: z.number().int().nonnegative(),
    prompts: z.number().int().nonnegative(),
  }),
});

export type PublishResponse = z.infer<typeof PublishResponseSchema>;

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const publishRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin — Mode"],
  summary: "Publish all drafts",
  description:
    "Atomically promote every `draft` and apply every `draft_delete` tombstone " +
    "for the active org, optionally archiving the specified connections. " +
    "After a successful response, no draft or tombstone rows remain for the org.",
  request: {
    body: {
      content: { "application/json": { schema: PublishRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Publish summary",
      content: { "application/json": { schema: PublishResponseSchema } },
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
      description: "Internal database not configured",
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
      description: "Publish failed — transaction rolled back",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminPublish = createAdminRouter();
adminPublish.use(requireOrgContext());

adminPublish.openapi(publishRoute, async (c) =>
  runHandler(c, "publish mode", async () => {
    const { requestId, orgId } = c.get("orgContext");
    const authResult = c.get("authResult");

    // Body validation is handled upstream by `validationHook` (returns 422
    // on invalid shapes) and `requireOrgContext()` (returns 404 when the
    // internal DB is unavailable). Here we just consume the validated body.
    const { archiveConnections } = c.req.valid("json");
    const archiveIds = archiveConnections ?? [];
    const archiveDemo = archiveIds.includes(DEMO_CONNECTION_ID);

    // Resolve demo industry before opening the transaction. A read
    // failure must 500 here — otherwise publish would commit with
    // prompts = 0 and demo prompts would stay published after archive.
    let demoIndustry: string | null = null;
    if (archiveDemo) {
      const industryResult = readDemoIndustry(orgId, requestId);
      if (!industryResult.ok) {
        return c.json(
          {
            error: "publish_failed",
            message:
              "Publish failed — could not read demo industry setting. See server logs for details.",
            requestId,
          },
          500,
        );
      }
      demoIndustry = industryResult.value;
    }

    // ── Transaction ────────────────────────────────────────────────
    const pool = getInternalDB();
    const client = await pool.connect();
    // pg destroys the socket when `release(err)` is called with a truthy
    // arg. We need to destroy on a failed ROLLBACK so a dirty client
    // doesn't poison the next borrower.
    let rollbackErr: Error | null = null;
    // Values are assigned inside the try block before either the 200
    // response or a 500 (which doesn't read them) — start as numbers for
    // type inference without seeding a read-before-write warning.
    let deletedEntityCount: number;
    let promotedEntityCount: number;
    let promotedConnectionCount: number;
    let promotedPromptCount: number;
    let promotedStarterPromptCount: number;
    let archivedConnectionCount: number;
    let archivedEntityCount: number;
    let archivedPromptCount: number;

    try {
      await client.query("BEGIN");

      // Phase 1: apply tombstones (delete targeted published rows + tombstones)
      deletedEntityCount = await applyTombstones(client, orgId);

      // Phase 2 + 3a: remove superseded published entities, promote drafts
      promotedEntityCount = await promoteDraftEntities(client, orgId);

      // Phase 3b: promote draft connections
      const promotedConns = await client.query(
        `UPDATE connections SET status = 'published', updated_at = now()
         WHERE org_id = $1 AND status = 'draft'
         RETURNING id`,
        [orgId],
      );
      promotedConnectionCount = promotedConns.rows.length;

      // Phase 3c: promote draft prompt collections
      const promotedPrompts = await client.query(
        `UPDATE prompt_collections SET status = 'published', updated_at = now()
         WHERE org_id = $1 AND status = 'draft'
         RETURNING id`,
        [orgId],
      );
      promotedPromptCount = promotedPrompts.rows.length;

      // Phase 3d: promote draft starter-prompt suggestions. Runs in the
      // same transaction as entities/connections/prompt collections so a
      // partial failure rolls all four promotions back — the admin never
      // sees some draft edits go live while others remain unpublished.
      const promotedStarterPrompts = await client.query(
        `UPDATE query_suggestions SET status = 'published', updated_at = now()
         WHERE org_id = $1 AND status = 'draft'
         RETURNING id`,
        [orgId],
      );
      promotedStarterPromptCount = promotedStarterPrompts.rows.length;

      // Phase 4: archive requested connections (+ cascade to their entities +
      // demo prompt collections when the id is `__demo__`). Loops the shared
      // single-connection helper so publish and the standalone archive
      // endpoints stay in lockstep — see #1437.
      archivedConnectionCount = 0;
      archivedEntityCount = 0;
      archivedPromptCount = 0;
      for (const id of archiveIds) {
        const archiveResult = await archiveSingleConnection(client, orgId, id, {
          demoIndustry: id === DEMO_CONNECTION_ID ? demoIndustry : null,
        });
        // Exhaustive switch — matches the pattern in admin-archive.ts so a
        // future ArchiveConnectionResult variant fails the `never` default
        // at compile time instead of getting silently treated as
        // `not_found`.
        switch (archiveResult.status) {
          case "archived":
            archivedConnectionCount++;
            archivedEntityCount += archiveResult.entities;
            archivedPromptCount += archiveResult.prompts;
            break;
          case "already_archived":
            // The connection row itself was already archived, but the
            // helper's cascade still reconciled any straggler entities /
            // demo prompts.
            archivedEntityCount += archiveResult.entities;
            archivedPromptCount += archiveResult.prompts;
            log.warn(
              {
                requestId,
                orgId,
                connectionId: id,
                cascadedEntities: archiveResult.entities,
                cascadedPrompts: archiveResult.prompts,
              },
              "archiveConnection id already archived during publish — cascade reconciled",
            );
            break;
          case "not_found":
            // Admin passed a bogus id. Surface it in the log so ops can
            // spot typos; publish itself still commits the rest.
            log.warn(
              { requestId, orgId, connectionId: id },
              "archiveConnection id not found during publish — skipped",
            );
            break;
          default: {
            const _exhaustive: never = archiveResult;
            throw new Error(
              `Unhandled archive result in publish loop: ${JSON.stringify(_exhaustive)}`,
            );
          }
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch((rbErr: unknown) => {
        rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        log.warn(
          {
            err: rollbackErr.message,
            orgId,
            requestId,
          },
          "ROLLBACK failed after publish error — client will be destroyed",
        );
      });
      log.error(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          orgId,
          requestId,
        },
        "Publish failed — transaction rolled back",
      );
      return c.json(
        {
          error: "publish_failed",
          message:
            "Publish failed — all changes rolled back. See server logs for details.",
          requestId,
        },
        500,
      );
    } finally {
      client.release(rollbackErr ?? undefined);
    }

    // ── Audit + response ────────────────────────────────────────────
    logAdminAction({
      actionType: ADMIN_ACTIONS.mode.publish,
      targetType: "mode",
      targetId: orgId,
      ipAddress:
        c.req.header("x-forwarded-for") ??
        c.req.header("x-real-ip") ??
        null,
      metadata: {
        promotedConnections: promotedConnectionCount,
        promotedEntities: promotedEntityCount,
        promotedPrompts: promotedPromptCount,
        promotedStarterPrompts: promotedStarterPromptCount,
        deletedEntities: deletedEntityCount,
        archivedConnections: archivedConnectionCount,
        archivedEntities: archivedEntityCount,
        archivedPrompts: archivedPromptCount,
        archiveIds,
      },
    });

    log.info(
      {
        requestId,
        orgId,
        actorId: authResult.user?.id,
        promoted: {
          connections: promotedConnectionCount,
          entities: promotedEntityCount,
          prompts: promotedPromptCount,
          starterPrompts: promotedStarterPromptCount,
        },
        deleted: { entities: deletedEntityCount },
        archived: {
          connections: archivedConnectionCount,
          entities: archivedEntityCount,
          prompts: archivedPromptCount,
        },
      },
      "Publish succeeded",
    );

    const response: PublishResponse = {
      promoted: {
        connections: promotedConnectionCount,
        entities: promotedEntityCount,
        prompts: promotedPromptCount,
        starterPrompts: promotedStarterPromptCount,
      },
      deleted: { entities: deletedEntityCount },
      archived: {
        connections: archivedConnectionCount,
        entities: archivedEntityCount,
        prompts: archivedPromptCount,
      },
    };
    return c.json(response, 200);
  }),
);

export { adminPublish };
