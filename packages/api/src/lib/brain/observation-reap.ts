/**
 * Reaping observations of rows the entity filter no longer counts (#5344,
 * [ADR-0042](../../../../../docs/adr/0042-warehouse-material-is-an-observation-never-a-published-belief.md)).
 *
 * #5329 gave an entity a `filter:`, so a churned customer stops being read as a
 * current row of the business. That is the EMISSION half. This module is the
 * CORPUS half: what happens to the observations already minted from rows the
 * filter now excludes, and to the `in-tension-with` edges they minted against
 * live claims.
 *
 * ## Why this is a delete and not a retirement
 *
 * `brain_facts` is *invalidate-never-delete*, and every word of that policy is
 * about BELIEFS: a claim somebody made, that a human blessed, that an `asOf`
 * read still has to answer correctly. ADR-0042 put observations outside that
 * population — nobody approved one, nothing serves one, and removing one
 * overturns no human decision. So the answer is *stop emitting and reap*, with
 * no correction verb, no `valid_to` stamp and no tombstone: every one of those
 * is belief machinery, and routing an observation through it would assert that
 * somebody decided something.
 *
 * ⚠️ **This is the first production DELETE against `brain_facts`, and the
 * population it may touch is fenced three ways rather than one.** A row is
 * reapable only if it is an OBSERVATION by its own stored provenance
 * ({@link observationSql}), only if its creating episode is a warehouse
 * snapshot of THIS entity, and only if it is still `draft`. Miss any one of
 * them and the statement deletes a belief. The `draft` arm is the narrowest and
 * the least obvious — see {@link OBSERVATION_REAP_SQL}.
 *
 * ## ⚠️ The rule is BROADER than "the filter excludes the row"
 *
 * The heading above this module says *filter*, and the ticket that asked for it
 * is about churn — but the predicate below is **"not seen by the last N
 * successful runs"**, and those are not the same set. A run can succeed and
 * still produce no provenance edge for a row that is present and counted:
 * `collidingSubjectRows`, `unsurfaceableKeyRows`, `unsurfaceableCells` and a
 * `reconcile` block all warn rather than refuse, so the run records success with
 * that row unrepresented.
 *
 * Worked example: someone alters a `status` column to `jsonb`, so every cell
 * becomes unsurfaceable. Three successful runs later this statement deletes every
 * `status` observation of that entity **and the tension edges they carried
 * against live human beliefs**, though nothing churned and no filter changed.
 *
 * That is survivable and deliberately not refused here — the next good run
 * re-mints the observations, beliefs are fenced out of the delete, and refusing
 * to reap on any warning would leave churned rows in the comparison surface
 * indefinitely, which is the defect #5344 exists to close. It is written down
 * because the module's name and its ticket both suggest a narrower rule than the
 * one it implements, and an operator reading an emptied comparison surface after
 * a schema change deserves to find this paragraph rather than infer a bug.
 *
 * Whether to suppress the reap while `unsurfaceableCells > 0` is a real question
 * and is deliberately NOT decided here.
 *
 * ## The reach rule is the store's, not a second one
 *
 * *Reap what that entity's last N successful runs did not see.* The window is
 * {@link WAREHOUSE_SUCCESS_WINDOW_CTE}, the same text
 * `reapUnreachedEntityEntries` opens with, and N is the same constant. Two
 * spellings of "this left reach" is how the store and the corpus come to
 * disagree about which rows are gone — the corpus reaping a row the store still
 * resolves, or the reverse — and #5344 asks for the shape to be reused for
 * exactly that reason.
 *
 * What differs is the LEFT side of the comparison, and it has to: the store's
 * is `brain_entity.snapshot_at`, rewritten wholesale on every committing run.
 * A fact has no such column. See {@link OBSERVATION_REAP_SQL}.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { observationSql } from "@atlas/api/lib/brain/observation";
import { episodeSourceArraySql, WAREHOUSE_SOURCES } from "@atlas/api/lib/brain/sources";
import {
  reapWindowSize,
  WAREHOUSE_SUCCESS_WINDOW_CTE,
} from "@atlas/api/lib/brain/warehouse-run-record";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";

const log = createLogger("brain-observation-reap");

/**
 * The warehouse vocabulary as a SQL `text[]` literal, for the EPISODE side.
 *
 * `observation.ts` builds the same array for the `provenance->>'source'` side
 * and keeps it private; both go through {@link episodeSourceArraySql}, which is
 * the single spelling of the splice and the reason neither needs to think about
 * escaping. Nothing user-supplied reaches it — every element is a compile-time
 * key of the source spec map.
 */
