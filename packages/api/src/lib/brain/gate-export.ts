/**
 * Gate-decision export — the review gate's decisions, as an EVALUATION corpus
 * (#5335, milestone "v0.2.x — The Extraction Cascade").
 *
 * The data already exists, unexported, as a consequence of the review gate
 * being mandatory: `brain_facts.source_episode_id` is a composite FK onto
 * `brain_episodes(workspace_id, id)` (migration 0180), so the
 * `(episode text → human decision)` pair is one join and not a labelling
 * project.
 *
 * ## ⚠️ EVALUATION ONLY — this is never a training corpus
 *
 * ADR-0043 (#5339) records the two training prohibitions: brain facts are
 * never trained into weights, and **customer data is never a training
 * corpus**. Models memorise, and "low probability of verbatim leakage" is not
 * the standard commitment 7 sets. The distilled extractor (#5337) trains on
 * public corpora plus our own workspace and never on a bundle this module
 * cuts.
 *
 * The asymmetry that makes this defensible: evaluation data is read once and
 * discarded, training data ends up in the weights. So #5338 may measure
 * stage-1 recall and gate agreement against real reviewed decisions while the
 * training corpus stays entirely non-customer. Every bundle carries
 * {@link EVALUATION_ONLY_NOTICE} in its header so the next reader cannot
 * mistake it — the notice is data in the file, not a comment in this source.
 *
 * ## A bundle is outside `purge-scope.ts` BY CONSTRUCTION
 *
 * That is the same objection #5339 raises against weights, and it is why a
 * bundle is cut for a NAMED evaluation and then destroyed, rather than
 * accumulated. Nothing here writes a bundle to durable storage or registers it
 * anywhere; the operator command holds the file and the operator destroys it.
 * What this module CAN guarantee is the other direction, and
 * `gate-export-pg.test.ts` pins it: a purged workspace exports zero rows,
 * because `brain_facts` and `brain_episodes` are both `purged` in
 * `purge-scope.ts` and this module reads nothing else.
 *
 * ## What a "decision" is here, which is not what the issue's first draft said
 *
 * `brain_facts.status` is `draft | published | archived` — there is no
 * `rejected` status, and looking for one is the first wrong turn. The review
 * gate's negative verb stamps `invalidated_at` and NEVER writes `status`
 * (`admin-brain-facts.ts`'s `POST /:id/retract`, the `retract` correction verb
 * since #4915): ADR-0036 makes withdrawal a tombstone rather than a demotion,
 * so a retracted claim stays readable to an as-of query while leaving the
 * review queue. Approval is the atomic publish endpoint, the single writer of
 * `status`.
 *
 * So the three classes read off two columns, not one:
 *
 * | Class      | Predicate                                                     |
 * |------------|---------------------------------------------------------------|
 * | `positive` | `status = 'published' AND invalidated_at IS NULL`              |
 * | `rejected` | tombstoned AND carrying a human correction episode (see below) |
 * | `negative` | extracted episode holding no claim except `archived` ones      |
 *
 * ⚠️ **`rejected` is not simply `invalidated_at IS NOT NULL`**, and the first
 * cut of this module assumed it was. `retract` is not that column's only
 * writer: `admin-migrate.ts` lands unkeyable region-imported facts tombstoned
 * (#5047), and migration 0194 did the same in place. Those are import
 * artifacts, not human decisions, and admitting them would label claims no
 * reviewer ever saw as rejections — poisoning the very measurement #5338 is
 * meant to trust. {@link GATE_REJECTED_PREDICATE} therefore tests the POSITIVE
 * evidence of the human act: the `derives-from` edge to the correction episode
 * a retraction materializes.
 *
 * The classes are disjoint and each row is one `(episode, decision, fact?)`
 * triple, which is why `fact` is null on exactly the `negative` arm. One
 * episode can appear on several rows — a reviewer who published one claim and
 * retracted another from the same message produced two decisions, and both are
 * signal.
 *
 * `negative` is the subtle arm — see {@link GATE_OCCUPIES_SLOT_PREDICATE} for
 * the full reasoning. In short: it asserts the extractor produced nothing a
 * reviewer promoted AND nothing is pending, so any non-archived claim on the
 * episode disqualifies it, while an episode whose only claims are `archived`
 * qualifies (the spec's wording is *"yielded no promoted fact"*, and an
 * archived claim was not promoted).
 *
 * ## Warehouse observations are excluded, because they were never decisions
 *
 * ADR-0042: a warehouse reading is a machine reading of a column, never
 * reviewed and never publishable — the publish gate has refused
 * warehouse-derived promotions since #5342, and `candidates.ts` excludes these
 * rows from the review queue at every status. A human made no call on them.
 * Carrying them would put rows in an evaluation corpus that no gate ever
 * judged, and every measurement built on it would be diluted by a population
 * whose "decision" was a foregone conclusion. Both grains are excluded, using
 * `observation.ts`'s own predicates rather than a fourth spelling of the
 * vocabulary: {@link notAnObservationSql} on the fact and
 * {@link notAWarehouseEpisodeSql} on the episode.
 *
 * ## Refusals are fail-closed
 *
 * {@link GATE_EXPORT_REFUSALS} enumerates them. Two are the issue's acceptance
 * criteria and one is the precondition they both assume; each returns a
 * refusal the caller renders, never a partial bundle. A partial export is the
 * dangerous outcome here — an operator who asked for a workspace and received
 * *some* of it has a corpus whose gaps are invisible and whose measurements
 * are silently wrong.
 */
