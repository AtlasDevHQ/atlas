/**
 * Region-migration Phase 4 — source-region data cleanup (#4458).
 *
 * After a workspace's region migration completes and the 7-day grace period
 * elapses, the workspace's data must actually be DELETED from the source
 * region — the residency/PII promise in `data-residency.mdx`. This module is
 * the destructive half: `runSourceCleanupSweep` (driven by the
 * `region_migration_source_cleanup` periodic fiber in `effect/layers.ts`)
 * consumes `getCleanupDueMigrations()` and removes the org's rows.
 *
 * ## Deletion scope — derived from the bundle-scope registry, never hand-listed
 *
 * The authoritative per-table moves/stays decision is
 * `BUNDLE_TABLE_DECISIONS` in `bundle-scope.ts` (#4460). Cleanup deletes the
 * org's rows in exactly `EXPORTED_TABLES ∪ STAYS_TABLES`:
 *
 * - `exported` tables are safe to delete because their rows already moved to
 *   the target region in the export bundle;
 * - `stays` tables are region-local residue (caches, history, region-bound
 *   ciphertext) that the registry explicitly marks "NOT retained";
 * - `platform` tables are never touched — they are operator/billing/auth-spine
 *   state with no per-workspace residency dimension (`region_migrations`
 *   itself, the Stripe spine, …).
 *
 * `CLEANUP_TABLE_RULES` below maps each in-scope table to its org-scoping
 * predicate (most tables carry `org_id`/`workspace_id` directly; a few scope
 * through a parent table or, for `chat_cache`, a JSONB expression). The
 * tripwire test (`__tests__/cleanup.test.ts`) asserts the rule set equals the
 * registry-derived scope exactly AND validates every referenced column
 * against the Drizzle schema — so a new table cannot silently miss cleanup,
 * and a platform table cannot silently enter it.
 *
 * ## Safety & retry contract
 *
 * - Each migration's cleanup runs in ONE transaction: every DELETE plus the
 *   `source_cleaned_at` stamp commit together, so a partial failure rolls
 *   back to "still due" and the next sweep retries — idempotent by
 *   construction (DELETEs of already-deleted rows are no-ops).
 * - The row is re-checked under `FOR UPDATE` inside the transaction, so two
 *   instances can't double-clean (the loser sees the stamp and skips).
 * - Cutover guard: if the `organization` row still homes the workspace in
 *   the source region, the delete would destroy LIVE data — the cleanup is
 *   refused and permanently resolved as skipped (audited). An organization
 *   row whose `region` is NULL/unreadable is ambiguous and fails CLOSED:
 *   nothing is deleted, nothing is stamped, the row stays due (re-warned
 *   every sweep). The cleanup never
 *   touches `status`/`region_updated`, so the unsafe-retry guard
 *   (`resetMigrationForRetry`) is unaffected.
 * - Region identity guard: when this process knows its region
 *   (`getApiRegion()`), it only cleans migrations whose `source_region`
 *   matches — a misrouted row is warned about and left alone.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, getInternalDB } from "@atlas/api/lib/db/internal";
import { BUNDLE_TABLE_DECISIONS } from "./bundle-scope";
import { getCleanupDueMigrations } from "./migrate";
import { getApiRegion } from "./misrouting";

const log = createLogger("region-migration-cleanup");

/**
 * Sweep cadence for the `region_migration_source_cleanup` fiber. Hourly is
 * plenty against a 7-day grace period; the worst-case delay between "grace
 * elapsed" and "residue deleted" is one interval.
 */
export const SOURCE_CLEANUP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Structured audit event, same shape as `logMigrationEvent` in migrate.ts. */
function logCleanupEvent(
  event: string,
  migrationId: string,
  details: Record<string, unknown>,
): void {
  log.info({ event, migrationId, ...details }, `Migration audit: ${event}`);
}

// ---------------------------------------------------------------------------
// Per-table scoping rules
// ---------------------------------------------------------------------------