const WAREHOUSE_EPISODE_SOURCES_SQL = episodeSourceArraySql(WAREHOUSE_SOURCES);

/**
 * The entity a warehouse episode was minted for, recovered from its `source_id`
 * — `warehouseEpisodeSourceId`'s inverse, in SQL.
 *
 * ⚠️ **A THIRD spelling of one format, and it is here rather than beside the
 * builder because it is SQL.** `warehouseEpisodeSourceId` builds
 * `warehouse:<entity>@<iso>` and `parseWarehouseEpisodeEntity` reads it back;
 * this is the same parse expressed as a POSIX regex, and
 * `observation-reap-pg.test.ts` drives BOTH over one corpus of entity names so
 * the two cannot answer differently.
 *
 * Greedy `(.*)` before the last `@`, matching `parseWarehouseEpisodeEntity`'s
 * `lastIndexOf`: an ISO-8601 instant contains no `@`, so everything after the
 * final one is the timestamp and everything before it is the entity. A
 * non-greedy match — or the `LIKE 'warehouse:' || $2 || '@%'` this could have
 * been — attributes an entity named `org@eu`'s episodes to an entity named
 * `org`, and the consequence here is not a mis-labelled log line: it is reaping
 * one entity's observations under another entity's success window. `LIKE` is
 * also wrong on a second count, and the commoner one — `_` is a metacharacter
 * and `billing_account` is an ordinary entity name.
 *
 * A capture compared for EQUALITY against a bind, never a pattern built from
 * one, so no entity name can be a metacharacter anywhere.
 */
const EPISODE_ENTITY_SQL = `substring(se.source_id from '^warehouse:(.*)@[^@]*$')`;

/**
 * Reap this entity's stranded observations, and every edge that hung off them.
 *
 * ## What "stranded" means, and why it is not the fact's own timestamp
 *
 * The obvious left side is `brain_facts.extracted_at`, and it is wrong. A run
 * that re-reads an UNCHANGED row does not mint a second fact — the corroboration
 * lookup finds the live one and `reconcile.ts` attaches a provenance edge,
 * deliberately changing nothing about the fact itself. So `extracted_at` on a
 * perfectly current observation stays pinned at the instant it was FIRST seen,
 * for as long as the row survives, and a rule keyed on it would reap the whole
 * comparison surface on the third run of every entity. Measured against the
 * corroboration path, not reasoned from the column name.
 *
 * The signal that actually moves is therefore the EVIDENCE: `last_seen` is the
 * newest warehouse episode still hanging off this observation by a `provenance`
 * edge, floored at its own creating episode for a row that somehow has no edge
 * (a region import, which carries facts and episodes but mints no edges). A row
 * in the filtered snapshot earns a fresh edge every run; a row the filter now
 * excludes earns none, and ages out.
 *
 * `GREATEST` ignores NULLs, so an observation with neither an edge nor an
 * `occurred_at` yields NULL, `NULL < gate.oldest` is unknown, and the row
 * survives. Fail-closed, and deliberately: the rule deletes on positive
 * evidence of absence, never on missing evidence.
 *
 * ⚠️ **`pe.source` is warehouse-class, and that arm is still load-bearing —
 * #5332 changed WHY, not whether.** It used to be the live case: an extractor
 * claim agreeing with an observation corroborated it and attached a CHAT
 * episode as evidence, so without this arm a Slack message would have held a
 * reading alive that the warehouse had stopped returning.
 *
 * #5332 closed the mint — `CORROBORATION_LOOKUP_SQL` excludes observations
 * unless the incoming claim is itself one, so a person agreeing with a reading
 * now gets their own draft and edges nothing onto the observation. What it did
 * NOT do is rewrite history: every such edge minted before that fix is still on
 * the corpus, and #5332's recorded decision was to LEAVE them rather than
 * re-mint the swallowed claims as drafts — the grounds, the enumeration query
 * and the falsifiers are in `docs/development/brain-swallowed-testimony.md`
 * (that doc is the decision record; ADR-0042 states the rule, not this
 * disposition). This arm IS what that decision rests on. Drop it and those
 * exact rows become permanently unreapable, which is the one thing the
 * "self-clearing population" argument requires not to happen.
 *
 * So the reading to avoid is *"#5332 landed, this is dead code"*. It is the
 * live handling of a bounded, closed population — and the argument holds
 * unchanged for any future non-warehouse edge onto an observation, which is why
 * it is expressed as a class arm rather than as a date.
 *
 * The evidence side is deliberately NOT scoped to `$2`: any warehouse read that
 * still saw this claim keeps it, whichever entity performed it. Two entities can
 * mint into one slot (corroboration matches on slot keys, never on entity), and
 * the safe direction for a shared observation is that BOTH have to stop seeing
 * it. The population side is scoped, so the run that licenses the reap is still
 * that entity's own.
 *
 * ## The three fences on the population
 *
 * `observationSql("f")` — the row's OWN stored provenance says warehouse-class.
 * Without it the statement reaps a published human belief that a warehouse
 * episode once corroborated, which is a live shape today.
 *
 * `se.source`/`{@link EPISODE_ENTITY_SQL}` — the row was MINTED by this
 * entity's producer. `source_episode_id` is single-valued and immutable, which
 * is what makes "whose observation is this" answerable at all.
 *
 * `f.status = 'draft'` — no human ever blessed it. ADR-0042 makes every
 * observation structurally `draft` and #5342 makes the publish gate refuse one,
 * so this arm is a no-op on everything minted since. It exists for the two rows
 * that predate the gate: ADR-0042 gives those a narrow `retract`, a verb a
 * PERSON uses, and a machine deleting a row a person published is exactly the
 * irreversible half #5329 flagged and this ticket's own framing disclaims.
 *
 * ## The edges are deleted by name, not left to the FK
 *
 * `brain_edges`' endpoint FKs are `ON DELETE CASCADE`, so the edges would go
 * anyway. Naming them buys three things a cascade does not: the count reaches
 * the operator's audit line for an irreversible delete; #5344's *"in the same
 * transaction"* is a property of the statement rather than of a constraint two
 * files away; and a migration that ever weakens the FK turns a silent
 * regression into no change at all. Both directions, and every type — an
 * `in-tension-with` edge POINTING AT a reaped observation is the reader-facing
 * failure the ticket describes (a live belief marked contested by a reading
 * nobody counts), and it is minted by the counterpart rather than by the
 * observation.
 *
 * ## Bind contract
 *
 * `$1` workspace, `$2` entity, `$3` N — {@link WAREHOUSE_SUCCESS_WINDOW_CTE}'s
 * order, which this statement inherits and must keep.
 *
 * Exported so a unit test dispatches on the EXACT bytes and the `-pg` suite runs
 * it against the live schema — `reconcile.ts`'s convention, for its reason: a
 * test that matches a paraphrase stays green against a statement that was
 * edited.
 */