import { createLogger } from "@atlas/api/lib/logger";
import {
  parseGrant,
  aclVisibilityClause,
  type BrainPrincipalContext,
} from "@atlas/api/lib/brain/acl";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import {
  notAnObservationSql,
  notAWarehouseEpisodeSql,
} from "@atlas/api/lib/brain/observation";
import { HUMAN_SOURCE } from "@atlas/api/lib/brain/sources";

const log = createLogger("brain-gate-export");

/**
 * The database handle this module needs.
 *
 * Structurally satisfied by `InternalPoolClient`, `pg.Pool` and `pg.PoolClient`,
 * so callers pass their existing handle straight through and tests pass a
 * literal with no `mock.module()` and no singleton to mutate. Mirrors
 * `BrainCandidateReader` in `candidates.ts`.
 */
export interface GateExportReader {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: readonly unknown[]; rowCount?: number | null }>;
}

/**
 * The header every bundle carries, verbatim.
 *
 * In the FILE, not merely in this source: a bundle outlives the process that
 * cut it and will be read by someone who never opened this module. #5339 is
 * the ADR it points at.
 */
export const EVALUATION_ONLY_NOTICE =
  "EVALUATION ONLY — never a training corpus. Atlas brain facts are never trained " +
  "into model weights, and customer data is never a training corpus (ADR-0043, " +
  "issue 5339). This bundle exists to MEASURE a pipeline (issue 5338: stage-1 " +
  "recall and gate agreement), which reads it once and discards it. It is outside " +
  "purge-scope.ts by construction, so cut it for a named evaluation and destroy it " +
  "afterwards — do not accumulate bundles, and do not fine-tune on this file.";

/** The three gate outcomes a bundle distinguishes. */
export const GATE_DECISION_CLASSES = ["positive", "rejected", "negative"] as const;
export type GateDecisionClass = (typeof GATE_DECISION_CLASSES)[number];

/**
 * Why an export refused. Every one is fail-closed — the caller renders the
 * refusal and writes no file.
 */
export const GATE_EXPORT_REFUSALS = {
  /**
   * The workspace is resident in another region (ADR-0024). The process IS the
   * region, so a bundle cut here for a workspace whose `organization.region`
   * names somewhere else would move tenant content across a boundary the whole
   * residency model exists to hold — and it would do so through a file, which
   * is portable by nature and which no later routing decision can recall.
   */
  regionBoundary: "region-boundary",
  /**
   * At least one row carries a `visible_to` token outside the grant grammar
   * (`acl.ts`). Grants travel with the rows or the rows do not leave: an
   * episode's `visible_to` is not decoration in an exported bundle, and a
   * token this deployment cannot parse is one whose audience it cannot state.
   * Refusing the WORKSPACE rather than dropping the row is deliberate — a
   * bundle silently missing its unrepresentable rows is a corpus whose gaps
   * are invisible.
   */
  unrepresentableGrant: "unrepresentable-grant",
} as const;

/**
 * ⚠️ There is deliberately NO `unknownWorkspace` refusal, and the reason is
 * that it cannot be told apart from the state acceptance criterion 5 requires.
 *
 * A purged workspace must export ZERO ROWS rather than refuse — the exporter
 * must not be able to resurrect deleted content, and "refused" is not "nothing
 * to export". But `hardDeleteWorkspace` removes the `organization` row too, so
 * after a purge a purged workspace and a mistyped id are byte-identical to
 * every query this module can run. A refusal keyed on "no such workspace"
 * would therefore fire on the purged case and break the criterion.
 *
 * What protects the operator from a typo instead is LOUDNESS, not a refusal:
 * an empty bundle is reported as an explicit warning by the operator command
 * rather than as a quiet success. See `ops-gate-export.ts`.
 */

export type GateExportRefusalCode =
  (typeof GATE_EXPORT_REFUSALS)[keyof typeof GATE_EXPORT_REFUSALS];

export interface GateExportRefusal {
  readonly refusal: GateExportRefusalCode;
  /** Operator-facing prose: what happened and what to do instead. */
  readonly detail: string;
}