/** How a table's rows are attributed to the migrated org for deletion. */
export type CleanupRule =
  /** The table carries the org id directly in `column`. */
  | { readonly kind: "column"; readonly column: string }
  /**
   * The table scopes through a parent: delete rows whose `fkColumn` matches
   * a `parentTable.id` owned by the org. Parent-scoped deletes run BEFORE
   * the direct-column phase (the parent rows must still exist for the
   * subquery — load-bearing for `slack_threads`, which has no FK cascade).
   */
  | {
      readonly kind: "parent";
      readonly fkColumn: string;
      readonly parentTable: string;
      readonly parentColumn: string;
    }
  /** SQL predicate over the row with `$1` = the org id (chat_cache JSONB). */
  | { readonly kind: "expression"; readonly predicate: `${string}$1${string}` }
  /** No org dimension exists — nothing is attributable; reason required. */
  | { readonly kind: "none"; readonly reason: string };

/**
 * The tables the cleanup is allowed to touch, derived at the TYPE level from
 * the bundle-scope registry: every non-`platform` decision key. The
 * `satisfies` on `CLEANUP_TABLE_RULES` below then makes both drift
 * directions a compile error — a new `exported`/`stays` table in
 * `BUNDLE_TABLE_DECISIONS` with no cleanup rule fails to type-check, and a
 * `platform` table added here is an excess property. The runtime tripwire
 * test keeps the half the type system can't see (column names vs the live
 * Drizzle schema).
 */
type CleanupScopedTable = {
  [K in keyof typeof BUNDLE_TABLE_DECISIONS]: (typeof BUNDLE_TABLE_DECISIONS)[K]["decision"] extends "platform"
    ? never
    : K;
}[keyof typeof BUNDLE_TABLE_DECISIONS];

/**
 * Org-scoping rule for every table cleanup is allowed to touch — keyed to
 * match `EXPORTED_TABLES ∪ STAYS_TABLES` exactly (compile-time via
 * `CleanupScopedTable`; re-pinned by the tripwire test). Column/table names
 * are static registry literals, validated against the Drizzle schema by the
 * tripwire.
 */
