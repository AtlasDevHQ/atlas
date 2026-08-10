/**
 * The admin-triggered tension sweep (#5029, ADR-0037 §7) — the one writer that
 * can mint an `in-tension-with` edge on a pair that already exists.
 *
 * ## Why a sweep and not a replay
 *
 * "Re-reconcile the corpus" is not an option that exists. `writeCandidate` does
 * the corroboration lookup FIRST and `return`s on a hit, while the tension pass
 * sits in the `created` branch below it — so replaying `reconcileFacts` over an
 * existing claim matches itself, inserts nothing, and never reaches the pass at
 * all. Backfilling keys (0187/0188/0194) therefore cannot retroactively mint the
 * edge those keys made possible, and neither can approving an alias or a
 * cardinality entry: both change what WOULD collide, for rows nothing will look
 * at again. This module is the thing that looks again.
 *
 * ## It replays `reconcile.ts`'s rule rather than inventing a second one
 *
 * Every arm of {@link TENSION_SWEEP_SQL}'s rival scan is
 * {@link TENSION_CANDIDATES_SQL}'s arm, in the same order, built from the same
 * two shared builders (`objectNotSameSql`, `subjectNotDifferentSql`). That is
 * the property to preserve when either statement is edited: two spellings of
 * "what is in tension" is how the sweep and the ingest path drift into flagging
 * different pairs, and a reviewer has no way to tell which one is right.
 *
 * The one structural difference is the DIRECTION arm. `reconcile.ts` runs at
 * write time, so "the rivals" are exactly the rows that already existed —
 * `newer → incumbent` falls out of when the statement runs. A sweep sees the
 * whole slot at once and has to say so: `(ingested_at, id) <` is the total order
 * that makes this statement generate the same edge set the ingest path would
 * have, one edge per unordered pair, with the per-fact fan-out cap biting on the
 * same side.
 *
 * ## TODAY's cardinality, not the value at write time (the AC-4 decision)
 *
 * The sweep reads {@link cardinalitySingleSql} — the workspace's CURRENT
 * approved vocabulary entry — and this is a decision rather than a default,
 * because T8's resolution left it open.
 *
 *   - **There is no write-time value left to read.** #5027 made cardinality a
 *     property of the canonical predicate and stopped reading
 *     `brain_facts.predicate_cardinality`, whose stored values are the
 *     EXTRACTOR's per-claim guesses against a prompt that says *"When unsure
 *     answer 'multi'"*. #5028 drops the column. Sweeping on it would resurrect
 *     the stochastic input #5027 made unrepresentable, at the one moment a human
 *     has just curated the deterministic one.
 *   - **A second reader is the seam `cardinality.ts` argues does not exist.**
 *     Its header keeps the value un-materialized precisely because there is ONE
 *     consumer, so two rows in a slot can never disagree. A sweep reading a
 *     different answer than the publish gate would make the disclosure and the
 *     transaction describe different sets — the failure this arc has now hit
 *     twice.
 *   - **The error direction is right.** Reading today's entry mints only where a
 *     human has approved `single` today; the edge is advisory and additive, so
 *     over-minting costs a reviewer a glance and under-minting costs them a
 *     hint. Reading a stale value would mint against an opinion nobody holds.
 *
 * The same sentence covers the KEYS: the sweep joins on the `subject_key` /
 * `predicate_key` stored on the rows, which ADR-0037 §7's drift re-key keeps
 * current at every alias approval. Today's vocabulary, at both ends.
 *
 * ## An explicitly-authorized autonomous writer, and what bounds it
 *
 * ADR-0036 gave `reconcile.ts` the only licence to write `in-tension-with`
 * unattended. This is the second, and the licence is narrower on every axis:
 * **workspace-scoped**, **admin-triggered** (never a scheduler, never the boot
 * path — `db/migrations/README.md:93-96`'s advisory-lock stall argument), and
 * **bounded twice**:
 *
 *   - {@link TENSION_EDGE_CAP} — reconcile's own per-fact fan-out bound, reused
 *     rather than re-declared, so a slot with a hundred live rivals cannot make
 *     one claim the centre of a hundred-edge star.
 *   - {@link TENSION_SWEEP_RUN_CAP} — how many edges ONE invocation may mint,
 *     which is what keeps the transaction (and therefore the advisory lock it
 *     holds against ingest) short on a corpus that has never been swept.
 *
 * ⚠️ The run cap is applied AFTER the already-exists filter, not before, and the
 * ordering is what makes a truncated sweep converge. Capping the candidate pairs
 * first would hand every later run the same already-minted prefix, mint nothing,
 * and report success forever while the tail stayed unswept.
 *
 * Nothing here supersedes, invalidates, retracts, or reorders. `brain_edges` is
 * the only table written, `in-tension-with` the only edge type, and the write is
 * additive — which is why minting is the recoverable direction and why this is
 * an operation an admin may run on a hunch.
 *
 * ## Running it twice is a no-op, in either direction
 *
 * The existence guard is DIRECTION-AGNOSTIC — it matches an edge between the two
 * facts whichever end it starts from — where `INSERT_TENSION_EDGE_SQL`'s is
 * ordered. Not symmetry for its own sake: a region import (`admin-migrate.ts`)
 * inserts rows carrying their ORIGIN region's `ingested_at`, so a row created
 * after an incumbent can be older on the clock. `reconcile.ts` pointed that row
 * at its rivals when it landed; this statement's `(ingested_at, id)` order points
 * the other way. An ordered guard would read the existing edge as absent and mint
 * its reciprocal — and `loadTensionClusters` walks both directions, so the
 * reviewer would see the same rival listed twice.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { objectNotSameSql } from "@atlas/api/lib/brain/object-cmp";
import { subjectNotDifferentSql } from "@atlas/api/lib/brain/subject-cmp";
import { cardinalitySingleSql } from "@atlas/api/lib/brain/cardinality";
import { isLockTimeout } from "@atlas/api/lib/brain/identity";
import {
  RECONCILE_LOCK_NAMESPACE,
  RECONCILE_LOCK_SQL,
  TENSION_EDGE_CAP,
  withBrainTransaction,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";

/**
 * Re-exported so a consumer of the sweep gets BOTH its bounds from one module.
 *
 * The route prints both in its published OpenAPI description, and reaching past
 * this module to `reconcile.ts` for one of them would give an HTTP handler a
 * direct edge onto the reconcile stage for an integer it only renders. It is
 * the same constant, not a copy — see its declaration for why the sweep may not
 * have one of its own.
 */
