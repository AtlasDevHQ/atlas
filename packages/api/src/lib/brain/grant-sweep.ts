/**
 * The entirely-malformed-grant sweep (#4797, ADR-0036 §Access control &
 * residency) — the observer that closes the residual gap `acl.ts`'s header
 * discloses.
 *
 * #4768's acceptance criterion is "unknown/malformed grant ⇒ row invisible AND
 * logged". The invisible half is structural: the predicate is an array overlap
 * against the reader's tokens and no reader token is ever malformed, so a
 * malformed stored token matches nothing. The logged half was only partly
 * delivered. `logGrantAnomalies` fires on rows a caller ALREADY HOLDS, which
 * catches `['user:abc', 'everyone']` — a grant that passes on its valid token
 * while carrying a second one the author believed was doing something. But a
 * grant that is ENTIRELY malformed (`['everyone']`, `['role:bogus']`) is
 * correctly invisible to every reader, so no caller ever holds the row, so
 * nothing logs it. A push-down predicate cannot log the rows it excluded; that
 * is the point of pushing it down.
 *
 * This is the seam that can. It is a SWEEP and not a write-time hook because a
 * write-time hook cannot close the acceptance criterion: a region-migration
 * import bundle carries grants that `grantProblem` legally admits, on a route the
 * ingest-time grant deriver (#4770, inherited onto facts by #4771's reconcile)
 * does not own. A sweep is indifferent to how the row arrived.
 *
 * ## An OBSERVER, never a gate
 *
 * Nothing here rejects, repairs, or writes. Migration 0180's
 * `chk_brain_{facts,episodes}_grant_nonempty` is the ceiling on what may be
 * stored, `grantProblem` in `api/routes/admin-migrate.ts` mirrors it exactly,
 * and a row Postgres legally stores but Atlas code refuses is a workspace that
 * cannot be migrated between regions — discovered at cutover, long after the
 * row landed. `acl.ts`'s parser is deliberately stricter than both and must
 * never be hoisted to import time, so this module reads it from a scheduler
 * fiber where it can only ever produce a log line and a number.
 *
 * ## Why a gauge, and why daily
 *
 * A malformed grant is a PERMANENT data defect — nothing repairs it
 * automatically, so the naive sweep reports the same rows identically forever,
 * on every replica, and the signal becomes ignorable. That is the same outcome
 * as not having it.
 *
 * The resolution is that the two channels want opposite things and only one of
 * them is an alert. The COUNT on the span is a gauge: it wants continuous
 * re-emission, because that is what makes it alertable on a threshold and what
 * makes it visibly return to zero when someone fixes the rows. Emitting it once
 * — which a per-row "already reported" stamp column would do — converts it
 * into an edge-triggered event that goes silent WHILE THE DEFECT PERSISTS, so a
 * report landing during a log rotation is lost forever. The LOG LINE is not the
 * alert; it is the fix list read after the gauge fires, and its cost is bounded
 * by cadence rather than by row count.
 *
 * So fatigue is a cadence problem, and the cadence is the control: this fiber
 * defaults to DAILY, not to the audience sync's 30 minutes. One line per day
 * per replica is a digest; forty-eight is noise. A permanent condition does not
 * become more urgent by being restated every half hour.
 *
 * ## Why its own fiber
 *
 * Not folded into `brain_audience_sync`. That cycle is gated on Slack chat
 * installs and is workspace-opt-out-able; a workspace with no installs still
 * has facts, and a grant defect there is exactly as invisible. Enablement here
 * is the internal DB and nothing else — an operator should not have to opt in
 * to learning that their data is broken.
 *
 * ## Drafts are in scope, and there is no status filter at all
 *
 * `loadFactCandidates` (`lib/brain/candidates.ts`) ANDs `aclVisibilityClause`
 * into the review queue, so an entirely-malformed DRAFT is invisible to the
 * reviewer too: it can never be reviewed, never promoted, never archived. It is
 * the most stuck row in the system, not the least, and filtering to `published`
 * would hide precisely the class that still has a human decision pending. The
 * only status-awareness in this module is carrying the column into the log
 * sample so an operator can deprioritise `archived` — never a `WHERE`.
 * `brain_episodes` has no `status` column at all, which is why the projection
 * branches per table.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { ACL_GATED_TABLES, parseGrant, type AclGatedTable } from "@atlas/api/lib/brain/acl";

const log = createLogger("brain.grant-sweep");

/** Daily. See the module header on why this is not the audience sync's 30m. */
export const DEFAULT_GRANT_SWEEP_INTERVAL_HOURS = 24;