/**
 * The episode half of a triple — tier-3 raw evidence, the extractor's INPUT.
 *
 * An explicit projection and never `SELECT *`, on `export.ts`'s reasoning: a
 * column added to `brain_episodes` later must be a deliberate decision to
 * export, not a silent consequence of a migration. `extraction_batch_id` is
 * the live example of a column that must never ride — it is a vendor handle
 * only the source region's key can poll.
 */
export interface GateExportEpisode {
  readonly id: string;
  readonly source: string;
  readonly sourceId: string;
  readonly sourceActor: string | null;
  readonly body: string | null;
  readonly locator: string | null;
  readonly occurredAt: string | null;
  readonly ingestedAt: string;
  readonly extractedAt: string | null;
  readonly visibleTo: readonly string[];
}

/**
 * The fact half — the claim a human ruled on. Null on the `negative` arm,
 * where the decision is that the extractor proposed nothing at all.
 *
 * `provenance` is NOT carried whole, and that is the secret-exclusion arm of
 * the acceptance criteria rather than an incidental narrowing. The column is
 * `jsonb` and for warehouse-derived facts it holds a PINNED SQL statement plus
 * a data snapshot; a `SELECT provenance` would put arbitrary
 * operator-authored SQL and its result set into a file that leaves the
 * machine. What an evaluation needs from provenance is who said it and where —
 * so `actor` and `sourceId` are projected by name and nothing else is. The
 * settings-audit posture (issue 5270) is the bar: a value that could be secret
 * does not travel because it was not enumerated.
 */
export interface GateExportFact {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly status: string;
  readonly extractedAt: string | null;
  readonly invalidatedAt: string | null;
  /**
   * When the review gate APPROVED this claim (#5591, migration 0214) — the
   * positive verb's timestamp, and the counterpart to `invalidatedAt`.
   *
   * ⚠️ NULL is common and permanent, not a gap waiting to be filled. Every fact
   * published before 0214 reads NULL, and so does every region-imported fact,
   * whose approval happened in another region and is not carried by the bundle.
   * Read it as "not datable" — never as zero, and never as "approved at epoch".
   * The corpus is therefore datable going FORWARD only, which is exactly what
   * #5338's held-out manifest works around by owning the decision label itself.
   */
  readonly publishedAt: string | null;
  readonly visibleTo: readonly string[];
  readonly actor: string | null;
  readonly provenanceSourceId: string | null;
}

/** One `(episode, decision, fact?)` triple. */
export interface GateDecision {
  readonly decision: GateDecisionClass;
  readonly episode: GateExportEpisode;
  readonly fact: GateExportFact | null;
}

/**
 * Gate analytics — the half of this ticket that delivers value before any
 * model work exists (acceptance criterion 7).
 *
 * Derived from the SAME query as the bundle, deliberately: an analytics panel
 * built on a second, similar query is a panel that can disagree with the
 * corpus it claims to describe, and the disagreement would show up as an
 * unexplained gap between what the oversight page says the gate did and what
 * #5338 measures it doing.
 */
export interface GateAnalytics {
  readonly positives: number;
  readonly rejected: number;
  readonly negatives: number;
  /**
   * Decided claims that were published, over all decided claims
   * (`positives / (positives + rejected)`), rounded to three places.
   *
   * Null when nothing has been decided — NOT zero. A workspace whose reviewer
   * has not started reads "no decisions yet"; rendering that as a 0% approval
   * rate would report a reviewer who rejects everything, which is a different
   * and alarming state.
   */
  readonly approvalRate: number | null;
  /** Predicates ranked by rejection count — where the extractor misfires most. */
  readonly topRejectedPredicates: readonly {
    readonly predicate: string;
    readonly rejections: number;
  }[];
  /**
   * Median hours from a claim's extraction to its RETRACTION, over rejected
   * claims carrying both stamps.
   *
   * ⚠️ Retraction, not "decision", and the narrower name is the honest one. An
   * approval leaves no timestamp of its own: publish writes `status` and the
   * atomic publish endpoint stamps nothing per-claim that says WHEN a reviewer
   * approved it (`updated_at` is also moved by grant widening, so it cannot
   * stand in). Only the negative verb dates itself. An earlier cut of this
   * called the field `medianHoursToDecision` and filtered on `invalidatedAt`
   * anyway — so every positive fell out of the sample and the number described
   * rejections while claiming to describe decisions.
   *
   * ⭐ THE LIMIT IS NOW CLOSING, FORWARD-ONLY (#5591). `brain_facts.published_at`
   * exists as of migration 0214 and the two allowlisted promote statements
   * stamp it, so an approval made from now on DOES date itself and rides this
   * bundle as `GateExportFact.publishedAt`. This field keeps its narrow name
   * regardless: every fact published before 0214 reads NULL permanently and is
   * never backfilled, so a `medianHoursToDecision` computed today would describe
   * the recent minority while looking like it described the corpus. Rename it
   * when the NULL population stops mattering, not before — and note that the
   * analytics here deliberately did NOT change in the same slice, so nothing
   * this bundle reports silently switched denominators.
   *
   * Null when no rejected claim carries both stamps — an authored
   * (never-extracted) fact has no `extracted_at`, and reporting its absence as
   * zero would claim an instantaneous review.
   */
  readonly medianHoursToRetraction: number | null;
}

