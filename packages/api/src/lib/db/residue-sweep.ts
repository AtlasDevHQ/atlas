/**
 * Orphaned-workspace residue sweep (#5185) — the mechanism `platform-admin.mdx`
 * §Residue prescribed and nothing implemented.
 *
 * Residue is tenant data whose `organization` row is already gone: rows a purge
 * left behind because their table entered the purge path later. The normal
 * purge cannot reach them — `hardDeleteWorkspace` requires the workspace to
 * exist and be soft-deleted, and answers `409` otherwise — so residue needs its
 * own mechanism. The runbook forbade hand-running the delete and named a
 * double-gated operator command to run instead; that command did not exist, so
 * the only forbidden path was also the only available one.
 *
 * Two properties do the work here, and both are about NOT trusting a list:
 *
 *  1. **The candidate table set is derived from `PURGE_TABLE_DECISIONS`**, not
 *     hand-written. Only `decision: "purged"` tables are candidates: an
 *     `anonymized` row is meant to survive (`admin_action_log`), a `retained`
 *     one is load-bearing (`user_trial_grants`, `stripe_teardown_pending`), and
 *     a `user_scoped` one belongs to the orphaned-user arm. The docs section
 *     this replaces carried a four-table hand-written query that returned 0
 *     rows in all three prod regions while genuine residue sat in three tables
 *     it did not name.
 *  2. **A scope value that matches no organization is NOT automatically tenant
 *     data.** Sentinel scope values are not organization ids, so
 *     `NOT EXISTS (… o.id = t.scope)` is true for them and they are reported
 *     identically to real residue. Of the 9 rows the 2026-08-12 prod sweep
 *     flagged, 8 were sentinels — `_default` (the deployment-wide default SLA
 *     tier, in all three regions), `<atlas-operator>` (`crm_outbox`), and the
 *     empty string (`admin_action_log`). Deleting the first would destroy SLA
 *     defaults for every workspace. {@link classifyScopeValue} is the guard,
 *     and it is the whole risk of this command.
 *
 * Nothing is filtered silently. Every table that drops out of the sweep and
 * every value withheld from deletion is carried in the report with its reason,
 * because the operator's next move depends on WHY a thing was skipped: an
 * absent relation means run the migrations, a missing scope column means resolve
 * it through the parent, and a withheld sentinel means leave it alone.
 */

import { PURGE_TABLE_DECISIONS, PURGED_TABLES, WORKSPACE_SCOPE_COLUMNS } from "./purge-scope";

/** Minimal row-returning query surface — `internalQuery` or a test fake. */
export type ResidueQuery = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/**
 * Postgres identifier quoting — doubles any embedded `"` and wraps in `"`.
 *
 * Every identifier interpolated below comes from `information_schema` (a system
 * catalog), never from operator input, and is quoted here all the same.
 * `commands/operator/ops.ts` carries the same three lines for the wipe path;
 * they are not shared because `@atlas/cli` depends on `@atlas/api` and not the
 * reverse, and importing a residue module into the wipe path to save three
 * lines would be the wrong dependency.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Scope-column data types the sweep can compare against `organization.id`.
 *
 * The filter is load-bearing: a scope column of another type makes the orphan
 * test abort the whole statement (`operator does not exist: text = integer`),
 * which is why the runbook query carries the same list. `uuid` is included
 * because the comparison casts both sides to text, so a uuid scope column
 * compares cleanly rather than erroring — it simply never matches a text
 * organization id, which is the correct answer for it.
 */
export const SWEEPABLE_SCOPE_TYPES: readonly string[] = [
  "text",
  "character varying",
  "uuid",
];

/** A known sentinel scope value and why deleting it would be wrong. */
export interface ScopeSentinel {
  readonly value: string;
  readonly reason: string;
}

/**
 * Scope values that are NOT organization ids, observed in prod on 2026-08-12.
 *
 * This denylist is checked FIRST so each known sentinel reports its own reason
 * rather than the generic structural one below. That ordering is the whole
 * reason the denylist is testable: the structural rules happen to withhold all
 * three of these too, so a test asserting only "it was not deleted" would pass
 * with the denylist deleted. `residue-sweep.test.ts` asserts the REASON.
 */
export const SCOPE_SENTINELS: readonly ScopeSentinel[] = [
  {
    value: "_default",
    reason:
      "`_default` is the deployment-wide default tier row (sla_thresholds), shared by every workspace — deleting it destroys SLA defaults for the whole region.",
  },
  {
    value: "<atlas-operator>",
    reason:
      "`<atlas-operator>` is the operator attribution sentinel `crm_outbox.workspace_id` defaults to (migration 0106) — operator-originated events with no tenant behind them.",
  },
  {
    value: "",
    reason:
      "an empty scope value marks a deployment-scoped row (e.g. `admin_action_log`'s `brain.extraction_cycle` and `oauth_token.refresh` entries), not a workspace.",
  },
];