/**
 * Rows examined per table per cycle, AFTER the `org` narrow — the public
 * majority never reaches it, so this is not a fraction of the table's row count.
 *
 * A bound, not a policy — but a bound that is REPORTED rather than silent, via
 * `countIsFloor` (and `scan_truncated` on the span, which names this cause
 * specifically). A sweep that quietly stopped at the cap would read as
 * "nothing more to find" on exactly the deployments too large for it to have
 * looked, which is the failure mode this module exists to remove one instance
 * of. Generous enough that hitting it is itself the finding.
 */
export const GRANT_SWEEP_ROW_CAP = 50_000;

/**
 * How many malformed rows one log line (and {@link GrantSweepResult.sample})
 * carries. A bound, not a policy. Exported so tests assert against it rather
 * than restating `20` — a literal that silently inverts when fixtures change.
 */
export const MALFORMED_SAMPLE_CAP = 20;

/**
 * The scan, per gated table.
 *
 * ## The narrow is one exact string, and that is deliberate
 *
 * `parsePrincipal` / `parseGrant` in `acl.ts` are the ONLY authority on what a
 * valid principal is. The tempting optimisation here is a SQL predicate that
 * pre-filters malformed rows so the fiber never has to parse them — and it is a
 * grammar duplication, the exact failure `acl.ts` and `audience/sync.ts` both
 * spend paragraphs on: two independent derivations agree until one of them
 * changes, and then the sweep goes quiet about the rows it stopped recognising.
 *
 * Worse, the obvious narrow is unsafe in the direction that matters. "Rows
 * where no element has a valid prefix" DROPS `['role:bogus']` — valid prefix,
 * does not parse, entirely malformed, and exactly the row being looked for. A
 * pre-filter must never exclude a row TS would call malformed, which rules out
 * every predicate that reasons about the PARAMETERISED arms.
 *
 * `NOT (visible_to @> ARRAY['org'])` is safe because `org` is a single exact
 * token, not a grammar: a row containing it demonstrably has a valid principal,
 * so excluding it can never hide a finding, and the rule survives any change to
 * the `role:`/`user:`/`audience:` arms because it does not mention them.
 * ADR-0036's "the public majority carries an explicit `[org]`" is what makes it
 * worth having — it should shed most of the table.
 *
 * ## Why `@>` and NOT `'org' = ANY(visible_to)`
 *
 * The two read as synonyms and are not. `= ANY` is a scalar comparison folded
 * over the elements, so it inherits SQL's three-valued logic: over an array
 * containing a NULL element with no match it evaluates to NULL, not FALSE.
 * `NOT NULL` is NULL, and `WHERE NULL` DROPS THE ROW.
 *
 * `['everyone', NULL]` and `['role:bogus', NULL]` are legal at rest — 0180's
 * CHECK counts non-NULL non-empty elements and one survivor is enough — parse
 * to zero principals, and are exactly what this sweep exists to find. Under
 * `= ANY` all of them were silently excluded by the pre-filter, and the cycle
 * reported `malformed_rows: 0, status: success`: a fabricated all-clear on the
 * module's only signal, in the under-reporting direction, on rows an import
 * bundle can carry today (`grantProblem` admits `["everyone", null]`).
 *
 * `@>` is array containment, which is two-valued over element NULLs: it answers
 * FALSE, `NOT` answers TRUE, and the row is examined. It also matches the GIN
 * index's own operator class, so the shape stays legible next to
 * `idx_brain_*_visible_to`. This is a correctness fix, not a style preference —
 * do not "simplify" it back to `= ANY`.
 *
 * It is still a heap FILTER, not an index scan — a NEGATED containment is not
 * an index-scannable predicate, whichever operator sits inside it. (`= ANY(col)`
 * would not have been GIN-servable in either polarity either; `array_ops` serves
 * `&&`, `@>`, `<@`, `=`.) What the narrow buys is rows-not-sent-over-the-wire,
 * which is the cost that actually scales here, since the parse must be in TS.
 *
 * `ORDER BY workspace_id, id` makes the capped prefix stable across cycles
 * rather than whatever the heap happened to return, so a truncated sweep
 * reports the same rows each day instead of a different arbitrary slice.
 */