export interface GateExportBundle {
  readonly notice: string;
  readonly workspaceId: string;
  readonly region: string | null;
  readonly decisions: readonly GateDecision[];
  readonly analytics: GateAnalytics;
}

/** How many predicates the rejection ranking carries. */
export const TOP_REJECTED_PREDICATE_MAX = 20;

/**
 * Hard cap on rows in one bundle.
 *
 * An evaluation set is hundreds of rows (#5335's own framing: *"we will
 * measure against 200 of your reviewed claims"*), not a workspace's whole
 * archive. The cap is a blast-radius bound on an operator act that reads
 * tenant content, and hitting it is REPORTED rather than silently truncating —
 * a corpus quietly clipped at its cap is one whose measurements are computed
 * over a population nobody chose.
 */
export const GATE_EXPORT_ROW_MAX = 5_000;

/**
 * The decision projection.
 *
 * A UNION ALL of the three arms rather than a LEFT JOIN with CASE, because the
 * arms genuinely have different grains: the first two are per-FACT and the
 * third is per-EPISODE. Expressing that as one join would make the negative
 * arm's `fact` columns null-by-outer-join, which is indistinguishable at the
 * row level from a fact whose columns are genuinely null, and the class would
 * then have to be re-derived in TypeScript from the shape of the nulls.
 *
 * ⚠️ ORDER BY is on `(occurred_at, episode id, fact id)` and is total. A
 * bundle feeds a measurement, and a measurement that is not reproducible from
 * a command is #5338's acceptance criterion failing one level down — two
 * exports of an unchanged workspace must be byte-identical, which an
 * unstable sort silently breaks as soon as Postgres changes a plan.
 */
/**
 * `brain_facts` is a published, non-retracted claim — a gate APPROVAL.
 *
 * Exported so the operator bundle and the oversight panel cannot drift: one
 * definition of what a positive is, in one place, and — since the review pass
 * on #5335 — genuinely composed by BOTH, rather than re-spelled inline in the
 * bundle SQL while a docstring claimed otherwise.
 */
export const GATE_POSITIVE_PREDICATE = `(f.status = 'published' AND f.invalidated_at IS NULL)`;

/**
 * `brain_facts` was retracted BY A HUMAN — a gate REJECTION.
 *
 * ## Why this is not simply `invalidated_at IS NOT NULL`
 *
 * On `invalidated_at` rather than `status`, because the review gate's negative
 * verb is `POST /:id/retract` (#4915) and ADR-0036 makes withdrawal a tombstone
 * rather than a demotion — `status` has exactly one writer (the atomic publish
 * endpoint) and carries no `rejected` value.
 *
 * ⚠️ **But the tombstone alone does not mean a human rejected anything, and an
 * earlier cut of this module assumed it did.** `retract` is not the only writer
 * of `invalidated_at`: `admin-migrate.ts` lands region-imported facts whose
 * slot key could not be derived with a placeholder key AND `invalidated_at`
 * set (#5047 — its own run report calls `tombstonedFacts` "THE COUNT TO ACT ON
 * FIRST"), and migration 0194 tombstoned the same population in place. Those
 * rows are import artifacts. Counting them as rejections would put claims no
 * reviewer ever saw into an evaluation corpus labelled as human decisions, and
 * would drag `approvalRate` and `topRejectedPredicates` with them — poisoning
 * exactly the measurement #5338 is meant to trust.
 *
 * So the test is the POSITIVE evidence of the human act rather than its
 * side effect: a retraction materializes an immutable human-authored
 * correction episode and links it `derives-from` (fact → episode). That edge
 * is `derives-from` and not `provenance` deliberately — the episode REFUTES
 * the claim rather than evidencing it — and `correction.ts` is the only
 * in-region writer of it at this grain. A region import restores such edges
 * verbatim, which is correct: an imported workspace's real retractions were
 * still real retractions.
 */
export const GATE_REJECTED_PREDICATE = `(f.invalidated_at IS NOT NULL AND EXISTS (
  SELECT 1
    FROM brain_edges ed
    JOIN brain_episodes ce
      ON ce.workspace_id = ed.workspace_id AND ce.id = ed.to_episode_id
   WHERE ed.workspace_id = f.workspace_id
     AND ed.from_fact_id = f.id
     AND ed.edge_type = 'derives-from'
     AND ce.source = '${HUMAN_SOURCE}'))`;

