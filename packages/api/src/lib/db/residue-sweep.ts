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
 * Three properties do the work here, and all three are about NOT trusting
 * something that looks trustworthy:
 *
 *  1. **The candidate table set is derived from `PURGE_TABLE_DECISIONS`**, not
 *     hand-written. Only `decision: "purged"` tables are candidates: an
 *     `anonymized` row is meant to survive (`admin_action_log`), a `retained`
 *     one is load-bearing (`user_trial_grants`, `stripe_teardown_pending`), and
 *     a `user_scoped` one belongs to the orphaned-user arm. This is the same
 *     lesson the docs section learned one issue earlier: until #5184 it carried
 *     a four-table HAND-WRITTEN query that returned 0 rows in all three prod
 *     regions while genuine residue sat in three tables it did not name. #5184
 *     made the detection query self-discovering; this module makes the DELETE a
 *     command, and derives its table set the same way.
 *  2. **A scope value that matches no organization is NOT automatically tenant
 *     data.** Sentinel scope values are not organization ids, so
 *     `NOT EXISTS (… o.id = t.scope)` is true for them and they are reported
 *     identically to real residue. Of the 9 rows the 2026-08-12 **diagnostic
 *     query** flagged — a wider instrument than this command, since it scans
 *     every org-scoped column rather than the `purged` set — 8 were sentinels:
 *     `_default` (the deployment-wide default SLA tier, in all three regions),
 *     `<atlas-operator>` (`crm_outbox`), and the empty string
 *     (`admin_action_log`, which this sweep never reads). Deleting the first
 *     would destroy SLA defaults for every workspace. {@link classifyScopeValue} is that guard,
 *     and {@link DeletableValue} is what makes it unskippable: withheld values
 *     are not assignable to {@link executeResidueDeletes}, so
 *     `execute(…, plan.withheld)` — a one-identifier slip that would delete
 *     ONLY the sentinels — does not compile.
 *  3. **The orphan predicate is only meaningful if `organization` is
 *     populated.** `organization` is a Better Auth table and is NOT created by
 *     Atlas migrations, so "the Atlas schema is here" does not imply "the orgs
 *     are here": a partial restore, a scratch DB, a passive region
 *     mid-provision, or a `--database-url` typo all produce a schema with an
 *     empty one. There, `NOT EXISTS` is true for every row in every table and
 *     the "residue" is the entire tenant dataset.
 *     {@link assertOrganizationPopulated} refuses rather than sweeping, and
 *     {@link checkResidueBlastRadius} caps how many workspaces one EXECUTE may
 *     touch — the same guard `ops teardown-verify-accounts` carries as
 *     `checkBlastRadius`, for the same reason, on a strictly less destructive
 *     command.
 *
 * Nothing is filtered silently, and the distinction that matters most is
 * **"not applicable" vs "we tried and could not read it"**. A table absent from
 * the schema is benign; a table the sweep could not read has an UNKNOWN residue
 * state and must not be reported as clean. {@link ResidueSkip} discriminates on
 * `kind` rather than on prose, so the exit code, the printer and any future
 * consumer can tell those apart without substring-matching English.
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
 * Every identifier interpolated below comes from a system catalog, never from
 * operator input, and is quoted here all the same.
 * `commands/operator/ops.ts` carries the same three lines for the wipe path;
 * they are not shared because `@atlas/cli` depends on `@atlas/api` and not the
 * reverse, and importing a residue module into the wipe path to save three
 * lines would be the wrong dependency.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Scope-column data types the sweep will compare against `organization.id`.
 *
 * The filter is load-bearing: a scope column of another type makes the orphan
 * test abort the whole statement (`operator does not exist: text = integer`),
 * which is why the runbook query carries the same list.
 *
 * ⚠️ **`uuid` is deliberately NOT here, though the runbook's diagnostic query
 * allows it.** For a query that only REPORTS, "a uuid never equals a text
 * organization id" is a harmless answer. For a DELETE it means *every row in
 * that table is an orphan* — and a uuid string passes the id-shape arm of
 * {@link classifyScopeValue}, so the whole table would be swept. No `purged`
 * table has a uuid scope column today (measured 2026-08-12 across all 87: every
 * scope column is `text`); if one ever does it falls into the
 * `unsweepable-type` skip, and the operator hears about it instead of losing
 * the table.
 */
