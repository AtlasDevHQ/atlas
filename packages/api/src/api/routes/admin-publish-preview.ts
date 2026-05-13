/**
 * GET /api/v1/admin/publish/preview — per-surface draft rows about to be
 * promoted by the next call to /api/v1/admin/publish (#2177).
 *
 * The pending-changes Publish modal reads this endpoint when the admin
 * opens it and renders a per-surface list of draft rows. Confirming the
 * modal POSTs to /api/v1/admin/publish to promote them atomically.
 *
 * Returns lightweight identity fields per surface — id, name/description,
 * updated_at, status — not the full row. Full diffs against the published
 * row are out of scope for v1; the existing semantic-entity diff endpoint
 * covers the most-asked-for case.
 *
 * Scope follows the content-mode registry: connections, prompt_collections,
 * query_suggestions (starter prompts), and semantic_entities (drafts,
 * draft-edits, and tombstoned deletes). Adding a new mode-tracked surface
 * means widening the response schema below in lockstep with
 * `CONTENT_MODE_TABLES`.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { runHandler } from "@atlas/api/lib/effect/hono";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { matchScopeAcrossAliases } from "@atlas/api/lib/db/with-group-scope";
import { ErrorSchema, AuthErrorSchema } from "./shared-schemas";
import { createAdminRouter, requireOrgContext } from "./admin-router";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DraftRowSchema = z.object({
  id: z.string(),
  /** Human-readable label — `name` for entities/prompts/connections, `description` for starter prompts. */
  label: z.string(),
  /** Last-edit timestamp (ISO-8601). */
  updatedAt: z.string().datetime(),
});

const TombstoneRowSchema = z.object({
  id: z.string(),
  /** Entity name that will be deleted on publish. */
  label: z.string(),
  updatedAt: z.string().datetime(),
});

const EntityEditRowSchema = z.object({
  id: z.string(),
  /** Entity name; the published row sharing the same `connection_group_id` will be replaced. */
  label: z.string(),
  /**
   * Legacy connection scope. Retained for SDK compatibility during the
   * dual-write transition (#2336). `null` matches NULL-scope entities.
   * Removed when `connection_id` drops in a follow-on slice.
   */
  connectionId: z.string().nullable(),
  /**
   * Group scope (#2340) — the environment the entity belongs to. `null`
   * for legacy `__global__` rows whose backfill did not resolve a group.
   */
  connectionGroupId: z.string().nullable(),
  updatedAt: z.string().datetime(),
});

const PublishPreviewSchema = z.object({
  connections: z.array(DraftRowSchema),
  /** Drafts of new entities (no published row exists yet for that `connection_group_id`). */
  entities: z.array(DraftRowSchema),
  /** Drafts that supersede an existing published entity row. */
  entityEdits: z.array(EntityEditRowSchema),
  /** Tombstones — published rows that will be deleted. */
  entityDeletes: z.array(TombstoneRowSchema),
  prompts: z.array(DraftRowSchema),
  starterPrompts: z.array(DraftRowSchema),
});

