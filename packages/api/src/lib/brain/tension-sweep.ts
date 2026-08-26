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
 * ⚠️ #5332 opened ONE crack in that paragraph and it is not a way out. The
 * lookup now excludes OBSERVATIONS, so a belief-class replay over a warehouse
 * row does miss, insert, and reach the pass. That is a strictly worse
 * "re-reconcile" than it sounds: it mints a duplicate DRAFT of the claim as the
 * price of reaching the pass, which is a corpus edit, where this module's whole
 * licence is that it writes advisory edges and nothing else. It also covers
 * only pairs whose incumbent is an observation. Still not an option.
 *
 * ## It replays `reconcile.ts`'s rule rather than inventing a second one
 *
 * Every arm of {@link TENSION_SWEEP_SQL}'s rival scan is
 * {@link TENSION_CANDIDATES_SQL}'s arm, in the same order, built from the same
 * three shared builders (`tensionReachSql`, `objectNotSameSql`,
 * `subjectNotDifferentSql`). That is
 * the property to preserve when either statement is edited: two spellings of
 * "what is in tension" is how the sweep and the ingest path drift into flagging
 * different pairs, and a reviewer has no way to tell which one is right.
 *
 * ⚠️ The slot arm became a REACH in #5438 — the exact slot, OR the same subject
 * ANCHOR from a different episode with no predicate test — and it moved into
 * `segmentation.ts` precisely so this statement and the ingest scan could not
 * acquire two versions of it. The whole argument for dropping the predicate at
 * an ADVISORY consumer, and the three mechanisms falsified before it, live in
 * that module's header. This module gets the widening for free and does not
 * restate it.
 *
 * TWO structural differences in the rival SCAN, both about ORDER rather than
 * about which pairs qualify. (The CARDINALITY gate differs too, and that one DOES
 * change which pairs qualify — the ingest path reads the extractor's per-claim
 * guess, this reads the curated vocabulary — which is the entire point of the
 * module; see §"TODAY's cardinality". So "the same edge set the ingest path
 * would have", below, means: among the pairs it would have considered at all.)
 *
 *   - **The DIRECTION arm.** `reconcile.ts` runs at write time, so "the rivals"
 *     are exactly the rows that already existed — `newer → incumbent` falls out
 *     of when the statement runs. A sweep sees the whole slot at once and has to
 *     say so: `(ingested_at, id) <` is the total order that makes this statement
 *     generate the same edge set the ingest path would have, one edge per
 *     unordered pair, with the per-fact fan-out cap biting on the same side.
 *   - **The id TIEBREAK in the `ORDER BY`.** After the shared head term both
 *     statements now carry (`exactSlotFirstSql`, #5438),
 *     `TENSION_CANDIDATES_SQL` orders
 *     `ingested_at DESC` alone; this orders `ingested_at DESC, id DESC`. Under
 *     tied timestamps — a batch insert, a region import carrying one window —
 *     the two can therefore select DIFFERENT rivals inside the per-fact cap, so
 *     the "same edge set" claim above is exact only up to the cap's tail. This
 *     statement's version is the better one (an unordered tie makes the ingest
 *     path's own cap non-deterministic), and the honest fix is to add the
 *     tiebreak there rather than to remove it here — deliberately NOT done in
 *     this PR, because it changes which edges the ingest path mints and belongs
 *     in a change that can falsify that.
 *
 * ## TODAY's cardinality, not the value at write time (the AC-4 decision)
 *
 * The sweep reads {@link cardinalitySingleSql} — the workspace's CURRENT
 * approved vocabulary entry — and this is a decision rather than a default,
 * because T8's resolution left it open.
 *
 *   - **There is no write-time value left to read.** #5027 made cardinality a
 *     property of the canonical predicate and stopped WRITING
 *     `brain_facts.predicate_cardinality` (#5035 stopped the region importer's
 *     write; #5028 phase 1b stopped the last two READS — this header used to
 *     say #5027 stopped the reads, which was false for one shipped release),
 *     whose stored values are the
 *     EXTRACTOR's per-claim guesses against a prompt that says *"When unsure
 *     answer 'multi'"*. Sweeping on it would resurrect
 *     the stochastic input #5027 made unrepresentable, at the one moment a human
 *     has just curated the deterministic one.
 *   - **A second reader is the seam `cardinality.ts` argues does not exist.**
 *     Its header makes two arguments that are easy to run together: the value is
 *     un-materialized because there is one CONSUMER and therefore no seam, and
 *     two facts in a slot cannot disagree because there is one cardinality ROW
 *     for them to disagree about. This module falsifies the first — it is a
 *     second live consumer — and leaves the second untouched, which is what
 *     keeps the seam closed anyway: both consumers read the same BUILDER rather
 *     than a second spelling of it. A sweep reading a
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
 *   - {@link TENSION_SWEEP_RUN_CAP} — how many edges ONE invocation may WRITE.
 *
 * ⚠️ **Neither cap bounds the transaction, and an earlier draft of this header
 * claimed the run cap did.** `LIMIT $3` sits on `fresh`, so it caps the INSERT;
 * the `candidate` scan underneath it walks every live fact in the workspace
 * regardless, and on an already-swept corpus it does that walk in full and mints
 * zero. What bounds the transaction — and therefore how long namespace 4771 is
 * held against this workspace's ingest — is
 * `TENSION_SWEEP_STATEMENT_TIMEOUT_SQL`, and it is a separate mechanism for a
 * separate failure.
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
// The SAME reach the ingest path uses, imported rather than respelled — this
// module's header names two spellings of "what is in tension" as the drift that
// leaves a reviewer unable to tell which statement is right (#5438).
import { exactSlotFirstSql, tensionReachSql } from "@atlas/api/lib/brain/segmentation";
import { cardinalitySingleSql } from "@atlas/api/lib/brain/cardinality";
import { identityKey, isLockTimeout } from "@atlas/api/lib/brain/identity";
import type { Exact } from "@atlas/api/lib/type-utils";
import type {
  BrainFactTensionForecastRequest,
  BrainFactTensionForecastResponse,
} from "@useatlas/types";
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
 * A SECOND bound beside {@link TENSION_EDGE_CAP}, and the two are easily
 * confused: that one caps a single claim's fan-out (and so bounds how misleading
 * one row's cluster can get), this one caps the whole run (and so bounds how many
 * edges a single press can write). Neither
 * substitutes for the other — a corpus of ten thousand two-row slots trips this
 * one without ever approaching that one.
 *
 * Sized for the WRITE: a sweep that hits the cap reports
 * {@link TensionSweepReport.truncated}, and the next run picks up exactly where
 * it stopped, so the cost of it being too small is another button press.
 *
 * ⚠️ It does NOT bound how long the transaction runs — the candidate scan
 * underneath it is unbounded by this number. `TENSION_SWEEP_STATEMENT_TIMEOUT_SQL`
 * is what holds that line.
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
 * This transaction has exactly one more statement, and every lock it waits on is
 * one an admin-triggered sweep SHOULD abandon rather than sit through. Leaving
 * the bound in force is the behaviour we want, not an omission of the reset.
 * Pinned by `tension-sweep.test.ts`, so a "consistency" fix that adds the reset
 * is a failing test rather than a silent behaviour change.
 *
 * ⚠️ **An earlier draft justified this with "its only remaining lock wait is the
 * `RowExclusiveLock` an INSERT takes on `brain_edges` — i.e. a wait on concurrent
 * DDL", and that premise is FALSE.** It omits the referential check: the INSERT
 * takes `FOR KEY SHARE` on both endpoint rows in `brain_facts`, so it also waits
 * on any `FOR UPDATE` held there — a concurrent publish or correction, neither
 * of which takes namespace 4771. The decision survives its bad premise (those
 * waits are exactly as worth abandoning), but the REFUSAL that reports them had
 * to change; see {@link TensionSweepContention}'s `conflicting-lock`.
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
 * Pinned IN-TREE at the shipped 5s bound by `tension-sweep-pg.test.ts`'s
 * deadline-raced contention test, so the property survives without anyone
 * re-running the 400ms probe.
 * (`promoteBrainFacts` depends on the same property and states it without
 * measuring; this is that measurement.)
 */
const TENSION_SWEEP_LOCK_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5s'`;

/**
 * Bounds the STATEMENT, which `lock_timeout` above does not and
 * {@link TENSION_SWEEP_RUN_CAP} does not either.
 *
 * ⚠️ **The run cap bounds the WRITE, not the SCAN, and reading it as "the
 * transaction is short" is the mistake this constant exists to correct.**
 * `LIMIT $3` sits on `fresh`, so it caps how many edges are INSERTed — while the
 * `candidate` CTE cross-joins laterally over every live fact in the workspace
 * and evaluates an `EXISTS` against `brain_predicate_cardinality` per row. On an
 * already-swept corpus that full scan runs every time and mints zero: maximum
 * work, minimum output, and the cap never engages.
 *
 * `lock_timeout` cannot help — it bounds WAITING for a lock, not a statement
 * that is simply running. So without this bound a large corpus produces the
 * exact outcome the lock bound's own docstring says it prevents: a request that
 * hangs with no log line and no `requestId`, holding one of five internal-pool
 * connections, **and holding namespace 4771 against this workspace's extraction
 * fiber for the whole duration**. The blast radius is wider than the alias
 * producer's, which is otherwise the closest precedent
 * (`alias-proposal.ts`'s `boundedTransaction`, whose docstring
 * makes the same argument: *"a JS deadline alone abandons a statement that goes
 * on holding one of five pooled connections. `statement_timeout` cancels it."*)
 *
 * 30s rather than that module's 10s, and the reason is the shape of the work
 * rather than a missing index — an earlier draft cited ADR-0037 §7's
 * no-skip-scan argument, which is about the drift RE-KEY (it filters
 * `predicate_key` without `subject_key` and must reach tombstoned rows the
 * partial index excludes) and does NOT apply here: the rival scan supplies all
 * three key columns and both partial-predicate arms, so `idx_brain_facts_subject`
 * is an exact match for it. What actually costs is the outer walk over every live
 * fact plus the per-row cardinality `EXISTS`, named two paragraphs above. That,
 * and this being a human-triggered one-off rather than a fiber tick, is why the
 * tolerance for a slow honest answer is higher. It is still a bound, and exceeding it is reported as
 * a refusal naming what to do — see {@link TensionSweepContention}.
 */
const TENSION_SWEEP_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '30s'`;

/**
 * The FORECAST's statement bound - deliberately far tighter than the sweep's.
 *
 * Same scan, different tolerance, and the tolerance follows from what the caller
 * is doing rather than from what the statement costs. The sweep's 30s is
 * justified in its own docstring by *"this being a human-triggered one-off
 * rather than a fiber tick, [which] is why the tolerance for a slow honest
 * answer is higher"*. A forecast is the opposite: it is rendered beside a
 * decision, possibly several at once, and an answer that takes half a minute has
 * already failed as a preview whether or not it eventually arrives.
 *
 * It is also the second half of {@link FORECAST_MAX_CONCURRENT}'s argument. The
 * permit caps HOW MANY connections this endpoint can hold; this caps HOW LONG it
 * can hold one. Either alone leaves the pool reachable - two permits held for
 * 30s each is most of a five-connection pool for most of a minute.
 *
 * WARNING: Not shared with the sweep, and must not be "unified" with it. They
 * are two different numbers because they answer to two different callers, and
 * collapsing them silently gives one of the two the other's tolerance.
 */
const TENSION_FORECAST_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = '5s'`;

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
/**
 * "What pairs are in tension, and which of them do not already carry an edge" —
 * the whole scan, spelled ONCE and parameterized at the CARDINALITY GATE alone.
 *
 * ## Why a builder rather than two statements
 *
 * The module header's standing rule is that a second spelling of "what is in
 * tension" is how two readers of this corpus drift into flagging different
 * pairs, *"and a reviewer has no way to tell which one is right"*. That rule was
 * written about the SWEEP against the INGEST path, which cannot share a
 * statement — one scans a workspace, the other scans one claim's rivals — so it
 * had to be enforced by shared expression builders and a test.
 *
 * {@link TENSION_FORECAST_SQL} is the case where the sharing CAN be total: the
 * forecast asks the sweep's exact question and declines to write the answer, so
 * every arm, every `ORDER BY`, both caps and the freshness guard are the same
 * TEXT rather than the same intent. A forecast that drifted from the sweep is
 * strictly worse than no forecast — it is a number an approver acts on that the
 * button then contradicts.
 *
 * ⚠️ `cardinalityGate` is INTERPOLATED. Callers pass an expression this module
 * builds, never anything reaching it from a request; the counterfactual travels
 * as a BIND (`$4`), which is what keeps a predicate surface out of the SQL text.
 */
function tensionCandidateCteSql(cardinalityGate: string): string {
  return `
  WITH candidate AS (
    SELECT a.id AS newer, rival.id AS older
      FROM brain_facts a
      CROSS JOIN LATERAL (
        SELECT b.id
          FROM brain_facts b
         WHERE b.workspace_id = a.workspace_id
           AND ${tensionReachSql(
             {
               subjectKeyExpr: "b.subject_key",
               predicateKeyExpr: "b.predicate_key",
               episodeIdExpr: "b.source_episode_id",
             },
             {
               subjectKeyExpr: "a.subject_key",
               predicateKeyExpr: "a.predicate_key",
               episodeIdExpr: "a.source_episode_id",
             },
           )}
           AND ${objectNotSameSql("b.object_key", "a.object_key", "b.object_cmp", "a.object_cmp")}
           AND ${subjectNotDifferentSql("b.subject_cmp", "a.subject_cmp")}
           AND b.invalidated_at IS NULL
           AND b.valid_to IS NULL
           AND (b.ingested_at, b.id) < (a.ingested_at, a.id)
         ORDER BY ${exactSlotFirstSql(
           { subjectKeyExpr: "b.subject_key", predicateKeyExpr: "b.predicate_key" },
           { subjectKeyExpr: "a.subject_key", predicateKeyExpr: "a.predicate_key" },
         )}, b.ingested_at DESC, b.id DESC
         LIMIT $2
      ) rival
     WHERE a.workspace_id = $1
       AND a.invalidated_at IS NULL
       AND a.valid_to IS NULL
       AND ${cardinalityGate}
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
  )`;
}

export const TENSION_SWEEP_SQL = `${tensionCandidateCteSql(cardinalitySingleSql("a"))}
  INSERT INTO brain_edges (workspace_id, edge_type, from_fact_id, to_fact_id)
  SELECT $1, 'in-tension-with', f.newer, f.older FROM fresh f
  RETURNING 1 AS minted`;

/**
 * The cardinality gate with ONE predicate key added to it, hypothetically.
 *
 * `cardinalityFlipExpr`'s shape in `vocabulary-preview.ts`, and deliberately the
 * same one: that module already answers *"what would approving this predicate
 * supersede?"* by adding the key to the gate rather than by writing the row, and
 * this answers the other half of the same question — *"what would it FLAG?"*
 *
 * ⚠️ `$4` is bound to NULL when the caller asks about the workspace as it stands
 * TODAY, and that is what makes one statement serve both questions. `a.predicate_key
 * = NULL` is NULL, never TRUE, so the disjunction collapses to the stored
 * `EXISTS` exactly — the same three-valued reasoning `cardinalityUnflipExpr`
 * spells out for its own `IS DISTINCT FROM`.
 *
 * ⚠️ That NULL is the BIND's, not the column's, and an earlier draft of this
 * paragraph confused the two — it went on to reason about "a row whose
 * `predicate_key` is itself NULL", which this module's own header says is
 * unrepresentable: all three key columns have been `NOT NULL` since migration
 * 0194. The conclusion was unaffected (such a row would be excluded either way),
 * but two docstrings in one file disagreeing about what the schema admits is
 * worse than the hedge was worth, and in this module the docstrings ARE the
 * design record. `cardinalityUnflipExpr` still needs its `IS DISTINCT FROM`
 * because it reads a column the PREVIEW can leave null through an alias
 * counterfactual; nothing here does.
 *
 * ⚠️ Two statements — one with the disjunct, one without — was the first cut and
 * is the drift this file spent a builder to prevent: the "today" spelling is the
 * one nobody edits, so it is the one that goes stale.
 */
const TENSION_FORECAST_GATE = `(a.predicate_key = $4 OR ${cardinalitySingleSql("a")})`;

/**
 * The sweep's question, asked WITHOUT writing the answer (#5450).
 *
 * ## Why this exists as shipped code rather than as a query on an issue
 *
 * #5425 forecast the first sweep's reach by hand — the sweep's CTEs pasted into
 * `psql` with the gate replaced by `TRUE` — and #5450 then made that scan a
 * standing precondition: *"before approving any of `plan tier` / `name` /
 * `region` / `is active`, run the read-only candidate scan and report the count
 * it would mint."* A precondition discharged by pasting a copy of a statement
 * this module owns is the second spelling the header forbids, wearing an
 * operator's clothes — and the copy is not version-controlled, so it goes stale
 * against the very arm it is meant to price.
 *
 * ## What the number means, and the one thing it is not
 *
 * `would_mint` is what {@link TENSION_SWEEP_SQL} would return as `minted` if it
 * ran in the same instant, under the same two caps — the per-fact fan-out and
 * the run cap — so a forecast and the press that follows it are the same
 * arithmetic. It is NOT a count of pairs in tension: a pair that already carries
 * an edge is excluded by `fresh` in both statements, because both answer *"what
 * would this press ADD?"*
 *
 * ⚠️ It is a FORECAST, not a promise. Nothing is locked (see
 * {@link forecastTensionEdges}), so an ingest pass between the read and the
 * press moves the number. The gap is the same one any preview carries and is
 * disclosed rather than closed: closing it would mean holding this workspace's
 * reconcile lock across a human's decision.
 *
 * ⚠️ `$4` is the counterfactual predicate key and is bound at ONE site; `$1`
 * still reaches TWO here rather than the sweep's three, because there is no
 * INSERT column to scope. A widened bind list has to renumber both.
 */
export const TENSION_FORECAST_SQL = `${tensionCandidateCteSql(TENSION_FORECAST_GATE)}
  SELECT count(*)::int AS would_mint FROM fresh`;

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
   *
   * ⚠️ A DELIBERATE divergence from `loadTensionClusters`, cited above as the
   * `ORDER BY`-determinism precedent: that one DOES bind `cap + 1` and discard
   * the extra. It is a READ whose caller renders a badge off the flag, where
   * this is a WRITE whose caller can simply run again. Named so the
   * inconsistency is not "fixed" into an extra row on every sweep.
   */
  readonly truncated: boolean;
}

/**
 * WHY the sweep could not run — three lock/time bounds, three different remedies.
 *
 * A single `contended` arm carrying free prose was the first cut, and it was
 * wrong in the way a shared refusal usually is: one copy cannot state three
 * different recoveries, so it states the one its author had in mind.
 *
 * ⚠️ **No arm may assert a single holder or cause as ESTABLISHED**, because in
 * all three cases the SQLSTATE carries neither.
 *
 * Naming the candidate holders is fine and encouraged — hedged, exhaustive, and
 * ordered by likelihood — which is what all three shipped messages do. The rule
 * is about certainty, not about vocabulary; an earlier draft said "never a holder
 * or a cause", which the file's own messages then contradicted, leaving a reader
 * either to strip useful hedged text or to read the shipped text as licence to
 * re-add an unhedged one.
 * That rule was learned the expensive way: the first cut of each arm asserted a
 * cause, and all three were wrong. `too-slow` assumed a timeout where `57014` is
 * also a cancel; `ingest` assumed the extraction fiber where namespace 4771 also
 * has the sweep itself; `table-lock` assumed maintenance where the INSERT's FK
 * check waits on any `FOR UPDATE`, which usually means a publish. Each arm's own
 * docstring records its measurement. **Do not reintroduce a cause into any of
 * them, including into the prose around them** — `tension-sweep.test.ts` greps
 * for the defeated phrasings, because three rounds of fixing the message and
 * leaving a comment behind is what made that guard necessary.
 */
export type TensionSweepContention =
  /**
   * Somebody else holds this workspace's reconcile lock — `55P03` on the
   * acquisition.
   *
   * ⚠️ Named for the LOCK, not for a holder, because `pg_advisory_xact_lock`'s
   * `55P03` carries no holder identity and nothing here queries one. Namespace
   * 4771 has TWO takers as of this module (`reconcile.ts`'s own docstring says
   * so): the extraction fiber, and a concurrent SWEEP — a second admin, or a
   * double-press inside the first run's window. An earlier spelling called this
   * `ingest` and its message asserted an extraction fiber, which sends the
   * second presser to look for an ingest pass that may not exist. Same defect
   * class as the `unfinished` arm below, one arm over, introduced by the very
   * change that created the second taker.
   */
  | "reconcile-lock"
  /**
   * Something holds a conflicting lock on a row or table the statement touches —
   * `55P03` from the sweep statement itself.
   *
   * ⚠️ Named for the LOCK rather than for a holder, and the holder set is much
   * wider than "maintenance" — MEASURED, not reasoned. `brain_edges` carries
   * composite FKs to `brain_facts` (0180's `fk_brain_edges_from_fact` /
   * `fk_brain_edges_to_fact`), so this INSERT's referential check runs
   * `SELECT 1 FROM ONLY brain_facts … FOR KEY SHARE` on BOTH endpoint rows —
   * verified against this repo's PG 16, which reports exactly
   * `55P03 … while locking tuple in relation "parent"` when the parent row is
   * `FOR UPDATE`-held.
   *
   * `FOR KEY SHARE` conflicts with `FOR UPDATE`, and two ordinary operations
   * hold that on live `brain_facts` rows without taking namespace 4771 —
   * DELIBERATELY, in both cases:
   *
   *   - **publish**, whose `DRAFT_FACTS_SQL` takes `FOR UPDATE` on every live
   *     draft in the workspace and holds it to COMMIT. It takes 5024 and must
   *     never take 4771 (`identity.ts`' lock-order note), so it runs
   *     concurrently with the sweep on purpose — and the sweep does not filter
   *     on `status`, so drafts are in scope at both endpoints.
   *   - **a correction**, whose `correctionTargetSql` ends `FOR UPDATE` on its
   *     target and which takes no advisory lock at all.
   *
   * An earlier spelling called this `table-lock` and made the remedy conditional
   * on maintenance completing — advice to wait for an event that will never
   * happen, for what is usually a colleague pressing Publish. Third instance of
   * the assume-the-cause defect in this union, one arm over from the other two.
   *
   * ⚠️ Described rather than QUOTED, deliberately. The lexical guard in
   * `tension-sweep.test.ts` cannot tell a quotation of a defeated phrase from an
   * assertion of it, and it caught this docstring the first time it ran. An
   * exemption for quotations is exactly the seam through which the phrase comes
   * back, so the rule is that the words do not appear in this file at all — the
   * defeated wording lives in the test's own matcher list, which is where a
   * reader can see it without the module carrying it.
   */
  | "conflicting-lock"
  /**
   * The statement did not FINISH — `57014`.
   *
   * ⚠️ Named for what is known rather than for a cause, because `57014` is
   * `query_canceled` generally: a `statement_timeout` expiry AND an operator or
   * pooler `pg_cancel_backend` both raise it, and Postgres offers no SQLSTATE
   * that separates them. An earlier spelling (`too-slow`) asserted the cause,
   * and its message then told the admin not to retry — which is wrong for every
   * cancelled statement, and was contradicted by this module's own
   * `isStatementTimeout` docstring two hundred lines away.
   */
  | "unfinished";

/**
 * The sweep's outcome — swept, or refused without running.
 *
 * ⚠️ This docstring was ORPHANED for two rounds: the union moved below it while
 * the block stayed put, so tooling attached it to the neighbour and this type
 * had none. Its old text also asserted one holder and one of three reasons —
 * the exact thing {@link TensionSweepContention} forbids — while sitting
 * directly above the ⚠️ that says so.
 *
 * Contention is a REFUSAL arm rather than a thrown error because it is neither
 * rare nor a fault: the sweep is bounded on purpose and every bound it can hit
 * is somebody else's ordinary work. An admin who pressed a button deserves
 * *"nothing was changed, here is what to try"* rather than the generic 500 an
 * unrecognized throw becomes. Every OTHER failure still throws — a refusal arm
 * that swallowed a broken statement would report "nothing to do" on a sweep
 * that could not run.
 */
export type TensionSweepOutcome =
  | { readonly kind: "swept"; readonly report: TensionSweepReport }
  | {
      readonly kind: "contended";
      /**
       * ⚠️ The ONLY thing this arm carries. There is deliberately no `message`
       * field — a caller renders one with {@link contentionMessage}.
       *
       * It used to carry one, typed
       * `(typeof CONTENTION_MESSAGE)[TensionSweepContention]` on the theory that
       * a literal union would make `message: errorMessage(err)` fail to compile.
       * **MEASURED: it does not.** All three messages are built with `+`, and a
       * concatenated initializer has type `string` under `as const` — only a
       * bare literal keeps its literal type. So the field was `string`, the
       * guarantee was fictional, and the docstring asserting it was written by a
       * comment sweep that replaced an ACCURATE description of the hole with a
       * claim of a guard nobody had built (#5068's class: an annotation derived
       * from the object it guards collapses).
       *
       * Removing the field is simpler than repairing the type and strictly
       * stronger: the slot that could have carried a pg error message — which
       * `withBrainTransaction` scrubs from its own logs precisely because it can
       * echo a credentialed connection URL — no longer exists, and `reason` and
       * its prose can no longer be cross-wired.
       */
      readonly reason: TensionSweepContention;
    };

/**
 * The refusal an admin reads, per reason.
 *
 * Held here rather than at the route because all three say the same two
 * load-bearing things — *nothing was changed* and *what would make a retry
 * work* — and the seam is what knows which happened. A route re-spelling them
 * would be a second copy of a rule this module owns; `admin-brain-vocabulary.ts`
 * keeps its denial prose at the route for the opposite reason (there the ROUTE
 * knows the entitlement and the store does not).
 */
/**
 * The operator-facing sentence for a refusal.
 *
 * A FUNCTION rather than a field on {@link TensionSweepOutcome}, so the message
 * is always the one that belongs to the reason — see that arm's ⚠️ for why the
 * field was removed.
 */
export function contentionMessage(reason: TensionSweepContention): string {
  return CONTENTION_MESSAGE[reason];
}

/**
 * The refusal an operator reads for a FORECAST, over all of its arms.
 *
 * Delegates to {@link contentionMessage} for the arms it shares, so the two
 * endpoints cannot describe the same SQLSTATE differently, and owns the one arm
 * the sweep does not have.
 *
 * WARNING: this message NAMES A CAUSE, which every message in
 * `CONTENTION_MESSAGE` is forbidden from doing. The prohibition there is about
 * SQLSTATEs, which carry no cause - `tension-sweep.test.ts` greps for the
 * defeated phrasings precisely because three rounds of asserting one were wrong.
 * This arm is not derived from a SQLSTATE at all: the server counted its own
 * in-flight scans, so the cause is established rather than guessed, and hedging
 * it would be a false modesty that costs the operator the one actionable
 * sentence available.
 */
export function forecastContentionMessage(reason: TensionForecastContention): string {
  return reason === "forecast-busy"
    ? "This server was at its tension-forecast concurrency limit for the whole wait, so this request gave up its place in the queue rather than holding an HTTP request open indefinitely. Nothing was read and nothing was changed. Ask again in a moment; if it persists, something is calling this endpoint in a loop."
    : contentionMessage(reason);
}

const CONTENTION_MESSAGE = {
  // True of BOTH holders of namespace 4771 — the extraction fiber and another
  // sweep — because the SQLSTATE names neither. The remedy holds for both: an
  // ingest pass is short, and a sweep is bounded by its own statement timeout.
  "reconcile-lock":
    "The tension sweep could not start: another operation holds this workspace's reconcile lock " +
    "— an ingest pass, or a sweep already running. Both write the same advisory edges, so they " +
    "cannot overlap. Nothing was changed. Retry in a few seconds.",
  // True of every holder, and ordered by what an admin will actually have hit:
  // a concurrent publish or correction first, maintenance second. The remedy
  // that works for the common case is given first, with the rarer one as an
  // escalation rather than as the headline.
  "conflicting-lock":
    "The tension sweep could not finish: another operation holds a conflicting lock on this " +
    "workspace's facts. Most often that is a publish or a correction, which the sweep " +
    "deliberately does not queue behind; less often a migration or an index build. " +
    "Nothing was changed. Retry in a few seconds, and check whether maintenance is running if " +
    "it persists.",
  // ⚠️ True of BOTH members of the `57014` class — a timeout and a cancel — and
  // that is the constraint this string is written under. A message that assumes
  // the timeout — blaming how much data there is, and ruling out a retry — sends an admin whose
  // statement was merely cancelled to hunt a problem that does not exist, with
  // the one correct remedy explicitly ruled out.
  //
  // ⚠️ Nor does a REPEAT discriminate — a supervisor that cancels once cancels
  // twice — so the escalation clause may not name the corpus either. It says
  // where the answer lives (the logs, which DO carry the distinction) instead of
  // guessing which member repeated.
  unfinished:
    "The tension sweep did not finish — it either exceeded its time bound or was cancelled. " +
    "Nothing was changed. Retry once, and escalate to an operator if it repeats — a repeat is not " +
    "proof of either cause, so diagnosing it needs the server logs rather than another press.",
} as const satisfies Record<TensionSweepContention, string>;

/** {@link sweepTensionEdges}' seams. */
export interface TensionSweepDeps {
  /** Defaults to a transaction on the internal pool. */
  readonly withTransaction?: ReconcileTransactionRunner;
  /**
   * Forecast only: how long to wait for a concurrency permit before refusing.
   * Defaults to {@link FORECAST_QUEUE_WAIT_MS}.
   *
   * A test seam in the shape `dashboard-screenshot.ts` uses for the same
   * property (`_setRenderConcurrency`): the queue's EXPIRY arm is otherwise
   * only reachable by making a suite sit for the real ten seconds, which is how
   * a bound ends up asserted by nobody.
   */
  readonly queueWaitMs?: number;
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
 * Lock ORDER is safe against the other ADVISORY namespaces by the same reasoning
 * `identity.ts` applies to reconcile: this transaction takes 4771 and no other
 * advisory lock, so it cannot participate in a cycle with 5022 or 5024.
 *
 * ⚠️ **That is a claim about ADVISORY locks only. An earlier draft dropped the
 * qualifier and asserted the transaction holds no other lock of any kind, which
 * is false and was used to argue that `40P01` could not happen here.** The INSERT takes ROW locks:
 * `FOR KEY SHARE` on both endpoint rows in `brain_facts`, in plan order, while a
 * concurrent publish takes `FOR UPDATE` across every live draft in its own order
 * and deliberately does not take 4771. A deadlock is therefore reachable, and
 * the catch below has an arm for it.
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
    | { readonly kind: "swept"; readonly minted: number }
    | { readonly kind: "contended"; readonly reason: TensionSweepContention }
  >(async (tx) => {
    await tx.query(TENSION_SWEEP_LOCK_TIMEOUT_SQL);
    await tx.query(TENSION_SWEEP_STATEMENT_TIMEOUT_SQL);
    try {
      await tx.query(RECONCILE_LOCK_SQL, [RECONCILE_LOCK_NAMESPACE, workspaceId]);
    } catch (err: unknown) {
      // ⚠️ `57014` FIRST, and on this statement too — round 1 gave the sweep
      // statement both arms and left the acquisition with one, which is the
      // reported instance closed and the class left open one statement over.
      // The bounds are issued ABOVE this line, so a cancelled acquisition is an
      // outcome this design creates; `lock_timeout` (5s) beats
      // `statement_timeout` (30s) on a pure lock wait, so the reachable member
      // here is a `pg_cancel_backend` from an operator, a supervisor, or a
      // pooler during the wait.
      if (isStatementTimeout(err)) {
        log.warn(
          { workspaceId, namespace: RECONCILE_LOCK_NAMESPACE, code: pgCode(err), err: errorMessage(err) },
          "brain tension sweep: the reconcile-lock acquisition did not finish (57014 — a time-bound expiry or a cancel; Postgres does not distinguish them, so read `err` for which)",
        );
        return { kind: "contended", reason: "unfinished" };
      }
      // Named rather than passed through as a raw `55P03`, on
      // `promoteBrainFacts`' precedent: an operator reading "lock_not_available"
      // has no way to know an ingest pass is what they are queued behind. Logged
      // AND returned — the returned message is the caller's copy, not a
      // server-side record.
      if (!isLockTimeout(err)) throw err;
      log.warn(
        // `err` on this arm too. Its detail is usually uninformative for an
        // advisory-lock wait — which is exactly why the field should be there
        // rather than reasoned about: this message hedges between two holders,
        // and "the log carries whatever the driver said" is a property worth
        // holding uniformly instead of re-deciding per arm. The sibling arms
        // were each fixed one round apart for want of it.
        { workspaceId, namespace: RECONCILE_LOCK_NAMESPACE, code: pgCode(err), err: errorMessage(err) },
        "brain tension sweep: timed out taking the reconcile lock — an ingest pass or another sweep holds namespace 4771 for this workspace; the SQLSTATE does not say which",
      );
      // Returning (rather than re-throwing) leaves `withBrainTransaction` to
      // COMMIT a transaction Postgres has already put in `25P02`. Safe and
      // deliberate, and MEASURED rather than assumed — against this repo's
      // PG 16, COMMIT on an aborted transaction answers with a `ROLLBACK`
      // command tag, raises nothing, and leaves the session usable. There is
      // nothing to lose either way: the failed statement was the lock
      // acquisition, so no row was ever written. Throwing instead would make
      // contention indistinguishable from a real fault at every layer above.
      return { kind: "contended", reason: "reconcile-lock" };
    }
    try {
      const { rows } = await tx.query(TENSION_SWEEP_SQL, [
        workspaceId,
        TENSION_EDGE_CAP,
        TENSION_SWEEP_RUN_CAP,
      ]);
      return { kind: "swept", minted: rows.length };
    } catch (err: unknown) {
      // ⚠️ THE STATEMENT'S OWN BOUNDS, and this arm exists because the two above
      // it are deliberately left in force for exactly this statement. Without it
      // the one outcome the design creates ON PURPOSE — abandon a wait rather
      // than sit through it — arrives at the caller as an unmapped 500 reading
      // "Failed to sweep brain fact tension edges", which is the generic message
      // this repo forbids and is indistinguishable from a broken query.
      //
      // The two are separate arms because the RECOVERY differs, and the
      // reconcile-lock copy is wrong for both. Neither arm names a cause: a
      // `55P03` here is some conflicting lock on `brain_edges` or on a
      // `brain_facts` row this INSERT must `FOR KEY SHARE`, and a `57014` is the
      // statement not finishing. Which one, in each case, is something the
      // SQLSTATE does not say — see each arm on `TensionSweepContention`.
      if (isLockTimeout(err)) {
        log.warn(
          // ⚠️ `where`, NOT just `err`, and the distinction is MEASURED. This
          // arm's discriminator is `… while locking tuple in relation
          // "brain_facts"` — the difference between "a colleague pressed
          // Publish" (a row lock, via the FK's `FOR KEY SHARE`) and "someone is
          // running DDL" (a relation lock), which are the two ends of this
          // message's own hedge and have different remedies.
          //
          // That clause is the server's CONTEXT, surfaced by `pg` as
          // `DatabaseError.where`. `errorMessage` returns `.message`, which is
          // the bare `canceling statement due to lock timeout` in BOTH cases —
          // verified against this repo's PG 16. Logging `err` alone would have
          // been the promise-without-a-discriminator defect one more time, in
          // the fix written to close it.
          { workspaceId, code: pgCode(err), where: pgWhere(err), err: errorMessage(err) },
          "brain tension sweep: the sweep statement hit its lock bound — something holds a conflicting lock on brain_edges or on a brain_facts row this INSERT must FOR KEY SHARE (a publish, a correction, or DDL); the SQLSTATE does not say which",
        );
        return { kind: "contended", reason: "conflicting-lock" };
      }
      // ⚠️ DEADLOCK, and its absence was argued away by a premise this PR itself
      // falsified. `sweepTensionEdges`' docstring claimed the transaction holds
      // 4771 and no lock of any other kind — true of ADVISORY locks and false of
      // row locks: the INSERT's FK check takes `FOR KEY SHARE` on both endpoint rows
      // in `brain_facts`, acquired in plan order, while a concurrent publish
      // takes `FOR UPDATE` over every live draft in its own order and does not
      // take 4771. Two writers taking overlapping row locks in independent
      // orders is the textbook `40P01`, and `identity.ts` records that this repo
      // has already been bitten by one produced by exactly this reasoning gap.
      //
      // Routed to `conflicting-lock` rather than given a fourth arm: the remedy
      // is identical (retry in seconds, nothing was changed) and the message
      // already names the whole holder set. A separate arm would be a fourth
      // wire value for one recovery.
      if (pgCode(err) === DEADLOCK_DETECTED) {
        log.warn(
          { workspaceId, code: pgCode(err), err: errorMessage(err) },
          "brain tension sweep: the sweep statement was chosen as a deadlock victim — the INSERT's FK check takes FOR KEY SHARE on both endpoint rows in brain_facts, which can cycle with a concurrent publish's FOR UPDATE; the SQLSTATE does not name the other party",
        );
        return { kind: "contended", reason: "conflicting-lock" };
      }
      if (isStatementTimeout(err)) {
        log.warn(
          {
            workspaceId,
            code: pgCode(err),
            bound: TENSION_SWEEP_STATEMENT_TIMEOUT_SQL,
            // ⚠️ THE DISCRIMINATOR for this arm. `57014` is
            // identical for both members; the only thing that separates them is
            // the message text (`canceling statement due to statement timeout`
            // vs `… due to user request`). The `unfinished` refusal tells the
            // admin the answer is in the server logs — so the logs have to
            // actually carry it, or that is a reassurance nothing establishes.
            err: errorMessage(err),
          },
          "brain tension sweep: the sweep statement did not finish (57014 — a time-bound expiry or a cancel; Postgres does not distinguish them, so read `err` for which)",
        );
        return { kind: "contended", reason: "unfinished" };
      }
      throw err;
    }
  }).catch((err: unknown) => {
    // Re-thrown, not degraded. A sweep that failed and reported zero is
    // indistinguishable from a corpus with nothing to mint, and the admin would
    // read a broken statement as a clean bill of health.
    //
    // ⚠️ The wording claims only what this site can KNOW. It used to say "no
    // edges were written", which this catch cannot establish: it wraps the whole
    // runner including `withBrainTransaction`'s COMMIT, so a connection reset
    // between the server committing and the client seeing the ack lands here
    // with the edges durably written. An operator reading the old line during an
    // incident would conclude the corpus was untouched.
    //
    // `code` is carried BESIDE the scrubbed message rather than instead of it.
    // Scrubbing is right — a pg error can echo a credentialed connection URL —
    // but `errorMessage` collapses the error to a string, which drops the
    // SQLSTATE, and "was this contention or a real fault?" is the first question
    // an operator asks and the one the arms above key on.
    log.error(
      { workspaceId, code: pgCode(err), err: errorMessage(err) },
      "brain tension sweep: the run failed — any edges it wrote were rolled back, unless the failure was at COMMIT, in which case they may have landed. Re-running is a no-op either way",
    );
    throw err;
  });

  if (outcome.kind === "contended") {
    return { kind: "contended", reason: outcome.reason };
  }

  const report = tensionSweepReport(outcome.minted);
  // UNCONDITIONAL, and the `minted === 0` case is the one that needed it. Three
  // materially different situations produce a byte-identical `{0, false}`: the
  // corpus has converged, the workspace has never had a predicate APPROVED
  // `single` (so `cardinalitySingleSql` matches nothing and the sweep is
  // structurally incapable of minting), or there are no live facts at all. An
  // admin who curates, sweeps, and sees `0` most often hit the second — a
  // `pending` proposal is not an approval — and while this call was gated on a
  // positive count there was no server-side line to debug that from.
  //
  // ⚠️ Described rather than QUOTED: `tension-sweep.test.ts` asserts
  // structurally that no count test sits between the report and this call, and
  // that scan cannot tell a quotation from a gate. Same rule as the refusal
  // guard — the words do not appear, because an exemption is how they return.
  log.info(
    {
      workspaceId,
      minted: report.minted,
      truncated: report.truncated,
      perFactCap: TENSION_EDGE_CAP,
      runCap: TENSION_SWEEP_RUN_CAP,
    },
    report.minted > 0
      ? "brain tension sweep: minted advisory in-tension-with edges over existing rows for predicates curated `single` — nothing was superseded, retracted, or reordered"
      : "brain tension sweep: nothing to mint — either the corpus has converged, or no predicate in this workspace is APPROVED `single` (a pending proposal does not arm the sweep)",
  );
  return { kind: "swept", report };
}

// ---------------------------------------------------------------------------
// The forecast — the sweep's question, without the sweep's write (#5450)
// ---------------------------------------------------------------------------

/**
 * What {@link forecastTensionEdges} was asked.
 *
 * Takes the SURFACE, never the key — `BlastRadiusRequest`'s `cardinality-flip`
 * arm makes the same choice for the same reason, and states it: the key is
 * derived here and never travels back out, because a request type that accepted
 * one would be the seam through which a key reaches a route body
 * (ADR-0037 §6, `keys-not-on-the-wire.test.ts`).
 */
export type TensionForecastRequest =
  /**
   * The workspace exactly as it stands. `wouldMint` is what pressing the sweep
   * right now would return as `minted`.
   */
  | { readonly kind: "as-curated" }
  /**
   * …and additionally treating `predicateSurface`'s canonical predicate as
   * approved `single`.
   *
   * ⚠️ The counterfactual is ADDITIVE and does not model a REMOVAL. Un-curating
   * a predicate mints nothing by construction — the sweep only ever adds edges —
   * so the question "what would un-approving this un-mint?" has the answer zero
   * and is not asked here. `vocabulary-preview.ts` needs both directions because
   * supersession's counterfactual is genuinely two-sided; this one is not.
   */
  | { readonly kind: "if-approved"; readonly predicateSurface: string };

/**
 * The bounds a FORECAST can hit — the sweep's three, minus the one it cannot.
 *
 * `reconcile-lock` is excluded because this transaction never takes namespace
 * 4771 (see {@link forecastTensionEdges}), and an arm a caller is invited to
 * handle for a refusal that cannot occur is a branch nothing will ever exercise
 * and everything will keep copying. Derived by `Exclude` rather than re-listed,
 * so a fourth sweep bound joins this union automatically and has to be
 * considered rather than silently omitted.
 */
export type TensionForecastContention =
  | Exclude<TensionSweepContention, "reconcile-lock">
  /**
   * Too many forecasts are already in flight IN THIS PROCESS — see
   * {@link FORECAST_MAX_CONCURRENT}.
   *
   * Its own arm rather than reusing `unfinished`, on the rule
   * {@link TensionSweepContention} states: three bounds, three remedies, and a
   * shared refusal can only state the one its author had in mind. This one's
   * remedy is *wait a moment and ask again* and its cause IS established — the
   * server counted — which is the opposite of every SQLSTATE-derived arm beside
   * it, all of which are forbidden from naming a cause.
   */
  | "forecast-busy";

/**
 * How many forecasts may hold a pooled connection AT ONCE, per process.
 *
 * ## The sweep is self-limiting and this is not, which is the whole reason
 *
 * `sweepTensionEdges` can only ever have one 30s statement in flight per
 * workspace, because it holds advisory namespace 4771 and bounds the
 * acquisition at 5s: a burst of presses queues and then refuses. The forecast
 * deliberately takes no lock ({@link forecastTensionEdges} argues why), writes
 * no audit row, and its own route invites being *"run repeatedly and idly before
 * a decision"*. Nothing was left to bound it.
 *
 * MEASURED against the shape rather than assumed: the internal pool is `max: 5`
 * (`lib/db/internal.ts`), and the candidate walk is explicitly the unbounded
 * half - `TENSION_SWEEP_STATEMENT_TIMEOUT_SQL`'s own docstring warns about
 * *"holding one of five internal-pool connections"*. So five concurrent
 * forecasts hold the ENTIRE pool for the length of their scans, starving auth,
 * settings and audit reads for the whole process. That is not hypothetical
 * traffic: a vocabulary pane that prices each pending predicate on render has
 * four to ask about on the very workspace #5450 measured, and a stale second tab
 * makes five.
 *
 * ## Why a process-local counter is the RIGHT instrument here
 *
 * The resource being protected is per-PROCESS - one pool, one `max: 5` - so a
 * process-local bound is exactly scoped to it. A distributed limiter would be
 * strictly worse: more machinery, a second failure mode, and no closer fit.
 *
 * ## ⚠️ It QUEUES over the cap; it does not refuse at it. That is a CORRECTION
 *
 * The first cut refused anything past the cap, and it was self-contradicting in
 * a way review caught: this docstring rejected `pg_try_advisory_xact_lock`
 * because it *"refuses the 2nd, 3rd and 4th of a legitimate four-predicate
 * render - turning a pane that asks four honest questions into three errors"*,
 * and then set a cap of two, which refuses the 3rd and 4th of exactly that
 * render. The same defect, one smaller, stated and then committed in the same
 * paragraph. The pane in question is not hypothetical any more: #5447's
 * cardinality surface ships it.
 *
 * The argument that produced it - *"a queued preview still ends up holding a
 * connection, just later"* - is FALSE on the axis that matters. The pool bound
 * is about CONCURRENT holders, which the permit enforces whether the excess
 * waits or is turned away. Waiting costs latency; refusing costs an answer.
 *
 * So the excess waits, FIFO, and that is also what the in-repo precedent does:
 * `dashboard-screenshot.ts`'s render semaphore caps concurrency at 3 and
 * queues, with the same *"excess requests QUEUE (FIFO) and run as permits free
 * up, rather than being rejected"* note. Under this shape a four-predicate
 * render gets four answers, holding at most two connections at a time.
 *
 * Two rather than five, so a forecast storm can never take the last connection:
 * three stay free for the rest of the process no matter how hard this endpoint
 * is pressed.
 */
export const FORECAST_MAX_CONCURRENT = 2;

/**
 * How long a queued forecast waits for a permit before giving up.
 *
 * ⚠️ The queue is BOUNDED, and the bound is what keeps `forecast-busy` a
 * reachable, meaningful outcome rather than dead code. An unbounded queue turns
 * a stuck scan into an unbounded backlog of held HTTP requests - the failure
 * this endpoint's whole design is trying to avoid, moved up one layer.
 *
 * Sized at twice {@link TENSION_FORECAST_STATEMENT_TIMEOUT_SQL}'s 5s, so a
 * waiter outlives the scan ahead of it (which cannot exceed 5s and then
 * releases) but not two of them. A caller that waits longer than that is behind
 * a queue deeper than the endpoint is meant to serve, and an honest refusal is
 * better than a request that eventually answers about a corpus that has moved.
 */
export const FORECAST_QUEUE_WAIT_MS = 10_000;

/**
 * In-flight forecasts in this process, and who is waiting for a permit.
 *
 * Module-level mutable state, which this subsystem otherwise avoids - justified
 * because the thing being counted IS process-global (the pool), so a counter
 * scoped any tighter would not bound it. `lib/dashboard-screenshot.ts` holds the
 * same shape for the same reason, down to the `_renderInFlight()` probe.
 *
 * Released in a `finally`, so a throw cannot leak a permit; a leaked permit is
 * worse than the exhaustion it guards, because it never recovers.
 */
let forecastsInFlight = 0;
const forecastWaiters: (() => void)[] = [];

/**
 * Take a permit, waiting up to {@link FORECAST_QUEUE_WAIT_MS} for one.
 *
 * `false` means the wait expired - the caller must NOT run and must not
 * release. Every path that resolves `true` has already incremented, so the
 * increment and the grant cannot be separated by an `await` and double-spent.
 */
async function acquireForecastPermit(waitMs: number): Promise<boolean> {
  if (forecastsInFlight < FORECAST_MAX_CONCURRENT) {
    forecastsInFlight += 1;
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const grant = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Incremented HERE rather than by the releaser, so the invariant
      // "in-flight never exceeds the cap" is maintained by whoever is about to
      // run, and an expired waiter that races a release cannot leave the count
      // raised with nobody holding it.
      forecastsInFlight += 1;
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const at = forecastWaiters.indexOf(grant);
      if (at >= 0) forecastWaiters.splice(at, 1);
      resolve(false);
    }, waitMs);
    // `unref` where the runtime has it: a pending forecast wait must never be
    // the thing keeping a process alive at shutdown.
    (timer as unknown as { unref?: () => void }).unref?.();
    forecastWaiters.push(grant);
  });
}