export { TENSION_EDGE_CAP };

const log = createLogger("brain-tension-sweep");

/**
 * How many edges ONE invocation may mint.
 *
 * A SECOND bound beside {@link TENSION_EDGE_CAP}, which they are often confused
 * for: that one caps a single claim's fan-out (and so bounds how misleading one
 * row's cluster can get), this one caps the whole run (and so bounds how long
 * the transaction holds namespace 4771 against this workspace's ingest). Neither
 * substitutes for the other — a corpus of ten thousand two-row slots trips this
 * one without ever approaching that one.
 *
 * Sized for the transaction rather than for the corpus: a sweep that hits the
 * cap reports {@link TensionSweepReport.truncated}, and the next run picks up
 * exactly where it stopped, so the cost of it being too small is another button
 * press and the cost of it being too large is an ingest stall.
 */
export const TENSION_SWEEP_RUN_CAP = 1000;

/**
 * Bounds the advisory-lock acquisition, on `promoteBrainFacts`' precedent and
 * for its reason: `pg_advisory_xact_lock` never errors on contention, it waits
 * forever, so an unbounded acquisition here is an admin request that hangs with
 * no log line and no `requestId`.
 *
 * ⚠️ **Deliberately NOT reset after the acquisition**, which is where this
 * diverges from that precedent. The reset exists there because `SET LOCAL`
 * reverts at COMMIT rather than at the next statement, and publish's later
 * statements are row-lock contention with ingest that must be allowed to wait.
 * This transaction has exactly one more statement, and its only remaining lock
 * wait is the `RowExclusiveLock` an INSERT takes on `brain_edges` — i.e. a wait
 * on concurrent DDL, which is a wait an admin-triggered sweep SHOULD abandon
 * rather than sit through. Leaving the bound in force is the behaviour we want,
 * not an omission of the reset. Pinned by `tension-sweep.test.ts`, so a
 * "consistency" fix that adds the reset is a failing test rather than a silent
 * behaviour change.
 *
 * ## MEASURED, because the whole contention arm rests on it
 *
 * `lock_timeout`'s documentation says *"a lock on a table, index, row, or other
 * database object"*, and whether an ADVISORY lock is one of those is the kind of
 * thing that reads as obvious and is worth ten seconds to check — if it were
 * not, this bound would be decoration and the refusal arm below dead code that
 * every test still exercised through its double.
 *
 * Against this repo's PG 16, with one session holding
 * `pg_advisory_xact_lock(4771, hashtext('ws'))`: a second session under
 * `SET LOCAL lock_timeout = '400ms'` aborts with **`55P03` canceling statement
 * due to lock timeout** — exactly the SQLSTATE {@link isLockTimeout} matches.
 * (`promoteBrainFacts` depends on the same property and states it without
 * measuring; this is that measurement.)
 */
