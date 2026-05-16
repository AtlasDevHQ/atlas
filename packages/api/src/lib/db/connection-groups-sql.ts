/**
 * SQL fragments for connection-group deletion and archive cascade,
 * shared between the `admin-connection-groups` route and the real-Postgres
 * migration smoke test. Centralised here because the same statement has
 * now caused #2410 three times (#2405 → #2406 → #2410) — drift between
 * route and test was the root cause of #2410 going unnoticed under the
 * #2406 patch.
 *
 * Keeping the canonical SQL here means a regression that re-introduces
 * a too-tight WHERE clause (e.g. `AND url <> ''`) shows up in *both* the
 * route and the test in the same diff, so it can't ship green.
 *
 * The group-archive cascade follows the same discipline: the
 * `CASCADE_ARCHIVE_GROUP_*` statements below are imported by both the
 * archive route handler and the migrate-pg smoke. A regression that
 * relaxes the `org_id` predicate or skips a content table shows up in
 * both call sites in the same diff.
 */

/**
 * Atomic env-delete SQL: drop every archived connection in the group, then
 * drop the group itself. Parameters are positional and shared across the
 * two statements:
 *   $1 = group id
 *   $2 = org id
 *
 * MUST match `status = 'archived'` unconditionally — both archived shapes
 * (real org-owned archived rows AND `url = ''` per-org global-hide
 * tombstones) reference the group via `connections.group_id` and so must
 * be cleared before `DELETE FROM connection_groups` to avoid a 23503
 * against the `fk_connections_group` FK.
 */
export const DELETE_GROUP_AND_ARCHIVED_CONNECTIONS_SQL = `
  WITH deleted_archived_connections AS (
    DELETE FROM connections
     WHERE group_id = $1
       AND org_id = $2
       AND status = 'archived'
    RETURNING id
  )
  DELETE FROM connection_groups WHERE id = $1 AND org_id = $2
`;

/**
 * Atomic merge SQL: consolidate N source connections into one target
 * environment within a single statement (#2409). A single CTE-driven
 * statement is the atomicity primitive — Postgres evaluates every branch
 * inside one implicit transaction, so a failure in any branch rolls every
 * branch back. Avoids needing `pool.connect()` + manual BEGIN/COMMIT
 * (which the route mock surface doesn't currently expose).
 *
 * Parameters:
 *   $1 = target group id (newly generated; only consumed when the
 *        ON CONFLICT branch does NOT fire and we actually insert)
 *   $2 = org id
 *   $3 = target group display name (trimmed, validated via GROUP_NAME_PATTERN)
 *   $4 = primary_connection_id to seed on INSERT (always one of the source ids)
 *   $5 = boolean — when true, the override REPLACES the existing primary on
 *        ON CONFLICT DO UPDATE; when false, the existing primary is preserved
 *   $6 = source connection ids (text[])
 *   $7 = source group ids — the union of group_ids the source connections
 *        were sitting in before the merge.
 *
 * Cleanup gating (the `cleanup` CTE) deletes a candidate source group iff:
 *   1. `id LIKE 'g\_%' ESCAPE '\' AND name = SUBSTRING(id FROM 3)` →
 *      only auto-backfilled singletons (migration 0062 shape) are
 *      eligible. User-renamed groups and `g_<random>` user-created
 *      groups are preserved even when empty.
 *   2. `id <> target.id` → never delete the target we just landed in.
 *   3. `NOT EXISTS` guards against every reference table that carries a
 *      `connection_group_id` column today. The FK-bearing references
 *      (`connections.group_id`, `approval_queue.connection_group_id`,
 *      `scheduled_tasks.connection_group_id`) would raise 23503 and roll
 *      the merge back without the guard; the soft-reference columns
 *      (`dashboard_cards.connection_group_id`,
 *      `semantic_entities.connection_group_id`,
 *      `pii_column_classifications.connection_group_id`,
 *      `conversations.connection_group_id`) carry no FK (see 0066
 *      "Why no FK on connection_group_id") and would silently dangle —
 *      worse than a rolled-back merge, because downstream readers would
 *      stop matching the orphaned rows. Guarding both FK and soft
 *      references collapses the two failure modes to one: a source
 *      group with admin-curated content is left in place, the merge
 *      succeeds with a partial cleanup, and the residual group surfaces
 *      in `skipped_group_ids` so the wizard can show what was preserved.
 *
 *   The connections NOT EXISTS guard subtracts the `$6::text[]` source
 *   set explicitly — Postgres data-modifying CTEs share one snapshot, so
 *   the sibling `moved` UPDATE is invisible to a fresh SELECT on
 *   `connections` here. Without the `<> ALL($6)` subtraction, the
 *   cleanup would see every source connection still in its source group
 *   and skip every candidate, leaving `deleted_group_ids` empty in
 *   production while the wire tests (which mock the CTE result directly)
 *   would still pass. The bug is invisible without a real-Postgres
 *   smoke; see #2437 codex review for the diagnosis.
 *
 *   `dashboard_cards` is the lone reference without its own `org_id`
 *   (see migration 0066 § "Why no FK on connection_group_id" — cards
 *   inherit org scope from their parent `dashboards` row). The
 *   composite (id, org_id) PK on connection_groups means a `cg.id`
 *   can repeat across orgs, so the dashboard_cards predicate alone
 *   could incorrectly preserve a group when the dangling card is in
 *   a different org. We accept this conservatively: any global-`cg.id`
 *   collision (rare and observable via audit) is preferable to silently
 *   orphaning a card.
 *
 * Return shape: one row, four columns.
 *   target               jsonb  — { id, name, primaryConnectionId, createdAt, updatedAt, created }
 *   moved_connection_ids text[] — ids actually re-parented this statement
 *   deleted_group_ids    text[] — auto-backfilled source groups cleaned up
 *   skipped_group_ids    text[] — auto-backfilled candidates we declined
 *                                 to delete because a NOT EXISTS guard
 *                                 fired (i.e. the group still anchors
 *                                 admin-curated content). Surfaced so
 *                                 the wizard preview can reconcile its
 *                                 client-side cleanup estimate with the
 *                                 server's actual decision.
 *
 * The `(xmax = 0)` trick on the target CTE tells INSERT (no concurrent
 * xact touched the row) from ON CONFLICT DO UPDATE (the conflicting row
 * was visible). Wire-format calls this `created` so the wizard knows
 * whether to say "Created prod" vs "Added to prod".
 */