/** Give the permit back, handing it straight to the longest waiter if any. */
function releaseForecastPermit(): void {
  forecastsInFlight -= 1;
  forecastWaiters.shift()?.();
}

/** Test seam: in-flight count, for asserting the permit is always returned. */
export function _forecastsInFlight(): number {
  return forecastsInFlight;
}

/** Test seam: queued waiters, so a leaked queue entry is visible too. */
export function _forecastsQueued(): number {
  return forecastWaiters.length;
}

/**
 * Test seam: drop all permits and waiters.
 *
 * ⚠️ Exists because its absence was a review finding: the permit tests shared
 * one module-level counter with no reset, so a failure before a release left
 * every later test in the file answering `forecast-busy`. An end-of-test
 * assertion that the count is zero is a CHECK, not isolation - it tells you
 * the leak happened, after it has already poisoned the run.
 *
 * Waiters are resolved `false` rather than dropped on the floor, so a reset
 * cannot strand a pending promise.
 */
export function _resetForecastPermits(): void {
  forecastsInFlight = 0;
  while (forecastWaiters.length > 0) forecastWaiters.shift();
}

/** What one forecast answered. */
export type TensionForecastOutcome =
  | {
      readonly kind: "forecast";
      /**
       * Edges a sweep in this same instant would WRITE — the number
       * {@link TensionSweepReport.minted} would carry, under both the same caps.
       *
       * Named `wouldMint` rather than `minted` deliberately: the two records
       * are otherwise field-identical, and a log line, a metric or a UI string
       * that reads one as the other reports a write that never happened.
       */
      readonly wouldMint: number;
      /** The run cap bit — {@link TensionSweepReport.truncated}'s meaning exactly. */
      readonly truncated: boolean;
    }
  /**
   * The requested surface norms away to nothing (`-`, `___`, `  `), so it
   * occupies no slot and can arm nothing.
   *
   * ⚠️ Its own arm rather than a `wouldMint: 0`, and the distinction is the one
   * `StructurallyEmptyReason.unkeyable-surface` was added to
   * `vocabulary-preview.ts` to make after its absence shipped as a defect there:
   * *"a request that was never computable rendered as"* a confident zero. A
   * forecast is read as a licence to approve, so a zero that means **"we could
   * not ask your question"** and a zero that means **"approving this mints
   * nothing"** must not be the same value.
   */
  | { readonly kind: "unkeyable-surface" }
  | { readonly kind: "contended"; readonly reason: TensionForecastContention };