/**
 * `brain_facts` still OCCUPIES its slot — anything but `archived`.
 *
 * Not a class a bundle carries; it exists to keep the `negative` arm honest,
 * and getting it right took two attempts.
 *
 * A negative asserts something quite specific: *the extractor produced no claim
 * a reviewer promoted, and nothing is pending*. The danger is asserting SILENCE
 * about an episode the extractor actually spoke about — that teaches #5338's
 * measurement the opposite of what happened.
 *
 * So the arm excludes an episode holding any non-archived claim:
 *
 *   - **published** — already carried, on the `positive` arm.
 *   - **human-retracted** — already carried, on the `rejected` arm.
 *   - **a live draft** — undecided. A queue a reviewer has not reached is not
 *     the extractor staying silent.
 *   - **a tombstone with NO correction episode** — a migration artifact
 *     (`admin-migrate.ts`'s unkeyable imports, #5047; migration 0194). Neither
 *     a rejection nor silence: a claim WAS extracted and then destroyed by
 *     something unrelated to review. Ambiguous, so it is carried by no arm at
 *     all rather than guessed onto one. This is the case an earlier cut got
 *     wrong in both directions — first labelling it a rejection, then
 *     labelling its episode a negative.
 *
 * `archived` is the one state that does NOT block the negative arm, and the
 * spec is explicit about why: negatives are episodes that *"yielded no promoted
 * fact"*, and an archived claim was not promoted. An earlier cut tested "no
 * fact rows at all" and dropped the archived-only episode into no arm
 * whatsoever — a silent hole.
 */
export const GATE_OCCUPIES_SLOT_PREDICATE = `(f.status <> 'archived')`;

const GATE_DECISIONS_SQL = `
WITH decided AS (
  SELECT CASE WHEN ${GATE_REJECTED_PREDICATE} THEN 'rejected' ELSE 'positive' END AS decision,
         e.id AS episode_id, e.source, e.source_id, e.source_actor, e.body, e.locator,
         e.occurred_at, e.ingested_at, e.extracted_at AS episode_extracted_at, e.visible_to AS episode_visible_to,
         f.id AS fact_id, f.subject, f.predicate, f.object, f.status,
         f.extracted_at AS fact_extracted_at, f.invalidated_at, f.published_at, f.visible_to AS fact_visible_to,
         f.provenance->>'actor' AS actor, f.provenance->>'sourceId' AS provenance_source_id
    FROM brain_facts f
    JOIN brain_episodes e
      ON e.workspace_id = f.workspace_id AND e.id = f.source_episode_id
   WHERE f.workspace_id = $1
     AND ${notAnObservationSql("f")}
     AND ${notAWarehouseEpisodeSql("e")}
     AND (${GATE_POSITIVE_PREDICATE} OR ${GATE_REJECTED_PREDICATE})
),
silent AS (
  SELECT 'negative' AS decision,
         e.id AS episode_id, e.source, e.source_id, e.source_actor, e.body, e.locator,
         e.occurred_at, e.ingested_at, e.extracted_at AS episode_extracted_at, e.visible_to AS episode_visible_to,
         NULL::uuid AS fact_id, NULL::text AS subject, NULL::text AS predicate, NULL::text AS object,
         NULL::text AS status, NULL::timestamptz AS fact_extracted_at, NULL::timestamptz AS invalidated_at,
         NULL::timestamptz AS published_at,
         NULL::text[] AS fact_visible_to, NULL::text AS actor, NULL::text AS provenance_source_id
    FROM brain_episodes e
   WHERE e.workspace_id = $1
     AND e.extracted_at IS NOT NULL
     AND ${notAWarehouseEpisodeSql("e")}
     AND NOT EXISTS (
           SELECT 1 FROM brain_facts f
            WHERE f.workspace_id = e.workspace_id
              AND f.source_episode_id = e.id
              AND ${GATE_OCCUPIES_SLOT_PREDICATE}
         )
)
SELECT * FROM (SELECT * FROM decided UNION ALL SELECT * FROM silent) rows
 ORDER BY occurred_at NULLS LAST, episode_id, fact_id NULLS FIRST
 LIMIT $2`;