export const CLEANUP_TABLE_RULES = {
  // ── Exported pillars (already moved — delete the source copy) ────────────
  conversations: { kind: "column", column: "org_id" },
  messages: {
    kind: "parent",
    fkColumn: "conversation_id",
    parentTable: "conversations",
    parentColumn: "org_id",
  },
  semantic_entities: { kind: "column", column: "org_id" },
  learned_patterns: { kind: "column", column: "org_id" },
  // Platform-scoped settings rows have org_id NULL and are never matched.
  settings: { kind: "column", column: "org_id" },
  dashboards: { kind: "column", column: "org_id" },
  dashboard_cards: {
    kind: "parent",
    fkColumn: "dashboard_id",
    parentTable: "dashboards",
    parentColumn: "org_id",
  },
  dashboard_user_drafts: {
    kind: "parent",
    fkColumn: "dashboard_id",
    parentTable: "dashboards",
    parentColumn: "org_id",
  },
  knowledge_documents: { kind: "column", column: "workspace_id" },
  knowledge_links: {
    kind: "parent",
    fkColumn: "source_document_id",
    parentTable: "knowledge_documents",
    parentColumn: "workspace_id",
  },
  scheduled_tasks: { kind: "column", column: "org_id" },
  agent_session_memory: { kind: "column", column: "org_id" },

  // ── Stays residue (region-local; registry says NOT retained) ─────────────
  // No org column: cache keys have no org dimension, but the Slack
  // installation store rides this table with the org id in the JSONB value
  // (see the bundle-scope rationale) — scope by that expression. Generic
  // cache rows are unattributable and expire by TTL.
  chat_cache: { kind: "expression", predicate: "value->>'orgId' = $1" },
  dashboard_draft_card_cache: {
    kind: "parent",
    fkColumn: "dashboard_id",
    parentTable: "dashboards",
    parentColumn: "org_id",
  },
  scheduled_task_runs: {
    kind: "parent",
    fkColumn: "task_id",
    parentTable: "scheduled_tasks",
    parentColumn: "org_id",
  },
  agent_runs: { kind: "column", column: "org_id" },
  knowledge_sync_credentials: { kind: "column", column: "workspace_id" },
  knowledge_sync_state: { kind: "column", column: "workspace_id" },
  semantic_entity_versions: { kind: "column", column: "org_id" },
  semantic_profile_status: { kind: "column", column: "org_id" },
  connection_profile_state: { kind: "column", column: "org_id" },
  learned_pattern_injections: { kind: "column", column: "org_id" },
  query_suggestions: { kind: "column", column: "org_id" },
  suggestion_user_clicks: {
    kind: "parent",
    fkColumn: "suggestion_id",
    parentTable: "query_suggestions",
    parentColumn: "org_id",
  },
  // No FK to conversations (plain index), so the parent-first phase ordering
  // is what guarantees these rows are matched before conversations vanish.
  slack_threads: {
    kind: "parent",
    fkColumn: "conversation_id",
    parentTable: "conversations",
    parentColumn: "org_id",
  },
  action_log: { kind: "column", column: "org_id" },
  audit_log: { kind: "column", column: "org_id" },
  admin_action_log: { kind: "column", column: "org_id" },
  token_usage: { kind: "column", column: "org_id" },
  usage_events: { kind: "column", column: "workspace_id" },
  usage_summaries: { kind: "column", column: "workspace_id" },
  overage_meter_reports: { kind: "column", column: "org_id" },
  pii_column_classifications: { kind: "column", column: "org_id" },
  backups: {
    kind: "none",
    reason:
      "Backup artifacts are instance-level (no workspace column) — rotated by the backup retention policy, not attributable to one org.",
  },
  backup_config: {
    kind: "none",
    reason: "Single-row instance backup schedule — no workspace dimension.",
  },
  connection_group_descriptions: { kind: "column", column: "org_id" },
  workspace_plugins: { kind: "column", column: "workspace_id" },
  plugin_settings: { kind: "column", column: "org_id" },
  integration_credentials: { kind: "column", column: "workspace_id" },
  twenty_integrations: { kind: "column", column: "workspace_id" },
  discord_installations: { kind: "column", column: "org_id" },
  github_installations: { kind: "column", column: "org_id" },
  linear_installations: { kind: "column", column: "org_id" },
  email_installations: { kind: "column", column: "org_id" },
  sandbox_credentials: { kind: "column", column: "org_id" },
  sso_providers: { kind: "column", column: "org_id" },
  scim_group_mappings: { kind: "column", column: "org_id" },
  custom_domains: { kind: "column", column: "workspace_id" },
  ip_allowlist: { kind: "column", column: "org_id" },
  custom_roles: { kind: "column", column: "org_id" },
  workspace_branding: { kind: "column", column: "org_id" },
  workspace_model_config: { kind: "column", column: "org_id" },
  workspace_model_catalog: { kind: "column", column: "org_id" },
  mcp_action_policy: { kind: "column", column: "org_id" },
  approval_rules: { kind: "column", column: "org_id" },
  approval_queue: { kind: "column", column: "org_id" },
  prompt_collections: { kind: "column", column: "org_id" },
  prompt_items: {
    kind: "parent",
    fkColumn: "collection_id",
    parentTable: "prompt_collections",
    parentColumn: "org_id",
  },
  user_favorite_prompts: { kind: "column", column: "org_id" },
  // The OAuth client's `reference_id` claim IS the workspace/org id (see
  // lib/auth/oauth-workspace-grants.ts).
  oauth_client_rate_limits: { kind: "column", column: "reference_id" },
  oauth_client_workspace_scope: { kind: "column", column: "reference_id" },
  oauth_client_workspace_grants: { kind: "column", column: "workspace_id" },
  audit_retention_config: { kind: "column", column: "org_id" },
  admin_action_retention_config: { kind: "column", column: "org_id" },
  sla_thresholds: { kind: "column", column: "workspace_id" },
  sla_metrics: { kind: "column", column: "workspace_id" },
  sla_alerts: { kind: "column", column: "workspace_id" },
  workspace_proactive_config: { kind: "column", column: "workspace_id" },
  channel_proactive_config: { kind: "column", column: "workspace_id" },
  proactive_pauses: { kind: "column", column: "workspace_id" },
  proactive_meter_events: { kind: "column", column: "workspace_id" },
  proactive_classification_review: { kind: "column", column: "workspace_id" },
  proactive_public_dataset: { kind: "column", column: "workspace_id" },
} satisfies Readonly<Record<CleanupScopedTable, CleanupRule>>;