/**
 * ⚠️ Compile-time lock: this outcome's two ANSWERING arms and the wire response
 * are the SAME TYPE.
 *
 * `BlastRadius`' pin, for the reason its docstring records at length — the wire
 * type and the engine type here are hand-written twins, not aliases, and the
 * drift is silent in BOTH directions: a field the engine grows is one no client
 * can read and that `z.strictObject` then rejects on the way out, and a field
 * the wire grows is one this module never populates and the schema then demands.
 * That module measured it: a field added to a literal arm compiled COMPLETELY
 * CLEAN and 500'd every request.
 *
 * `contended` is excluded because it is not a 200 — the route maps it to a 409
 * whose body is `ErrorSchema`, so it has no counterpart on this response and
 * including it would make the pin unsatisfiable rather than strict.
 *
 * ⚠️ Stated at the UNION rather than at one arm, which is the correction
 * `BlastRadius`' pin needed: pinning only the numeric arm leaves `kind` and the
 * whole `unkeyable-surface` member unreached, and those are exactly the fields a
 * discriminated union is carrying the weight with.
 */
const _forecastMatchesTheWire: Exact<
  Exclude<TensionForecastOutcome, { kind: "contended" }>,
  BrainFactTensionForecastResponse
> = true;
void _forecastMatchesTheWire;