interface RawDecisionRow {
  decision: string;
  episode_id: string;
  source: string;
  source_id: string;
  source_actor: string | null;
  body: string | null;
  locator: string | null;
  occurred_at: Date | string | null;
  ingested_at: Date | string;
  episode_extracted_at: Date | string | null;
  episode_visible_to: unknown;
  fact_id: string | null;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  status: string | null;
  fact_extracted_at: Date | string | null;
  invalidated_at: Date | string | null;
  published_at: Date | string | null;
  fact_visible_to: unknown;
  actor: string | null;
  provenance_source_id: string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Grants travel with the rows or the rows do not leave.
 *
 * Returns the grant as `string[]` when every token parses, or `null` when any
 * does not. `parseGrant` never throws — a malformed token is REPORTED, and the
 * deny is the result rather than an exception — so the fail-closed decision is
 * this function's, not the parser's.
 */
/**
 * The unrepresentable-grant refusal, in one place.
 *
 * `subject` names the row so an operator can go and repair it — the episode id
 * or the fact id. Two near-identical nine-line blocks were the alternative, and
 * the copy that drifts is the one that stops naming the row.
 */
function unrepresentableGrantRefusal(kind: "Episode" | "Fact", id: string): GateExportRefusal {
  return {
    refusal: GATE_EXPORT_REFUSALS.unrepresentableGrant,
    detail:
      `${kind} ${id} carries a visible_to token outside the grant grammar, so this deployment ` +
      `cannot state who the row is for. Grants travel with the rows or the rows do not leave — ` +
      `no bundle was written. Repair the grant (see lib/brain/acl.ts for the grammar) and re-run.`,
  };
}

function representableGrant(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed = parseGrant(raw as readonly unknown[]);
  if (parsed.malformed.length > 0) return null;
  return raw.map((token) => String(token));
}

/**
 * Read one workspace's gate decisions.
 *
 * Deliberately NOT reader-scoped: this is an operator act on the whole
 * workspace, so there is no `aclVisibilityClause` here and no principal to
 * resolve. The grant is not the filter — it is CARGO, and it rides on every
 * row. The gate on this function is the operator command's (double-gated and
 * audited), not an ACL predicate's, and conflating the two would either hide
 * rows from an evaluation set or invent an operator principal that can read
 * everything, which is a worse thing to have than this function.
 */
export async function loadGateDecisions(
  db: GateExportReader,
  workspaceId: string,
): Promise<
  | { readonly ok: true; readonly decisions: readonly GateDecision[]; readonly capped: boolean }
  | { readonly ok: false; readonly refusal: GateExportRefusal }
> {
  const result = await db.query(GATE_DECISIONS_SQL, [workspaceId, GATE_EXPORT_ROW_MAX + 1]);
  const rows = result.rows as readonly RawDecisionRow[];

  const capped = rows.length > GATE_EXPORT_ROW_MAX;
  const kept = capped ? rows.slice(0, GATE_EXPORT_ROW_MAX) : rows;
  if (capped) {
    log.warn(
      { workspaceId, cap: GATE_EXPORT_ROW_MAX },
      "gate export hit its row cap — the bundle is a prefix, not the workspace",
    );
  }

  const decisions: GateDecision[] = [];
  for (const row of kept) {
    const episodeGrant = representableGrant(row.episode_visible_to);
    if (!episodeGrant) {
      return { ok: false, refusal: unrepresentableGrantRefusal("Episode", row.episode_id) };
    }

    let fact: GateExportFact | null = null;
    if (row.fact_id !== null) {
      const factGrant = representableGrant(row.fact_visible_to);
      if (!factGrant) {
        return { ok: false, refusal: unrepresentableGrantRefusal("Fact", row.fact_id) };
      }
      fact = {
        id: row.fact_id,
        subject: row.subject ?? "",
        predicate: row.predicate ?? "",
        object: row.object ?? "",
        status: row.status ?? "",
        extractedAt: iso(row.fact_extracted_at),
        invalidatedAt: iso(row.invalidated_at),
        publishedAt: iso(row.published_at),
        visibleTo: factGrant,
        actor: row.actor,
        provenanceSourceId: row.provenance_source_id,
      };
    }

    // The SQL emits exactly these three, and a value outside them means the
    // CASE above was edited without this narrowing. Throwing beats defaulting:
    // a row silently relabelled `negative` would teach a measurement that the
    // extractor stayed silent on a claim a human actually ruled on.
    const decision = row.decision;
    if (decision !== "positive" && decision !== "rejected" && decision !== "negative") {
      throw new Error(
        `brain gate export: unknown decision class ${JSON.stringify(decision)} — ` +
          `the projection and GATE_DECISION_CLASSES have drifted`,
      );
    }

    decisions.push({
      decision,
      episode: {
        id: row.episode_id,
        source: row.source,
        sourceId: row.source_id,
        sourceActor: row.source_actor,
        body: row.body,
        locator: row.locator,
        occurredAt: iso(row.occurred_at),
        ingestedAt: iso(row.ingested_at) ?? "",
        extractedAt: iso(row.episode_extracted_at),
        visibleTo: episodeGrant,
      },
      fact,
    });
  }

  return { ok: true, decisions, capped };
}

/**
 * Approvals over all decided claims, or null when nothing has been decided.
 *
 * One function rather than the same ternary in two places: the operator bundle
 * and the reader-scoped panel must not be able to round differently, because a
 * bundle and a panel disagreeing in the third decimal is the kind of thing that
 * gets investigated as a data bug.
 *
 * Null and NOT zero on an empty denominator — "no decisions yet" and "the
 * reviewer rejects everything" are different states, and only the second is
 * alarming.
 */
export function approvalRateOf(positives: number, rejected: number): number | null {
  const decided = positives + rejected;
  if (decided === 0) return null;
  return Math.round((positives / decided) * 1000) / 1000;
}

/**
 * Median of a numeric sample. Even-length takes the mean of the two middle
 * values; an empty sample is null, never zero.
 */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  return Math.round(raw * 100) / 100;
}