export const SWEEPABLE_SCOPE_TYPES: readonly string[] = ["text", "character varying"];

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
      "an empty scope value marks a row belonging to the DEPLOYMENT rather than to any workspace — `settings`' global tier is the `purged`-class example. It was first seen in `admin_action_log` (`brain.extraction_cycle`, `oauth_token.refresh`), which this sweep never reads because it is `anonymized`; the diagnostic runbook query is wider than this command.",
  },
];

/**
 * Words a deployment-wide marker row plausibly uses, withheld on sight.
 *
 * The denylist can only ever name sentinels someone has already been bitten by,
 * and the `_`-prefix arm below catches only the `_default` subfamily. These are
 * the same class one spelling over: a future `sla_thresholds`-shaped row keyed
 * `default` or `global` is an ordinary identifier to the shape rule and would
 * be swept. Withholding one costs an operator a line of report; deleting one
 * costs the region its defaults.
 */
export const RESERVED_SCOPE_WORDS: readonly string[] = [
  "default",
  "global",
  "system",
  "all",
  "none",
  "shared",
  "platform",
  "internal",
  "operator",
  "atlas",
  "unknown",
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
 * reported for an operator to resolve rather than swept.
 *
 * ⚠️ What the `residue` verdict establishes is *shape-plausibility*, not
 * provenance: this is a lexical test and it cannot tell an organization id from
 * an id minted by another id space. What bounds that gap is
 * {@link checkResidueBlastRadius} and the fact that every value is printed
 * before it is deleted, not the classifier.
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
  if (RESERVED_SCOPE_WORDS.includes(value.toLowerCase())) {
    return {
      kind: "withheld",
      reason: `${JSON.stringify(value)} is a reserved deployment-wide marker word — it reads as an ordinary identifier but names a tier, not a workspace.`,
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

/**
 * Something the sweep did not interrogate, and why.
 *
 * ⚠️ **The discriminant is the point.** `relation-absent` / `no-scope-column` /
 * `unsweepable-type` all mean "this table was never in scope" — benign, and the
 * operator's next move is migrations or the parent table. `unreadable` means
 * the sweep TRIED and could not: no `SELECT` privilege, a lock timeout, a query
 * error, an ambiguous schema. Its residue state is UNKNOWN, and reporting it
 * beside the benign three as undifferentiated prose is how a partially-blind
 * run gets read as clean — measured as the round-1 finding on this PR, where
 * three `permission denied` tables would have produced exit 0 and a
 * "No residue found" line.
 */
export type ResidueSkip =
  | {
      readonly kind: "relation-absent";
      readonly table: string;
      readonly column: null;
      readonly reason: string;
    }
  | {
      readonly kind: "no-scope-column";
      readonly table: string;
      readonly column: null;
      readonly reason: string;
    }
  | {
      readonly kind: "unsweepable-type";
      readonly table: string;
      readonly column: string;
      readonly reason: string;
    }
  | {
      readonly kind: "unreadable";
      readonly table: string;
      readonly column: string | null;
      readonly reason: string;
    };

/**
 * True when the table was never in scope, as opposed to could not be read.
 *
 * ⚠️ **Exhaustive on purpose.** Written as `skip.kind !== "unreadable"` this
 * FAILS OPEN: a future arm — a lock timeout, a refused decision — would be
 * silently benign, exit 0, printed under "never candidates". The whole finding
 * behind `ResidueSkip`'s discriminant is that unknown must not read as clean,
 * and the helper encoding that decision must not default to clean. The switch
 * makes a new arm a compile error instead.
 */
export function isBenignSkip(skip: ResidueSkip): boolean {
  switch (skip.kind) {
    case "relation-absent":
    case "no-scope-column":
    case "unsweepable-type":
      return true;
    case "unreadable":
      return false;
  }
}

/** One catalog row: a candidate table, and one scope column of it (or none). */
interface CatalogColumnRow extends Record<string, unknown> {
  table_name: string;
  relkind: string;
  column_name: string | null;
  data_type: string | null;
}

/**
 * Relation kinds the sweep can DELETE through: an ordinary table and a
 * partitioned one. Anything else — a view, a matview, a foreign table — is
 * reported `unreadable` rather than swept or, worse, reported absent.
 */
const DELETABLE_RELKINDS: readonly string[] = ["r", "p"];

/**
 * Refuse to sweep a database whose `organization` table is empty.
 *
 * With zero organizations the orphan predicate is true for every row in every
 * purged table, and the plan becomes "delete the tenant dataset". That is
 * exactly what a wrong `--database-url`, a dump restored without the Better
 * Auth tables, or a not-yet-provisioned region looks like. This throws rather
 * than returning a report, because a preview built on a broken premise is worse
 * than no preview: an operator would read it as a genuine finding.
 *
 * ⚠️ **What this establishes is non-emptiness, NOT completeness**, and the
 * difference matters: a restore that recovered 1 organization of 5,000 passes
 * here while the orphan predicate is still trivially true for nearly
 * everything. {@link checkResidueBlastRadius} narrows that band — a plan naming
 * more than {@link MAX_RESIDUE_WORKSPACES} ids is refused on an EXECUTE and
 * flagged on a DRY RUN — but it does not
 * close it, and an earlier draft of this line said it did, which is the same
 * over-claim one guard over. **The residual, stated plainly: a partial restore
 * that lost at most {@link MAX_RESIDUE_WORKSPACES} organizations is covered by
 * NEITHER guard.** What bounds it there is the DRY RUN — every value is printed
 * before it is deleted, and a plan naming workspaces the operator recognises as
 * live is the signal no predicate here can produce.
 */
export async function assertOrganizationPopulated(query: ResidueQuery): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM public.organization`,
  );
  const n = Number.parseInt(rows[0]?.n ?? "", 10);
  if (!Number.isFinite(n)) {
    throw new Error(
      "Refusing to sweep: could not count public.organization, so the orphan predicate " +
        "cannot be evaluated at all. Re-check --region / --database-url.",
    );
  }
  if (n === 0) {
    throw new Error(
      "Refusing to sweep: public.organization has 0 rows, so EVERY workspace-scoped row " +
        "matches the orphan predicate and the whole tenant dataset would read as residue. " +
        "`organization` is a Better Auth table and is not created by Atlas migrations, so a " +
        "full Atlas schema with no orgs is a wrong-DB, partially-restored-DB, or " +
        "not-yet-provisioned-region signal. Re-check --region / --database-url.",
    );
  }
  return n;
}

/**
 * Resolve which `purged` tables this region's schema can actually be swept for,
 * pairing each with its workspace scope column.
 *
 * ⚠️ **Both presence and columns come from `pg_catalog`, NOT
 * `information_schema`.** Those views are PRIVILEGE-FILTERED — `tables` and
 * `columns` per relation AND per COLUMN — so a role without the right grant
 * simply sees no rows. An earlier revision read that as *"relation absent — run
 * the region's migrations"*; a later one fixed the relation half with
 * `to_regclass` and left the column half, where a role holding column-level
 * grants that exclude the scope column reported *"no workspace scope column —
 * the purge reaches this table through a parent subquery"*. Both diagnoses are
 * confident, specific and false, both send the operator somewhere useless, and
 * both file the table as benign so the run still exits 0.
 *
 * `pg_class` / `pg_attribute` answer regardless of privilege, so "the table
 * has no scope column" is now a structural fact rather than a privilege
 * artifact. A table the role genuinely cannot READ then fails in
 * {@link enumerateOrphanValues} and is recorded as `unreadable` — measured,
 * rather than inferred from an absence.
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

  // LEFT JOIN so a present table with no scope column still yields a row (with
  // NULL column_name) — that is how presence and scope are answered by one
  // privilege-blind query. `atttypid::regtype` gives the bare type name without
  // a typmod, so `character varying(255)` compares as `character varying`.
  const catalogRows = await query<CatalogColumnRow>(
    // relkind is SELECTED, not filtered on. Filtering it made every non-ordinary
    // relation — a partitioned table, a view, a matview — return zero rows and
    // read as `relation-absent`: "run the region's migrations", benign, exit 0.
    // That is verbatim the false-benign diagnosis this query was written to
    // remove, one arm over, and `messages` / `agent_runs` / `audit_log` are the
    // standard partition candidates.
    `SELECT c.relname AS table_name,
            c.relkind::text AS relkind,
            a.attname AS column_name,
            a.atttypid::regtype::text AS data_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       LEFT JOIN pg_attribute a
              ON a.attrelid = c.oid
             AND a.attnum > 0
             AND NOT a.attisdropped
             AND a.attname = ANY($2)
      WHERE c.relname = ANY($1)
      ORDER BY c.relname, a.attname`,
    [candidateNames, [...WORKSPACE_SCOPE_COLUMNS]],
  );
  const byTable = new Map<string, CatalogColumnRow[]>();
  for (const row of catalogRows) {
    const list = byTable.get(row.table_name);
    if (list) list.push(row);
    else byTable.set(row.table_name, [row]);
  }

  const targets: ResidueTarget[] = [];
  const skipped: ResidueSkip[] = [];

  for (const { table, registryReason } of candidates) {
    const rows = byTable.get(table);
    if (!rows) {
      skipped.push({
        kind: "relation-absent",
        table,
        column: null,
        reason:
          "relation absent from this region's schema — nothing to sweep. Run the region's migrations and re-run.",
      });
      continue;
    }

    const relkind = rows[0]?.relkind;
    if (typeof relkind !== "string" || !DELETABLE_RELKINDS.includes(relkind)) {
      skipped.push({
        kind: "unreadable",
        table,
        column: null,
        reason: `relation exists but has relkind ${JSON.stringify(relkind)} (not an ordinary or partitioned table). The sweep does not delete through views, matviews or foreign tables, so this table's residue state is UNKNOWN, not clean. Resolve it by hand.`,
      });
      continue;
    }

    // SPLIT, not filtered: a row naming a scope column whose type came
    // back in an unexpected SHAPE is not the same as a table with no scope
    // column, and silently dropping it produced the second thing while meaning
    // the first — a benign, exit-0 verdict on a table nobody looked at.
    const columns = rows.filter(
      (r): r is CatalogColumnRow & { column_name: string; data_type: string } =>
        typeof r.column_name === "string" && typeof r.data_type === "string",
    );
    const malformed = rows.filter(
      (r) => r.column_name !== null && !(typeof r.column_name === "string" && typeof r.data_type === "string"),
    );
    if (malformed.length > 0) {
      skipped.push({
        kind: "unreadable",
        table,
        column: null,
        reason: `${malformed.length} catalog row(s) for this table have an unexpected shape (column_name/data_type were not both strings), so the sweep cannot tell whether it has a scope column. Its residue state is UNKNOWN, not clean.`,
      });
      continue;
    }
    if (columns.length === 0) {
      skipped.push({
        kind: "no-scope-column",
        table,
        column: null,
        reason:
          "no workspace scope column — the purge reaches this table through a parent subquery or an expression predicate, so residue in it must be resolved through that parent. Registry note: " +
          registryReason,
      });
      continue;
    }

    for (const col of columns) {
      if (SWEEPABLE_SCOPE_TYPES.includes(col.data_type)) continue;
      skipped.push({
        kind: "unsweepable-type",
        table,
        column: col.column_name,
        reason: `scope column has data type "${col.data_type}"; the orphan test compares against organization.id, and only ${SWEEPABLE_SCOPE_TYPES.join(" / ")} columns are swept.`,
      });
    }

    const sweepable = columns.filter((c) => SWEEPABLE_SCOPE_TYPES.includes(c.data_type));
    // Two sweepable scope columns on one table would produce two independent
    // DELETEs, and a row orphaned on column A but pointing at a LIVE workspace
    // through column B would be destroyed on A's verdict alone. No `purged`
    // table has two today (measured 2026-08-12 across all 87); if one appears
    // through schema drift in a single region, refuse it rather than guess.
    if (sweepable.length > 1) {
      skipped.push({
        kind: "unreadable",
        table,
        column: null,
        reason: `${sweepable.length} workspace scope columns (${sweepable.map((c) => c.column_name).join(", ")}) — a row can be orphaned on one and live on another, so a single-column verdict is not safe here. Resolve this table by hand.`,
      });
      continue;
    }

    for (const col of sweepable) targets.push({ table, column: col.column_name });
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
 * An orphan value {@link classifyScopeValue} has cleared for deletion.
 *
 * The brand is what makes the guard unskippable rather than conventional.
 * `WithheldValue extends OrphanValue`, so before this existed
 * `executeResidueDeletes(query, plan.withheld)` — deleting ONLY the sentinels,
 * one identifier away from the correct call — compiled silently. `Classified`
 * is deliberately not exported, so a `DeletableValue` can only be produced by
 * {@link planResidueSweep}.
 */