/**
 * ⚠️ …and the same pin on the REQUEST, which has the opposite failure mode.
 *
 * The wire carries an optional `predicateSurface` and this module takes a
 * discriminated union, so they are deliberately NOT the same type — the route is
 * the translation. What must hold is that every surface the wire can express is
 * one this union has an arm for: `undefined` → `as-curated`, a string →
 * `if-approved`. Asserted by mapping the wire type through the translation the
 * route performs, so a third wire field (a `position`, a workspace override)
 * fails HERE rather than being silently dropped in the handler.
 */
const _forecastRequestIsTotal: Exact<
  keyof BrainFactTensionForecastRequest,
  "predicateSurface"
> = true;
void _forecastRequestIsTotal;

/**
 * How many advisory edges a sweep would mint — asked without minting them
 * (#5450, and the precondition #5425 discharged by hand).
 *
 * ## Read-only, and it does NOT take the reconcile lock
 *
 * {@link sweepTensionEdges} takes namespace 4771 because its `NOT EXISTS`
 * freshness guard has to be sound against a concurrent writer of the same
 * edges. This statement writes nothing, so there is no guard to make sound —
 * and taking the lock would be actively wrong in two ways. It would queue a
 * human's *read* behind an ingest pass, and, worse, it would hold this
 * workspace's reconcile lock for the duration of a preview whose whole purpose
 * is to be run repeatedly and idly before a decision.
 *
 * The price is that the number is a FORECAST rather than a promise: an ingest
 * pass or a correction landing between the read and the press moves it. That is
 * disclosed on {@link TENSION_FORECAST_SQL} rather than closed, because closing
 * it means holding a lock across a human's deliberation.
 *
 * ## The statement bounds ARE kept, both of them
 *
 * The candidate scan is the same unbounded walk over every live fact that
 * `TENSION_SWEEP_STATEMENT_TIMEOUT_SQL` exists to bound — the cap sits on
 * `fresh`, which is the part this statement replaces with a `count(*)`, so the
 * expensive half is untouched. And `lock_timeout` still earns its place: a
 * plain `SELECT` takes `AccessShareLock`, which conflicts with the
 * `AccessExclusiveLock` a migration or an index rebuild holds, so a forecast run
 * during maintenance refuses in 5s rather than sitting for 30.
 *
 * @throws on any database failure that is not one of those two bounds — a
 *   forecast that failed and answered zero is indistinguishable from a corpus
 *   with nothing to mint, which is the reading that would license the approval.
 */