export const MERGE_CONNECTIONS_INTO_GROUP_SQL = `
  WITH target AS (
    INSERT INTO connection_groups (id, org_id, name, primary_connection_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (org_id, name) DO UPDATE
      SET updated_at = NOW(),
          primary_connection_id = CASE
            WHEN $5::boolean THEN EXCLUDED.primary_connection_id
            ELSE connection_groups.primary_connection_id
          END
    RETURNING id, name, primary_connection_id, created_at, updated_at, (xmax = 0) AS created
  ),
  moved AS (
    UPDATE connections
       SET group_id = (SELECT id FROM target), updated_at = NOW()
     WHERE id = ANY($6::text[])
       AND org_id = $2
    RETURNING id
  ),
  cleanup_candidates AS (
    SELECT cg.id
      FROM connection_groups cg
     WHERE cg.org_id = $2
       AND cg.id = ANY($7::text[])
       AND cg.id <> (SELECT id FROM target)
       AND cg.id LIKE 'g\\_%' ESCAPE '\\'
       AND cg.name = SUBSTRING(cg.id FROM 3)
  ),
  cleanup AS (
    DELETE FROM connection_groups cg
     WHERE cg.org_id = $2
       AND cg.id IN (SELECT id FROM cleanup_candidates)
       AND NOT EXISTS (
         SELECT 1 FROM connections c
          WHERE c.group_id = cg.id
            AND c.org_id = $2
            -- Subtract the rows the sibling moved CTE is re-parenting.
            -- Without this, the cleanup never sees the source group as
            -- empty because data-modifying CTEs share one snapshot.
            AND c.id <> ALL($6::text[])
       )
       AND NOT EXISTS (
         SELECT 1 FROM approval_queue aq
          WHERE aq.connection_group_id = cg.id AND aq.org_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_tasks st
          WHERE st.connection_group_id = cg.id AND st.org_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM dashboard_cards dc
          WHERE dc.connection_group_id = cg.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM semantic_entities se
          WHERE se.connection_group_id = cg.id AND se.org_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM pii_column_classifications pc
          WHERE pc.connection_group_id = cg.id AND pc.org_id = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM conversations cv
          WHERE cv.connection_group_id = cg.id AND cv.org_id = $2
       )
    RETURNING cg.id
  )
  SELECT
    (SELECT jsonb_build_object(
       'id', t.id,
       'name', t.name,
       'primaryConnectionId', t.primary_connection_id,
       'createdAt', t.created_at,
       'updatedAt', t.updated_at,
       'created', t.created
     ) FROM target t) AS target,
    COALESCE((SELECT array_agg(id ORDER BY id) FROM moved), ARRAY[]::text[]) AS moved_connection_ids,
    COALESCE((SELECT array_agg(id ORDER BY id) FROM cleanup), ARRAY[]::text[]) AS deleted_group_ids,
    COALESCE(
      (SELECT array_agg(id ORDER BY id) FROM cleanup_candidates
        WHERE id NOT IN (SELECT id FROM cleanup)),
      ARRAY[]::text[]
    ) AS skipped_group_ids
`;