const TENSION_SWEEP_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5s'`;

/**
 * The whole sweep, as one statement.
 *
 * ## Reading it
 *
 *   - `candidate` — every ordered pair the ingest path would have wired, for
 *     facts whose canonical predicate is curated `single` TODAY. The `LATERAL`
 *     is what applies {@link TENSION_EDGE_CAP} PER FACT rather than per run; a
 *     plain self-join with one `LIMIT` would cap the whole result and silently
 *     drop whole slots instead of trimming each one's fan-out.
 *   - `fresh` — the pairs that do not already have an edge, in EITHER direction,
 *     capped at {@link TENSION_SWEEP_RUN_CAP}. `ORDER BY` makes the cap's bite
 *     deterministic, on `loadTensionClusters`' precedent: without it a truncated
 *     sweep picks an arbitrary subset, which is still correct and still
 *     converges, but is not reproducible and so cannot be falsified.
 *   - the `INSERT` — additive, one edge per surviving pair, `RETURNING` so the
 *     caller counts what it actually wrote rather than what it planned to.
 *
 * ## The arms, and which are load-bearing
 *
 * `invalidated_at IS NULL` / `valid_to IS NULL` appear on BOTH sides, exactly as
 * `TENSION_CANDIDATES_SQL` requires them of the rival and `writeCandidate`'s own
 * INSERT guarantees of the new row. A retracted or superseded row is not a
 * tension: the arbitration already happened, and wiring an edge at settled
 * history tells a reviewer a live claim is contested by a belief a human retired.
 *
 * The comparisons stay NULL-hostile. All three key columns are `NOT NULL` since
 * migration 0194, but both `_cmp` columns are permanently nullable and the
 * abstain band is what this statement exists to catch — `objectNotSameSql`'s
 * docstring carries the full argument for why it is not spelled
 * `objectSameSql(…) IS NOT TRUE`.
 *
 * `(b.ingested_at, b.id) < (a.ingested_at, a.id)` is a ROW comparison, so the id
 * breaks ties on a timestamp two rows can share (a batch insert, a region import
 * carrying one window's rows). Without the tiebreak, tied rows generate the pair
 * in neither direction — the edge is not minted at all, which is a silent
 * under-match rather than a duplicate, and therefore the direction that would
 * never be noticed.
 *
 * ## No identity key reaches a projection
 *
 * Every key column appears in a `WHERE` and none in a `SELECT` list — the shape
 * `TENSION_CANDIDATES_SQL` already has, and the shape `keys-not-on-the-wire.test.ts`
 * scans for. A `WITH slot AS (SELECT f.subject_key …)` refactor would be the
 * natural way to write this and would trip that guard correctly: this module is
 * not a row-copy path.
 *
 * ⚠️ `$1` is the workspace and is bound at THREE sites (the candidate scan, the
 * existence guard, and the INSERT's own column), so a widened bind list has to
 * renumber all three. `$2` is the per-fact cap, `$3` the run cap.
 */