export async function forecastTensionEdges(
  workspaceId: string,
  request: TensionForecastRequest,
  deps: TensionSweepDeps = {},
): Promise<TensionForecastOutcome> {
  // BEFORE the transaction. An unkeyable surface is a property of the request,
  // not of the corpus, so checking it here keeps a pooled connection out of the
  // one case that provably cannot need one.
  let counterfactualKey: string | null = null;
  if (request.kind === "if-approved") {
    counterfactualKey = identityKey(request.predicateSurface);
    if (counterfactualKey === null) return { kind: "unkeyable-surface" };
  }

  // BEFORE the pool is touched. Over the cap this WAITS rather than refusing -
  // see {@link FORECAST_MAX_CONCURRENT}, which records why the refusing version
  // contradicted its own stated requirement.
  const granted = await acquireForecastPermit(deps.queueWaitMs ?? FORECAST_QUEUE_WAIT_MS);
  if (!granted) {
    log.warn(
      { workspaceId, inFlight: forecastsInFlight, cap: FORECAST_MAX_CONCURRENT, queued: forecastWaiters.length },
      "brain tension forecast: gave up waiting for a permit - this process has been at its forecast concurrency cap for the whole wait",
    );
    return { kind: "contended", reason: "forecast-busy" };
  }
  try {
    return await runForecast(workspaceId, counterfactualKey, request, deps);
  } finally {
    // `finally`, so neither a throw nor an early return can leak a permit. A
    // leaked one never recovers: the endpoint would refuse forever with a
    // message telling the operator to wait. The release hands the permit
    // straight to the longest waiter, so a queued caller does not re-poll.
    releaseForecastPermit();
  }
}