export function grantScanSql(table: AclGatedTable): string {
  // `table` is a union member, not caller input — it cannot be an arbitrary
  // identifier. The status projection branches because `brain_episodes` has no
  // such column; see the module header.
  const status = table === "brain_facts" ? "status" : "NULL::text AS status";
  return `
  SELECT workspace_id, id, visible_to, ${status}
    FROM ${table}
   WHERE NOT (visible_to @> ARRAY['org'])
   ORDER BY workspace_id, id
   LIMIT $1`;
}

/** One row the sweep flagged, as it appears in the log sample. */
export interface MalformedGrantRow {
  readonly table: AclGatedTable;
  readonly workspaceId: string;
  readonly rowId: string;
  readonly status: string | null;
  /** The stored grant verbatim, so the log line is a fix list and not a lookup. */
  readonly grant: readonly unknown[];
}

/**
 * What one cycle found. `null` on the counters means the sweep COULD NOT RUN —
 * distinct from `0`, which means it ran and found nothing.
 *
 * The distinction is the whole point of reporting a count at all. A failed
 * sweep reporting `0` is indistinguishable from a healthy deployment on the
 * span, and would hide exactly the number this module exists to show.
 */
export interface GrantSweepResult {
  /**
   * `skipped` is a FOURTH state, not a flavour of success: there is no internal
   * DB, so nothing ran. Without it the no-DB path returned `success` with
   * all-null counters — the one combination this type's doc calls impossible.
   */
  readonly status: "success" | "degraded" | "failure" | "skipped";
  readonly malformedRows: number | null;
  readonly malformedWorkspaces: number | null;
  readonly rowsScanned: number | null;
  /**
   * Rows the scan returned whose SHAPE could not be read (query drift, not a
   * data defect — see {@link readScanRow}). Non-zero forces `degraded`, because
   * a row that could not be read is one this sweep did not clear: without that,
   * a projection change that made EVERY row unreadable reported
   * `success / malformedRows: 0`, a fabricated all-clear on the module's only
   * signal.
   */
  readonly unreadableRows: number | null;
  /**
   * `malformedRows` is a FLOOR rather than a total. THREE causes are folded
   * here so an alert can read one field: the scan hit
   * {@link GRANT_SWEEP_ROW_CAP}, a table's scan failed, or rows came back in a
   * shape this module could not read (a row it could not read is not a row it
   * cleared). `scan_truncated` on the span discriminates the first — the three
   * have different remediations and the fold must not cost the cause.
   *
   * `true` on the all-tables-failed path too: the cycle that scanned NOTHING is
   * the strongest case for "this count is not a total", and reporting `false`
   * there inverted the field's own rule.
   */
  readonly countIsFloor: boolean;
  /**
   * The row cap alone — {@link countIsFloor}'s cap arm, unfolded. Kept beside
   * the fold because the three causes have different remediations, and an
   * operator seeing only `countIsFloor` cannot tell "raise the cap" from "fix
   * the scan".
   */
  readonly scanTruncated: boolean;
  readonly sample: readonly MalformedGrantRow[];
  /** {@link sample} was clipped to its cap; more rows are in the log line. */
  readonly sampleTruncated: boolean;
  readonly error?: string;
}

/**
 * Frozen, not merely `readonly` — `readonly` is compile-time only.
 *
 * Both call sites SPREAD this, so each return gets a fresh outer object; it is
 * the `sample` ARRAY that genuinely escapes by reference into every no-result
 * report in the process, and a type-violating `push` on it would poison all of
 * them. That inner freeze is the load-bearing half; the outer one keeps the
 * constant honest about being a constant. `acl.ts`'s `DENY_ALL` freezes its
 * `params` for exactly the same reason.
 */
const NO_RESULT: Omit<GrantSweepResult, "status"> = Object.freeze({
  malformedRows: null,
  malformedWorkspaces: null,
  rowsScanned: null,
  unreadableRows: null,
  countIsFloor: false,
  scanTruncated: false,
  sample: Object.freeze([]) as readonly MalformedGrantRow[],
  sampleTruncated: false,
});