/** A deletable statement derived from one rule (rules of kind "none" yield none). */
export interface CleanupStatement {
  readonly table: string;
  /** Parameterized DELETE with `$1` = the migrated org/workspace id. */
  readonly sql: string;
}

/**
 * Build the ordered DELETE statements for one org's cleanup. Parent-scoped
 * rules run first (their subqueries need the parent rows to still exist —
 * see `slack_threads`); the one expression rule rides the same phase for
 * simplicity. The direct-column phase then deletes the parents themselves.
 * Within the column phase, ordering doesn't matter: every FK between
 * in-scope tables is `ON DELETE CASCADE` (or `SET NULL` for
 * `conversations.bound_dashboard_id`), so no column-phase delete can be
 * blocked by remaining child rows — pinned against real Postgres by
 * `migrate-roundtrip-pg.test.ts`. Exported for the tripwire + PG tests.
 */
export function buildCleanupStatements(): readonly CleanupStatement[] {
  const first: CleanupStatement[] = [];
  const second: CleanupStatement[] = [];
  for (const [table, rule] of Object.entries<CleanupRule>(CLEANUP_TABLE_RULES)) {
    switch (rule.kind) {
      case "parent":
        first.push({
          table,
          sql: `DELETE FROM ${table} WHERE ${rule.fkColumn} IN (SELECT id FROM ${rule.parentTable} WHERE ${rule.parentColumn} = $1)`,
        });
        break;
      case "expression":
        first.push({ table, sql: `DELETE FROM ${table} WHERE ${rule.predicate}` });
        break;
      case "column":
        second.push({ table, sql: `DELETE FROM ${table} WHERE ${rule.column} = $1` });
        break;
      case "none":
        // intentionally no statement: no org dimension to scope a delete by
        break;
      default:
        // Exhaustiveness guard: a new CleanupRule kind must decide its
        // statement shape here, or the table would silently miss cleanup.
        rule satisfies never;
        break;
    }
  }
  return [...first, ...second];
}

// ---------------------------------------------------------------------------
// Per-migration cleanup
// ---------------------------------------------------------------------------

/** Outcome of one migration's cleanup attempt. */
export type SourceCleanupResult =
  | { readonly outcome: "cleaned"; readonly deletedRows: number }
  /** Another instance already cleaned it, or the row is no longer eligible. */
  | { readonly outcome: "already_resolved" }
  /**
   * The workspace is homed in the source region again (cutover guard) — the
   * delete would destroy live data. Permanently resolved as skipped; a later
   * migration away from this region gets its own row and its own cleanup.
   */
  | { readonly outcome: "workspace_active_in_source" }
  /**
   * The organization row exists but its `region` is NULL/unreadable — an
   * ambiguous home we refuse to delete against (fail closed). NOT resolved:
   * no stamp, the row stays due and is re-attempted (and re-warned) every
   * sweep until an operator fixes the organization row.
   */
  | { readonly outcome: "organization_region_unknown" };

/**
 * Delete one migrated workspace's source-region residue, transactionally.
 * See the module doc for the safety/retry contract.
 */