export const OBSERVATION_REAP_SQL = `WITH ${WAREHOUSE_SUCCESS_WINDOW_CTE}
  , stale AS (
    SELECT f.id
      FROM brain_facts f
      JOIN brain_episodes se
        ON se.workspace_id = f.workspace_id
       AND se.id = f.source_episode_id
      CROSS JOIN gate
      LEFT JOIN brain_edges g
        ON g.workspace_id = f.workspace_id
       AND g.edge_type = 'provenance'
       AND g.from_fact_id = f.id
      LEFT JOIN brain_episodes pe
        ON pe.workspace_id = g.workspace_id
       AND pe.id = g.to_episode_id
       AND pe.source = ANY (${WAREHOUSE_EPISODE_SOURCES_SQL})
     WHERE f.workspace_id = $1
       AND gate.n >= $3::bigint
       AND f.status = 'draft'
       AND ${observationSql("f")}
       AND se.source = ANY (${WAREHOUSE_EPISODE_SOURCES_SQL})
       AND ${EPISODE_ENTITY_SQL} = $2
     GROUP BY f.id, se.occurred_at, gate.oldest
    HAVING GREATEST(max(pe.occurred_at), se.occurred_at) < gate.oldest
  ), dropped_edges AS (
    DELETE FROM brain_edges g
     USING stale
     WHERE g.workspace_id = $1
       AND (g.from_fact_id = stale.id OR g.to_fact_id = stale.id)
    RETURNING g.id, g.edge_type
  ), dropped_facts AS (
    DELETE FROM brain_facts f
     USING stale
     WHERE f.workspace_id = $1
       AND f.id = stale.id
    RETURNING f.id
  )
  SELECT 'fact' AS kind, id::text AS id, NULL::text AS edge_type FROM dropped_facts
   UNION ALL
  SELECT 'edge' AS kind, id::text AS id, edge_type FROM dropped_edges`;