declare const Classified: unique symbol;
export type DeletableValue = OrphanValue & { readonly [Classified]: true };

/**
 * Enumerate the distinct orphan scope values per target, with row counts.
 *
 * Values are enumerated rather than deleted by predicate on purpose: the delete
 * names the exact values the report showed the operator, so what is printed and
 * what is destroyed cannot diverge within one invocation. Across two — the
 * documented preview-then-execute flow — the DELETE re-asserts the orphan
 * predicate itself; see {@link executeResidueDeletes}.
 *
 * `IS NOT NULL` is load-bearing, not defensive tidiness: `NOT EXISTS (o.id =
 * NULL)` is TRUE, so without it every NULL-scope row reads as an orphan — and
 * several purged tables have them by design (`prompt_collections`' built-in
 * library rows, `email_outbox`'s session-less password-reset rows, `settings`'
 * deployment-wide tier). A NULL that reaches the classifier anyway is caught
 * below rather than thrown on, because `planResidueSweep` runs OUTSIDE this
 * per-target `try` and a `TypeError` there would abort the entire sweep.
 *
 * A per-target failure is recorded as an `unreadable` skip and the sweep
 * continues — one unreadable table must not cost the whole run, and `unreadable`
 * is what stops the run being reported as clean.
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
    // Collected per target and only committed if the WHOLE target was clean.
    // Continuing the row loop on an anomaly declared the table's state UNKNOWN
    // and then deleted its other rows on the strength of the very query that
    // had just been called untrustworthy — the two-scope-column arm above faces
    // a milder ambiguity and correctly refuses the whole table.
    const candidates: OrphanValue[] = [];
    let anomaly: string | null = null;
    try {
      const rows = await query<{ scope_value: string | null; row_count: string }>(
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
        if (typeof row.scope_value !== "string") {
          anomaly =
            "a NULL scope value reached the classifier, which means the IS NOT NULL guard did not apply. NULL-scope rows are deployment-scoped by design and are NOT residue";
          break;
        }
        const rowCount = Number.parseInt(row.row_count, 10);
        if (!Number.isFinite(rowCount)) {
          anomaly = `unparseable row count ${JSON.stringify(row.row_count)} for scope value ${JSON.stringify(row.scope_value)} — the row shape is not what the sweep assumes`;
          break;
        }
        candidates.push({
          table: target.table,
          column: target.column,
          value: row.scope_value,
          rows: rowCount,
        });
      }
    } catch (err) {
      anomaly = `orphan query failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (anomaly) {
      skipped.push({
        kind: "unreadable",
        table: target.table,
        column: target.column,
        reason: `${anomaly}. No value from this table is proposed for deletion, and its residue state is UNKNOWN, not clean.`,
      });
      continue;
    }
    orphans.push(...candidates);
  }

  return { orphans, skipped };
}

/** The deletion list and the withheld list, split by {@link classifyScopeValue}. */
export interface ResiduePlan {
  readonly deletable: readonly DeletableValue[];
  readonly withheld: readonly WithheldValue[];
}