/**
 * The query surface this module needs — injectable, so tests pass a literal
 * rather than mocking a module. Shaped as `internalQuery`'s rows-array return
 * (not `pg`'s `{ rows }`), matching `AudienceSyncDeps.query`.
 */
export type GrantSweepQuery = (
  sql: string,
  params?: unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export interface GrantSweepDeps {
  readonly query?: GrantSweepQuery;
  /** Row cap per table. Injectable so a test can drive truncation cheaply. */
  readonly rowCap?: number;
}

/**
 * Effect's clock treats any duration above this as INFINITE — `unsafeSchedule`
 * returns without arming a timer, so `Schedule.spaced` runs its first tick and
 * then never ticks again. Shared bound with
 * `scheduler/knowledge-bundle-sync.ts`'s `MAX_TIMER_DELAY_MS` (#4236).
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Floor on the interval (3 minutes).
 *
 * The clamp above is not enough on its own: this is the module whose entire
 * design argument is that CADENCE is the control against alert fatigue, and an
 * unguarded `…_HOURS=0.0001` runs a full two-table scan roughly three times a
 * second — with a findings warn line each cycle on any deployment that has a
 * malformed row. Guarding one end and not the other would leave the knob able
 * to defeat the property it exists to set.
 */
export const MIN_GRANT_SWEEP_INTERVAL_MS = 180_000;

/**
 * How often the sweep runs, in milliseconds.
 *
 * Unparseable or non-positive falls back to the DEFAULT rather than disabling.
 * A typo in an operator's override should not quietly switch off the only
 * observer of a permanent defect class — and unlike the staleness bound, there
 * is no enforcement here to escape from, so "0 disables" would buy nothing but
 * a way to lose the signal by accident.
 *
 * Over-large values are CLAMPED for the same reason, and the reason is not
 * cosmetic: past `MAX_TIMER_DELAY_MS` (~596.5h) Effect never re-arms the timer,
 * so `…_HOURS=600` — a plausible "dial this way down" keystroke — yields one
 * boot tick and then permanent silence. That is indistinguishable from a dead
 * fiber, and "nothing to notice but an ABSENCE of spans" is precisely the
 * outcome this fiber's registration comment says it exists to avoid.
 */
export function getGrantSweepIntervalMs(): number {
  const raw = getSettingAuto("ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS");
  if (raw === undefined || raw === "") return DEFAULT_GRANT_SWEEP_INTERVAL_HOURS * 3_600_000;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    log.warn(
      { raw },
      "ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS is non-positive or unparseable — using the default",
    );
    return DEFAULT_GRANT_SWEEP_INTERVAL_HOURS * 3_600_000;
  }
  const ms = hours * 3_600_000;
  if (ms < MIN_GRANT_SWEEP_INTERVAL_MS) {
    log.warn(
      { raw, minMinutes: MIN_GRANT_SWEEP_INTERVAL_MS / 60_000 },
      "ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS is below the minimum sweep interval — clamping, since a permanent defect does not need re-reporting this often",
    );
    return MIN_GRANT_SWEEP_INTERVAL_MS;
  }
  if (ms > MAX_TIMER_DELAY_MS) {
    log.warn(
      { raw, maxHours: MAX_TIMER_DELAY_MS / 3_600_000 },
      "ATLAS_BRAIN_GRANT_SWEEP_INTERVAL_HOURS exceeds the max timer delay — clamping, since a larger value would stop the fiber ticking entirely",
    );
    return MAX_TIMER_DELAY_MS;
  }
  return ms;
}

/** Narrow one scanned row, or `null` if its shape is unreadable. */
function readScanRow(
  row: unknown,
): { workspaceId: string; rowId: string; status: string | null; grant: readonly unknown[] } | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const workspaceId = record.workspace_id;
  const rowId = record.id;
  const grant = record.visible_to;
  if (typeof workspaceId !== "string" || typeof rowId !== "string") return null;
  // `visible_to` is `text[] NOT NULL`, so a non-array here is query drift, not
  // data. Reported as unreadable rather than coerced: a row whose grant cannot
  // be read is not a row this sweep may pronounce clean, and counting it as
  // malformed would put a shape bug in the same bucket as a data defect and
  // send the investigation to the wrong file. See {@link GrantSweepResult}.
  if (!Array.isArray(grant)) return null;
  const status = record.status;
  return {
    workspaceId,
    rowId,
    status: typeof status === "string" ? status : null,
    grant: grant as readonly unknown[],
  };
}