/** Whether a scope value may be deleted, and when not, why not. */
export type ScopeValueVerdict =
  | { readonly kind: "residue" }
  | { readonly kind: "withheld"; readonly reason: string };

/**
 * Decide whether a scope value that matches no `organization` row is genuine
 * tenant residue or a sentinel that merely looks like one.
 *
 * Every arm below can only WITHHOLD — the failure mode this guard exists to
 * prevent is deleting deployment-wide config, so an unrecognized value is
 * reported for an operator to resolve rather than swept. Three of the arms
 * generalise beyond the values actually seen in prod, deliberately: the
 * denylist can only ever name sentinels someone has already been bitten by.
 */
export function classifyScopeValue(value: string): ScopeValueVerdict {
  const sentinel = SCOPE_SENTINELS.find((s) => s.value === value);
  if (sentinel) return { kind: "withheld", reason: sentinel.reason };

  if (value.trim() === "") {
    return {
      kind: "withheld",
      reason: "whitespace-only scope value — not a workspace id.",
    };
  }
  if (value.startsWith("_")) {
    return {
      kind: "withheld",
      reason:
        "a leading `_` marks a deployment-wide sentinel by convention (the `_default` class); workspace ids never start with one.",
    };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return {
      kind: "withheld",
      reason:
        "not the shape of a workspace id (contains characters outside [A-Za-z0-9_-]) — treated as an unrecognized sentinel.",
    };
  }
  return { kind: "residue" };
}

/** A (table, scope column) pair the sweep will interrogate. */
export interface ResidueTarget {
  readonly table: string;
  readonly column: string;
}

/** Something the sweep did not interrogate, and why. `column` is null for a
 *  table-level skip (the whole relation dropped out). */
export interface ResidueSkip {
  readonly table: string;
  readonly column: string | null;
  readonly reason: string;
}

interface SchemaColumnRow extends Record<string, unknown> {
  table_name: string;
  column_name: string;
  data_type: string;
}

interface SchemaTableRow extends Record<string, unknown> {
  table_name: string;
}

/**
 * Resolve which `purged` tables this region's schema can actually be swept for,
 * pairing each with its workspace scope column(s).
 *
 * A table can drop out three ways and each gets its own reason, because they
 * imply different operator responses: an absent relation means the region is
 * behind on migrations, a scope column of the wrong type means the comparison
 * cannot be made, and no scope column at all means the purge reaches the table
 * through a parent subquery or an expression predicate — so its residue has to
 * be resolved through that parent. The registry's own reason is quoted for that
 * last case, since it is where the parent path is documented.
 */
export async function discoverResidueTargets(
  query: ResidueQuery,
): Promise<{ targets: ResidueTarget[]; skipped: ResidueSkip[] }> {
  // Entries rather than `PURGED_TABLES` alone: membership still comes from that
  // set, but each candidate carries its registry reason so the no-scope-column
  // skip below can quote it without a second lookup keyed on a widened string.
  const candidates = Object.entries(PURGE_TABLE_DECISIONS)
    .filter(([table]) => PURGED_TABLES.has(table))
    .map(([table, scope]) => ({ table, registryReason: scope.reason }))
    .sort((a, b) => a.table.localeCompare(b.table));
  const candidateNames = candidates.map((c) => c.table);

  const presentRows = await query<SchemaTableRow>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name = ANY($1)`,
    [candidateNames],
  );
  const present = new Set(presentRows.map((r) => r.table_name));

  const columnRows = await query<SchemaColumnRow>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1)
        AND column_name = ANY($2)
      ORDER BY table_name, column_name`,
    [candidateNames, [...WORKSPACE_SCOPE_COLUMNS]],
  );
  const byTable = new Map<string, SchemaColumnRow[]>();
  for (const row of columnRows) {
    const list = byTable.get(row.table_name);
    if (list) list.push(row);
    else byTable.set(row.table_name, [row]);
  }

  const targets: ResidueTarget[] = [];
  const skipped: ResidueSkip[] = [];

  for (const { table, registryReason } of candidates) {
    if (!present.has(table)) {
      skipped.push({
        table,
        column: null,
        reason:
          "relation absent from this region's schema — nothing to sweep. Run the region's migrations and re-run.",
      });
      continue;
    }

    const columns = byTable.get(table) ?? [];
    if (columns.length === 0) {
      skipped.push({
        table,
        column: null,
        reason:
          "no workspace scope column — the purge reaches this table through a parent subquery or an expression predicate, so residue in it must be resolved through that parent. Registry note: " +
          registryReason,
      });
      continue;
    }

    for (const col of columns) {
      if (!SWEEPABLE_SCOPE_TYPES.includes(col.data_type)) {
        skipped.push({
          table,
          column: col.column_name,
          reason: `scope column has data type "${col.data_type}"; the orphan test compares against organization.id, and only ${SWEEPABLE_SCOPE_TYPES.join(" / ")} columns are swept.`,
        });
        continue;
      }
      targets.push({ table, column: col.column_name });
    }
  }

  return { targets, skipped };
}