/** {@link forecastTensionEdges}' body, once the permit is held. */
async function runForecast(
  workspaceId: string,
  counterfactualKey: string | null,
  request: TensionForecastRequest,
  deps: TensionSweepDeps,
): Promise<TensionForecastOutcome> {
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const outcome = await withTransaction<
    | { readonly kind: "forecast"; readonly wouldMint: number }
    | { readonly kind: "contended"; readonly reason: TensionForecastContention }
  >(async (tx) => {
    await tx.query(TENSION_SWEEP_LOCK_TIMEOUT_SQL);
    await tx.query(TENSION_FORECAST_STATEMENT_TIMEOUT_SQL);
    try {
      const { rows } = await tx.query(TENSION_FORECAST_SQL, [
        workspaceId,
        TENSION_EDGE_CAP,
        TENSION_SWEEP_RUN_CAP,
        counterfactualKey,
      ]);
      // `count(*)` over a CTE always returns exactly one row, so a missing one
      // means the driver or a test double is not answering this statement —
      // which must not read as a converged corpus. Narrowed on the VALUE rather
      // than cast, on `readPredicateCardinality`'s posture: nothing in the
      // executor's type stops `{ rows: [{}] }` reaching here.
      const raw: unknown = (rows as readonly Record<string, unknown>[])[0]?.["would_mint"];
      // ⚠️ The STRING arm is not defensive padding and the `null`/`undefined`
      // rejection is not either — both were failing tests. `count(*)::int` is an
      // int4 the driver parses to a number, but the cast is one edit from being
      // dropped, and bare `count(*)` is int8, which `pg` hands back as a STRING
      // to protect precision; that edit must be a passing test, not a 500.
      // In the other direction, a bare `Number(raw)` coerces `null` to **0** —
      // so a NULL, or a row that does not carry the column at all, would arrive
      // as a confident "approving this mints nothing", which is the one reading
      // this whole outcome type exists to keep unrepresentable.
      const wouldMint =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim() !== ""
            ? Number(raw)
            : Number.NaN;
      if (!Number.isInteger(wouldMint) || wouldMint < 0) {
        throw new Error(
          `brain tension forecast: the count statement answered ${String(raw)}, which is not a row count`,
        );
      }
      return { kind: "forecast", wouldMint };
    } catch (err: unknown) {
      // The sweep's arms, in the sweep's order, minus the acquisition it never
      // makes. `57014` FIRST for the reason it is first there: a cancel and a
      // time-bound expiry share the SQLSTATE and only the `where` field
      // separates a lock wait from a statement that was simply running.
      if (isStatementTimeout(err)) {
        log.warn(
          { workspaceId, code: pgCode(err), where: pgWhere(err), err: errorMessage(err) },
          "brain tension forecast: the candidate scan did not finish (57014 — a time-bound expiry or a cancel; Postgres does not distinguish them, so read `err` for which)",
        );
        return { kind: "contended", reason: "unfinished" };
      }
      if (isLockTimeout(err)) {
        log.warn(
          { workspaceId, code: pgCode(err), where: pgWhere(err), err: errorMessage(err) },
          "brain tension forecast: timed out taking a read lock on this workspace's facts — most often a migration or an index build; the SQLSTATE does not say which",
        );
        return { kind: "contended", reason: "conflicting-lock" };
      }
      throw err;
    }
  }).catch((err: unknown) => {
    // Re-thrown rather than degraded to a zero, and the stake is higher than it
    // is for the sweep: the sweep's degraded zero would be read as "nothing to
    // do", where a forecast's would be read as "approving this is free".
    log.error(
      { workspaceId, code: pgCode(err), err: errorMessage(err) },
      "brain tension forecast: the read failed — no number was produced and nothing was written",
    );
    throw err;
  });

  if (outcome.kind === "contended") return { kind: "contended", reason: outcome.reason };

  // The SAME derivation the sweep's report uses, so a forecast and the press
  // that follows it cannot disagree about the flag. Constructed through
  // `tensionSweepReport` rather than re-deriving `>= RUN_CAP` here — that
  // function's docstring says a second truncation source has one place to be
  // taught, and this is the second reader it was written for.
  const { minted, truncated } = tensionSweepReport(outcome.wouldMint);
  log.info(
    {
      workspaceId,
      wouldMint: minted,
      truncated,
      counterfactual: request.kind === "if-approved",
      perFactCap: TENSION_EDGE_CAP,
      runCap: TENSION_SWEEP_RUN_CAP,
    },
    "brain tension forecast: counted the advisory edges a sweep would mint — nothing was written",
  );
  return { kind: "forecast", wouldMint: minted, truncated };
}