/** Split enumerated orphans into what may be deleted and what is withheld. */
export function planResidueSweep(orphans: readonly OrphanValue[]): ResiduePlan {
  const deletable: DeletableValue[] = [];
  const withheld: WithheldValue[] = [];
  for (const orphan of orphans) {
    const verdict = classifyScopeValue(orphan.value);
    if (verdict.kind === "residue") {
      // The single trusted construction site for the brand: this is the one
      // place a value has actually been through the guard.
      deletable.push(orphan as DeletableValue);
    } else {
      withheld.push({ ...orphan, reason: verdict.reason });
    }
  }
  return { deletable, withheld };
}

/**
 * Blast-radius cap. Residue is the TAIL of past purges — the 2026-08-12 prod
 * sweep found one genuine row across all three regions — so a plan naming more
 * workspaces than this is a wrong-DB or broken-premise signal, not a big
 * cleanup. `ops teardown-verify-accounts` carries the same guard at 12 on a
 * strictly less destructive command; this one is looser because a legitimate
 * backlog is plausible here, and a preview is always uncapped.
 */
export const MAX_RESIDUE_WORKSPACES = 50;

/**
 * Whether the plan's size is itself evidence the premise is wrong.
 *
 * ⚠️ **This fires in BOTH modes, and the first version of it did not.** It was
 * written as `if (dryRun) return null` — "an operator must be able to preview
 * any result set" — beside {@link assertOrganizationPopulated}, whose whole
 * argument is that *"a preview built on a broken premise is worse than no
 * preview: an operator would read it as a genuine finding."* Two guards for the
 * same broken premise, in the same commit, disagreeing about the preview.
 *
 * The resolution keeps both halves: a DRY RUN still enumerates and still prints
 * everything, so nothing is hidden from the operator — but the result is
 * FLAGGED rather than presented as a finding, and the run exits non-zero.
 * `refusedToExecute` is what stops an EXECUTE; this is what stops a preview
 * being read as clean. Returns the warning, or null.
 *
 * SYSTEM behaviour, of which this function computes only the `string | null`
 * — the exit code is {@link ~ops-residue.residueExitCode}'s and the refusal is
 * `sweepResidue`'s:
 *
 * ```
 * dry run, <= cap    silent
 * dry run,  > cap    WARN, preview still printed in full, exit 1
 * execute, <= cap    silent
 * execute,  > cap    REFUSE, nothing deleted, exit 1
 * ```
 *
 * The dry-run row is the one that changed during review: an earlier draft
 * returned null there, which is the arm the note above is about.
 */