export async function cleanupMigrationSourceData(migration: {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceRegion: string;
}): Promise<SourceCleanupResult> {
  const { id: migrationId, workspaceId, sourceRegion } = migration;
  const pool = getInternalDB();
  const client = await pool.connect();
  // Set when ROLLBACK itself fails: passed to `release()` so the pool
  // destroys the connection instead of handing a possibly-aborted
  // transaction to an unrelated later query.
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    // Bound the FOR UPDATE waits: without this, a wedged transaction holding
    // the organization row would hang the tick forever — the fiber would
    // stop ticking with no error and no span (absence-only signal). With it,
    // a stuck lock surfaces as a tick failure → warn + span ERROR + retry.
    await client.query("SET LOCAL lock_timeout = '10s'");

    // Re-check eligibility under a row lock — the loser of a concurrent
    // sweep (multi-instance deploy) sees the winner's stamp and skips.
    const rows = await client.query(
      `SELECT status, source_cleaned_at FROM region_migrations WHERE id = $1 FOR UPDATE`,
      [migrationId],
    );
    const row = rows.rows[0];
    if (!row || row.status !== "completed" || row.source_cleaned_at !== null) {
      await client.query("ROLLBACK");
      return { outcome: "already_resolved" };
    }

    // Cutover guard: never delete a workspace that is homed HERE. After a
    // normal cutover the source DB's organization row points at the target
    // region; if it points at the source region again (e.g. the workspace
    // migrated back before this cleanup ran), the "residue" is live data.
    // `FOR UPDATE` pins the verdict to the deletes: a concurrent cutover
    // UPDATE on this row blocks until this transaction finishes, so the
    // region we checked is the region the deletes run against.
    // A missing organization row means the workspace was deleted entirely —
    // removing its residue is exactly what we want, so proceed.
    const org = await client.query(
      `SELECT region FROM organization WHERE id = $1 FOR UPDATE`,
      [workspaceId],
    );
    const orgRow = org.rows[0];
    if (orgRow) {
      if (orgRow.region === sourceRegion) {
        await client.query(
          `UPDATE region_migrations SET source_cleaned_at = NOW() WHERE id = $1`,
          [migrationId],
        );
        await client.query("COMMIT");
        log.warn(
          { migrationId, workspaceId, sourceRegion },
          "Source cleanup skipped — workspace is homed in the source region again; residue is live data",
        );
        logCleanupEvent("region_migration_source_cleanup_skipped", migrationId, {
          workspaceId,
          sourceRegion,
          reason: "workspace_active_in_source_region",
        });
        return { outcome: "workspace_active_in_source" };
      }
      if (typeof orgRow.region !== "string" || orgRow.region.trim() === "") {
        // Fail closed on ambiguity: an organization row with region NULL,
        // empty, or any non-string value doesn't prove the workspace moved
        // away, and the only irreversible mistake here is deleting live
        // data. (Region names are free strings across residency/, so a full
        // membership check isn't possible here — NULL/empty is the
        // detectable ambiguity.) No stamp — the row stays due, so the state
        // stays visible (re-warned every sweep) until an operator resolves
        // the organization row.
        await client.query("ROLLBACK");
        log.warn(
          { migrationId, workspaceId, sourceRegion, region: orgRow.region ?? null },
          "Source cleanup refused — organization.region is NULL/empty/unreadable; leaving the migration due",
        );
        return { outcome: "organization_region_unknown" };
      }
    }

    const deletedByTable: Record<string, number> = {};
    let deletedRows = 0;
    for (const stmt of buildCleanupStatements()) {
      const result = await client.query(stmt.sql, [workspaceId]);
      if (result.rowCount === undefined || result.rowCount === null) {
        // Real pg always reports rowCount for DELETE; a client that doesn't
        // degrades the deletion audit (not the deletes) — make that visible.
        log.debug(
          { migrationId, table: stmt.table },
          "DELETE reported no rowCount — deletion audit counts will under-report",
        );
      }
      const count = result.rowCount ?? 0;
      if (count > 0) deletedByTable[stmt.table] = count;
      deletedRows += count;
    }

    await client.query(
      `UPDATE region_migrations SET source_cleaned_at = NOW() WHERE id = $1`,
      [migrationId],
    );
    await client.query("COMMIT");

    logCleanupEvent("region_migration_source_cleaned", migrationId, {
      workspaceId,
      sourceRegion,
      deletedRows,
      deletedByTable,
    });
    log.info(
      { migrationId, workspaceId, sourceRegion, deletedRows },
      "Source-region data cleanup completed",
    );
    return { outcome: "cleaned", deletedRows };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      log.error(
        { err: broken.message, migrationId },
        "Source cleanup rollback failed — destroying the connection instead of pooling it",
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    client.release(broken);
  }
}