/**
 * Scan one gated table. Never throws — a per-table failure degrades the cycle
 * rather than taking the other table down with it.
 */
type TableScan =
  | {
      readonly ok: true;
      readonly scanned: number;
      readonly truncated: boolean;
      readonly unreadable: number;
      readonly malformed: readonly MalformedGrantRow[];
    }
  /** `error` is non-optional exactly where it is guaranteed. */
  | { readonly ok: false; readonly error: string };

async function sweepTable(
  query: GrantSweepQuery,
  table: AclGatedTable,
  rowCap: number,
): Promise<TableScan> {
  try {
    const rows = await query(grantScanSql(table), [rowCap]);
    const malformed: MalformedGrantRow[] = [];
    let unreadable = 0;
    for (const raw of rows) {
      const row = readScanRow(raw);
      if (!row) {
        unreadable++;
        continue;
      }
      // THE parse — `acl.ts`'s, not a second opinion about it. A row is flagged
      // only when the module that decides visibility finds no principal in it,
      // which is what makes this count and the predicate's silence the same
      // fact rather than two derivations that agree for now.
      const parsed = parseGrant(row.grant);
      if (parsed.principals.length > 0) continue;
      malformed.push({
        table,
        workspaceId: row.workspaceId,
        rowId: row.rowId,
        status: row.status,
        grant: row.grant,
      });
    }
    if (unreadable > 0) {
      // Logged HERE, not in the cycle, because `table` is in scope only here —
      // and the two projections deliberately differ (`status` vs `NULL::text AS
      // status`), so "the scan query's projection changed" is useless without
      // saying which one. The per-table catch below carries `table` for the
      // same reason.
      log.warn(
        { table, unreadable, scanned: rows.length },
        "brain grant sweep: scanned rows had an unreadable shape — this table's scan projection changed; these rows were neither cleared nor flagged",
      );
    }
    return { ok: true, scanned: rows.length, truncated: rows.length >= rowCap, unreadable, malformed };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(
      { table, err: error },
      "brain grant sweep: scan failed — this table's malformed-grant count is unavailable this cycle",
    );
    return { ok: false, error };
  }
}

/**
 * Run one malformed-grant sweep. Never throws.
 *
 * Returns all-`null` counters when it could not run at all, so the span records
 * "we do not know" rather than a fabricated all-clear. A partial run — one
 * table scanned, one failed — is `degraded` with the counters it does have,
 * because half a floor is still more useful than none.
 */