/**
 * The one construction point for a {@link TensionSweepReport}.
 *
 * `truncated` is DERIVED, never passed in. It is a pure function of `minted` and
 * the run cap, and a record that stores both admits `{minted: 0, truncated:
 * true}` and `{minted: RUN_CAP, truncated: false}` — states the producer cannot
 * emit and a reader cannot interpret. Routing every construction through here
 * means a second truncation source (a time budget, a second cap) has one place
 * to be taught rather than a grep to find.
 */
function tensionSweepReport(minted: number): TensionSweepReport {
  return { minted, truncated: minted >= TENSION_SWEEP_RUN_CAP };
}

/**
 * Postgres' SQLSTATE off an unknown thrown value, or `undefined`.
 *
 * Narrowed rather than cast, on `isLockTimeout`'s shape — the value reaching
 * these handlers is whatever the driver threw, which is not necessarily an
 * `Error` and not necessarily an object.
 *
 * EXPORTED for its test and nothing else. Round 1 added it to four log sites and
 * shipped it with no falsifier: the test that claimed to cover it asserted only
 * that a thrown value propagated, so deleting every `code:` field, or making
 * this return `undefined` always, stayed green. A direct assertion is cheaper
 * than a logger double and kills all three mutations.
 */
export function pgCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Postgres' CONTEXT field off an unknown thrown value, or `undefined`.
 *
 * `pg` surfaces the server's CONTEXT as `DatabaseError.where`, and for a `55P03`
 * it is the ONLY thing separating a row-lock wait (`… while locking tuple in
 * relation "brain_facts"`) from a relation-level one — `.message` is the bare
 * `canceling statement due to lock timeout` in both, measured against this
 * repo's PG 16. Narrowed rather than cast, on {@link pgCode}'s shape.
 *
 * Server-generated and safe to log: it names a relation and echoes the
 * referential-integrity statement, neither of which can carry a credential the
 * way a connection string can.
 *
 * EXPORTED for its test, like {@link pgCode} — and for the same lesson, which
 * this helper reproduced one round later: `pgCode` shipped unfalsified in round
 * 1, was given a direct assertion in round 2, and round 3 then added this
 * same-shape sibling with no test at all. Instance closed, class reopened one
 * helper over.
 */