export const TENSION_SWEEP_SQL = `
  WITH candidate AS (
    SELECT a.id AS newer, rival.id AS older
      FROM brain_facts a
      CROSS JOIN LATERAL (
        SELECT b.id
          FROM brain_facts b
         WHERE b.workspace_id = a.workspace_id
           AND b.subject_key = a.subject_key
           AND b.predicate_key = a.predicate_key
           AND ${objectNotSameSql("b.object_key", "a.object_key", "b.object_cmp", "a.object_cmp")}
           AND ${subjectNotDifferentSql("b.subject_cmp", "a.subject_cmp")}
           AND b.invalidated_at IS NULL
           AND b.valid_to IS NULL
           AND (b.ingested_at, b.id) < (a.ingested_at, a.id)
         ORDER BY b.ingested_at DESC, b.id DESC
         LIMIT $2
      ) rival
     WHERE a.workspace_id = $1
       AND a.invalidated_at IS NULL
       AND a.valid_to IS NULL
       AND ${cardinalitySingleSql("a")}
  ),
  fresh AS (
    SELECT c.newer, c.older
      FROM candidate c
     WHERE NOT EXISTS (
       SELECT 1 FROM brain_edges e
        WHERE e.workspace_id = $1
          AND e.edge_type = 'in-tension-with'
          AND ((e.from_fact_id = c.newer AND e.to_fact_id = c.older)
            OR (e.from_fact_id = c.older AND e.to_fact_id = c.newer)))
     ORDER BY c.newer, c.older
     LIMIT $3
  )
  INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
  SELECT $1, 'in-tension-with', f.newer, f.older FROM fresh f
  RETURNING 1 AS minted`;

/** What one invocation did. */
export interface TensionSweepReport {
  /** Edges actually written — never the number of pairs considered. */
  readonly minted: number;
  /**
   * The run cap bit, so the corpus may hold more unswept pairs.
   *
   * ⚠️ Conservative by one run: a sweep that mints EXACTLY
   * {@link TENSION_SWEEP_RUN_CAP} edges and had nothing left reports `true`. The
   * alternative is selecting one row past the cap and discarding it, which
   * makes the statement do work it throws away to sharpen a flag whose only
   * consequence is "press it again" — and pressing it again answers the question
   * definitively, as a no-op.
   */
  readonly truncated: boolean;
}

/**
 * The sweep's outcome — swept, or refused because ingest holds the lock.
 *
 * Contention is a REFUSAL arm rather than a thrown error because it is neither
 * rare nor a fault: the sweep contends with this workspace's own extraction
 * fiber, which runs unattended, and an admin who pressed a button deserves *"an
 * ingest pass is running, nothing was changed, retry"* rather than the generic
 * 500 an unrecognized throw becomes. Every OTHER failure still throws — a
 * refusal arm that swallowed a broken statement would report "nothing to do" on
 * a sweep that could not run.
 */
export type TensionSweepOutcome =
  | { readonly kind: "swept"; readonly report: TensionSweepReport }
  | { readonly kind: "contended"; readonly message: string };

/** {@link sweepTensionEdges}' seams. */
export interface TensionSweepDeps {
  /** Defaults to a transaction on the internal pool. */
  readonly withTransaction?: ReconcileTransactionRunner;
}

/**
 * Mint the `in-tension-with` edges one workspace's corpus has earned but never
 * been offered.
 *
 * ## Why namespace 4771, and why that is not the publish argument in reverse
 *
 * `RECONCILE_LOCK_NAMESPACE` — reconcile's own — because reconcile is the writer
 * this races with. `pg_advisory_xact_lock` is what makes the statement's
 * `NOT EXISTS` sound rather than correct-by-coincidence: without it, a
 * concurrent ingest pass minting the same pair and a second sweep both read the
 * guard against a snapshot that cannot see the other's uncommitted INSERT, and
 * both write.
 *
 * `brain-facts.ts` argues at length that PUBLISH must never take 4771, because
 * publish must not be wedged by ingest. That argument does not transfer, and the
 * difference is what this operation IS: publish is the review gate a human is
 * standing at, and this is an unattended-by-nature write a human has chosen to
 * run. Being queued behind an extraction pass is the correct answer for it — and
 * the wait is bounded, so the answer arrives either way.
 *
 * Lock ORDER is safe by the same reasoning `identity.ts` applies to reconcile:
 * this transaction takes 4771 and nothing else, ever, so it cannot participate
 * in a cycle with 5022 or 5024.
 *
 * @throws on any database failure that is not lock contention.
 */