export async function runGrantSweepCycle(deps: GrantSweepDeps = {}): Promise<GrantSweepResult> {
  // `skipped`, not `success` — nothing ran, and the counters are null to say
  // so. Reporting `success` here was the one state {@link GrantSweepResult}
  // documents as impossible: an all-clear status over "we do not know".
  //
  // `countIsFloor` stays FALSE here, unlike the all-tables-failed path below,
  // and the two are not inconsistent: that path ATTEMPTED a count and could not
  // complete it, so its zero is a floor. This one never attempted one — there
  // is no count for a floor to be a floor OF. (`status` already distinguishes
  // them, and the fiber's gate makes this path near-unreachable in production.)
  if (!hasInternalDB()) return { status: "skipped", ...NO_RESULT };

  const query = deps.query ?? internalQuery;
  const rowCap = deps.rowCap ?? GRANT_SWEEP_ROW_CAP;

  const malformed: MalformedGrantRow[] = [];
  const workspaces = new Set<string>();
  let scanned = 0;
  let truncated = false;
  let unreadable = 0;
  let failures = 0;
  let firstError: string | undefined;

  // Iterated, not hardcoded: a third gated table must not silently fall out of
  // the sweep's coverage while `aclVisibilityClause` still gates it.
  for (const table of ACL_GATED_TABLES) {
    const out = await sweepTable(query, table, rowCap);
    if (!out.ok) {
      failures++;
      firstError ??= out.error;
      continue;
    }
    scanned += out.scanned;
    truncated ||= out.truncated;
    unreadable += out.unreadable;
    for (const row of out.malformed) {
      malformed.push(row);
      workspaces.add(row.workspaceId);
    }
  }

  if (failures === ACL_GATED_TABLES.length) {
    // `countIsFloor: true` overrides NO_RESULT's `false`: nothing was scanned,
    // which is the strongest case for "not a total" the field has.
    return {
      status: "failure",
      ...NO_RESULT,
      countIsFloor: true,
      ...(firstError ? { error: firstError } : {}),
    };
  }

  // Every cause of an incomplete count, folded into one field an alert can
  // read. `truncated` alone would have read a half-scan (one table errored) as
  // a complete one; `truncated || failures` would have read a cycle whose rows
  // were all UNREADABLE as a complete one — reporting `malformed_rows: 0,
  // count_is_floor: false` while nothing was actually examined, which is the
  // fabricated all-clear `unreadableRows` was added to prevent.
  const countIsFloor = truncated || failures > 0 || unreadable > 0;

  if (truncated) {
    // The "no silent caps" half of the contract. A capped sweep reports a
    // FLOOR, and an operator reading the count has to know that.
    log.warn(
      { rowCap, scanned },
      "brain grant sweep: the row cap was reached — the malformed-grant count is a floor, not a total, and rows past the cap were not examined",
    );
  }

  if (malformed.length > 0) {
    // The #4797 event. `warn` and with the row ids, because the operator-visible
    // symptom is a fact that silently vanished from the brain: debugging starts
    // from "the agent doesn't know X" with nothing to search for, and the only
    // answer that helps names the rows and shows the grant that was stored.
    //
    // Emitted every cycle for as long as the rows exist. That is a gauge, not a
    // repeat — see the module header on why reporting once would be worse.
    log.warn(
      {
        malformedRows: malformed.length,
        malformedWorkspaces: workspaces.size,
        rowsScanned: scanned,
        unreadableRows: unreadable,
        countIsFloor,
        sample: malformed.slice(0, MALFORMED_SAMPLE_CAP),
        sampleTruncated: malformed.length > MALFORMED_SAMPLE_CAP,
      },
      "brain grant sweep: rows carry no parseable principal — they are invisible to every reader AND to the review queue, and nothing repairs them automatically. Re-grant them at the source or re-import with a valid grant",
    );
  }

  return {
    // `degraded` means the counters are a partial or unverified floor through
    // a FAULT — one table's scan failed, or rows came back in a shape this
    // module could not read. A cap hit also makes them a floor and stays
    // `success` on purpose: the cap is an operator-tunable bound working as
    // configured, not something going wrong, and `countIsFloor` +
    // `scan_truncated` already carry it. So the fold has three causes and this
    // status takes two. It is deliberately NOT set by FINDINGS: malformed rows are a
    // steady-state defect, and folding them in would make `degraded` permanent
    // on any deployment that has one — and therefore ignorable, which is the
    // failure this whole module is shaped around avoiding.
    //
    // The two arms it IS set by are not equally self-limiting, and the
    // difference is worth stating rather than implying. An unreadable row is a
    // code defect (`visible_to` is `text[] NOT NULL`, so no DATA can produce
    // one) and gets fixed, so it cannot pin the status. A failing table CAN pin
    // it indefinitely — a revoked `SELECT`, or a third entry added to
    // `ACL_GATED_TABLES` before its migration reaches every region. That is
    // accepted: a permanently failing scan is an operator action item, not a
    // steady-state property of the data, and a sweep that cannot read its own
    // tables should not be reporting `success`.
    status: failures > 0 || unreadable > 0 ? "degraded" : "success",
    malformedRows: malformed.length,
    malformedWorkspaces: workspaces.size,
    rowsScanned: scanned,
    unreadableRows: unreadable,
    countIsFloor,
    scanTruncated: truncated,
    sample: malformed.slice(0, MALFORMED_SAMPLE_CAP),
    sampleTruncated: malformed.length > MALFORMED_SAMPLE_CAP,
    ...(firstError ? { error: firstError } : {}),
  };
}