// ---------------------------------------------------------------------------
// The sweep — tick body of the `region_migration_source_cleanup` fiber
// ---------------------------------------------------------------------------

/**
 * One sweep's outcome, attached to the fiber's per-tick span. The buckets
 * partition the due set together with the implicit failure remainder:
 * `cleaned + skipped + blocked + <failed> === due`.
 */
export interface SweepSummary {
  readonly due: number;
  /** Deleted + stamped. */
  readonly cleaned: number;
  /** RESOLVED without deleting (already stamped, or cutover-guard stamp). */
  readonly skipped: number;
  /**
   * NOT resolved and NOT attempted/completed by design: region-identity
   * mismatch or an ambiguous organization row. These stay due — a non-zero
   * value that persists across sweeps is an operator signal.
   */
  readonly blocked: number;
}

/**
 * Clean every migration whose grace period has elapsed.
 *
 * Returns the buckets separately so the fiber's span can distinguish
 * "nothing owed" from "owed but not done". Mirrors the sibling
 * `failStaleMigrations` contract: throws when attempts FAILED outright and
 * nothing succeeded or resolved — that tick must surface as span ERROR +
 * warn, not a quiet zero. Guard-blocked rows don't suppress the throw (they
 * are counted, not treated as success), and partial failure stays
 * non-throwing: the per-migration error is logged and the next sweep
 * retries the stragglers.
 */
export async function runSourceCleanupSweep(): Promise<SweepSummary> {
  if (!hasInternalDB()) return { due: 0, cleaned: 0, skipped: 0, blocked: 0 };

  const due = await getCleanupDueMigrations();
  if (due.length === 0) return { due: 0, cleaned: 0, skipped: 0, blocked: 0 };

  const apiRegion = getApiRegion();
  if (apiRegion === null) {
    // Single-instance / self-hosted deploys have no region identity — the
    // cutover guard inside each cleanup is the remaining check. Record that
    // a destructive sweep is running without the region-identity guard.
    log.info(
      { due: due.length },
      "Region identity unresolved (no ATLAS_API_REGION / residency.defaultRegion) — cleaning without the region-identity guard",
    );
  }
  let cleaned = 0;
  let skipped = 0;
  let blocked = 0;
  for (const migration of due) {
    // Region identity guard: a process that knows its region only cleans its
    // own rows. In the 3-region deploy each region's internal DB holds only
    // its own migrations, so a mismatch here means misconfiguration — warn
    // and leave the row alone (it stays due; nothing is deleted).
    if (apiRegion !== null && migration.sourceRegion !== apiRegion) {
      blocked++;
      log.warn(
        { migrationId: migration.id, sourceRegion: migration.sourceRegion, apiRegion },
        "Source cleanup blocked — migration's source region does not match this instance's region identity",
      );
      continue;
    }
    try {
      const result = await cleanupMigrationSourceData(migration);
      switch (result.outcome) {
        case "cleaned":
          cleaned++;
          break;
        case "already_resolved":
        case "workspace_active_in_source":
          skipped++;
          break;
        case "organization_region_unknown":
          blocked++;
          break;
        default:
          result satisfies never;
          break;
      }
    } catch (err) {
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          migrationId: migration.id,
          workspaceId: migration.workspaceId,
        },
        "Source-region cleanup failed for migration — rolled back, will retry next sweep",
      );
    }
  }

  const failed = due.length - cleaned - skipped - blocked;
  if (failed > 0 && cleaned === 0 && skipped === 0) {
    throw new Error(
      `Found ${due.length} region migration(s) due for source cleanup but every attempt failed — migrated workspace data persists in the source region`,
    );
  }

  return { due: due.length, cleaned, skipped, blocked };
}