export type PublishPreview = z.infer<typeof PublishPreviewSchema>;

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const previewRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Mode"],
  summary: "List drafts that the next publish call will promote",
  description:
    "Returns the per-surface inventory of draft rows that " +
    "`POST /api/v1/admin/publish` would promote on this org. Read by the " +
    "Publish modal in the admin top bar so the admin can review before " +
    "confirming. The shape mirrors the content-mode registry tuple.",
  responses: {
    200: {
      description: "Per-surface draft inventory",
      content: { "application/json": { schema: PublishPreviewSchema } },
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
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DbRow = {
  id: string;
  label: string;
  updated_at: Date | string | null;
  connection_id?: string | null;
  connection_group_id?: string | null;
} & Record<string, unknown>;

/** Coerce pg timestamptz → ISO-8601 string, falling back to epoch-zero so
 *  the wire schema's `.datetime()` validator stays satisfied. Mismatches
 *  log noisily upstream but never fail the preview render. */
function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const adminPublishPreview = createAdminRouter();
adminPublishPreview.use(requireOrgContext());

adminPublishPreview.openapi(previewRoute, async (c) =>
  runHandler(c, "preview publish", async () => {
    const { orgId } = c.get("orgContext");

    // Fan out one query per surface — runs in parallel via Promise.all.
    // Each query is indexed on `(org_id, status)` (see migration
    // `0044_content_mode_indexes.sql`) so the planner uses an index scan
    // even for orgs with thousands of historical rows.
    const [
      connectionsRows,
      newEntityRows,
      entityEditRows,
      entityDeleteRows,
      promptRows,
      starterPromptRows,
    ] = await Promise.all([
      internalQuery<DbRow>(
        `SELECT id, id AS label, updated_at
           FROM connections
          WHERE org_id = $1 AND status = 'draft'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      // Entities that are NOT also a draft-edit (no published sibling).
      // The `NOT EXISTS` filter mirrors the `entityEdits` segment in
      // `CONTENT_MODE_TABLES` so the two lists never overlap. Scope match
      // keys on `connection_group_id` (#2340) — multi-environment drafts
      // collapse to one preview row per logical entity, not N per replica.
      //
      // `pub.entity_type = d.entity_type` is load-bearing: the partial
      // unique indexes from 0063 key on `(org_id, entity_type, name,
      // connection_group_id)`, so without this clause a draft *metric*
      // named "accounts" would falsely "match" a published *entity* of
      // the same name (and vice versa) — counted as a new-entity create
      // when it should be an edit, or hidden from `entities` when it's
      // genuinely new. Same fix on both queries below.
      internalQuery<DbRow>(
        `SELECT d.id::text AS id, d.name AS label, d.updated_at,
                d.connection_id, d.connection_group_id
           FROM semantic_entities d
          WHERE d.org_id = $1
            AND d.status = 'draft'
            AND NOT EXISTS (
              SELECT 1 FROM semantic_entities pub
               WHERE pub.org_id = d.org_id
                 AND pub.entity_type = d.entity_type
                 AND pub.name = d.name
                 AND ${matchScopeAcrossAliases({ leftAlias: "pub", rightAlias: "d", column: "connection_group_id" })}
                 AND pub.status = 'published'
            )
          ORDER BY d.updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT d.id::text AS id, d.name AS label, d.updated_at,
                d.connection_id, d.connection_group_id
           FROM semantic_entities d
           INNER JOIN semantic_entities pub
             ON d.org_id = pub.org_id
            AND d.entity_type = pub.entity_type
            AND d.name = pub.name
            AND ${matchScopeAcrossAliases({ leftAlias: "d", rightAlias: "pub", column: "connection_group_id" })}
          WHERE d.org_id = $1
            AND d.status = 'draft'
            AND pub.status = 'published'
          ORDER BY d.updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT id::text AS id, name AS label, updated_at
           FROM semantic_entities
          WHERE org_id = $1 AND status = 'draft_delete'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT id::text AS id, name AS label, updated_at
           FROM prompt_collections
          WHERE org_id = $1 AND status = 'draft'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
      internalQuery<DbRow>(
        `SELECT id::text AS id, description AS label, updated_at
           FROM query_suggestions
          WHERE org_id = $1 AND status = 'draft'
          ORDER BY updated_at DESC`,
        [orgId],
      ),
    ]);

    const response: PublishPreview = {
      connections: connectionsRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      entities: newEntityRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      entityEdits: entityEditRows.map((r) => ({
        id: r.id,
        label: r.label,
        connectionId: r.connection_id ?? null,
        connectionGroupId: r.connection_group_id ?? null,
        updatedAt: toIso(r.updated_at),
      })),
      entityDeletes: entityDeleteRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      prompts: promptRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
      starterPrompts: starterPromptRows.map((r) => ({
        id: r.id,
        label: r.label,
        updatedAt: toIso(r.updated_at),
      })),
    };

    return c.json(response, 200);
  }),
);

export { adminPublishPreview };