/**
 * Gate analytics over an already-loaded decision set.
 *
 * Takes the decisions rather than the database on purpose: it is the SAME
 * population the bundle carries, so the oversight page and the corpus cannot
 * drift apart, and the function is pure and testable with no handle at all.
 */
export function summarizeGateDecisions(
  decisions: readonly GateDecision[],
): GateAnalytics {
  let positives = 0;
  let rejected = 0;
  let negatives = 0;
  const rejectionsByPredicate = new Map<string, number>();
  const hoursToRetraction: number[] = [];

  for (const row of decisions) {
    if (row.decision === "positive") positives += 1;
    else if (row.decision === "rejected") rejected += 1;
    else negatives += 1;

    if (row.decision === "rejected" && row.fact) {
      const key = row.fact.predicate;
      rejectionsByPredicate.set(key, (rejectionsByPredicate.get(key) ?? 0) + 1);
    }

    // Only RETRACTIONS are timed, because only they are dated — see the field's
    // docstring. `invalidatedAt` is non-null on exactly the rejected arm, so
    // this loop samples that arm alone; the name says so rather than implying
    // an approval clock the schema does not carry.
    if (row.fact?.invalidatedAt) {
      const from = row.fact.extractedAt ?? row.episode.extractedAt;
      if (from) {
        const delta = Date.parse(row.fact.invalidatedAt) - Date.parse(from);
        if (Number.isFinite(delta) && delta >= 0) hoursToRetraction.push(delta / 3_600_000);
      }
    }
  }

  const decided = positives + rejected;
  const topRejectedPredicates = [...rejectionsByPredicate.entries()]
    // Count descending, then predicate ascending — a total order, so the panel
    // does not reshuffle between reads on ties.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_REJECTED_PREDICATE_MAX)
    .map(([predicate, rejections]) => ({ predicate, rejections }));

  return {
    positives,
    rejected,
    negatives,
    approvalRate: approvalRateOf(positives, rejected),
    topRejectedPredicates,
    medianHoursToRetraction: median(hoursToRetraction),
  };
}

/**
 * Region containment (ADR-0024), the acceptance criterion's first arm.
 *
 * Returns a refusal when this process's region and the workspace's disagree,
 * and null when the export may proceed. A deployment with NO region configured
 * (self-hosted) skips the check entirely, on `detectMisrouting`'s reasoning —
 * there is no boundary to cross when there is one region.
 *
 * ⚠️ A workspace with no region assigned is allowed through. That is the same
 * call `detectMisrouting` makes and it is deliberate: the unassigned state is a
 * new workspace's, not a foreign one's, and refusing it would block the export
 * on a condition the operator cannot fix from here.
 */
export function checkRegionContainment(
  apiRegion: string | null,
  workspaceRegion: string | null,
): GateExportRefusal | null {
  // A workspace with no region assigned is a NEW one, not a foreign one — the
  // same call `detectMisrouting` makes. Refusing it would block the export on a
  // condition the operator cannot fix from here, and on a self-hosted
  // deployment (no regions at all) it would block every export.
  if (!workspaceRegion) return null;

  // ⚠️ The workspace IS in a region and this process cannot say which region it
  // is itself — so containment is UNPROVEN, and unproven fails closed.
  //
  // The first cut returned null here, which made the whole criterion nearly
  // unreachable: on the `--database-url` path from an operator's laptop there
  // is no `ATLAS_API_REGION`, so the one invocation that can point at any
  // region on earth was also the one that skipped the check. CLAUDE.md's
  // "prefer errors over silent fallbacks" is the rule, and a residency
  // boundary is exactly where a silent pass is worst.
  if (!apiRegion) {
    return {
      refusal: GATE_EXPORT_REFUSALS.regionBoundary,
      detail:
        `This workspace is resident in region "${workspaceRegion}" and this process cannot ` +
        `establish its own region, so containment cannot be proven (ADR-0024). Set ` +
        `ATLAS_API_REGION to the region this deployment serves, or re-run with ` +
        `--region ${workspaceRegion}.`,
    };
  }

  if (apiRegion === workspaceRegion) return null;
  return {
    refusal: GATE_EXPORT_REFUSALS.regionBoundary,
    detail:
      `This workspace is resident in region "${workspaceRegion}" and this process serves ` +
      `"${apiRegion}". A bundle is portable by nature, so cutting one here would move tenant ` +
      `content across a residency boundary that no later routing decision could recall ` +
      `(ADR-0024). Re-run the export against the "${workspaceRegion}" region's deployment.`,
  };
}