/** One distinct scope value with no matching `organization` row, and its count. */
export interface OrphanValue {
  readonly table: string;
  readonly column: string;
  readonly value: string;
  readonly rows: number;
}

/** An orphan value the sweep refuses to delete, with the reason. */
export interface WithheldValue extends OrphanValue {
  readonly reason: string;
}

/**
 * Enumerate the distinct orphan scope values per target, with row counts.
 *
 * Values are enumerated rather than deleted by predicate on purpose: the delete
 * names the exact values the report showed the operator, so what is printed and
 * what is destroyed cannot diverge.
 *
 * Both sides of the comparison are cast to text so a uuid scope column compares
 * instead of aborting the statement. A per-target failure is recorded as a skip
 * and the sweep continues — one unreadable table must not cost the whole run.
 */
export async function enumerateOrphanValues(
  query: ResidueQuery,
  targets: readonly ResidueTarget[],
): Promise<{ orphans: OrphanValue[]; skipped: ResidueSkip[] }> {
  const orphans: OrphanValue[] = [];
  const skipped: ResidueSkip[] = [];

  for (const target of targets) {
    const table = quoteIdent(target.table);
    const column = quoteIdent(target.column);
    try {
      const rows = await query<{ scope_value: string; row_count: string }>(
        `SELECT t.${column}::text AS scope_value, count(*)::text AS row_count
           FROM public.${table} t
          WHERE t.${column} IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM public.organization o WHERE o.id = t.${column}::text
            )
          GROUP BY 1
          ORDER BY 2 DESC, 1`,
      );
      for (const row of rows) {
        orphans.push({
          table: target.table,
          column: target.column,
          value: row.scope_value,
          rows: Number.parseInt(row.row_count, 10),
        });
      }
    } catch (err) {
      skipped.push({
        table: target.table,
        column: target.column,
        reason: `orphan query failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { orphans, skipped };
}

/** The deletion list and the withheld list, split by {@link classifyScopeValue}. */
export interface ResiduePlan {
  readonly deletable: readonly OrphanValue[];
  readonly withheld: readonly WithheldValue[];
}

/** Split enumerated orphans into what may be deleted and what is withheld. */
export function planResidueSweep(orphans: readonly OrphanValue[]): ResiduePlan {
  const deletable: OrphanValue[] = [];
  const withheld: WithheldValue[] = [];
  for (const orphan of orphans) {
    const verdict = classifyScopeValue(orphan.value);
    if (verdict.kind === "residue") deletable.push(orphan);
    else withheld.push({ ...orphan, reason: verdict.reason });
  }
  return { deletable, withheld };
}

/** One executed delete: the exact values named, and what it actually removed. */
export interface ResidueDeletion {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
  /** Rows the enumeration pass counted. */
  readonly expectedRows: number;
  /** Rows the DELETE actually removed — a mismatch means concurrent writes. */
  readonly deletedRows: number;
}

/** A delete that could not be made, with the Postgres message. */
export interface ResidueDeleteError {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
  readonly message: string;
}

interface DeleteGroup {
  readonly table: string;
  readonly column: string;
  readonly values: string[];
  readonly expectedRows: number;
}

/** Group the deletable values into one statement per (table, column). */
function groupDeletions(deletable: readonly OrphanValue[]): DeleteGroup[] {
  const groups = new Map<string, DeleteGroup>();
  for (const orphan of deletable) {
    const key = `${orphan.table} ${orphan.column}`;
    const existing = groups.get(key);
    if (existing) {
      existing.values.push(orphan.value);
      groups.set(key, { ...existing, expectedRows: existing.expectedRows + orphan.rows });
    } else {
      groups.set(key, {
        table: orphan.table,
        column: orphan.column,
        values: [orphan.value],
        expectedRows: orphan.rows,
      });
    }
  }
  return [...groups.values()];
}

/**
 * Delete the planned values, retrying to a fixed point.
 *
 * The retry exists because several `purged` tables reference each other under
 * RESTRICT — `brain_facts` → `brain_episodes` and `brain_vocabulary_target` →
 * `brain_vocabulary_edge` are the documented pairs — so a delete order that is
 * wrong for one pair aborts that statement. Rather than encode a second copy of
 * the purge's ordering (which would drift from it), each statement is attempted
 * and any that fail are retried while at least one other is still making
 * progress. A pass where nothing succeeds is the fixed point: whatever is still
 * failing is reported with its Postgres message.
 *
 * Each DELETE is its own implicit transaction. Nothing here is atomic across
 * tables by design — a residue sweep is a cleanup, the operator has taken a
 * `pg_dump`, and one table's RESTRICT must not roll back the tables that
 * succeeded.
 */
export async function executeResidueDeletes(
  query: ResidueQuery,
  deletable: readonly OrphanValue[],
): Promise<{ deletions: ResidueDeletion[]; errors: ResidueDeleteError[] }> {
  const deletions: ResidueDeletion[] = [];
  const errors: ResidueDeleteError[] = [];
  let pending = groupDeletions(deletable);

  while (pending.length > 0) {
    const failures: { group: DeleteGroup; message: string }[] = [];
    let progressed = false;

    for (const group of pending) {
      const table = quoteIdent(group.table);
      const column = quoteIdent(group.column);
      try {
        const removed = await query<{ deleted: number }>(
          `DELETE FROM public.${table} WHERE ${column}::text = ANY($1) RETURNING 1 AS deleted`,
          [group.values],
        );
        deletions.push({
          table: group.table,
          column: group.column,
          values: group.values,
          expectedRows: group.expectedRows,
          deletedRows: removed.length,
        });
        progressed = true;
      } catch (err) {
        failures.push({
          group,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failures.length === 0) break;
    if (!progressed) {
      for (const failure of failures) {
        errors.push({
          table: failure.group.table,
          column: failure.group.column,
          values: failure.group.values,
          message: failure.message,
        });
      }
      break;
    }
    // At least one statement succeeded, so `pending` strictly shrinks and the
    // loop terminates. A retry may now clear a RESTRICT its sibling was holding.
    pending = failures.map((f) => f.group);
  }

  return { deletions, errors };
}

/** Everything the sweep looked at, refused, removed, or failed on. */
export interface ResidueSweepReport {
  readonly dryRun: boolean;
  /** `purged` tables in the registry — the population before any narrowing. */
  readonly tablesConsidered: number;
  readonly targets: readonly ResidueTarget[];
  readonly skipped: readonly ResidueSkip[];
  readonly withheld: readonly WithheldValue[];
  /** Populated on a DRY RUN: what an EXECUTE would remove. */
  readonly wouldDelete: readonly OrphanValue[];
  /** Populated on EXECUTE. */
  readonly deletions: readonly ResidueDeletion[];
  readonly errors: readonly ResidueDeleteError[];
  readonly totals: {
    readonly rowsWouldDelete: number;
    readonly rowsDeleted: number;
    readonly rowsWithheld: number;
    readonly tablesSkipped: number;
    readonly errors: number;
  };
}

/**
 * Run the sweep end to end against one region's internal DB.
 *
 * DRY RUN enumerates and classifies but issues no DELETE; the caller's gate
 * decides which mode this is, so a gate-less invocation previews rather than
 * deletes.
 */
export async function sweepResidue(
  query: ResidueQuery,
  options: { readonly dryRun: boolean },
): Promise<ResidueSweepReport> {
  const { targets, skipped: discoverySkips } = await discoverResidueTargets(query);
  const { orphans, skipped: querySkips } = await enumerateOrphanValues(query, targets);
  const { deletable, withheld } = planResidueSweep(orphans);

  const skipped = [...discoverySkips, ...querySkips];
  const rowsWithheld = withheld.reduce((n, w) => n + w.rows, 0);
  const tablesSkipped = new Set(skipped.map((s) => s.table)).size;

  if (options.dryRun) {
    return {
      dryRun: true,
      tablesConsidered: PURGED_TABLES.size,
      targets,
      skipped,
      withheld,
      wouldDelete: deletable,
      deletions: [],
      errors: [],
      totals: {
        rowsWouldDelete: deletable.reduce((n, d) => n + d.rows, 0),
        rowsDeleted: 0,
        rowsWithheld,
        tablesSkipped,
        errors: 0,
      },
    };
  }

  const { deletions, errors } = await executeResidueDeletes(query, deletable);
  return {
    dryRun: false,
    tablesConsidered: PURGED_TABLES.size,
    targets,
    skipped,
    withheld,
    wouldDelete: [],
    deletions,
    errors,
    totals: {
      rowsWouldDelete: 0,
      rowsDeleted: deletions.reduce((n, d) => n + d.deletedRows, 0),
      rowsWithheld,
      tablesSkipped,
      errors: errors.length,
    },
  };
}