export function pgWhere(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("where" in err)) return undefined;
  const where = (err as { where?: unknown }).where;
  return typeof where === "string" ? where : undefined;
}

/**
 * Postgres' SQLSTATE for a transaction chosen as a deadlock victim.
 *
 * Reachable here because the INSERT takes ROW locks (`FOR KEY SHARE` on both
 * endpoint rows, via `brain_edges`' composite FKs) that can cycle with a
 * concurrent publish's `FOR UPDATE` — see `sweepTensionEdges`' ⚠️ on why the
 * advisory-lock ordering argument does not cover this.
 */
const DEADLOCK_DETECTED = "40P01";

/**
 * Postgres' SQLSTATE for a cancelled statement.
 *
 * ⚠️ NOT "a `statement_timeout` expiry", which is what this said first and is
 * one member of the class. `pg_cancel_backend` raises it too. The name is the
 * honest one; see {@link isStatementTimeout}.
 */
const QUERY_CANCELED = "57014";

/**
 * Whether an unknown error is a cancelled statement — `57014`.
 *
 * ⚠️ The NAME says timeout and the class is wider, which is a wart kept
 * deliberately: it reads at the call site as the bound it pairs with
 * (`TENSION_SWEEP_STATEMENT_TIMEOUT_SQL`), and renaming it to
 * `isQueryCanceled` would suggest a discrimination the function does not make
 * either. The summary line no longer claims one.
 *
 * ⚠️ `57014` is `query_canceled` GENERALLY — `pg_cancel_backend` raises it too,
 * and Postgres offers no SQLSTATE that separates them. Both mean the same thing
 * to THIS caller — the statement did not finish and nothing was written — which
 * is why the conflation is safe here.
 *
 * ⚠️ It is only safe as long as the REFUSAL says the same thing. The
 * `unfinished` message is written to be true of both members precisely because
 * this predicate cannot tell them apart; a message that assumed the timeout
 * would be wrong for every cancel, and that mismatch is what a reviewer caught
 * in this function's first cut.
 */
function isStatementTimeout(err: unknown): boolean {
  return pgCode(err) === QUERY_CANCELED;
}