/**
 * Build a bundle for one workspace: containment, then rows, then analytics.
 *
 * `workspaceRegion` is passed in rather than looked up so this stays a pure
 * function of its inputs plus one query — the operator command owns the
 * `getWorkspaceRegion` call, and a test can exercise every refusal without a
 * region fixture.
 */
export async function buildGateExportBundle(
  db: GateExportReader,
  options: {
    readonly workspaceId: string;
    readonly apiRegion: string | null;
    readonly workspaceRegion: string | null;
  },
): Promise<
  | { readonly ok: true; readonly bundle: GateExportBundle; readonly capped: boolean }
  | { readonly ok: false; readonly refusal: GateExportRefusal }
> {
  const containment = checkRegionContainment(options.apiRegion, options.workspaceRegion);
  if (containment) return { ok: false, refusal: containment };

  const loaded = await loadGateDecisions(db, options.workspaceId);
  if (!loaded.ok) return loaded;

  return {
    ok: true,
    capped: loaded.capped,
    bundle: {
      notice: EVALUATION_ONLY_NOTICE,
      workspaceId: options.workspaceId,
      region: options.workspaceRegion,
      decisions: loaded.decisions,
      analytics: summarizeGateDecisions(loaded.decisions),
    },
  };
}

// ---------------------------------------------------------------------------
// The oversight-page arm — the same classes, READER-SCOPED
// ---------------------------------------------------------------------------

/**
 * Gate analytics for the oversight page.
 *
 * ⚠️ **Reader-scoped, unlike {@link loadGateDecisions} — and the asymmetry is
 * deliberate, not an inconsistency.** The operator bundle runs unscoped
 * because it is an audited, double-gated operator act on a whole workspace and
 * the grant travels as cargo on every row. This one is served over HTTP to a
 * workspace admin, so it composes `aclVisibilityClause` exactly as
 * `loadFactCandidateSummary` does. A COUNT is not exempt from a visibility
 * predicate: an admin who cannot read a private claim must not learn it exists
 * by watching a total move.
 *
 * The consequence is stated rather than hidden: this panel's numbers are
 * *"what YOU can see"* and the operator bundle's are *"what there is"*, so the
 * two can legitimately disagree for a reader with a narrow grant. That is the
 * correct direction for a disclosure surface, and it is why this returns the
 * same shape by construction (`summarizeGateDecisions`' fields) rather than
 * inviting the caller to treat them as interchangeable.
 *
 * Only the two DECIDED counts and the approval rate are served. The `negative`
 * class is per-EPISODE and cannot be counted on this fact-grained join, and
 * reporting it as 0 would be a false claim about the extractor's silence — so
 * the panel names the two classes it has rather than implying a third.
 * `topRejectedPredicates`
 * and `medianHoursToDecision` are deliberately NOT: a predicate string is claim
 * content, and shipping a ranked list of it through an aggregate would route
 * around the row-level gate the counts respect.
 */
export async function loadGateAnalytics(
  db: GateExportReader,
  ctx: BrainPrincipalContext,
  requestId?: string,
): Promise<{
  readonly positives: number;
  readonly rejected: number;
  readonly approvalRate: number | null;
}> {
  const acl = aclVisibilityClause(ctx, {
    table: "brain_facts",
    alias: "f",
    paramIndex: 1,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  if (acl.decision === "deny-all") {
    // The same throw `loadFactCandidateSummary` raises: a reader Atlas could
    // not identify gets an error, never a zeroed panel. "0 decisions" served to
    // an unresolvable session reads as a gate nobody has used.
    throw new BrainReaderUnresolvedError(ctx.workspaceId, ctx.origin, "gate-analytics");
  }

  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE ${GATE_POSITIVE_PREDICATE})::int AS positives,
       COUNT(*) FILTER (WHERE ${GATE_REJECTED_PREDICATE})::int AS rejected
     FROM brain_facts f
     JOIN brain_episodes e
       ON e.workspace_id = f.workspace_id AND e.id = f.source_episode_id
    WHERE ${acl.sql}
      AND ${notAnObservationSql("f")}
      AND ${notAWarehouseEpisodeSql("e")}`,
    [...acl.params],
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    // An aggregate with no GROUP BY always returns exactly one row, so this is
    // unreachable — and a silent "0 decisions" would report a gate nobody has
    // used, which is a real and different state from a query that broke.
    throw new Error(
      "brain gate analytics: the aggregate returned no row — the query shape changed",
    );
  }

  const positives = Number(row.positives ?? 0);
  const rejected = Number(row.rejected ?? 0);
  return { positives, rejected, approvalRate: approvalRateOf(positives, rejected) };
}