// ---------------------------------------------------------------------------
// Group-archive cascade
// ---------------------------------------------------------------------------
//
// Archiving a connection group atomically retires every content row scoped
// to it. The cascade runs in one transaction owned by the caller (see
// `POST /admin/connection-groups/:id/archive` in
// `admin-connection-groups.ts`) — any sub-step failure rolls every row
// back, so a partial archive is never observable.
//
// Vocabulary mismatch between this slice and the rest of the schema:
//
//   - `connection_groups.status` uses an `active` / `archived` enum.
//     The mode-system tables reuse the existing `published` / `draft`
//     / `archived` lifecycle (`semantic_entities` additionally has
//     `draft_delete` for its tombstone overlay).
//   - `scheduled_tasks` has no `status` column — it carries an
//     `enabled` boolean that already serves the same intent. The
//     existing `cascadeWorkspaceDelete` flow in `lib/db/internal.ts`
//     also uses `enabled = false` as the archive-cascade semantic;
//     mirror it here so reads downstream stay in lockstep.
//   - `approval_queue.status` is a CHECK-constrained enum (`pending`,
//     `approved`, `denied`, `expired`). `archived` would 23514. The
//     existing `expireStaleRequests` in `ee/src/governance/approval.ts`
//     flips pending requests to `expired` when their owning resource
//     goes away; we mirror that semantic here so a pending request
//     can't survive its target group.
//   - `dashboard_cards` has neither `status` nor `enabled`. Cards
//     continue to reference the archived group AND continue to
//     render normally — `lib/dashboards.ts` and
//     `lib/dashboards-group-resolve.ts` do not filter on
//     `connection_groups.status`. Cascading cards is intentionally
//     out of scope for this slice; surfacing the archived state at
//     view time would require either adding a status column to
//     `dashboard_cards` or threading a `WHERE group.status = 'active'`
//     filter through every dashboard read path. Both are dedicated
//     follow-ups. Admins archiving a group should plan to edit or
//     remove cards that reference it.
//
// Each statement takes the same parameters:
//   $1 = group id
//   $2 = org id
//
// All four UPDATEs are idempotent: a re-run on an already-archived group
// flips zero rows (the source predicates filter to the non-archived set).
// The route caller wraps them in BEGIN/COMMIT so the whole bundle is
// atomic.

// Per-table cascade statements. Each takes `$1 = group id, $2 = org id`,
// returns `id` per touched row for the count, and is idempotent (a re-run
// against an already-cascaded group flips zero rows). The terminal state
// per table is captured by the umbrella vocabulary-mismatch block above;
// names are self-describing, so no per-constant JSDoc.

export const CASCADE_ARCHIVE_GROUP_ENTITIES_SQL = `
  UPDATE semantic_entities
     SET status = 'archived', updated_at = NOW()
   WHERE connection_group_id = $1
     AND org_id = $2
     AND status != 'archived'
  RETURNING id
`;

export const CASCADE_ARCHIVE_GROUP_TASKS_SQL = `
  UPDATE scheduled_tasks
     SET enabled = false, updated_at = NOW()
   WHERE connection_group_id = $1
     AND org_id = $2
     AND enabled = true
  RETURNING id
`;

export const CASCADE_ARCHIVE_GROUP_APPROVALS_SQL = `
  UPDATE approval_queue
     SET status = 'expired'
   WHERE connection_group_id = $1
     AND org_id = $2
     AND status = 'pending'
  RETURNING id
`;

// `WHERE status = 'active'` is load-bearing — it converts a concurrent
// duplicate flip into a 0-row no-op rather than a 23505 / silent
// duplicate audit. The route maps RETURNING [] to 409.
export const ARCHIVE_GROUP_SQL = `
  UPDATE connection_groups
     SET status = 'archived', updated_at = NOW()
   WHERE id = $1
     AND org_id = $2
     AND status = 'active'
  RETURNING id
`;