export async function sweepTensionEdges(
  workspaceId: string,
  deps: TensionSweepDeps = {},
): Promise<TensionSweepOutcome> {
  const withTransaction = deps.withTransaction ?? withBrainTransaction;

  // The contention arm travels as a RETURN VALUE rather than a flag the callback
  // sets and the caller reads afterwards. A mutable flag reads identically at the
  // one call site and is wrong the moment a retry loop is added around this: the
  // flag survives the attempt that set it.
  const outcome = await withTransaction<
    { readonly kind: "swept"; readonly minted: number } | { readonly kind: "contended" }
  >(async (tx) => {
    await tx.query(TENSION_SWEEP_LOCK_TIMEOUT_SQL);
    try {
      await tx.query(RECONCILE_LOCK_SQL, [RECONCILE_LOCK_NAMESPACE, workspaceId]);
    } catch (err: unknown) {
      // Named rather than passed through as a raw `55P03`, on
      // `promoteBrainFacts`' precedent: an operator reading "lock_not_available"
      // has no way to know an ingest pass is what they are queued behind. Logged
      // AND returned — the returned message is the caller's copy, not a
      // server-side record.
      if (!isLockTimeout(err)) throw err;
      log.warn(
        { workspaceId, namespace: RECONCILE_LOCK_NAMESPACE },
        "brain tension sweep: timed out taking the reconcile lock — an ingest pass is reconciling this workspace",
      );
      // Returning (rather than re-throwing) leaves `withBrainTransaction` to
      // COMMIT a transaction Postgres has already put in `25P02`. Safe and
      // deliberate, and MEASURED rather than assumed — against this repo's
      // PG 16, COMMIT on an aborted transaction answers with a `ROLLBACK`
      // command tag, raises nothing, and leaves the session usable. There is
      // nothing to lose either way: the failed statement was the lock
      // acquisition, so no row was ever written. Throwing instead would make
      // contention indistinguishable from a real fault at every layer above.
      return { kind: "contended" };
    }
    const { rows } = await tx.query(TENSION_SWEEP_SQL, [
      workspaceId,
      TENSION_EDGE_CAP,
      TENSION_SWEEP_RUN_CAP,
    ]);
    return { kind: "swept", minted: rows.length };
  }).catch((err: unknown) => {
    // Re-thrown, not degraded. A sweep that failed and reported zero is
    // indistinguishable from a corpus with nothing to mint, and the admin would
    // read a broken statement as a clean bill of health. The line names the
    // workspace because the message alone will not.
    log.error(
      { workspaceId, err: errorMessage(err) },
      "brain tension sweep: the sweep failed — no edges were written",
    );
    throw err;
  });

  if (outcome.kind === "contended") {
    return {
      kind: "contended",
      message:
        "The tension sweep could not start: an ingest pass is reconciling this workspace's facts, " +
        "and the sweep writes the same advisory edges that pass does. Nothing was changed. " +
        "Retry in a few seconds.",
    };
  }

  const { minted } = outcome;
  const report: TensionSweepReport = {
    minted,
    truncated: minted >= TENSION_SWEEP_RUN_CAP,
  };
  if (minted > 0) {
    log.info(
      {
        workspaceId,
        minted,
        truncated: report.truncated,
        perFactCap: TENSION_EDGE_CAP,
        runCap: TENSION_SWEEP_RUN_CAP,
      },
      "brain tension sweep: minted advisory in-tension-with edges over existing rows for predicates curated `single` — nothing was superseded, retracted, or reordered",
    );
  }
  return { kind: "swept", report };
}