export function checkResidueBlastRadius(deletable: readonly DeletableValue[]): string | null {
  const ids = new Set(deletable.map((d) => d.value));
  if (ids.size > MAX_RESIDUE_WORKSPACES) {
    return (
      `${ids.size} distinct workspace ids resolved as residue (> ${MAX_RESIDUE_WORKSPACES}). ` +
      "Residue is the tail of past purges, not a population — a set this size reads as a wrong " +
      "DB or a partially-restored one, in which the orphan predicate is trivially true for " +
      "nearly everything. Treat this result as a wrong-DB signal, not a finding: re-check " +
      "--region / --database-url before acting on any of it."
    );
  }
  return null;
}

/** One executed delete: the exact values named, and what it actually removed. */
export interface ResidueDeletion {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
  /** Rows the enumeration pass counted. */
  readonly expectedRows: number;
  /** Rows the DELETE actually removed. */
  readonly deletedRows: number;
}

/** A delete that could not be made, with the Postgres message. */
export interface ResidueDeleteError {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
  /** Rows that therefore SURVIVE — the number an operator needs after a failure. */
  readonly expectedRows: number;
  readonly message: string;
}

interface DeleteGroup {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
  readonly expectedRows: number;
}

/** Group the deletable values into one statement per (table, column). */
function groupDeletions(deletable: readonly DeletableValue[]): DeleteGroup[] {
  const order: string[] = [];
  const building = new Map<
    string,
    { table: string; column: string; values: string[]; expectedRows: number }
  >();
  for (const orphan of deletable) {
    const key = `${orphan.table} ${orphan.column}`;
    const existing = building.get(key);
    if (existing) {
      existing.values.push(orphan.value);
      existing.expectedRows += orphan.rows;
    } else {
      order.push(key);
      building.set(key, {
        table: orphan.table,
        column: orphan.column,
        values: [orphan.value],
        expectedRows: orphan.rows,
      });
    }
  }
  // Copy each group's values on the way out, so the array that reaches
  // `ResidueDeletion` / `ResidueDeleteError` is not the mutable accumulator.
  return order.flatMap((key) => {
    const g = building.get(key);
    return g
      ? [{ table: g.table, column: g.column, values: [...g.values], expectedRows: g.expectedRows }]
      : [];
  });
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
 * ⚠️ **The pass bound is what makes the loop FALSIFIABLE, not belt-and-braces.**
 * Each productive pass retires at least one group, so `groups.length` passes is
 * provably sufficient and the bound never ends a healthy run. With only the
 * `progressed` break, a mutation removing that break turns this into an
 * unbounded retry against a production database — and no test can see it, because
 * the microtask loop starves bun's timer queue and the suite HANGS instead of
 * going red. A hang is not a falsifier. With the bound, the same mutation
 * terminates and a test can pin the statement count.
 *
 * ⚠️ **The DELETE re-asserts the orphan predicate AND its own precondition.**
 * The proof that these values are orphans was gathered in a different
 * statement, possibly a different invocation. Both clauses are ADDITIVE — they
 * can only ever delete fewer rows, never more — so neither can regress in the
 * destructive direction.
 *
 * The `EXISTS (SELECT 1 FROM public.organization)` clause is the one that was
 * missing when the `NOT EXISTS` clause was first added, and it is the same
 * defect one layer down: with an empty `organization` the `NOT EXISTS` is
 * vacuously true for every row, so the guard protected nothing in precisely the
 * state it was written for. {@link assertOrganizationPopulated} covers
 * `sweepResidue`, but this function is exported and callable on its own — so
 * the premise travels WITH the destructive statement rather than being
 * established once in an earlier read and thereafter trusted.
 *
 * Each DELETE is its own implicit transaction. Nothing here is atomic across
 * tables by design — a residue sweep is a cleanup, the operator has taken a
 * `pg_dump`, and one table's RESTRICT must not roll back the tables that
 * succeeded.
 *
 * ⚠️ **THROWS rather than returning on a broken premise** — an empty
 * `organization`, or a plan over {@link MAX_RESIDUE_WORKSPACES}. Both are
 * checked HERE and not only in `sweepResidue`, because this function is
 * exported and callable on its own.
 */
export async function executeResidueDeletes(
  query: ResidueQuery,
  deletable: readonly DeletableValue[],
): Promise<{ deletions: ResidueDeletion[]; errors: ResidueDeleteError[] }> {
  const deletions: ResidueDeletion[] = [];
  const errors: ResidueDeleteError[] = [];

  // ⚠️ Both premises are re-established HERE, not just in `sweepResidue`.
  //
  // The SQL clause below is defence in depth, and on its own it is not enough:
  // when `AND EXISTS (SELECT 1 FROM public.organization)` is what zeroes the
  // delete, the code path is identical to "the rows were already gone" — no
  // error, a `✓` line, exit 0. The guard fires and nobody is told, which is the
  // silent-failure shape this whole module is about. So the premise is checked
  // where it can be REPORTED, and the statement carries it too.
  if (deletable.length > 0) {
    await assertOrganizationPopulated(query);
    const overRadius = checkResidueBlastRadius(deletable);
    if (overRadius) {
      // The cap is the only guard covering a partial restore that kept enough
      // organizations to pass the non-emptiness check. `sweepResidue` consults
      // it, but this function is exported and callable on its own — the same
      // reason the SQL clause exists.
      throw new Error(`Refusing to delete: ${overRadius}`);
    }
  }

  const groups = groupDeletions(deletable);
  let pending = groups;

  for (let pass = 0; pass < groups.length && pending.length > 0; pass++) {
    const failures: { group: DeleteGroup; message: string }[] = [];
    let progressed = false;

    for (const group of pending) {
      const table = quoteIdent(group.table);
      const column = quoteIdent(group.column);
      try {
        const removed = await query<{ deleted: number }>(
          `DELETE FROM public.${table} t
            WHERE t.${column}::text = ANY($1)
              AND EXISTS (SELECT 1 FROM public.organization)
              AND NOT EXISTS (
                SELECT 1 FROM public.organization o WHERE o.id = t.${column}::text
              )
            RETURNING 1 AS deleted`,
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

    pending = failures.map((f) => f.group);
    if (failures.length === 0) break;
    if (!progressed) {
      // The fixed point: nothing moved this pass, so retrying cannot help.
      for (const failure of failures) {
        errors.push({
          table: failure.group.table,
          column: failure.group.column,
          values: failure.group.values,
          expectedRows: failure.group.expectedRows,
          message: failure.message,
        });
      }
      pending = [];
      break;
    }
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
  /** Populated on a DRY RUN, and on an EXECUTE the blast-radius cap refused. */
  readonly wouldDelete: readonly OrphanValue[];
  /** Populated on EXECUTE. */
  readonly deletions: readonly ResidueDeletion[];
  readonly errors: readonly ResidueDeleteError[];
  /** Non-null when an EXECUTE computed its plan and then refused to run it. */
  readonly refusedToExecute: string | null;
  /**
   * Non-null when the plan's SIZE is itself evidence the premise is wrong.
   *
   * Present in BOTH modes — on an EXECUTE it is also the `refusedToExecute`
   * reason, and on a DRY RUN it flags the preview rather than suppressing it.
   * A preview of a broken-premise state that reads as an ordinary finding is
   * the failure `assertOrganizationPopulated` refuses outright for; this is the
   * partial-restore version, which cannot be refused outright because a large
   * legitimate backlog is possible.
   */
  readonly blastRadiusWarning: string | null;
  readonly totals: {
    readonly rowsWouldDelete: number;
    readonly rowsDeleted: number;
    readonly rowsWithheld: number;
    /** Tables never in scope — absent, scope-less, or wrong column type. */
    readonly tablesNotInScope: number;
    /** Tables the sweep could NOT read. Their residue state is UNKNOWN. */
    readonly tablesUnreadable: number;
    readonly errors: number;
  };
}

/** Totals that do not depend on which mode the sweep ran in. */
function summarize(
  skipped: readonly ResidueSkip[],
  withheld: readonly WithheldValue[],
): Pick<
  ResidueSweepReport["totals"],
  "rowsWithheld" | "tablesNotInScope" | "tablesUnreadable"
> {
  const unreadable = new Set(skipped.filter((s) => !isBenignSkip(s)).map((s) => s.table));
  // A table can appear in both lists (one sweepable column, one of the wrong
  // type). Unreadable wins: its state is UNKNOWN either way.
  const notInScope = new Set(
    skipped.filter(isBenignSkip).map((s) => s.table).filter((t) => !unreadable.has(t)),
  );
  return {
    rowsWithheld: withheld.reduce((n, w) => n + w.rows, 0),
    tablesNotInScope: notInScope.size,
    tablesUnreadable: unreadable.size,
  };
}

/**
 * Run the sweep end to end against one region's internal DB.
 *
 * DRY RUN enumerates and classifies but issues no DELETE; the caller's gate
 * decides which mode this is, so a gate-less invocation previews rather than
 * deletes. Throws only when a premise is broken: an empty `organization`
 * ({@link assertOrganizationPopulated}), or a schema carrying none of the
 * purged-class tables — the symmetric case, checked inline below.
 */
export async function sweepResidue(
  query: ResidueQuery,
  options: { readonly dryRun: boolean },
): Promise<ResidueSweepReport> {
  await assertOrganizationPopulated(query);

  const { targets, skipped: discoverySkips } = await discoverResidueTargets(query);
  if (targets.length === 0 && PURGED_TABLES.size > 0) {
    // The symmetric premise to an empty `organization`: that one says "these
    // orgs are not real", this one says "this is not an Atlas schema". A DB with
    // a populated `organization` but no purged tables is a wrong `--database-url`
    // pointed at another service, a region mid-provision, or a Better Auth
    // global schema (ADR-0024). Without this the sweep prints 87 benign
    // `relation-absent` skips and "No residue found", and exits 0.
    throw new Error(
      `Refusing to sweep: none of the ${PURGED_TABLES.size} purged-class tables is present with a ` +
        "workspace scope column, so the sweep would examine nothing and report clean. That is a " +
        "wrong-DB or not-yet-migrated-region signal, not an empty region. Re-check --region / " +
        "--database-url, then run the region's migrations.",
    );
  }
  const { orphans, skipped: querySkips } = await enumerateOrphanValues(query, targets);
  const { deletable, withheld } = planResidueSweep(orphans);

  const skipped = [...discoverySkips, ...querySkips];
  const common = summarize(skipped, withheld);
  // Computed in BOTH modes. On EXECUTE it also refuses; on DRY RUN it flags the
  // preview, because a preview of this state is read as a finding.
  const blastRadiusWarning = checkResidueBlastRadius(deletable);
  const blastRefusal = options.dryRun ? null : blastRadiusWarning;

  if (options.dryRun || blastRefusal) {
    return {
      dryRun: options.dryRun,
      tablesConsidered: PURGED_TABLES.size,
      targets,
      skipped,
      withheld,
      wouldDelete: deletable,
      deletions: [],
      errors: [],
      refusedToExecute: blastRefusal,
      blastRadiusWarning,
      totals: {
        ...common,
        rowsWouldDelete: deletable.reduce((n, d) => n + d.rows, 0),
        rowsDeleted: 0,
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
    refusedToExecute: null,
    blastRadiusWarning,
    totals: {
      ...common,
      rowsWouldDelete: 0,
      rowsDeleted: deletions.reduce((n, d) => n + d.deletedRows, 0),
      errors: errors.length,
    },
  };
}