/** What one entity's reap removed. */
export interface ObservationReapResult {
  /**
   * The observations deleted, by id.
   *
   * Ids rather than a count, on `reapUnreachedEntityEntries`' terms: an
   * irreversible DELETE that reports only a number is one an operator cannot
   * audit after the fact. Ids rather than SUBJECTS, unlike the store's
   * `key_norm`, because a fact's subject is the customer's own data and this
   * line goes to the server log — the id resolves to the row for anyone with
   * database access, and to nothing for anyone without it.
   */
  readonly factIds: readonly string[];
  /** Every edge that hung off a reaped observation, in either direction. */
  readonly edgesRemoved: number;
  /**
   * The `in-tension-with` subset — the half a READER would have noticed.
   *
   * Counted separately because it is the failure #5344 is named for: an edge
   * left behind after its counterpart is reaped tells a person their live
   * belief is contested by something they cannot open.
   */
  readonly tensionEdgesRemoved: number;
}

/** The result of a reap that removed nothing — the ordinary outcome. */
const NOTHING_REAPED: ObservationReapResult = Object.freeze({
  factIds: Object.freeze([]),
  edgesRemoved: 0,
  tensionEdgesRemoved: 0,
});

/**
 * How many ids a log line carries — `entity-store.ts`'s constant and its reason
 * (an irreversible DELETE reporting only a count is one nobody can audit after
 * the fact; the COUNT beside the sample is always exact, so a truncated sample
 * never reads as the whole story).
 *
 * ⚠️ **Deliberately NOT hoisted the way `WAREHOUSE_REAP_AFTER_SUCCESSFUL_RUNS`
 * was, and the distinction is the point rather than an inconsistency.** That
 * constant is a RULE: the two reapers disagreeing about it means they disagree
 * about which rows are gone, which is a behaviour difference with no inverse.
 * This is a DISPLAY CAP on a log line. The two copies drifting costs a reader
 * five more digests in one payload than in another, and hoisting it would put a
 * logging detail in a module about the success table — or force an import edge
 * between two reapers that deliberately share nothing but the window.
 */
const LOGGED_ID_SAMPLE = 20;

/**
 * Reap one entity's observations whose rows have left the filtered snapshot.
 *
 * ⚠️ **Per entity, and keyed on that entity's OWN successful runs.** A failed or
 * refused run records no success, so the window never advances and nothing is
 * reaped — an outage cannot empty the comparison surface. That is #5344's second
 * acceptance criterion and it is inherited whole from the window, not
 * re-implemented here.
 *
 * ⚠️ **Must run in the entity's own transaction, AFTER its success record**, for
 * `reapUnreachedEntityEntries`' two reasons: the run about to license a
 * reap has to be inside the window the reap reads, and a rollback has to take
 * the deletion with the evidence that licensed it.
 *
 * ⚠️ **Unlike the store's reaper, this one DOES work on the reconcile arm.** The
 * store's is a no-op there by construction — that arm has just rewritten every
 * entry at the run's own `snapshot_at`. A fact is not rewritten; a row still in
 * the snapshot gets a fresh evidence edge and a row that left gets nothing, so
 * the arm where an entity still emits is exactly where an excluded row shows up.
 */
export async function reapUnreachedObservations(
  tx: ReconcileExecutor,
  params: {
    readonly workspaceId: string;
    readonly entity: string;
    /** Test-only seam; clamped by {@link reapWindowSize}. */
    readonly afterSuccessfulRuns?: number;
  },
): Promise<ObservationReapResult> {
  const { workspaceId, entity } = params;
  const n = reapWindowSize(params.afterSuccessfulRuns);
  const { rows } = await tx.query(OBSERVATION_REAP_SQL, [workspaceId, entity, n]);

  const factIds: string[] = [];
  let edgesRemoved = 0;
  let tensionEdgesRemoved = 0;
  for (const row of rows) {
    // Total over driver output, on `readDroppedRows`' terms: this is a
    // `RETURNING` reader, and a statement edited to rename a column must report
    // nothing rather than report `undefined` as a deletion.
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || id === "") continue;
    if (record.kind === "fact") {
      factIds.push(id);
      continue;
    }
    if (record.kind !== "edge") continue;
    edgesRemoved++;
    if (record.edge_type === "in-tension-with") tensionEdgesRemoved++;
  }

  if (factIds.length === 0 && edgesRemoved === 0) return NOTHING_REAPED;

  log.warn(
    {
      workspaceId,
      entity,
      reaped: factIds.length,
      reapedIds: factIds.length <= LOGGED_ID_SAMPLE ? factIds : factIds.slice(0, LOGGED_ID_SAMPLE),
      edgesRemoved,
      tensionEdgesRemoved,
      afterSuccessfulRuns: n,
    },
    "Warehouse producer: reaped observations whose rows have not been in this entity's filtered " +
      "snapshot for N consecutive successful reads, and every edge that hung off them — the " +
      "comparison surface stops holding readings of rows nobody counts",
  );

  return { factIds, edgesRemoved, tensionEdgesRemoved };
}
