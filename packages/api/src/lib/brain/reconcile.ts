/**
 * The reconcile stage (#4771, ADR-0036 §Ingestion & connectors, §Temporal,
 * conflict & provenance) — the ONE place a fact candidate becomes a stored
 * draft.
 *
 * ## Entry-point-agnostic by construction
 *
 * ADR-0036 §T6 makes this a stage, not a step of the extraction fiber: M5's
 * write-back reuses this exact seam, the human-correction entry point reuses
 * it, and a warehouse-pinned fact will reuse it. So the signature names an
 * EPISODE and a list of CANDIDATES and nothing else — there is no `episodeRow`
 * fresh off the extraction drain, no "stamp the queue marker for me" flag, and
 * no assumption that an LLM produced the candidates. Everything path-specific
 * (which episodes to walk, what to do with the outcome, when to take the
 * episode off the extraction queue) belongs to the caller.
 *
 * Two consequences worth stating, because both were tempting to violate:
 *
 *   - `brain_episodes.extracted_at` is NEVER written here. It is the extraction
 *     fiber's work-queue marker and means "the extraction pass ran", which is a
 *     fact about that path and not about reconciliation. `extract.ts` stamps it
 *     AFTER this stage commits, and leans on the corroboration dedupe below for
 *     crash-safety rather than on a flag threaded through here.
 *   - The producer is a plain `producer` string in the provenance payload. A
 *     `kind: "extraction" | "write-back"` union would have grown an arm per
 *     entry point and put path knowledge back inside the stage.
 *
 * ## What a reviewer receives
 *
 * ADR-0036 requires the reviewer to make ONLY the trust call — so a candidate
 * that reaches `draft` is already fully formed: provenance edge, grant,
 * resolved entities, corroboration edges, and (for `single`-cardinality
 * predicates) advisory `in-tension-with` edges. All of it commits in ONE
 * transaction, so there is no window in which a fact exists without the
 * provenance edge that justifies it.
 *
 * ## Block vs flag — the asymmetry is the safety property
 *
 * ADR-0036 §T6 splits failure into two classes that must never share a branch:
 *
 *   - **Block + log** — a SAFETY failure. No provenance, no usable grant, or an
 *     unresolvable source principal. Each means Atlas cannot say where the claim
 *     came from or who may see it, and there is no draft state that a reviewer
 *     could repair into a safe one. Nothing is written; the reason is counted
 *     and logged. (A blocked candidate is not a silent drop: the episode stays
 *     in `brain_episodes` forever, so the evidence is never lost — only the
 *     unsafe derived claim is refused.) Those three are the ADR's; there is a
 *     fourth this module adds, `MALFORMED_CLAIM` — a proposal that is not a
 *     claim at all. See {@link RECONCILE_BLOCK_REASONS} for why it blocks
 *     rather than flags.
 *   - **Flag provisional** — a QUALITY failure. The entity store did not ANSWER:
 *     it threw, was unavailable, or broke its contract. (NOT a hang — nothing
 *     here imposes a deadline; see {@link resolveEntitiesForEpisode}.) The claim
 *     is still written as a
 *     draft, with `provenance.provisional = true`, because dropping it instead
 *     would make this stage a silent fact-dropper, which the issue forbids in
 *     both directions.
 *
 *     Since #5031 the flag means one narrow thing — *this row's COMPARABLE
 *     VALUES are worth recomputing* — and a store that answers "no entry" does
 *     NOT set it. Since #5032 that is BOTH `_cmp` columns, since one failed
 *     batch withheld both. **Not its keys**: the resolver reaches no key at any
 *     position, so a replay recomputes those to the same bytes under the same
 *     vocabulary. That abstain is honest, it is represented at rest already (a
 *     NULL `_cmp` → `unknown` → tension only at the object, and no suppression
 *     at the subject), and it will not change on replay; an outage will, and
 *     nothing else in the design can find those rows afterwards. See
 *     {@link resolveEntitiesForEpisode}, which also states where the marker is
 *     NOT written.
 *
 * ### Why the grant check is `parseGrant(...).principals.length === 0`
 *
 * NOT the 0180 CHECK's non-empty test. `chk_brain_facts_grant_nonempty` admits
 * `['everyone']`: cardinality 1, grants NOBODY, because enforcement is Postgres
 * array overlap against reader tokens and no reader token is ever malformed
 * (`acl.ts`). Written as a draft it would be legal, invisible, refused at every
 * publish forever by #4769's `GRANT_UNUSABLE` classifier, and unrepairable —
 * #4772's review surface is the repair UI and cannot precede this. Blocking
 * upstream is the only place that hazard is reachability-proof, and it is what
 * makes #4769's refusal genuine defence in depth instead of a dead end. The
 * same rule, for the same reason, screens episodes at the ingest seam
 * (`ingest/grant.ts::isUsableGrant`).
 *
 * ## Corroboration, not duplication
 *
 * Re-observing a claim STRENGTHENS it: the existing live fact gains a
 * `provenance` edge to the new episode and no second fact row appears. That is
 * what makes re-running extraction over an already-extracted window a no-op
 * (acceptance criterion 5) and what lets `extract.ts` stamp the queue marker
 * AFTER the commit — a crash in that window costs a repeated LLM call and, when
 * the producer reproduces its own output, no duplicated belief. That proviso is
 * load-bearing; see the third bullet of the slot-key note below for what a
 * paraphrase still costs.
 *
 * Two writers racing on the same claim would defeat a bare read-then-insert, so
 * the transaction opens by taking a per-workspace transaction-scoped advisory
 * lock. The rejected alternative was a partial UNIQUE index on the claim tuple
 * (as written then, `(workspace_id, subject, predicate, object)`; today it would
 * be the key columns) `WHERE invalidated_at IS NULL` plus
 * `ON CONFLICT DO NOTHING`: structurally stronger, but it needs a migration to
 * a table this milestone is still shaping, and it would make an ordinary
 * bi-temporal case (the same SPO re-asserted over a different validity window,
 * which M2 owns) unrepresentable rather than merely unusual. The lock is
 * reversible; the index would be a decision M2 has to live with. Revisit it
 * when M2 settles supersession — and read `identity-pg.test.ts`'s argument
 * against a UNIQUE slot index first, which is a second and independent reason:
 * on the keys it would make a tension between two live objects structurally
 * unrepresentable.
 *
 * ⚠️ REVISITED AND CLOSED (#5038, 2026-08-10): the index is NOT coming. The
 * revisit above is discharged, so read the paragraph as history rather than as
 * an open action. ADR-0037 §1's amendment carries the argument; the short form
 * is that T12 raised the bar to "it must carry `subject_cmp` or be dropped",
 * and `subject_cmp` cannot pay it — NULL for every extractor-supplied subject,
 * so the index is inert over the whole corpus under `NULLS DISTINCT` and
 * cements a homonym merge under `NULLS NOT DISTINCT`. Note the tuple #5038
 * weighed is the CLAIM tuple, which includes `object_key`; the slot-index
 * objection two sentences up is about a strictly stronger index and does not
 * transfer to it. Both land in the same place for different reasons.
 *
 * ⚠️ So the `_Avoid_` — read-then-insert as the only dedup — stays open, and
 * this lock is a PARTIAL mitigation in a way worth stating precisely: it
 * serializes reconcile against reconcile, which is the race it was chosen for,
 * and it does nothing about the region importer. That is the only other writer
 * of `brain_facts` (asserted in `__tests__/fact-writers.test.ts`), it takes the
 * VOCABULARY lock rather than this one — a different namespace, so no mutual
 * exclusion — and only on its legacy-keying arm. The dropped index would not
 * have covered that gap either: an imported row's `subject_cmp` is NULL by
 * construction (only an `entity:` value can reach that column, and #5035's
 * portability table calls `entity` store-local), so the index would either not
 * constrain those rows at all or reject the import outright.
 *
 * Identity is the materialized SLOT KEY of the trimmed SPO —
 * `alias(lexicalNorm(surface))`, computed by `lib/brain/identity.ts`'s
 * {@link slotKey} once per candidate here and stored on the row (#5020,
 * ADR-0037 §1). It REPLACED a byte-exact comparison of the surface columns, and
 * that is an observable change, not a refactor: `Ships On` and `ships_on` were
 * two slots and are now one, so a claim that used to duplicate silently now
 * corroborates. The retained surface is still exactly what the producer said —
 * only what COUNTS AS THE SAME CLAIM moved.
 *
 * The lexical layer folds ASCII case and separators and does nothing semantic
 * (no stemming — the corpus carries `led_by` and `leads`, which are INVERSE
 * relations), so deciding that `the deploy box` and `deploy-01` are one entity
 * is not its call. Nor, since #5031, is it the ENTITY RESOLVER's: that decision
 * arrives as curated vocabulary with a reviewer behind it, at every position,
 * which is why `is priced at` and `priced at` still do not unify. What the
 * resolver decides is narrower and lives off the join arms entirely — whether
 * two objects are provably DIFFERENT (`object_cmp`). See {@link EntityResolver}.
 *
 * The keys are written at `INSERT_FACT_SQL` and READ by the two lookups below.
 * No PRODUCER outside this stage derives one (ADR-0037 §8 — a region import
 * carries keys verbatim, #5035); the two writers that legitimately key rows they
 * did not author are both migrations of the corpus rather than claim producers —
 * 0187/0188's backfill, and ADR-0037 §7's drift re-key inside the
 * alias-approval decide transaction.
 *
 * ## The fold widens matching, and two downstreams feel it
 *
 * Stated because the NULL bullets below are all UNDER-matches and would
 * otherwise read as the whole risk register. Folding `Ships On` into `ships_on`
 * makes more things one claim, and one claim is a join arm:
 *
 *   - **The grant.** A corroboration writes a `provenance` edge, and publish
 *     unions the grants of every evidenced episode into the promoted fact
 *     (`widenGrantFromEvidence`, #4823). So a restatement in a WIDER-audience
 *     episode now attaches to a claim first seen in a private channel, where
 *     byte-exactness minted a separate fact that kept its narrow grant. Not a
 *     hole — the widening happens only at the review gate and is disclosed to
 *     the admin as a `GrantWidening` — but the ACL surface did move.
 *   - **`valid_to`.** The same fold reaches `supersessionCollisionJoin`, and a
 *     collision is what the publish gate stamps. The irreversible write is now
 *     reachable through a lexical rule rather than a byte comparison. Bounded
 *     (ASCII case and separators, nothing semantic), human-gated, and
 *     previewed pair-by-pair by `loadSupersessionPreview` — which is the whole
 *     mitigation, and it is only as good as the reviewer reading the first
 *     batch after this deploys.
 *
 * It NARROWS the two `<>` arms in the same move, and that direction is worth
 * naming because it is the one an operator sees first: a live rival whose object
 * differs only by case or separator stops being a rival, so a workspace's
 * will-supersede count can DROP at this deploy and some standing advisory
 * `in-tension-with` edges stop being minted. At ingest that is strictly better
 * — those pairs corroborate instead. For rows already in the corpus it is a
 * visible number moving the opposite way from the paragraph above.
 *
 * ## The keys are TOTAL as of #5047, and what that changed
 *
 * `SET NOT NULL` on all three columns landed in migration 0194, so a NULL key
 * no longer means two things — it cannot occur. Migration 0187's header
 * enumerated three prerequisites; #5020 supplied the first (`INSERT_FACT_SQL`
 * keys new rows), #5035 the second (a v3 bundle carries keys verbatim), and
 * #5047 the third: the `MALFORMED_CLAIM` guard in the preparation loop below now
 * REFUSES a candidate whose `slotKey` is null, so an ingest that used to store an
 * identity-less row is a block instead of a not-null violation that would fail
 * the whole reconcile transaction.
 *
 *   - A surface that norms away (`-`, `___`) is no longer a storable claim. It
 *     used to be — `String#trim` strips whitespace but not `_` or `-`, so the
 *     blank-trim guard let it through — and the row it produced corroborated
 *     nothing and earned no tension edge for as long as it existed. The refusal
 *     is what the constraint needed and is the honest verdict besides: a claim
 *     whose subject norms away asserts nothing.
 *   - The comparisons stay NULL-hostile even though no key is NULL now. `= NULL`
 *     being unknown is what keeps the abstain band honest at the two `_cmp`
 *     columns, which ARE permanently nullable; and never write the KEY
 *     comparisons NULL-safe, because the alternative a NULL-safe arm invites is
 *     a stored `''`, the one key value that joins every other degenerate row
 *     (migration 0187's header).
 *   - Rows written between 0187 deploying and #5020's deploy were unkeyed and
 *     dropped out of all three slot consumers. Migration 0188 repeated 0187's
 *     re-runnable backfill to close that window; 0194 repeats it once more,
 *     vocabulary-aware and per-column, immediately before the constraint, to
 *     sweep the residue a rolling deploy's own overlap leaves behind.
 *   - Legacy rows whose surfaces norm away could not be keyed by any backfill.
 *     0194 tombstones them and gives the affected columns a per-row placeholder
 *     (the row's own id, which `lexicalNorm` can never emit — it collapses `-`
 *     and `_` away). The tombstone is what keeps them out of all three slot
 *     consumers, which every one of them already required; the placeholder is
 *     only there to satisfy the constraint. See 0194's header.
 *   - A carried key can still name a norm THIS region's vocabulary cannot
 *     produce, so it collides with nothing until a human curates. Under-match,
 *     and the recoverable direction ADR-0037 §8 chose deliberately.
 *   - Dedupe is still only as good as the producer's determinism, just at a
 *     coarser grain. Two passes that phrase one claim differently ("is" vs "is
 *     on") remain two claims — that pair is a vocabulary ENTRY, not a
 *     normalization rule. The reviewer collapses those; nothing in this stage
 *     can. `extract.ts` pins its model call to `temperature: 0` for exactly this
 *     reason. What can no longer cause that particular miss is the ENTITY
 *     RESOLVER: since #5031 it reaches no key at any position, so a store that
 *     answers differently between two runs cannot move a claim's slot.
 *
 * ## What this slice does NOT do
 *
 * A fact's grant is INHERITED from its FIRST episode verbatim — a claim is never
 * more visible than the evidence behind it, and this stage never revisits that
 * choice. A later episode restating the claim under a wider grant is recorded
 * as evidence and nothing more; the publish gate is what unions those grants in
 * (#4823, `promoteBrainFacts`). Deriving a grant from source membership
 * (a chat channel's roster → `audience:` + a `fact_audience_member` sync) is the
 * INGEST seam's job for the episode (`ingest/grant.ts`), and the membership sync
 * that makes a private channel's `audience:` resolve to real people is not in
 * this slice at all — see #4801. Until it lands, a private channel's episodes
 * and the facts drawn from them are visible to nobody, which is the fail-closed
 * direction and repairable with no rewrite (the grant already names the
 * audience; only the membership rows are missing).
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getInternalDB } from "@atlas/api/lib/db/internal";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { logGrantAnomalies } from "@atlas/api/lib/brain/acl";
// The write-side "does this grant name anyone?" predicate, imported rather than
// re-spelled: `isUsableGrant`'s own docstring exists so the ingest screen and
// this one can never disagree about what usable MEANS, and two `parseGrant(...)
// .principals.length === 0` sites would be exactly that disagreement waiting to
// happen. It lives under `ingest/` for historical reasons but is a pure
// grant-vocabulary helper with no ingest state.
import { isUsableGrant } from "@atlas/api/lib/brain/ingest/grant";
// The identity composition, imported rather than spelled here: `slotKey` is the
// ONE place `alias(lexicalNorm(surface))` is assembled, and a second assembly
// site is how the write side and a future re-key start disagreeing about what a
// claim's slot IS.
import {
  identityKey,
  slotKey,
  type ClaimVocabulary,
  type InheritedSlot,
} from "@atlas/api/lib/brain/identity";
// The tension scan's REACH, imported for the same reason the two `_cmp` builders
// are: `TENSION_SWEEP_SQL` replays this rule and a second spelling is how the
// sweep and the ingest path drift into flagging different pairs. #5438's whole
// argument for why the predicate may be dropped HERE and at no other consumer
// lives in that module's header.
import { exactSlotFirstSql, exactSlotSql, tensionReachSql } from "@atlas/api/lib/brain/segmentation";
// The APPROVED-entry gate, imported rather than respelled (#5467). The sweep
// already reads this exact expression, and a second spelling of "the workspace
// says this predicate holds one value" is how two lanes start flagging
// different pairs. `cardinality.ts` imports only a TYPE back from this module,
// so nothing here is a runtime cycle.
import { cardinalitySingleSql } from "@atlas/api/lib/brain/cardinality";
// The comparable value, on the same terms: `comparableValue` is the ONE place a
// surface becomes a typed canonical form, and `comparableSameSql` the ONE place
// *provably same* is spelled — the two statements below negate each other and
// must do so against one definition, not two.
import {
  comparableValueWithReason,
  objectNotSameSql,
  objectSameSql,
  type ComparableValue,
  type DeclaredObjectType,
} from "@atlas/api/lib/brain/object-cmp";
// The SUBJECT's comparable value, and its ONE arm. A separate module because
// the polarity is INVERTED — proven difference SUPPRESSES here where it enables
// at the object — and because the value comes from a store id and never from a
// parse of the surface. Reading `subject-cmp.ts` before editing either of the
// two statements below is not optional: the mistake it exists to prevent
// (mirroring the object arms) mints tension edges between provably-different
// entities and leaves the ACL-widening hole open.
import {
  subjectComparableValue,
  subjectNotDifferentSql,
  type ResolvedEntityId,
  type SubjectComparable,
} from "@atlas/api/lib/brain/subject-cmp";
import { notAnObservationSql } from "@atlas/api/lib/brain/observation";
import { isWarehouseDerivedSource } from "@atlas/api/lib/brain/sources";
import type {
  BrainFactProvenance,
  EntityRole,
  PredicateCardinality,
} from "@atlas/api/lib/brain/types";

const log = createLogger("brain.reconcile");

/**
 * `classkey` for the per-workspace reconcile advisory lock — the `classkey` arg
 * of the two-arg `pg_advisory_xact_lock(int4, int4)`, valued at this issue's
 * number per the house convention. Distinct from every other two-arg user
 * (`lead-outbox` 2870, chat-install 3001, stripe-subscription 3445, last-admin
 * 3158, demo-seed 3683, knowledge-install 4235) so a reconcile never serializes
 * behind an unrelated guard on the same workspace; a `hashtext` collision
 * INSIDE this namespace costs extra serialization, never correctness.
 *
 * ⚠️ **A SECOND taker since #5029** — `lib/brain/tension-sweep.ts`, which writes
 * the same `in-tension-with` edges this stage does and so has to serialize
 * against it or race the `WHERE NOT EXISTS` guard below. Exported for that
 * caller and no other; publish deliberately takes 5024 instead
 * (`content-mode/adapters/brain-facts.ts`), because sharing this namespace is
 * exactly the wedged-by-ingest outcome that file refuses. Both takers hold no
 * OTHER ADVISORY lock, which is what keeps them out of a wait-for cycle with
 * 5022/5024 — see `identity.ts`'s lock-order note.
 *
 * ⚠️ **That is a claim about ADVISORY locks only. An earlier draft of this line
 * dropped the qualifier and asserted both takers hold no other lock of any kind,
 * which is false and reads as a proof that `40P01` cannot happen.** The sweep's INSERT takes ROW locks — `FOR KEY SHARE`
 * on both endpoint rows via `brain_edges`' composite FKs, in plan order — while
 * a concurrent publish takes `FOR UPDATE` across every live draft in its own
 * order and does not take this namespace. A deadlock is reachable, and
 * `tension-sweep.ts` has an arm for it.
 */
export const RECONCILE_LOCK_NAMESPACE = 4771;

/**
 * Bound how many existing facts one new `single`-cardinality claim may be put
 * in tension with. The edges are ADVISORY — `lib/brain/tensions.ts` is the
 * clustering that reads them (#4913), and arbitration stays with the human
 * gate — so a subject/predicate that somehow accumulated hundreds of live
 * objects should surface a few for a reviewer rather than write a fan
 * of edges nobody reads.
 *
 * ⚠️ *"the newest few"* until #5438, and the order is what changed rather than
 * the bound: both statements now rank exact-slot rivals ahead of anchor-only
 * ones (`exactSlotFirstSql`) and only then by recency. The widened reach makes
 * the candidate set strictly larger, so without that head term this cap would
 * silently DROP a true slot rival in favour of a newer anchor-only one — a
 * widening that subtracts edges, invisible because a missing advisory edge looks
 * exactly like agreement.
 *
 * Exported since #5029 so `lib/brain/tension-sweep.ts` applies THIS bound rather
 * than declaring its own. Two constants would let the ingest path and the sweep
 * disagree about how wide a star one claim may sit at the centre of, and the
 * sweep's whole contract is that it mints the edge set ingest would have.
 */
export const TENSION_EDGE_CAP = 10;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The narrow database handle this stage needs — structurally satisfied by
 * `pg.PoolClient`, so the transaction runner passes its checked-out client
 * straight through and a test passes a literal with no `mock.module()`.
 */
export interface ReconcileExecutor {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/** Runs `fn` inside ONE transaction and returns its result. */
export type ReconcileTransactionRunner = <T>(
  fn: (tx: ReconcileExecutor) => Promise<T>,
) => Promise<T>;

/**
 * The evidence a candidate hangs off, as this stage needs it.
 *
 * Deliberately NOT `BrainEpisode`: that is the stored row and carries fields
 * (`body`, `ingestedAt`, `extractedAt`) reconciliation must not read or write.
 * `visibleTo` is `readonly unknown[]` because it usually arrives straight off
 * `pg` as a `text[]` whose elements may be `null`, and narrowing it optimis-
 * tically here would move the check into every caller.
 */
export interface ReconcileEpisodeRef {
  readonly id: string;
  readonly workspaceId: string;
  /** Connector class — `slack`, `warehouse`, `human`. */
  readonly source: string;
  readonly sourceId: string;
  /** Source-side author principal; null when the source has no author. */
  readonly sourceActor: string | null;
  readonly occurredAt: Date | null;
  readonly visibleTo: readonly unknown[];
}

/** One proposed claim, from any producer. */
export interface FactCandidate {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /** Valid time, when the producer can establish one. */
  readonly validFrom?: Date | null;
  /**
   * A HINT, and since #5027 an advisory one only: it gates the
   * `in-tension-with` edges below and nothing else.
   *
   * It used to be written to `brain_facts.predicate_cardinality`, where the
   * publish gate read it from both sides of a collision — so two independent
   * model calls had to agree, and supersession fired at roughly
   * P(model says `single`)² against a prompt biased toward `multi`. Cardinality
   * is now a property of the CANONICAL PREDICATE (`lib/brain/cardinality.ts`,
   * ADR-0037 §3), read live at the publish gate, and this field reaches no
   * destructive path at all.
   *
   * Kept rather than deleted because a tension edge is exactly what a model
   * guess is worth: over-flagging costs a reviewer a glance, and under-flagging
   * costs a hint. Omit for the conservative default (`multi` — values coexist).
   *
   * ⚠️ Do NOT reintroduce a consumer that can stamp `valid_to` from this. That
   * is the defect #5027 removed, and it is invisible at rest — the column looked
   * unpopulated to everyone who read the schema.
   *
   * ⚠️ Since #5438 this hint no longer reaches only the claim's OWN slot — see
   * {@link FactCandidate.anchorReach}, which is where a producer says how far it
   * has standing to spend it.
   */
  readonly predicateCardinality?: PredicateCardinality;
  /**
   * How far {@link FactCandidate.predicateCardinality} carries — the bound
   * #5438 removed and #5467 put back on the one lane that never re-made the
   * trade.
   *
   * `TENSION_CANDIDATES_SQL` has two arms. The EXACT-SLOT arm asks about the
   * claim's own slot; the ANCHOR arm reaches every live claim sharing the
   * subject's whole-token prefix, from a different episode, with no predicate
   * test at all (`lib/brain/segmentation.ts`). A per-claim `single` hint is a
   * statement about ONE predicate, so spending it on the second arm is
   * spending it on slots the producer never spoke about.
   *
   *   - `"producer-hint"` (the default, and today's shipped behaviour) — the
   *     hint arms BOTH arms. What the extractor's guess has done since #5438,
   *     recorded as a named limit on `docs/prd/company-atlas.md`'s condition 4
   *     rather than as an accident.
   *   - `"curated-only"` — the hint arms the exact slot; the anchor arm is
   *     admitted only where the workspace holds an APPROVED `single` entry for
   *     the predicate (`cardinalitySingleSql`, the bound `TENSION_SWEEP_SQL`
   *     already has). `correction.ts` passes this.
   *
   * ⚠️ **Not a switch for "how noisy do we want this producer to be."** It says
   * whose assertion licenses the reach, and there are only two answers: the
   * producer's own hint about its own predicate, or the workspace's curated
   * entry (#5027's answer to who may say a predicate is single-valued). A third
   * value would be a third authority, and there isn't one.
   *
   * Omitting it preserves byte-identical behaviour for every producer that has
   * not thought about the question, which is the direction a bound has to
   * default in: a producer that acquires standing declares it.
   */
  readonly anchorReach?: "producer-hint" | "curated-only";
  /**
   * What the producer knows its own object IS (#5030) — on
   * {@link FactCandidate.predicateCardinality}'s precedent exactly: a
   * producer-declared property of the claim with a conservative default, NOT a
   * matching rule, so it stays inside ADR-0037's source-agnostic line.
   *
   * Omit for the conservative default. With no declaration the surface is
   * parsed on its own terms and anything ambiguous abstains — which is where
   * the extractor belongs, since it GUESSES. A warehouse producer reading a
   * `price` column knows the number is USD and says so, and that is the one
   * thing that makes a bare `499` comparable at all.
   *
   * A declaration only ever supplies what the surface LACKS; it can never
   * override what the surface states, and every disagreement between them
   * resolves to `null`. `lib/brain/object-cmp.ts` owns the arms.
   */
  readonly objectType?: DeclaredObjectType;
  /**
   * Producer-specific provenance (model id, prompt version, confidence, the
   * pinned SQL of a warehouse fact). Merged UNDER the structural keys, so a
   * producer can enrich the payload but never overwrite what records where the
   * claim came from.
   */
  readonly detail?: Record<string, unknown>;
  /**
   * ADR-0037 §8's row-copy doorway (#5037) — the SLOT this claim belongs to,
   * copied off an existing fact row instead of derived from this candidate's
   * surfaces.
   *
   * ⚠️ **This is the ONE exception to *producers supply claims, never matching
   * rules*, and it is an exception the rule always had.** §1 prohibits a producer
   * COMPUTING identity; a row-copy path COPIES it, which is why `correction.ts`
   * was called the immune producer in the first place. The doorway is explicit
   * rather than implicit because the immunity was only ever true while identity
   * == surface: the instant keys are computed at this seam, a correction passing
   * the target's SURFACES down here stops carrying identity and starts
   * re-deriving it, which is the operation §1 rules out for everyone.
   *
   * Unforgeable by construction — {@link InheritedSlot} is nominal (a class with
   * a `#private` field, exported as a TYPE only) and has one exported mint — so a
   * producer can forward a slot it read off a row but cannot author one. See that
   * type for why neither the nominality nor the single mint is the whole guard on
   * its own, and for what a second mint would cost.
   *
   * ⚠️ Omit it. The absence is the correct answer for every claim-supply
   * producer, and a producer reaching for this field is almost certainly
   * answering the question §1 answers instead.
   */
  readonly inheritedSlot?: InheritedSlot;
}

/**
 * A resolved entity: a stable store id, and nothing else (#5031).
 *
 * It USED to carry a `canonical` surface that replaced what the producer said.
 * Both of that field's jobs are gone, and they were taken by different
 * decisions (ADR-0037 §5):
 *
 *   - **Writing the SPO column** — forbidden outright. The surface columns keep
 *     the producer's raw text unconditionally, resolver or not, because
 *     retention is what makes an alias REVERSIBLE. A resolver that overwrites
 *     the surface reintroduces at the entity position exactly the
 *     irreversibility the key design spent its effort removing.
 *   - **Feeding the slot key** — taken by the vocabulary. A store's slot-side
 *     contribution is an ordinary approved alias edge (`lib/brain/vocabulary.ts`),
 *     so a key stays `alias(lexicalNorm(surface))` at every position and an id
 *     never appears in one. Ids at the slot would silently orphan the existing
 *     corpus: a workspace's hundred live facts keyed `acme corp` stop colliding
 *     with anything new the moment the store starts answering `ent_7f3`.
 *
 * What is left is a COMPARISON value, which is why the shape collapsed to an id
 * and absence became the abstain. The id reaches `object_cmp` through
 * {@link comparableValueWithReason} and reaches no join arm at all.
 *
 * ⚠️ **Ids must be GLOBALLY unique** (ULID/UUID) — a store contract clause, not
 * an implementation note. Deterministic and workspace-scoped does NOT imply
 * globally unique, and a derived id (`dim_plan:7`) that collides across regions
 * for two DIFFERENT rows produces a false `same` at the publish gate: two
 * distinct entities merged, with no inverse.
 */
export interface ResolvedEntity {
  readonly entityId: string;
}

/**
 * Subject/object entity resolution — an injected seam, not a hardcoded step.
 *
 * Answers `surface → stable id`, or abstains. **An absent key IS the abstain**,
 * and it is honest rather than degraded: the object lands `unknown`
 * (`object_cmp` NULL), the claim still keys exactly as it would have, still
 * corroborates, still earns tension edges, and declines only to prove
 * DIFFERENCE. (Exactly as it would have — not "totally": {@link slotKey} is
 * nullable for a surface that norms away, and resolution never touched that.)
 *
 * ## One call per EPISODE, over the deduplicated surface set
 *
 * Not one call per surface, and the difference is CORRECTNESS rather than a
 * saving. One Slack thread yields `Business tier / price / $499` beside
 * `Business tier / owner / Alice`; two lookups for that one surface can straddle
 * a store write and key the two rows differently **within a single episode**.
 * Batching makes intra-episode consistency structural — the same
 * materialize-once argument the slot keys are built on.
 *
 * The batch covers the deduplicated SUBJECT and OBJECT surfaces together, in one
 * call, and since #5032 BOTH ids have a destination column: the object's reaches
 * `object_cmp` and the subject's reaches `subject_cmp` (see
 * {@link PreparedCandidate.subjectComparable}). ⚠️ They are not two instances of
 * one mechanism — at the object a proven difference ENABLES supersession, at the
 * subject it SUPPRESSES every consumer at once, because two claims about
 * different entities are not in the same slot. `subject-cmp.ts` carries the
 * table.
 *
 * Invoked ONCE, BEFORE the transaction opens, which is load-bearing for the
 * DB-backed resolver this seam anticipates: it may check out its own connection
 * safely, whereas doing so inside the reconcile transaction is the bounded-pool
 * starvation deadlock {@link withBrainTransaction} warns about. Per-candidate
 * resolution used to make that docstring quietly mean "N times" — the call sat
 * inside the candidate loop and awaited once per candidate, so a 20-candidate
 * episode was 20 serialized round trips against any real store.
 *
 * ## `role` is deliberately absent from the context
 *
 * Resolution is role-INVARIANT: a store that answered differently by position
 * could make `Acme Corp` a different entity as a subject than as an object.
 * Rather than pin that as a contract property and test it, the argument is
 * deleted — the invariant now holds by TYPE and needs no test and no adversarial
 * double (ADR-0037, T7 §4). Do not add it back. `role` survives where it
 * describes an outcome rather than an input: {@link BrainFactProvenance.unresolved}.
 *
 * ## The store may do nothing clever at read time — a PROHIBITION
 *
 * No fuzzy matching, no embedding lookup, no LLM disambiguation behind this
 * call. Every equivalence a store reports is a precomputed, APPROVED edge. This
 * makes the seam less powerful than the phrase "entity resolution" normally
 * promises, and it is stated as a prohibition because someone will propose
 * read-time matching later; the same posture already refuses stemming in the
 * lexical layer and near-miss detection in the proposal query.
 *
 * Nor may a store read tier-1 LIVE — the semantic layer and the warehouse are
 * its highest-quality INPUT, never the store itself (ADR-0037 §5). A live
 * customer-warehouse query here would make a key irreproducible offline, make
 * resolution success a property of a datasource being up, and put
 * `ConnectionRegistry` egress on the pre-transaction path.
 */
export type EntityResolver = (
  /** Deduplicated across the whole episode, both positions, already trimmed. */
  surfaces: ReadonlySet<string>,
  context: {
    readonly workspaceId: string;
  },
) =>
  | Promise<ReadonlyMap<string, ResolvedEntity>>
  | ReadonlyMap<string, ResolvedEntity>;

/**
 * The shipped default: abstain on everything, because there is no entity store.
 *
 * Still a one-liner, which T5 §4 predicted it would stop being ("it becomes an
 * identity map-builder") — that prediction assumed a `canonical` field the
 * id-or-absent collapse removed. An empty map is now the whole passthrough, and
 * it is the HONEST answer rather than a stub: with no store, Atlas genuinely
 * cannot prove `Grace` and `Alan` are two different people, so every
 * entity-valued object stays `unknown` and reaches a reviewer as tension instead
 * of superseding something.
 *
 * It abstains; it does not FAIL. Nothing it returns flags a candidate
 * provisional — see {@link resolveEntitiesForEpisode}.
 */
export const passthroughEntityResolver: EntityResolver = () => new Map();

export interface ReconcileRequest {
  readonly episode: ReconcileEpisodeRef;
  readonly candidates: readonly FactCandidate[];
  /**
   * A label for what produced these candidates — `extraction:v1`, `write-back`,
   * `human`. Recorded in provenance so a reviewer (and a later re-extraction)
   * can tell one pass from another.
   */
  readonly producer: string;
  /**
   * When the pass that produced them ran. `null` for authored claims, which are
   * not extracted from anything (mirrors `brain_facts.extracted_at`).
   */
  readonly extractedAt: Date | null;
  /**
   * The principal that ASSERTED these claims, when the caller knows better than
   * the episode does. A warehouse entry point passes a system principal; the
   * human-correction path passes the author. Omitted, the principal is derived
   * from `episode.sourceActor` — and when neither yields one, every candidate
   * is BLOCKED (`SOURCE_PRINCIPAL_UNRESOLVED`) rather than attributed to
   * nobody.
   */
  readonly sourcePrincipal?: string | null;
  /** Defaults to {@link passthroughEntityResolver}. */
  readonly resolveEntity?: EntityResolver;
  /**
   * The workspace's curated identity vocabulary — one lookup over lexical norms
   * per claim slot (ADR-0037 §6, #5022's `lib/brain/vocabulary.ts`).
   *
   * Threaded through the REQUEST rather than left as `slotKey`'s default
   * parameter for `resolveEntity`'s reason exactly: a real vocabulary is
   * per-workspace and DB-backed, so the caller loads it once with
   * `loadClaimVocabulary` — above the per-candidate loop, which is what lets the
   * seam stay synchronous.
   *
   * REQUIRED, unlike `resolveEntity` beside it, and for `slotKey`'s stated
   * reason rather than by analogy (`identity.ts`, "`alias` is REQUIRED"). This
   * is the seam where a claim's keys are MATERIALIZED, so a caller that silently
   * defaulted would key its rows under a different identity function than every
   * other row in the workspace — an under-match spread corpus-wide, invisible at
   * rest, unfixable without a re-key. A failed entity resolution flags an
   * episode's candidates provisional, which is a signal someone reads; a
   * forgotten vocabulary is silent and corpus-wide.
   * Every call site therefore names its vocabulary out loud, which is what let
   * #5023 wire the loader into ingest without missing one: the four sites that
   * needed it were `grep identityVocabulary`, and a fifth would not compile.
   *
   * ⚠️ POSITION-SCOPED, and #5020 shipped this as a single bare `AliasLookup`,
   * which was wrong in a way worth recording rather than quietly fixing. One
   * lookup across all three slots is the position-agnostic vocabulary ADR-0037
   * §6 rules out: it does not merely permit cross-position composition, it
   * COMPELS it, and a PREDICATE approval then re-keys SUBJECTS workspace-wide in
   * the direction nothing can undo. That is why #5022 edited this field despite
   * this comment previously promising it would not have to.
   */
  readonly vocabulary: ClaimVocabulary;
}

export interface ReconcileDeps {
  /** Defaults to a transaction on the internal pool. */
  readonly withTransaction?: ReconcileTransactionRunner;
  /** Test clock. */
  readonly now?: () => Date;
}

/**
 * Why a candidate never became a draft. Every one is a SAFETY refusal — see the
 * module header on why quality failures flag instead.
 */
export const RECONCILE_BLOCK_REASONS = {
  /** The episode carries no id, so the claim would have no evidence pointer. */
  noProvenance: "NO_PROVENANCE",
  /** The episode's grant names no principal any reader could ever match. */
  noGrant: "NO_GRANT",
  /** Neither the caller nor the episode yields a principal to attribute to. */
  sourcePrincipalUnresolved: "SOURCE_PRINCIPAL_UNRESOLVED",
  /**
   * The candidate itself is not a claim. TWO halves under one reason: a BLANK
   * subject, predicate or object (`trim() === ""`), and — since #5047 — a
   * surface with no IDENTITY, i.e. any slot whose `slotKey` is null (a
   * degenerate surface, a vocabulary target that normalizes away, or an
   * inherited null).
   *
   * Both say the same thing: the proposal asserts nothing and there is nothing
   * for a reviewer to repair, which is what separates it from an unresolved
   * entity. The REASON stays single so one producer bug lands on one counter;
   * the positions and their causes travel beside it on
   * {@link BlockedEntry.unkeyed}, because one caller renders this for a human
   * and must not blame the wrong party. The producer's bug is logged with it.
   */
  malformedClaim: "MALFORMED_CLAIM",
} as const;

export type ReconcileBlockReason =
  (typeof RECONCILE_BLOCK_REASONS)[keyof typeof RECONCILE_BLOCK_REASONS];

/** What became of one candidate. */
export type ReconcileOutcome =
  | {
      readonly kind: "created";
      readonly factId: string;
      /** True when subject and/or object could not be resolved. */
      readonly provisional: boolean;
      /** Advisory `in-tension-with` edges written alongside it. */
      readonly tensionEdges: number;
    }
  | {
      readonly kind: "corroborated";
      readonly factId: string;
      /** False when this episode had already been recorded as evidence. */
      readonly evidenceAdded: boolean;
    }
  | {
      readonly kind: "blocked";
      readonly reason: ReconcileBlockReason;
      /**
       * For `MALFORMED_CLAIM` only: which slots had no identity, and WHY (#5047).
       * See {@link BlockedEntry.unkeyed} — this is the same detail, on the wire
       * the caller actually reads.
       */
      readonly unkeyed?: readonly UnkeyedSlot[];
    };

export interface ReconcileReport {
  /**
   * Set when the EPISODE was refused wholesale, INDEPENDENT of how many
   * candidates were offered.
   *
   * Without it, a pre-flighting caller that passes an empty candidate list gets
   * a report byte-identical to a clean "nothing to do" — every counter zero,
   * because `blocked[reason]` is `candidates.length`. A safety refusal that
   * reads as success is the one shape this stage must not return, and the
   * entry-point-agnostic contract means callers that pre-flight are expected.
   */
  readonly episodeBlocked?: ReconcileBlockReason;
  readonly created: number;
  readonly corroborated: number;
  /** Created facts carrying `provenance.provisional` — a subset of `created`. */
  readonly provisional: number;
  /**
   * Created facts carrying a non-null `object_cmp` — a subset of `created`, and
   * the ONE trigger condition for the alias-proposal producer (#5034).
   *
   * ⚠️ It is a gate, not a statistic, so read what it is a gate ON before
   * changing how it is counted. `ALIAS_PROPOSAL_SQL` joins two rows on
   * `object_cmp` non-null and equal, so its candidate set is a pure function of
   * the rows that HAVE one. A run that created none cannot have changed that
   * set: a corroborating candidate writes no row at all, and a created row with
   * a NULL comparable joins nothing on either side. `extract.ts` therefore skips
   * the corpus-wide self-join entirely when this is zero, which today is very
   * nearly always — `object_cmp` is never backfilled and there is no entity
   * store, so only a typed object (money, a number, a date) produces one.
   *
   * NOT the same number as `provisional`, and the two are easy to conflate
   * because both concern the resolver. `provisional` counts rows whose comparable
   * is missing BECAUSE THE BATCH FAILED; this counts rows that have one at all,
   * however they got it. A workspace with no store has `provisional: 0` and
   * `comparable: 0` for entirely different reasons.
   */
  readonly comparable: number;
  readonly blocked: Readonly<Record<ReconcileBlockReason, number>>;
  /**
   * The same refusals keyed by PREDICATE rather than by reason (#5396).
   *
   * ⚠️ **A refinement of {@link blocked}, never a second spelling of it.** The
   * two are not interchangeable and neither can be derived from the other: a
   * candidate refused with a BLANK predicate names no dimension and appears in
   * `blocked` alone, so summing this map is not a candidate total and must not
   * be used as one.
   *
   * It exists for the observation reaper's per-dimension fence. `reapStandDown`
   * holds back a dimension that had values and surfaced none of them; a
   * `reconcile` refusal is the fourth way a dimension goes unrepresented on a
   * run that records success, and until this map existed it was the one with no
   * dimension-shaped answer — so a PARTIAL block reaped the unwritten
   * candidates' dimensions while a wholesale one was caught. Keyed by the
   * TRIMMED predicate, which is what the fact would have carried had it been
   * written, and therefore what `brain_facts.predicate` is compared against.
   *
   * A `Map` rather than a `Record`, unlike `blocked`: these keys are dimension
   * names drawn from the workspace's own semantic layer rather than a
   * compile-time union, and an object keyed by customer-supplied strings
   * collides with `Object.prototype`'s own.
   */
  readonly blockedByPredicate: ReadonlyMap<string, number>;
  /** Per-candidate, in input order. */
  readonly outcomes: readonly ReconcileOutcome[];
}

const NO_BLOCKS: Readonly<Record<ReconcileBlockReason, number>> = Object.freeze({
  NO_PROVENANCE: 0,
  NO_GRANT: 0,
  SOURCE_PRINCIPAL_UNRESOLVED: 0,
  MALFORMED_CLAIM: 0,
});

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
//
// Exported so the real-Postgres test runs these exact strings against the live
// schema instead of asserting a paraphrase of them.
//
// NOTE for the next editor: none of these may name `status`, and no UPDATE
// here may name `visible_to` (#4823 — the grant is a per-version snapshot that
// widens only at the review gate; the INSERT below names it and must, because
// derive-at-ingest is that snapshot being taken). Nor may ANY statement here
// WRITE `valid_to` (#4912): "a human promotion stamps `valid_to`; there is no
// autonomous supersession" — the publish gate and `correct_fact` (#4915) are
// its only STAMPERS (a region import writes the column by INSERT, restoring an
// already-closed window rather than arbitrating — `admin-migrate.ts`), and this
// stage runs unattended on every ingest pass.
// Reading it is fine and required (two SELECTs below filter on it, and the
// guard's own fixtures pass a SELECT doing exactly that);
// `reconcile.test.ts` pins the write half.
// `scripts/check-brain-fact-promotion.sh` refuses any UPDATE-, INSERT-, or
// upsert-shaped statement that touches `brain_facts` and mentions `status` —
// including a mention only in the WHERE clause — and that over-breadth is
// deliberate. The fact insert omits `status` on purpose:
// migration 0180 defaults it to `draft`, and that default IS the review gate
// applying itself (#4769). Asking for `draft` explicitly would be the same
// value written by a second, ungated writer.

/** The per-workspace serialization point — see the module header. */
export const RECONCILE_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, hashtext($2))`;

/**
 * Does a live fact already assert exactly this claim?
 *
 * Matched on the SLOT KEYS, not the surfaces (#5020) — so a re-observation that
 * says `Ships On` where the stored row says `ships_on` strengthens it instead of
 * minting a second belief. `idx_brain_facts_subject` serves this again: 0187
 * repointed it onto `(workspace_id, subject_key, predicate_key)` with the
 * tighter `invalidated_at IS NULL AND valid_to IS NULL` partial predicate, both
 * of which this statement requires.
 *
 * A NULL bind (the candidate's surface norms away) matches NOTHING here, and
 * that is deliberate rather than tolerated: `IS NOT DISTINCT FROM` would make
 * every degenerate claim corroborate every other one, which is the same
 * corpus-corrupting over-match migration 0187's header rejects `DEFAULT ''` for.
 * A duplicate row is the price and it is the recoverable direction.
 *
 * ## The object arm is *provably same* — `objectSameSql` (#5030, ADR-0037 §2)
 *
 * `(object_key = $4 OR object_cmp = $5)`, vetoed by proven difference. The keys
 * prove sameness through the surface; the comparable value proves it through a
 * typed canonical form, so `499 USD` and `USD 499` corroborate where their keys
 * do not. Every arm is NULL-hostile — `= NULL` is unknown — so an unparseable
 * object simply falls back to the key arm, which is exactly the abstention
 * `null` means.
 *
 * The two positive arms are an `OR` and neither implies the other, which is why
 * one column compared two ways cannot do this job (T3 §4): drop the key arm and
 * byte-identical `Business tier` stops corroborating the moment it is
 * unresolvable as an entity; drop the cmp arm and two spellings of one price
 * mint two rows.
 *
 * The VETO is why the whole test is a builder rather than spelled here — see
 * `objectSameSql`. In short: `lexicalNorm` strips a leading `-`, so `-499` and
 * `499` key identically while their comparable values prove they disagree, and
 * without the veto this statement merges two opposite-signed beliefs into one
 * row with no reviewer anywhere in the loop.
 *
 * ## The class arm is a POPULATION restriction, not an identity arm (#5332)
 *
 * `(notAnObservationSql("brain_facts") OR $7)` — ADR-0042's *only a belief
 * can be corroborated*, and it is the newest arm here. `$7` is TRUE when the
 * INCOMING claim is itself an observation, which lifts the exclusion.
 *
 * The defect it closes: the lookup runs FIRST and `return`s on a hit, and it
 * filtered neither `status` nor `provenance.source`. So the producer minted
 * `Dharma / plan_tier / trial`, a person said the same thing in Slack, the
 * extractor's claim keyed identically — and it corroborated the WAREHOUSE row
 * and returned. No draft was minted, nothing reached the review queue, and the
 * person's statement became a `provenance` edge on a machine-produced row that
 * ADR-0042 never serves. Their testimony was swallowed. Part of why every
 * warehouse candidate in the prod queue is derivable is exactly this: a human
 * claim that agrees with a reading never became a candidate at all.
 *
 * ⚠️ **Read `$7` as a bind and not as a redundancy — an unconditional exclusion
 * breaks two things silently, both irreversible.** The warehouse producer
 * re-emits every enrolled row on EVERY run, and `warehouseRowId`'s stated
 * purpose is that a re-emission *"corroborates its predecessor instead of
 * contradicting it"*. Drop the `OR` and each run mints a duplicate observation
 * per row; worse, `observation-reap.ts`'s staleness signal is *"the newest
 * warehouse episode still hanging off this observation by a provenance edge"*,
 * so with no edge ever written `last_seen` collapses to the creating episode
 * and the reaper deletes the whole live comparison surface on the third run.
 *
 * So the four cells are not class-MATCHING, which is the reading to guard
 * against — belief↔belief cross-class corroboration is mutation-tested in
 * `multi-source-pg.test.ts` (*"the lookup scoped to one class … the exact
 * cross-class regression"*), and observation→belief is the live shape
 * `observation-reap.ts`'s `observationSql("f")` fence exists to protect. Only
 * belief→observation changes. `corroboration-class-pg.test.ts` drives all four.
 *
 * The arm reuses {@link notAnObservationSql} and the bind reuses
 * `isWarehouseDerivedSource`, rather than either spelling a `provenance.source`
 * literal of its own. That is #4938's finding applied rather than re-learned:
 * it found the tier-1 refusal *"one future naming decision away from silently
 * never firing"* because the producer and the predicate each spelled their own
 * literal. `IS NOT TRUE` inside the builder is load-bearing here for its usual
 * reason — a `source`-less legacy fact keys NULL, and `NOT NULL` is NULL, which
 * a WHERE reads as false, so the naive negation would stop every pre-provenance
 * belief in the corpus from ever being corroborated again.
 *
 * Agreement is not LOST by this. It is recoverable as the complement of the
 * tension scan — same subject key, same predicate key, same object key — which
 * is where a comparison between an observation and a belief belongs anyway.
 *
 * Deliberately NOT filtered by review state: a claim re-observed after it was
 * published must corroborate the published fact, not mint a fresh draft
 * duplicate of it. That is a STATUS arm, and it stays absent — the exclusion
 * above is on the SOURCE, for ADR-0042's reason: developer mode serves
 * `status IN ('published','draft')`, so a rule expressed as "never published"
 * would leave the whole comparison surface reachable under the `/ee` overlay.
 * Deliberately not filtered by grant either — a re-observation
 * at ANY grant, narrower or wider, is recorded as EVIDENCE and never rewrites
 * the existing fact's `visible_to` from here, because a grant is immutable per
 * fact version (0180) and ADR-0036 §T5 admits widening only at the review gate.
 * A wider re-observation is acted on there instead: `promoteBrainFacts` unions
 * the evidence grants in when the draft is published (#4823).
 *
 * ## The subject arm is a SUPPRESSION, and it is the one that matters (#5032)
 *
 * `subjectNotDifferentSql("subject_cmp", "$6")` — the whole statement is vetoed
 * when the store proves the two subjects are DIFFERENT ENTITIES. Not a mirror of
 * the object arm above: nothing is enabled here, and there is no positive
 * `subject_cmp = $6` disjunct anywhere, because two claims about different
 * entities are not in the same slot at all. See `subject-cmp.ts` for the
 * polarity table.
 *
 * THIS statement is why the column exists. It is the only identity consumer with
 * no grant arm and no cardinality arm, and on a hit it attaches the incoming
 * episode as evidence — so a homonym lets a PUBLIC episode become evidence for a
 * PRIVATE fact, and the publish gate then overwrites `visible_to` with the union
 * of every evidence grant. That is a private claim's body reaching a public
 * audience, and it is the reason a `subject_cmp` test asserting only *"no
 * supersession"* proves nothing.
 *
 * NULL on either side admits the pair — the abstain band, which at this position
 * is every extractor-supplied subject, permanently. So this arm is a no-op on
 * the corpus as it stands and stays one until a warehouse-backed store answers.
 *
 * `valid_to IS NULL` (#4912): only a CURRENT fact corroborates. A superseded
 * fact — `valid_to` stamped by a human promotion — is settled history that
 * every as-of-now read hides, so strengthening it would swallow the
 * re-observation invisibly: the evidence would attach to a row no default read
 * serves, and the world's flip BACK to the old value would never resurface.
 * Instead the re-observation mints a fresh draft (a new validity window), which
 * the publish gate can then arbitrate against the current rival. Note this
 * SELECT reads the raw column, not `brainFactCurrentClause` — a future-dated
 * `valid_to` off a region import is a fact with a CLOSED window, and minting a
 * fresh draft for a new window is right there too, where the read-side clause's
 * "still valid until then" reading answers a different question. Writes are
 * never touched here: this stage still stamps nothing (see the NOTE at the
 * top of this SQL section).
 */
export const CORROBORATION_LOOKUP_SQL = `SELECT id
     FROM brain_facts
    WHERE workspace_id = $1
      AND subject_key = $2
      AND predicate_key = $3
      AND ${objectSameSql("object_key", "$4", "object_cmp", "$5")}
      AND ${subjectNotDifferentSql("subject_cmp", "$6")}
      AND (${notAnObservationSql("brain_facts")} OR $7)
      AND invalidated_at IS NULL
      AND valid_to IS NULL
    ORDER BY ingested_at
    LIMIT 1`;

/**
 * The draft insert.
 *
 * `visible_to` travels as jsonb → `text[]` rather than as a native array bind.
 * NOT for the episode insert's reason — that one is a batch
 * `jsonb_array_elements` where per-row grants would need a ragged `text[][]`,
 * and this is a single-row `VALUES` where a plain `$9::text[]` would work
 * through `pg`. The reason here is {@link ReconcileExecutor}: its `query` takes
 * `unknown[]`, and it is structurally satisfied by both the `pg` client and a
 * test literal. Keeping every parameter a JSON scalar means no driver-specific
 * array marshalling can leak into that seam.
 *
 * ## The identity keys are named here, and this is their only deriver (#5020)
 *
 * Derived at ingest exactly as the grant is — which is why
 * `check-brain-fact-promotion.sh` gates the key columns on UPDATE only, and says
 * in as many words that OMITTING them is not a fix. They travel as three more
 * JSON scalars, and since #5047 NEVER as `null`: the `MALFORMED_CLAIM` guard
 * refuses a candidate whose `slotKey` is null, `ResolvedSlotKeys` carries that
 * in the type, and the columns are `NOT NULL` as of migration 0194. A surface
 * that norms away has no key and no longer becomes a row; a sentinel was the
 * other repair and would file every such claim under one slot.
 *
 * `object_cmp` (#5030) is derived here on the same terms, and this is the only
 * path that DERIVES one — migration 0191 deliberately does not backfill, so a
 * row predating this statement keeps NULL forever and stays `unknown`. That is
 * why the column is on the guard's UPDATE-only list beside the keys: a second
 * writer re-deriving it changes what a claim is provably different from, and
 * difference is what stamps `valid_to`.
 *
 * `subject_cmp` (#5032) joins it on identical terms — same sole DERIVER,
 * migration 0193, no backfill, UPDATE-gated — and for the INVERTED reason:
 * re-deriving one changes what a claim is provably NOT the same subject as, and
 * that suppresses corroboration. A second writer stamping subject ids onto the
 * existing corpus would silently split live beliefs apart.
 *
 * ⚠️ **Since #5035 there IS a second writer of both columns, and the wording
 * above narrowed to say so.** The region importer INSERTs them
 * (`admin-migrate.ts`), which is a row COPY rather than a derivation — ADR-0037
 * §8's rule — and it carries only what `regionPortableComparable` judged
 * portable, nulling every store-local id. So "sole writer" was false from that
 * commit; "sole deriver" is what the argument above actually needs, and it still
 * holds.
 *
 * `RETURNING id` and nothing else. A key must never reach a consumer that could
 * branch on it — that is what makes an alias un-removable — and
 * `keys-not-on-the-wire.test.ts` scans RETURNING lists naming this exact shape.
 *
 * ## `predicate_cardinality` is deliberately ABSENT from the column list (#5027)
 *
 * It was `$10` here, fed by the extractor's per-claim guess. Cardinality is a
 * property of the canonical predicate now (`lib/brain/cardinality.ts`,
 * ADR-0037 §3), so nothing on the row decides supersession and no producer
 * should be writing an opinion onto one.
 *
 * It was omitted from the list rather than bound to a literal, so the column
 * fell to its schema default (`'multi'`, 0180) — which is what kept this
 * statement legal while the column was still `NOT NULL` with a live CHECK.
 * #5028 phase 2 dropped the column (migration 0195) one release later, per the
 * two-phase discipline in `db/migrations/README.md`, so re-adding it here is no
 * longer a silently-wrong write: it is invalid SQL. A regression either way.
 */
export const INSERT_FACT_SQL = `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, valid_from, extracted_at,
          source_episode_id, provenance, visible_to,
          subject_key, predicate_key, object_key, object_cmp, subject_cmp)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::uuid, $8::jsonb,
               ARRAY(SELECT jsonb_array_elements_text($9::jsonb)),
               $10, $11, $12, $13, $14)
       RETURNING id`;

/**
 * The evidence pointer, fact → episode. `WHERE NOT EXISTS` makes a re-observed
 * claim's edge idempotent, so a repeated pass strengthens once and not twice;
 * the enclosing advisory lock is what makes the guard sound under concurrency.
 * `RETURNING id` is how the caller learns whether the edge was new.
 *
 * ## Why lock 5's *distinct source* rule is NOT enforced here (#5487)
 *
 * ADR-0036 §T9 lock 5: *"re-proposal strengthens (adds a provenance edge,
 * **weighting** distinct sources so self-echo is idempotent), never duplicates;
 * the distinct-source count is surfaced to the reviewer."*
 *
 * The obvious reading is that this guard should also refuse an episode whose
 * AUTHOR already backs the claim — the same person saying the same thing on
 * Monday and again on Friday. #5487 was written in that reading, and it is the
 * wrong lever. Lock 5 says the edge IS added and the WEIGHTING is by source;
 * suppressing the edge would not weight anything, it would destroy evidence —
 * and a provenance edge is load-bearing three times over beyond the count:
 *
 * 1. **The decay anchor.** `staleness.ts`'s `LAST_OBSERVED_AT_SELECT` is a MAX
 *    over the episodes on these edges. For `correction.ts`'s `re-authority` and
 *    `pinned` verbs the anchor reset is the *only* observable effect the verb
 *    has — the marker it writes has no reader — so a second attestation by the
 *    same admin would write nothing, move nothing, and report success. #4939
 *    refuses exactly that state by name: *"the verb would report an effect
 *    nobody can observe."*
 * 2. **Grant widening.** `promotion.ts`'s `widenGrantFromEvidence` unions the
 *    grants of every episode on an edge. A claim restated by one person in a
 *    wider channel would keep the narrower grant.
 * 3. **The audit record.** The edge set is what says WHICH episodes back a
 *    claim. "Two people" and "one person, twice" are different facts about the
 *    world and both are worth being able to read back.
 *
 * So this statement is UNCHANGED, and lock 5's residue lives one layer up in
 * `actor-identity.ts`'s `corroborationCountSql` — the number a reviewer reads,
 * which is now a count of distinct SOURCES over exactly these edges. The edge set
 * stays complete; the weighting stops double-counting a voice. Every writer of
 * this statement (`extract.ts`, `warehouse-producer.ts`, `correction.ts`)
 * therefore behaves precisely as it did.
 */
export const INSERT_PROVENANCE_EDGE_SQL = `INSERT INTO brain_edges
         (workspace_id, edge_type, from_fact_id, to_episode_id)
       SELECT $1, 'provenance', $2::uuid, $3::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM brain_edges
           WHERE workspace_id = $1
             AND edge_type = 'provenance'
             AND from_fact_id = $2::uuid
             AND to_episode_id = $3::uuid)
       RETURNING id`;

/**
 * Live facts that assert a DIFFERENT object for the same subject+predicate —
 * the advisory contradiction set. Only consulted for `single` cardinality,
 * where "one manager" makes two live objects a genuine tension; `multi` values
 * are supposed to coexist.
 *
 * `valid_to IS NULL` (#4912): a superseded rival is not a tension — the
 * arbitration already happened at the publish gate and the `supersedes` edge
 * records it. Wiring an `in-tension-with` edge at settled history would tell a
 * reviewer the new claim is contested by a belief a human already retired.
 * A FUTURE-dated `valid_to` (region import only) is likewise skipped — the
 * same accepted coexistence `supersessionCollisionJoin` documents: its end is
 * already decided, so it is neither a rival to flag nor a belief to supersede.
 *
 * Matched on the SLOT KEYS (#5020), which moves the rule in BOTH directions and
 * each is the intended one: `Alice`/`alice` under the same subject and predicate
 * are one claim rather than two rivals (they corroborated above and never
 * reached here), while `Ships On`/`ships_on` as PREDICATES now put their
 * differing objects in tension instead of sorting into two silent slots.
 *
 * The arms stay NULL-hostile even though no key is NULL any more (#5047 /
 * migration 0194): `object_key <> NULL` is unknown, so a row with no identity
 * abstains OUT of tension rather than joining everything. Keeping that shape is
 * what makes the statement correct standalone — it does not rely on the
 * constraint to avoid the over-match a NULL-safe comparison would buy, and an
 * N-1 instance during the deploy that adds the constraint runs this exact text
 * against a corpus that still holds NULLs.
 *
 * The object arm's falsifying case USED to be a DEGENERATE rival — a live row in
 * this slot whose object is `-`, which keyed to NULL and therefore matched
 * neither {@link CORROBORATION_LOOKUP_SQL} nor this scan, where `object <> $4`
 * would have been TRUE and would have wired a permanent advisory edge from a
 * real claim to a placeholder that asserts nothing. Since #5047 such a row
 * cannot be created: the `MALFORMED_CLAIM` guard refuses the candidate at
 * ingest, and migration 0194 tombstoned the legacy population — so the
 * `invalidated_at IS NULL` arm below excludes what survives of it. The rule the
 * case established is unchanged and is why the comparison is still on the KEY
 * and not on the surface. Pinned by `extract-reconcile-pg.test.ts`.
 *
 * ## Tension is *not provably same*, which is where the abstain band LANDS
 *
 * Three-valued agreement (#5030, ADR-0037 §2) splits what used to be one
 * complement into two non-complementary tests, and the three consumers take
 * different halves: corroboration fires on *same*, supersession on *different*,
 * and everything in between — the `unknown` band — falls to THIS statement and
 * nothing else. That is the entire point of the band. A pair whose objects
 * cannot be compared coexists, visibly flagged, until a human settles it; it is
 * never merged and never stamped.
 *
 * So the object arm here is `objectNotSameSql` — the counterpart of
 * corroboration's `objectSameSql`, spelled once beside it in `object-cmp.ts` so
 * the two cannot drift into disagreeing about which pairs are merely `unknown`.
 * `IS NOT TRUE` rather than `NOT (…)` throughout, because `NOT NULL` is NULL and
 * a WHERE clause treats that as false — the readable spelling silently drops
 * every pair where either side is unparseable, i.e. the whole abstain band.
 *
 * Note it is NOT `objectSameSql(…) IS NOT TRUE`, which would be the obvious
 * simplification and would reverse the NULL-key abstention documented above: a
 * degenerate rival would start earning advisory edges. The builder's own
 * docstring carries that argument.
 *
 * ## The subject arm is a SUPPRESSION here TOO, and that is not symmetry (#5032)
 *
 * Every other consumer split on the object's three-valued verdict — *same* to
 * corroboration, *different* to supersession, `unknown` here. `subject_cmp` does
 * not split at all: all three take
 * `subjectNotDifferentSql("subject_cmp", "$6")`, unchanged, because a proven
 * difference of SUBJECT removes the pair from the slot entirely rather than
 * moving it between verdicts.
 *
 * ⚠️ Concretely, and this is the mistake ADR-0037 §5 warns about by name:
 * treating `subject_cmp` as a mirror of `object_cmp` puts proven difference on
 * the tension side, which mints an `in-tension-with` edge between two claims the
 * store has just PROVEN are about different entities. That is a permanent
 * advisory edge asserting a contradiction that does not exist, surfaced to every
 * reviewer through the tension cluster. The `unknown` band still lands here; a
 * proven-different SUBJECT does not.
 *
 * ⚠️ **`$6` is the subject comparable and the two trailing binds moved** — the
 * self-exclusion is `$7` and the cap is `$8`. This statement spreads
 * {@link agreementBinds} in the MIDDLE of its bind list, so widening the tuple
 * without renumbering hands the slot declared `::uuid` a tagged comparable
 * value; `INSERT_FACT_SQL` would at least raise an arity error, this would not.
 * `reconcile.test.ts` pins both numbers lexically and positionally.
 *
 * ## The slot arm is now a REACH, and it is two arms (#5438)
 *
 * `subject_key = $2 AND predicate_key = $3` is still here, byte for byte, as the
 * first arm of {@link tensionReachSql} — nothing that earned an edge before
 * stops earning one. Beside it is an ANCHOR arm: same subject anchor, from a
 * different episode, with **no predicate test at all**.
 *
 * It exists because the strictness above was inherited from the SLOT and buys
 * nothing at THIS consumer. Two people contradicted each other in prod and Atlas
 * did not notice, because the extractor absorbed a word into one side's SUBJECT
 * and the pair diverged at both arms before any matching rule ran (`Series B` /
 * `target raise` against `Series B fundraise` / `has goal of`). `segmentation.ts`
 * carries the measurement, the three mechanisms that were falsified against the
 * shipped code first, and the argument for why an ADVISORY edge may drop the
 * predicate where corroboration and supersession may not.
 *
 * ⚠️ **`$9` is the new claim's episode, and it is bound LAST for the reason the
 * paragraph above gives.** Appended after the cap rather than inserted anywhere
 * nearer the spread, so it cannot push `$7`/`$8` along. A tenth bind goes after
 * it, on the same rule — and #5467 is that tenth bind.
 *
 * ## …and the anchor arm can be asked to EARN itself (#5467)
 *
 * The arm above reaches slots the producer never spoke about, and until #5467
 * the only thing licensing it was the producer's per-claim `single` hint. On the
 * correction lane that hint is a hard-code derived from a human's VERB, and a
 * verb is an assertion about the slot the human corrected — not about the rest
 * of the subject's predicate fan. One spurious prod edge exists because of it
 * (`e78de65d`: a raise target flagged against a post-money valuation).
 *
 * So the trailing conjunct: the pair qualifies if it is in the EXACT SLOT (the
 * hint's own territory, unchanged for every producer), **or** the producer said
 * its hint carries that far (`$10`, true for everyone who has not thought about
 * it), **or** the workspace holds an approved `single` entry for the predicate —
 * {@link cardinalitySingleSql}, the identical bound `TENSION_SWEEP_SQL` reads.
 *
 * Written as a conjunct beside the reach rather than folded INTO
 * `tensionReachSql`, and that is load-bearing twice over. The builder's output
 * stays byte-identical at both call sites, so the sweep is untouched and
 * `segmentation.test.ts`'s "the anchor arm carries NO predicate test" assertion
 * still means what it says. And `(exact OR anchor) AND (exact OR $10 OR curated)`
 * is `exact OR (anchor AND (…))` — the same rule, spelled where a reader can see
 * that the SLOT arm is exempt.
 *
 * ⚠️ `$3` rather than the row's own `predicate_key`: the gate asks about the
 * INCOMING claim's predicate, exactly as the sweep's `cardinalitySingleSql("a")`
 * asks about its driving side. Reading the rival's predicate would ask whether
 * some other slot is single-valued, which is a question nobody posed. The
 * workspace comes off `f.workspace_id`, which `WHERE workspace_id = $1` has
 * already equated to the bind.
 */
export const TENSION_CANDIDATES_SQL = `SELECT id
     FROM brain_facts f
    WHERE workspace_id = $1
      AND ${tensionReachSql(
        {
          subjectKeyExpr: "subject_key",
          predicateKeyExpr: "predicate_key",
          episodeIdExpr: "source_episode_id",
        },
        { subjectKeyExpr: "$2", predicateKeyExpr: "$3", episodeIdExpr: "$9::uuid" },
      )}
      AND (${exactSlotSql(
        { subjectKeyExpr: "subject_key", predicateKeyExpr: "predicate_key" },
        { subjectKeyExpr: "$2", predicateKeyExpr: "$3" },
      )}
        OR $10::boolean
        OR ${cardinalitySingleSql("f", "$3")})
      AND ${objectNotSameSql("object_key", "$4", "object_cmp", "$5")}
      AND ${subjectNotDifferentSql("subject_cmp", "$6")}
      AND invalidated_at IS NULL
      AND valid_to IS NULL
      AND id <> $7::uuid
    ORDER BY ${exactSlotFirstSql(
      { subjectKeyExpr: "subject_key", predicateKeyExpr: "predicate_key" },
      { subjectKeyExpr: "$2", predicateKeyExpr: "$3" },
    )}, ingested_at DESC
    LIMIT $8`;

/**
 * The advisory edge. `in-tension-with` is SURFACED with both provenances and
 * never ranked (ADR-0036) — writing it is not an arbitration, and nothing here
 * supersedes, invalidates, or reorders anything. `loadTensionClusters`
 * (`lib/brain/tensions.ts`) is the clustering that reads these, behind both
 * the review queue and `searchBrain` (#4913).
 */
export const INSERT_TENSION_EDGE_SQL = `INSERT INTO brain_edges
         (workspace_id, edge_type, from_fact_id, to_fact_id)
       SELECT $1, 'in-tension-with', $2::uuid, $3::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM brain_edges
           WHERE workspace_id = $1
             AND edge_type = 'in-tension-with'
             AND from_fact_id = $2::uuid
             AND to_fact_id = $3::uuid)
       RETURNING id`;

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/**
 * Turn candidates into fully-formed drafts, or refuse them.
 *
 * Throws only on a database failure — the caller decides what that means for
 * its own bookkeeping (`extract.ts` leaves the episode on the queue, so the
 * next cycle retries). Every DOMAIN refusal is a counted outcome, never an
 * exception: a blocked candidate is an ordinary result of running this stage.
 */
export async function reconcileFacts(
  request: ReconcileRequest,
  deps: ReconcileDeps = {},
): Promise<ReconcileReport> {
  const { episode, candidates, producer } = request;
  const resolveEntity = request.resolveEntity ?? passthroughEntityResolver;
  const { vocabulary } = request;
  const now = deps.now ?? (() => new Date());

  const blocked: Record<ReconcileBlockReason, number> = { ...NO_BLOCKS };
  // The same refusals, keyed by predicate (#5396). Every site that increments
  // `blocked` also calls this, and the pairing is the invariant the reaper's
  // fence rests on — a refusal counted on one and not the other is a dimension
  // the reap stops holding back.
  const blockedByPredicate = new Map<string, number>();
  const noteBlockedPredicate = (predicate: string): void => {
    // TRIMMED, matching what the fact would have carried: the reaper compares
    // these against `brain_facts.predicate`, and reconcile trims before it
    // writes. A blank one names no dimension — it is already counted on
    // `blocked.MALFORMED_CLAIM`, and no fact can exist with an empty predicate
    // for the fence to hold back.
    const name = predicate.trim();
    if (name === "") return;
    blockedByPredicate.set(name, (blockedByPredicate.get(name) ?? 0) + 1);
  };

  // ── Episode-level gate ────────────────────────────────────────────────
  // These are properties of the EVIDENCE, so one failure blocks every candidate
  // hanging off it — and it is evaluated before any connection is checked out,
  // so an episode that can produce no safe row never opens a transaction. (A
  // batch whose candidates are ALL individually malformed still does; only the
  // episode-level verdict is knowable this early.)
  //
  // A caller holding the episode before it has spent anything on producing
  // candidates should pre-flight this itself — `extract.ts` does, so a
  // grant-less episode costs no model call.
  const episodeBlock = classifyEpisodeForReconcile(episode, request.sourcePrincipal);
  if (episodeBlock !== null) {
    const reason = episodeBlock.reason;
    // Downgraded, never silent, when there was nothing to block: a caller that
    // pre-flighted and passed no candidates has already logged, and a second
    // identical warn per episode would train an operator to skim them — but
    // dropping the line entirely would leave a safety refusal with no trace at
    // all. The verdict also travels in `episodeBlocked` regardless.
    const detail = {
      workspaceId: episode.workspaceId,
      episodeId: episode.id,
      source: episode.source,
      sourceId: episode.sourceId,
      producer,
      reason,
      candidates: candidates.length,
    };
    const message = `brain reconcile: blocked every candidate from this episode — ${episodeBlock.detail}`;
    if (candidates.length > 0) log.warn(detail, message);
    else log.debug(detail, message);
    blocked[reason] = candidates.length;
    for (const candidate of candidates) noteBlockedPredicate(candidate.predicate);
    return {
      episodeBlocked: reason,
      created: 0,
      corroborated: 0,
      provisional: 0,
      comparable: 0,
      blocked,
      blockedByPredicate,
      outcomes: candidates.map(() => ({ kind: "blocked" as const, reason })),
    };
  }

  // Non-null past the gate above, which blocks the whole episode when the
  // principal cannot be resolved.
  const sourcePrincipal = resolvedPrincipal(episode, request.sourcePrincipal);
  // `isUsableGrant` above answers "can ANY reader match this?" and discards the
  // rest of the parse. The half it discards is the one that bites in practice:
  // a grant like `['user:abc', 'everyone']` passes on its valid token while
  // carrying a second one whose author believed it was doing something, and
  // NOTHING ever repairs it. Publish-time widening (#4823) is not the escape
  // hatch it might look like: it appends grammar-valid principals drawn from
  // EVIDENCE grants and never re-parses the fact's own tokens, so the dead one
  // rides along untouched. `logGrantAnomalies` is the seam `acl.ts` built for
  // exactly this, and this is the write path that holds the row.
  logGrantAnomalies(episode.visibleTo, {
    table: "brain_episodes",
    rowId: episode.id,
    workspaceId: episode.workspaceId,
  });
  // Non-string elements (a `null` off `pg`) are inert in the overlap predicate
  // and cannot survive the jsonb round-trip as themselves; dropping them keeps
  // the stored grant readable while the usable-principal check above is what
  // actually decided the row is safe.
  const grantTokens = episode.visibleTo.filter((t): t is string => typeof t === "string");

  if (candidates.length === 0) {
    return {
      created: 0,
      corroborated: 0,
      provisional: 0,
      comparable: 0,
      blocked,
      blockedByPredicate,
      outcomes: [],
    };
  }

  // ── Blank-trim pass (no database, no resolver) ────────────────────────
  //
  // Split out from preparation so the episode's surface set is knowable BEFORE
  // the one resolver call below: trimming needs no I/O, and resolving a surface
  // belonging to a claim that is about to be blocked would be work spent on a
  // row that will never exist.
  const trimmed: TrimmedEntry[] = [];
  for (const candidate of candidates) {
    const subject = candidate.subject.trim();
    const predicate = candidate.predicate.trim();
    const object = candidate.object.trim();
    if (subject === "" || predicate === "" || object === "") {
      log.warn(
        {
          workspaceId: episode.workspaceId,
          episodeId: episode.id,
          producer,
          hasSubject: subject !== "",
          hasPredicate: predicate !== "",
          hasObject: object !== "",
        },
        "brain reconcile: blocked a candidate with a blank subject, predicate, or object — a claim with an empty column asserts nothing",
      );
      blocked.MALFORMED_CLAIM++;
      // A blank SUBJECT or OBJECT still names its dimension; a blank predicate
      // does not, and `noteBlockedPredicate` drops it.
      noteBlockedPredicate(predicate);
      trimmed.push({ kind: "blocked", reason: RECONCILE_BLOCK_REASONS.malformedClaim });
      continue;
    }
    trimmed.push({ kind: "trimmed", subject, predicate, object, candidate });
  }

  // ── The ONE entity-resolution call (no database of ours) ──────────────
  const resolution = await resolveEntitiesForEpisode(resolveEntity, trimmed, episode);

  // ── Per-candidate preparation (no database) ───────────────────────────
  const prepared: PreparedEntry[] = [];
  for (const entry of trimmed) {
    if (entry.kind === "blocked") {
      prepared.push(entry);
      continue;
    }
    const { subject, predicate, object, candidate } = entry;

    // Both positions, from the one batch. An absent entry is an abstain, and an
    // abstain is not a failure: only a batch that FAILED — the store threw, was
    // unavailable, or violated its contract — flags anything.
    const subjectEntityId = storeId(resolution, subject);
    const objectEntityId = storeId(resolution, object);

    // Materialized ONCE, here, off the RETAINED surfaces — the strings that land
    // in the SPO columns, so the stored key always describes the stored row.
    // Computing it later, per statement, is how the corroboration lookup and the
    // INSERT would start disagreeing about which slot a claim is in.
    //
    // The resolver reaches none of this (#5031). It cannot rewrite a surface and
    // it cannot put an id in a key; its answers reach the row at the two `_cmp`
    // columns and nowhere else. A store's slot-side contribution travels as
    // vocabulary instead, which is what makes it re-keyable in place.
    // ⚠️ The SLOT may be INHERITED (#5037, ADR-0037 §8) — the object never is.
    //
    // A row-copy producer hands down the slot it read off the row it is
    // correcting, and copying beats re-deriving for the reason §8 gives: the two
    // agree only while the vocabulary has not moved, and where they diverge,
    // re-deriving lands the claim in a slot the target is not in. The failure is
    // silent and one-directional — the target's belief is retired by an id-based
    // stamp regardless, so the successor goes missing from the slot every future
    // collision joins on.
    //
    // The OBJECT is derived here unconditionally, and the asymmetry is the whole
    // design: the correction is *about this claim* (so the slot is the target's)
    // while the object is new, human-authored text (so it keys on its own terms).
    // Inheriting it too would make the replacement identical to the target at
    // every identity position, which is precisely what a supersession is not.
    //
    // `null` travels as `null`. An unkeyed row's slot is `(NULL, NULL)` and joins
    // nothing; deriving a key to fill the hole would invent identity for a row
    // that has none and move it into a live slot.
    //
    // ONE ternary over the whole slot, not one per position. Two independent
    // ternaries let a future edit inherit the subject and derive the predicate
    // with nothing objecting — a half-inherited slot, which is neither the
    // target's nor the candidate's and joins whatever it happens to land on.
    // "The slot is copied whole" is the invariant; this spelling is what makes
    // it structural instead of conventional.
    const inherited = candidate.inheritedSlot;
    const keys: SlotKeys =
      inherited !== undefined
        ? {
            subject: inherited.subject,
            predicate: inherited.predicate,
            object: slotKey(object, vocabulary.object),
          }
        : {
            subject: slotKey(subject, vocabulary.subject),
            predicate: slotKey(predicate, vocabulary.predicate),
            object: slotKey(object, vocabulary.object),
          };
    // ── The identity half of MALFORMED_CLAIM (#5047) ──────────────────
    //
    // POST-RESOLUTION, and after `keys` rather than beside the blank-trim pass
    // above, because the two guards test different things. `trim() === ""` asks
    // whether the producer sent a surface at all; this asks whether the
    // surface, put through the composition that decides the row's IDENTITY,
    // names a slot. `String#trim` strips whitespace but not `_` or `-`, so `-`
    // and `___` pass the first test and reach here with a null key — which is
    // migration 0187's header item 3, the third prerequisite of `SET NOT NULL`
    // and the reason the constraint could not land with #5020.
    //
    // It has to be HERE and not one loop earlier: `slotKey` composes the
    // workspace's vocabulary over the norm, so a real surface whose alias entry
    // maps it to something that norms away is also a null key — and an
    // INHERITED slot (#5037) is copied off the target row rather than derived
    // from any surface in this candidate at all. Neither is visible from the
    // raw text.
    //
    // ⚠️ REFUSED, not sentinel-keyed. 0187's header rejects the other repair by
    // name: a shared placeholder key is the one value that joins every other
    // degenerate row, so two unrelated placeholder claims would occupy one slot
    // and publishing either would stamp `valid_to` on the other.
    //
    // The BLOCK REASON is reused rather than widened. A claim whose subject
    // norms away asserts nothing, which is the argument `MALFORMED_CLAIM`
    // already makes for a blank one — the same verdict about the same kind of
    // defect, reached one layer deeper. A second reason code would split one
    // producer bug across two counters.
    //
    // This REPLACES the post-insert `log.warn` #5020 added at `writeCandidate`,
    // which described a row that had already been stored and told the operator
    // this guard was the fix. The signal it carried is preserved verbatim
    // below — including #5037's `inheritedUnkeyed` discriminator — because
    // blocking makes this line the only one such a claim ever produces.
    // Named for the ROLE and not `subjectKey`/`predicateKey`/`objectKey`:
    // `keys-not-on-the-wire.test.ts` bans those three identifiers outright in any
    // file that speaks about `brain_facts`, because it cannot tell a local from a
    // fact-shaped type growing a key field — which is the leak it exists to
    // catch. `SlotKeys` takes role names for the same reason.
    const { subject: subjectSlot, predicate: predicateSlot, object: objectSlot } = keys;
    if (subjectSlot === null || predicateSlot === null || objectSlot === null) {
      const surfaces = { subject, predicate, object } as const;
      // WHICH subsystem to fix, per position — decided here, where the surface,
      // the vocabulary and the inherited slot are all still in hand.
      //
      // ⚠️ An earlier cut of this line said the first two causes "cannot be
      // distinguished once the vocabulary is real". THAT WAS FALSE, and it is
      // the kind of false that sends an operator to the wrong subsystem: a null
      // `identityKey` is a fact about the TEXT alone, so a surface that norms
      // away and a vocabulary entry that maps a real norm to nothing are one
      // call apart. `correction.ts` made exactly this distinction for exactly
      // this reason until #5047 made its version unreachable; the distinction
      // is not unreachable here.
      const unkeyed: readonly UnkeyedSlot[] = SLOT_ROLES.filter(
        (role) => keys[role] === null,
      ).map((role) => ({
        role,
        cause:
          candidate.inheritedSlot !== undefined && role !== "object"
            ? "inherited"
            : identityKey(surfaces[role]) === null
              ? "degenerate-surface"
              : "vocabulary-target",
      }));
      log.warn(
        {
          workspaceId: episode.workspaceId,
          episodeId: episode.id,
          producer,
          unkeyed,
          // Logged ONLY where the cause is `degenerate-surface`, and that
          // restriction is the point: by construction such a surface is
          // separators and whitespace and carries no claim content. A
          // `vocabulary-target` surface is real text and stays out, matching the
          // blank-trim guard above, which logs booleans rather than surfaces.
          degenerateSurfaces: unkeyed
            .filter((slot) => slot.cause === "degenerate-surface")
            .map((slot) => ({ role: slot.role, surface: surfaces[slot.role] })),
          // ⚠️ `inheritedFrom` alone is NOT the discriminator, and reporting it
          // as one blames the wrong party. It is set for EVERY
          // correction-produced candidate, but only the SUBJECT and PREDICATE
          // are inherited — the object is always derived from the replacement's
          // own text. So a human superseding with `"-"` lands here with
          // `unkeyed: ["object"]` and a non-null `inheritedFrom`, and a message
          // keyed on that field alone would send the operator to inspect a
          // target row that is perfectly healthy.
          inheritedFrom: candidate.inheritedSlot?.fromFactId ?? null,
          // The intersection: unkeyed positions that were actually COPIED. Empty
          // means the target explains none of this, whatever `inheritedFrom`
          // says. Post-#5047 the slot keys are `NOT NULL`, so an inherited null
          // is unreachable through the database — it survives as a diagnostic
          // for a hand-built slot and for the deploy overlap, not as an expected
          // state.
          inheritedUnkeyed: unkeyed
            .filter((slot) => slot.cause === "inherited")
            .map((slot) => slot.role),
        },
        // The message renders `cause` rather than listing possibilities — see
        // the ⚠️ above, which records why the claim that these are
        // indistinguishable was false.
        "brain reconcile: blocked a candidate with no identity for one or more slots — such a claim could never corroborate, earn a tension edge, or be superseded at publish, and the slot keys are NOT NULL since #5047. `cause` names the subsystem to fix, per position: `degenerate-surface` = the producer emitted separators only, and the offending text is in `degenerateSurfaces` (fix the producer); `vocabulary-target` = this workspace's vocabulary maps that slot to something that normalizes away, so the surface is fine and the ENTRY is the defect (no re-key repairs it); `inherited` = a row-copy path copied a null slot off the fact named by `inheritedFrom`, so this claim's own text is fine at that position and the TARGET row is what has no identity. The object is never inherited — it is always derived from this claim's own text",
      );
      blocked.MALFORMED_CLAIM++;
      noteBlockedPredicate(predicate);
      // The POSITIONS travel with the block (#5047). `MALFORMED_CLAIM` covers a
      // blank surface, a degenerate one, a vocabulary target that norms away and
      // an inherited null, and one caller — `correction.ts`'s supersede — turns
      // this verdict into a message for a human. Without the positions it can
      // only guess which slot failed, and guessing "the object" blames the
      // replacement text for a defect in the target's slot or in the vocabulary.
      // The REASON stays single, which is what keeps one producer bug on one
      // counter; this is the detail beside it.
      prepared.push({
        kind: "blocked",
        reason: RECONCILE_BLOCK_REASONS.malformedClaim,
        unkeyed,
      });
      continue;
    }
    // Narrowed ONCE, here, so everything downstream of the guard carries three
    // non-null keys in its TYPE rather than by position in this loop. The
    // database stopped admitting a null key at migration 0194; this is the same
    // statement made where the compiler can check it, and it is what stops a
    // future edit that adds a second `prepared.push` above the guard from
    // reaching `INSERT_FACT_SQL` with a null — which is a `23502` that fails the
    // whole reconcile transaction, retried every cycle until quarantine.
    const resolvedKeys: ResolvedSlotKeys = {
      subject: subjectSlot,
      predicate: predicateSlot,
      object: objectSlot,
    };

    // The comparable value, materialized beside the keys and for the same
    // reason: computing it per statement is how the corroboration lookup and
    // the INSERT would start disagreeing about what a claim's value IS.
    //
    // Off the RETAINED surface, matching the keys above — but note the resolved
    // ENTITY ID takes precedence over any parse of it, because the store is
    // strictly better evidence than the text. `passthroughEntityResolver`
    // abstains on everything, so under the SHIPPED default resolver this is the
    // surface parse — `ReconcileRequest.resolveEntity` is an injectable seam, so
    // that is a statement about the default and not about every deployment.
    //
    // One of the resolver's two destinations on the row (the other is
    // `subjectComparable` below). Both are COMPARED values, never join arms, so
    // an id here costs nothing; at a slot it would cost the whole existing
    // corpus.
    const { value: parsed, reason: comparableReason } = comparableValueWithReason({
      surface: object,
      declared: candidate.objectType,
      entityId: objectEntityId,
    });
    // ⚠️ A FAILED batch withholds the comparable value FROM THE ROW, and keeps it
    // for the two lookups. Those are different jobs and an outage hits them in
    // opposite directions — this is the one place the value is not one value.
    //
    // AT REST it must be withheld. The rule above is that a store id beats any
    // parse of the surface, because the store is strictly better evidence than
    // the text; during an outage the fallback is that inferior evidence, and it
    // can be MORE proving, not less. A `499` that is an entity in the store
    // compares `entity:…` against a sibling's `number:99` — different tags, so
    // `unknown`, so tension only. Written as `number:499` it is the same tag,
    // unequal, *provably different*, and the publish gate stamps `valid_to` on a
    // belief a healthy store would only have flagged for a human. The stamp is
    // decided between two STORED rows, so this bind is the only outage-time
    // input to it, and supersession has no inverse verb anywhere in the product.
    //
    // AT THE LOOKUPS it must be kept. `objectSameSql`'s difference VETO is what
    // keeps *same* and *different* disjoint, and a NULL bind makes the veto NULL
    // → `IS NOT TRUE` → **disabled**, collapsing corroboration to bare key
    // equality. `lexicalNorm` strips a leading `-`, so `-499` and `499` key
    // identically: with the veto off, an outage MERGES a value into its own
    // negation — no new row, no tension edge, and (because corroboration writes
    // no provenance) not even a marker to find it by. That is a worse outcome
    // than the stamp this rule exists to prevent, reached by the arm nobody
    // changed. See `object-cmp.ts`'s `objectSameSql`, which argues the veto.
    //
    // What this buys, stated no wider than it is: the provably-DIFFERENT pair no
    // longer merges during an outage, the new claim mints its own row, and that
    // row carries a NULL `object_cmp` so it can never stamp at publish — plus,
    // on a `single` predicate, an advisory tension edge for a human.
    //
    // It does NOT make an outage conservative in every direction — do not
    // restate it that way. The parse also feeds `objectSameSql`'s
    // value-SAME arm, so two surfaces that canonicalize alike (`499.00` and
    // `499`) still corroborate during an outage where a healthy store might have
    // resolved them to different entities and kept them apart. That is `main`'s
    // behaviour and this change neither causes nor cures it — the alternative
    // (NULL at the lookups) merges strictly MORE, including a value into its own
    // negation. The episode-level log line is what records that the batch failed
    // at all for a corroborator, since corroboration writes no provenance
    // PAYLOAD — only the edge (see {@link resolveEntitiesForEpisode}).
    const comparableForLookups = parsed;
    const comparableAtRest = resolution.kind === "failed" ? null : parsed;
    // The SUBJECT's comparable value (#5032) — the store's id and NEVER a parse
    // of the surface, which is `subject-cmp.ts`'s rule rather than this line's.
    //
    // ONE value, no at-rest/lookup split, and the reason is that the split above
    // exists only because an outage's surface FALLBACK can out-prove the id it
    // replaced. There is no fallback here: `storeId` already returns `undefined`
    // for a failed batch, so an outage yields `null` at every site — which
    // suppresses nothing, i.e. exactly the pre-#5032 behaviour. That is the
    // conservative direction at this position: withholding a suppression costs a
    // homonym corroboration (the hazard, still guarded by the review-gate
    // widening disclosure), while fabricating one would silently split a live
    // belief apart with no reviewer anywhere.
    const subjectComparable = subjectComparableValue(subjectEntityId);
    // A REJECTED declaration is an operator-actionable defect, and the reason
    // code is what separates it from the abstain it otherwise looks identical
    // to. `objectType` exists solely to make an ambiguous surface comparable,
    // so a rejected one silently switches supersession off for that producer's
    // whole slot population — and the only symptom is an absence: nothing to
    // grep, nothing in the review queue, no failed write.
    //
    // ⚠️ Gated on `"declaration-rejected"`, NOT on `comparable === null`. That
    // wider condition fires on every honest abstain in a declared slot — every
    // `N/A` row of a declared `price` column — which is one warn per claim,
    // forever, burying the signal this line exists for.
    //
    // It DOES still fire on a surface that parses as the WRONG type in a
    // declared slot (`2026-08-04` where `{kind:"number"}` was declared), which
    // `object-cmp.ts` documents as an intended use of the payload-less
    // declarations. That is deliberate and bounded: it is the only signal an
    // operator would ever get that a row in their number slot is a date, and it
    // cannot reach the unparseable majority.
    //
    // Warned rather than blocked, for the malformed-claim guard's reason: the
    // claim itself is fine and a reviewer can still see it. Only its
    // comparability is lost.
    if (comparableReason === "declaration-rejected") {
      log.warn(
        {
          workspaceId: episode.workspaceId,
          episodeId: episode.id,
          producer,
          // The predicate, which IS a claim surface — logged deliberately,
          // because a slot is what an operator needs to find the producer and
          // this file already logs surfaces on the same terms elsewhere. The
          // OBJECT is not: it is the value the claim asserts, and naming the
          // slot is enough to locate a misconfigured producer without it.
          predicate,
          declaredKind: candidate.objectType?.kind,
          // The reason code comes from a parse of the SURFACE, which is the
          // evidence a healthy store would have overruled: `comparableValue`
          // short-circuits on an id, so a resolvable object never reaches this
          // branch at all. During an outage it does — so an operator sent after
          // a producer needs to know the store was also down, or they will go
          // looking for a misconfiguration that only shows up during outages.
          entityStoreFailed: resolution.kind === "failed",
        },
        candidate.objectType?.kind === "money"
          ? "brain reconcile: a producer declared money but the declaration was rejected — the claim landed as `unknown` and will never supersede. Either the declared currency is not an ISO-4217 alphabetic code, or the surface names a DIFFERENT currency; a declaration may supply what the surface lacks but never contradict it"
          : "brain reconcile: a producer declared an object type the surface contradicts — the claim landed as `unknown` and will never supersede. The surface parses as something else, and a declaration may supply what the surface lacks but never override what it states",
      );
    }
    prepared.push({
      kind: "prepared",
      subject,
      predicate,
      object,
      keys: resolvedKeys,
      comparableAtRest,
      comparableForLookups,
      resolutionFailed: resolution.kind === "failed",
      subjectComparable,
      candidate,
    });
  }

  if (resolutionFailedCount(prepared) > 0) {
    log.info(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        producer,
        // NOT named `provisional`: `ReconcileReport.provisional` counts CREATED
        // rows and this counts prepared candidates, which is a different and
        // larger number whenever one of them corroborates. Two spellings of one
        // word with two values is how an operator learns to distrust both.
        candidatesInFailedBatch: resolutionFailedCount(prepared),
      },
      // Names the batch, because that is now the unit that failed and the unit
      // worth re-running. An honest abstain never reaches this line — it is not
      // a failure, it changes nothing on replay, and logging one per
      // entity-valued object would be a line per claim forever under the shipped
      // default resolver.
      //
      // Emitted BEFORE the transaction, and the prose is written to survive
      // that: it claims a property of the BATCH, which is settled here, rather
      // than of rows that may still roll back. (This used to contrast itself
      // with the `unkeyed` warn "below" — #5047 deleted that one and its
      // replacement sits ABOVE, also pre-transaction, so the contrast was dead
      // twice over.)
      "brain reconcile: the entity store did not answer this episode's batch, so these candidates were reconciled with no object comparison (`object_cmp`) — worth recomputing once it does. Their identity keys are unaffected under the same vocabulary: no resolver reaches a slot key. The ones that CREATED a row carry `provenance.provisional`; the ones that corroborated get no provenance payload FROM THIS EPISODE — the existing row is untouched, keeping its own — so this count is the only place they are counted, and their `provenance` edges to this episode are how they are found",
    );
  }

  // ── The one transaction ───────────────────────────────────────────────
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const outcomes = await withTransaction(async (tx) => {
    await tx.query(RECONCILE_LOCK_SQL, [RECONCILE_LOCK_NAMESPACE, episode.workspaceId]);
    const results: ReconcileOutcome[] = [];
    for (const item of prepared) {
      if (item.kind === "blocked") {
        // SPREAD, not rebuilt field by field. `BlockedEntry` and the blocked
        // `ReconcileOutcome` are the same shape by design, and re-listing the
        // fields here is how `unkeyed` was silently dropped on its first cut —
        // the detail was attached in the preparation loop, discarded at this
        // line, and `correction.ts` then saw `undefined` and 500'd on a request
        // that should have been a 400. A spread cannot lose a field a future
        // edit adds.
        results.push({ ...item });
        continue;
      }
      results.push(
        await writeCandidate(tx, {
          item,
          episode,
          grantTokens,
          producer,
          sourcePrincipal,
          extractedAt: request.extractedAt,
          now,
        }),
      );
    }
    return results;
  });

  let created = 0;
  let corroborated = 0;
  let provisional = 0;
  let comparable = 0;
  for (const [index, outcome] of outcomes.entries()) {
    // Exhaustive, with a `never` binding: a fourth outcome arm must be counted
    // somewhere, and the compiler is the only reviewer that never forgets.
    switch (outcome.kind) {
      case "created": {
        created++;
        if (outcome.provisional) provisional++;
        // Read off `prepared`, which the transaction above maps 1:1 onto
        // `outcomes` in input order — the outcome itself does not carry the
        // comparable, and widening it to would put a value on the wire-ish shape
        // that `ReconcileReport.comparable`'s docstring says is a GATE. The
        // index lookup is what keeps the two definitions of "this row got a
        // comparable value" from becoming two.
        //
        // ⚠️ THROWS on a desync rather than under-counting, which is the same
        // choice the `never` arm below makes and for a sharper reason. This
        // number is not a statistic: it is the sole trigger for #5034's alias
        // producer, so a silent under-count does not skew a metric, it RETIRES
        // the producer repo-wide with no log line, no red test and no symptom —
        // the one failure the mutation table calls out as invisible to
        // everything else. The invariant is the one the compiler cannot check,
        // so it is the one that needs the runtime assertion.
        const item = prepared[index];
        if (item === undefined || item.kind !== "prepared") {
          throw new Error(
            `brain reconcile: outcomes/prepared fell out of 1:1 at index ${index} — a "created" ` +
              "outcome has no prepared candidate behind it. Refusing rather than under-counting " +
              "`comparable`, which would silently switch off the alias-proposal producer (#5034).",
          );
        }
        if (item.comparableAtRest !== null) comparable++;
        break;
      }
      case "corroborated":
        corroborated++;
        break;
      case "blocked":
        break;
      default: {
        const unexpected: never = outcome;
        throw new Error(`Unhandled reconcile outcome: ${JSON.stringify(unexpected)}`);
      }
    }
  }

  return { created, corroborated, provisional, comparable, blocked, blockedByPredicate, outcomes };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * A candidate's three materialized slot keys, `null` where the surface norms
 * away (`lib/brain/identity.ts`).
 *
 * Named by ROLE rather than as `subjectKey` / `predicateKey` / `objectKey`:
 * `keys-not-on-the-wire.test.ts` bans those three identifiers outright in any
 * source file that speaks about `brain_facts`, because a fact-shaped TYPE that
 * grows a key field is the leak it exists to catch and it cannot tell one from a
 * local. This shape is internal to the stage and never reaches a row type.
 */
interface SlotKeys {
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly object: string | null;
}

/**
 * The three roles, once. Tied to {@link SlotKeys} by `satisfies`, so a renamed
 * field is a compile error here rather than a filter that silently matches
 * nothing.
 */
const SLOT_ROLES = ["subject", "predicate", "object"] as const satisfies readonly (keyof SlotKeys)[];

/** One of the three claim slots, for the block detail and the log payload. */
type SlotRole = (typeof SLOT_ROLES)[number];

/**
 * WHY a slot has no key — the discriminator a consumer needs to blame the right
 * party (#5047).
 *
 * ⚠️ The POSITION is not the cause, and conflating them is a defect this type
 * exists to have already made once. `applySupersede` first gated its user-facing
 * 400 on "the object position failed", reasoning that the object is the
 * caller's own text. It is not always: `slotKey` is
 * `identityKey(alias(identityKey(surface)))`, so an object key is ALSO null when
 * the workspace's object-position vocabulary maps a real norm to something that
 * normalizes away — and the human is then told to retype text that is already
 * correct, on a request no retry can fix.
 *
 *   - `degenerate-surface` — the producer's own text asserts nothing (`-`,
 *     `___`). The one cause the SUPPLIER of the claim can fix.
 *   - `vocabulary-target` — the surface keys fine and this workspace's alias
 *     entry for it maps to nothing. A configuration defect; no re-key repairs it.
 *   - `inherited` — a row-copy path copied a null slot off the target row, so
 *     this claim's own text is fine at that position.
 */
export type SlotKeyFailureCause = "degenerate-surface" | "vocabulary-target" | "inherited";

/** One slot that had no key, and why. */
export interface UnkeyedSlot {
  readonly role: SlotRole;
  readonly cause: SlotKeyFailureCause;
}

/**
 * {@link SlotKeys} AFTER the `MALFORMED_CLAIM` guard — three keys, none null.
 *
 * The two types are deliberately both here rather than one nullable shape with a
 * runtime check. `SlotKeys` is what the composition PRODUCES: `slotKey` returns
 * null for a surface that norms away, and an {@link InheritedSlot} copies a
 * stored row whose columns the type still describes as nullable. This is what
 * survives the guard, and it is what every consumer downstream of the guard
 * takes — so "no null key reaches `INSERT_FACT_SQL`" is a property of the types
 * rather than of the order of statements in a 200-line loop body.
 *
 * That matters because `brain_facts`' three key columns are `NOT NULL` as of
 * migration 0194: the failure mode a lost guard produces is no longer a row that
 * joins nothing, it is a `23502` that rolls back the whole episode.
 */
interface ResolvedSlotKeys {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

/**
 * The five agreement values, in the order all three statements bind them: the
 * three slot keys, the OBJECT's comparable value (#5030), then the SUBJECT's
 * (#5032).
 *
 * ⚠️ The two comparable values are NOT two instances of one thing, and binding
 * them adjacently is the one place that is easy to forget. The object's proves
 * difference to ENABLE a stamp; the subject's proves difference to SUPPRESS
 * every consumer at once — see `subject-cmp.ts` for the polarity table.
 *
 * A swap is a COMPILE ERROR since the panel rounds on #5032: the subject
 * parameter is a `SubjectComparable`, which only `subjectComparableValue` can
 * produce, so neither a general `ComparableValue` nor a same-shaped
 * `entityComparable(…)` satisfies it. It was not before, and prose was all
 * that stood in the way. Two behavioural falsifiers back it up in the FAST lane
 * (`reconcile.test.ts` asserts, at all three statements, that the subject bind
 * carries the id AND the object bind is `null` — a swap flips both), so this is
 * not a property that needs `TEST_DATABASE_URL` to see.
 *
 * `ReconcileExecutor.query` takes `unknown[]`, so `[…, item.subject,
 * item.predicate, item.object]` type-checks perfectly at every one of these call
 * sites and silently restores byte-exact identity — the regression this cut
 * exists to undo. (The unit suite DOES catch that one: its fake records the
 * binds it was given and matches on them, so a surface bind fails the phrasing
 * test. What it cannot see is the COLUMN half — the statement text — which is
 * `extract-reconcile-pg.test.ts`'s plus the lexical backstop beside it.) One
 * spelling, spread three times, is what removes that class along with the
 * order-drift one.
 *
 * A fixed-length TUPLE, not `(string | null)[]`, and the arity is what it buys.
 * The hazard this docstring warned about arrived in #5030 and AGAIN in #5032,
 * and is kept because the next widener inherits it verbatim:
 * `TENSION_CANDIDATES_SQL` spreads this in the MIDDLE of its bind list, so
 * widening the tuple without renumbering that statement's trailing placeholders
 * pushes `factId` one placeholder along and hands the slot declared `::uuid` a
 * tagged comparable value instead. In `INSERT_FACT_SQL` the spread is last and
 * pg would at least raise an arity error; **in the rival scan** it would not.
 * #5032 renumbered it to `$7`/`$8`; a sixth member means `$8`/`$9` — and since
 * #5438/#5467 the rival scan's tail is `$9` (the episode) and `$10` (the anchor
 * arm's licence), so a sixth member moves FOUR placeholders there, not two.
 *
 * ⚠️ **Since #5332 the CORROBORATION lookup has a trailing placeholder too**,
 * so it is no longer the safe one of the three: its class arm binds `$7` after
 * the spread, and a sixth member means `$8` there as well. The failure mode is
 * milder than the rival scan's only by luck — `$7` is a boolean, so a
 * comparable value sliding into it raises rather than silently answering — and
 * "it raises" is not a reason to skip the renumbering. Both trailing statements
 * now have to move together.
 *
 * ⚠️ The arity buys no COMPILE-time protection, and an earlier version of this
 * docstring claimed it did. `ReconcileExecutor.query` takes `unknown[]`, so a
 * 4-tuple and a 5-tuple spread into an array literal identically — which is
 * exactly how #5032 could widen it without a single type error. What actually
 * enforces the renumbering is `reconcile.test.ts`: the lexical assertions on
 * `$6`/`$7`/`$8` and the positional `binds[0]![6]` self-exclusion check — plus,
 * for the corroboration statement, the `OR $7` assertion #5332 added beside
 * them, and `promotion-pg.test.ts`'s direct issue of the statement, whose own
 * comment records that an arity mismatch is a bind ERROR and is why *"this call
 * site had to move with the statement"*. It did, twice now.
 *
 * It does NOT catch subject/predicate/object ORDER drift, since those three
 * members share a type. A brand would, and is not obviously worth three more
 * types on values that are already `unknown[]` by the time they reach `query` —
 * the comparable values were worth it because their swap is silent AND
 * consequential, where a key swap mints rows that match nothing and is loud.
 *
 * ⚠️ **The three call sites no longer pass the same OBJECT comparable value**,
 * and that is deliberate rather than drift: the two LOOKUPS bind
 * {@link PreparedCandidate.comparableForLookups} and the INSERT binds
 * {@link PreparedCandidate.comparableAtRest}, which differ only when the entity
 * batch FAILED. They are two named fields for exactly this reason — so the
 * divergence is declared at the seam that computes them and can never be a
 * second derivation at a call site. See `comparableForLookups` for why an
 * outage must not withhold the value from a lookup.
 *
 * The SUBJECT's has no such split, and the asymmetry is a consequence rather
 * than a choice: {@link PreparedCandidate.subjectComparable} is derived from a
 * store id and from nothing else, so a FAILED batch has no id to withhold — it
 * is already `null` at every site. There is nothing an outage could bind here
 * that a healthy store would have out-proven, which is the whole reason the
 * object needed two fields. It is passed as a third parameter rather than
 * folded into a `{object, subject}` record so a call site cannot silently swap
 * the two positionally.
 */
function agreementBinds(
  // {@link ResolvedSlotKeys}, so the three key binds are `string` and the
  // compiler's view of `INSERT_FACT_SQL` matches the column's `NOT NULL` (#5047).
  // Every caller is downstream of the `MALFORMED_CLAIM` guard.
  keys: ResolvedSlotKeys,
  objectComparable: ComparableValue,
  subjectComparable: SubjectComparable,
): readonly [string, string, string, ComparableValue, SubjectComparable] {
  return [keys.subject, keys.predicate, keys.object, objectComparable, subjectComparable];
}

interface PreparedCandidate {
  readonly kind: "prepared";
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /**
   * The identity of the claim above — what the two lookups below match on.
   *
   * {@link ResolvedSlotKeys} and not {@link SlotKeys}: this shape only exists
   * past the `MALFORMED_CLAIM` guard, which refuses a null at any position.
   */
  readonly keys: ResolvedSlotKeys;
  /**
   * The object's typed canonical value, or `null` for *unknown* (#5030). Not
   * folded into {@link SlotKeys}: a key proves sameness and is a JOIN arm, this
   * proves difference and is a COMPARED value, and the three-valued agreement
   * is exactly the statement that those are different jobs.
   */
  /**
   * What lands in `object_cmp` — NULL when the batch failed, so an outage can
   * never write a value that out-proves the answer it did not get.
   */
  readonly comparableAtRest: ComparableValue;
  /**
   * What the two LOOKUPS compare against — always the parse, batch or no batch.
   *
   * ⚠️ Deliberately not the same value as {@link comparableAtRest}, and the one
   * place this module lets those diverge. A NULL bind at the lookups disables
   * `objectSameSql`'s difference veto (NULL → `IS NOT TRUE`), which is how an
   * outage would silently corroborate `-499` into a live `499`. Withholding
   * belongs on the ROW, where the irreversible stamp reads it, and nowhere else.
   */
  readonly comparableForLookups: ComparableValue;
  /**
   * The episode's resolver batch did not answer.
   *
   * A BOOLEAN, not the `EntityRole[]` that lands at rest: one call covered both
   * positions, so a failure has no per-role granularity, and an array here could
   * spell `["subject"]` — a state its own docstring calls impossible.
   * {@link provisionalFragment} widens it to both roles at the one place the
   * wire shape is built, so the two cannot disagree.
   *
   * An abstain does not set it: an abstain is honest, will not change on replay,
   * and flagging it would fire on every entity-valued object until a store
   * exists (ADR-0037 §5).
   */
  readonly resolutionFailed: boolean;
  /**
   * What lands in `subject_cmp`, and what all three consumers compare against
   * (#5032) — the subject's resolved store id as `entity:<id>`, or `null`.
   *
   * ⚠️ **Read `subject-cmp.ts` before touching this. Its polarity is INVERTED
   * against {@link comparableAtRest}:** non-null on both sides, same tag and
   * unequal means two claims about DIFFERENT entities, which suppresses
   * corroboration, tension and supersession alike. It is not the object's
   * comparable value at another position, and building it that way mints tension
   * edges between provably-different entities.
   *
   * ONE field, not the two the object needs, and the asymmetry falls out of
   * where the value comes from: {@link subjectComparableValue} reads a store id
   * and never parses the surface, so a FAILED batch leaves it `null` at every
   * site with nothing to withhold. The object's split exists because an outage's
   * surface parse can be MORE proving than the id it replaced; there is no
   * surface parse here to be more proving.
   *
   * Materialized in the preparation loop like the keys and for the same reason:
   * computing it at write time would open a second derivation site, and the two
   * lookups and the INSERT would be free to disagree about which entity a claim
   * is about.
   *
   * ⚠️ The id is NOT a candidate for a slot key, then or ever — see
   * {@link ResolvedEntity}. It reaches the row here and nowhere else.
   *
   * Typed {@link SubjectComparable} and not `EntityComparable`: the narrower
   * type is the one `entityComparable(surface)` cannot satisfy, and this field
   * is where that bypass would have landed.
   */
  readonly subjectComparable: SubjectComparable;
  readonly candidate: FactCandidate;
}

/** A candidate past the blank-trim pass, before any resolution. */
interface TrimmedCandidate {
  readonly kind: "trimmed";
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly candidate: FactCandidate;
}

/** A refusal, carried in candidate order so outcomes stay 1:1 with the input. */
interface BlockedEntry {
  readonly kind: "blocked";
  readonly reason: ReconcileBlockReason;
  /**
   * For `MALFORMED_CLAIM` only: WHICH slots had no identity (#5047).
   *
   * Optional because the other three reasons refuse the whole EPISODE and the
   * blank-trim guard refuses before any key exists. Present, it is what lets a
   * caller translating this verdict for a human name the right slot — see
   * `correction.ts`'s supersede arm, which must not blame a replacement's text
   * for an inherited or vocabulary-caused failure.
   */
  readonly unkeyed?: readonly UnkeyedSlot[];
}

type TrimmedEntry = TrimmedCandidate | BlockedEntry;

/**
 * A discriminated union rather than an `in`-probed pair: the transaction loop
 * switches on `kind`, so a third preparation outcome is a compile error there
 * instead of a silently-skipped candidate.
 */
type PreparedEntry = PreparedCandidate | BlockedEntry;

/**
 * Both roles, frozen — the only value `provenance.unresolved` ever takes.
 *
 * Shared rather than rebuilt per candidate so a reader can see at a glance that
 * a batch failure has no per-role granularity: it is one constant, written the
 * same way on every flagged row of every flagged episode.
 */
const BOTH_ROLES: readonly EntityRole[] = Object.freeze(["subject", "object"]);

function resolutionFailedCount(prepared: readonly PreparedEntry[]): number {
  return prepared.filter((p) => p.kind === "prepared" && p.resolutionFailed).length;
}

/**
 * The principal a claim is attributed to, or `null`.
 *
 * An explicit `sourcePrincipal` wins because the caller knows things the
 * episode row does not: a warehouse snapshot has no `source_actor` at all
 * (0180), and the human-correction path knows the Atlas user. Falling back to
 * the episode's actor keeps the connector path — the only producer today — free
 * of a field it would always compute the same way.
 */
function resolvedPrincipal(
  episode: ReconcileEpisodeRef,
  explicit: string | null | undefined,
): string | null {
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const actor = episode.sourceActor?.trim() ?? "";
  return actor === "" ? null : `${episode.source}:${actor}`;
}

/** An episode-level refusal: the reason, plus prose an operator can act on. */
export interface EpisodeBlock {
  readonly reason: ReconcileBlockReason;
  readonly detail: string;
}

/**
 * The three episode-level safety refusals, most consequential first.
 *
 * Exported and pure so a caller can pre-flight BEFORE spending anything on
 * producing candidates: `extract.ts` runs it ahead of the model call, which is
 * the difference between a grant-less episode costing one LLM call and costing
 * nothing. `reconcileFacts` runs it again regardless — a pre-flight is an
 * optimization, never the enforcement.
 */
export function classifyEpisodeForReconcile(
  episode: ReconcileEpisodeRef,
  explicitPrincipal?: string | null,
): EpisodeBlock | null {
  if (episode.id.trim() === "") {
    return {
      reason: RECONCILE_BLOCK_REASONS.noProvenance,
      detail: "the episode has no id, so no fact could point at the evidence behind it",
    };
  }
  // The load-bearing one. See the module header: NOT the 0180 CHECK's
  // non-empty test, because that admits a grant that grants nobody. The
  // predicate is the ingest seam's, imported rather than restated.
  if (!isUsableGrant(episode.visibleTo)) {
    return {
      reason: RECONCILE_BLOCK_REASONS.noGrant,
      detail:
        "the episode's grant names no principal any reader could match, so every fact drawn from it would be invisible and permanently unpublishable",
    };
  }
  if (resolvedPrincipal(episode, explicitPrincipal) === null) {
    return {
      reason: RECONCILE_BLOCK_REASONS.sourcePrincipalUnresolved,
      detail:
        "neither the caller nor the episode names who asserted the claim, and an unattributable claim cannot carry provenance",
    };
  }
  return null;
}

/**
 * What the episode's one resolver call produced — an ANSWER, or a FAILURE.
 *
 * The two used to share a branch. `tryResolve` collapsed a `null` return and a
 * thrown resolver into one provisional flag on purpose, and that was right while
 * `provisional` was the only way to say "we don't know". It is not any more:
 * abstention has a first-class representation at rest (`object_cmp` NULL →
 * `unknown` → tension only), so the flag is free to mean the one thing nothing
 * else can express.
 */
type EntityResolution =
  | { readonly kind: "answered"; readonly ids: ReadonlyMap<string, ResolvedEntityId> }
  | { readonly kind: "failed" };

/**
 * The id a store gave for `surface`, or `undefined` for an abstain.
 *
 * A plain lookup, and that is the point: every entry in `ids` was validated once
 * at the seam ({@link resolveEntitiesForEpisode}), so there is no per-candidate
 * re-check here to drift from it.
 */
function storeId(resolution: EntityResolution, surface: string): ResolvedEntityId | undefined {
  return resolution.kind === "failed" ? undefined : resolution.ids.get(surface);
}

/**
 * Resolve every surface this episode will store, in ONE call.
 *
 * The batch is the deduplicated union of the SUBJECT and OBJECT surfaces of
 * every candidate that survived the blank-trim pass — see {@link EntityResolver}
 * for why the unit is the episode and why the set covers both positions.
 *
 * ## Failure is caught here, and it means something narrow
 *
 * A resolver is injected code: a real one calls a store. Letting it throw would
 * abort the whole episode over a QUALITY problem and turn the flag path into a
 * block — inverting the asymmetry this stage exists to hold. Logged (never
 * swallowed) with a narrowed error.
 *
 * What the resulting flag MEANS is now one thing: *this row's COMPARABLE VALUES
 * are worth recomputing.* Since #5032 that is BOTH of them — one batch feeds
 * `object_cmp` and `subject_cmp`, so one failure withholds both, and a recompute
 * that repaired only the object would leave a homonym suppression unwritten.
 * **Not its keys** — the resolver reaches no key at any
 * position, so a replay recomputes them to the same bytes under the same
 * vocabulary; what an outage leaves missing is the comparable VALUES. An honest abstain will not change on replay,
 * and when the store later gains the entry the affected rows are findable by key
 * with no marker at all. An OUTAGE will change on replay and there is no
 * key-based way to find those rows — a NULL `_cmp` matches every honest
 * abstain too, and at the subject that is nearly the whole corpus. That is the
 * marker's entire remaining purpose, and the batch unit
 * reinforces it: an outage fails the whole batch, and the whole batch is exactly
 * what wants re-running.
 *
 * ⚠️ **The marker is not total, and the gap is structural rather than an
 * oversight.** A candidate that CORROBORATES an existing fact writes no
 * provenance PAYLOAD — the existing row is deliberately untouched
 * ({@link writeCandidate}: "Nothing about the fact itself changes") — so it
 * carries no `provisional` flag of its own.
 *
 * It is not traceless, though, and the difference matters to whoever builds the
 * repair: corroboration DOES write a `provenance` EDGE to this episode, so the
 * facts a failed batch touched are `SELECT from_fact_id FROM brain_edges WHERE
 * workspace_id = <ws> AND edge_type = 'provenance' AND to_episode_id = <the id
 * in the log line>` — scoped like every other edge query here, and returning the
 * CREATED rows too, which carry the marker as well. What
 * is genuinely lost for a corroborator is the DECISION — whether a healthy store
 * would have matched this claim to that row at all — not a value a recompute
 * could restore. A sweep over `provisional OR object_cmp IS NULL` would cover
 * the created rows and every honest abstain besides; the edge join is the narrow
 * one, and it exists.
 *
 * And the recompute does not exist yet, in either shape. `INSERT_FACT_SQL` is
 * the only writer that produces either `_cmp` value, and both are UPDATE-GATED
 * columns (`scripts/check-brain-fact-promotion.sh`), so the sweep
 * this marker is a handle FOR needs a second writer with an allowlist entry
 * behind it. ⚠️ A `subject_cmp` recompute is the more dangerous half and must
 * not be built by copying the object one: writing a subject id onto a row
 * SUPPRESSES corroboration, so a sweep that got the wrong entity splits a live
 * belief apart rather than merely failing to prove a difference. The marker is worth writing now — the rows are unfindable
 * otherwise, and that is irreversible in a way a missing job is not — but
 * nobody should read it as evidence that the repair is already possible.
 *
 * ## What a resolver must do, that the type cannot say
 *
 * **The batch is ALL-OR-NOTHING.** A resolver that cannot answer for *some* of
 * the set MUST throw rather than return a map missing those surfaces. A partial
 * answer is byte-identical to "no entry" here, and the whole abstain/failure
 * split collapses back into the pre-#5031 world the moment a store swallows its
 * own per-shard errors. It is the one prohibition a plausible implementation
 * violates by accident — `Promise.allSettled` over shards is exactly the shape.
 *
 * **A resolver owns its own deadline.** Nothing here imposes one: `await` has no
 * budget, so a store that hangs rather than rejecting stalls the episode before
 * the transaction opens, producing neither a flag nor an error nor a log line.
 * That is the resolver's to bound (a `Promise.race`, a statement timeout on its
 * own connection), and it is stated here because the alternative — a timer in
 * this file — is a primitive whose failure modes cost #5027 four review rounds.
 *
 * Nothing here ever BLOCKS. {@link RECONCILE_BLOCK_REASONS} gains nothing from
 * this seam, in either outcome.
 */
async function resolveEntitiesForEpisode(
  resolver: EntityResolver,
  trimmed: readonly TrimmedEntry[],
  episode: ReconcileEpisodeRef,
): Promise<EntityResolution> {
  // Kept per position for the failure line below, then unioned: a surface seen
  // at BOTH positions is one lookup (that is the point of role-invariance) and
  // counts in both tallies (that is what the tallies are for).
  const subjects = new Set<string>();
  const objects = new Set<string>();
  for (const entry of trimmed) {
    if (entry.kind !== "trimmed") continue;
    subjects.add(entry.subject);
    objects.add(entry.object);
  }
  // SORTED, so iteration order carries no positional information. Unsorted, the
  // union puts every subject-position surface first and the object-only ones
  // last, which hands a resolver back the `role` argument this seam deleted —
  // by inference for any surface that appears at exactly one position. Role
  // invariance is meant to hold by construction, not by the resolver not
  // looking. It also makes the batch stable for a store that caches on it.
  const surfaces = new Set([...subjects, ...objects].toSorted());
  // Our OWN copy, kept back from the resolver and used as the validation oracle
  // below. `ReadonlySet` is a compile-time fiction over a mutable object, so the
  // set handed out can be cleared or added to; checking a returned key against
  // it would let the resolver choose what counts as a legal answer.
  const requested = new Set(surfaces);
  // Read BEFORE the call, for the same reason: the failure line below is the one
  // record an operator gets, and a resolver that clears the set and then throws
  // should not get to report zero.
  const counts = {
    surfaces: surfaces.size,
    subjectSurfaces: subjects.size,
    objectSurfaces: objects.size,
  };

  // An episode whose every candidate was refused has nothing to look up, and a
  // real resolver would spend a connection checkout answering about nothing.
  // Skipping cannot change a verdict: there is no prepared candidate left for a
  // failure to flag.
  if (counts.surfaces === 0) return { kind: "answered", ids: new Map() };

  try {
    const answer = await resolver(surfaces, { workspaceId: episode.workspaceId });
    // COPIED into an owned Map, inside the try, rather than `instanceof`-checked.
    // The seam's declared type is STRUCTURAL (`ReadonlyMap`), so a nominal check
    // would be wrong in both directions: a conforming non-`Map` implementation — a
    // caching wrapper, a cross-realm map — would be reported as an outage
    // forever, while a Proxy-wrapped `Map` passes `instanceof` and then throws
    // `Map operation called on non-Map object` at the first `.get`, in the
    // preparation loop, OUTSIDE this catch. That is the
    // quality-failure-becomes-a-block inversion by a second route.
    //
    // Iterating settles both: anything that is not iterable (a `null`, a bare
    // object, a number) throws HERE where the catch is, a hostile `get` is
    // never called at all, and the snapshot is immune to a resolver that mutates
    // the map it handed back — which would otherwise let one surface resolve two
    // ways WITHIN one episode, the exact thing batching exists to prevent.
    const ids = new Map<string, ResolvedEntityId>();
    let unusable = 0;
    let foreign = 0;
    let overAnswered = 0;
    let duplicate = 0;
    let seen = 0;
    for (const [surface, entity] of answer) {
      // BOUNDED BY ENTRIES CONSUMED, which is the only counter that always
      // advances. The iteration is driven entirely by injected code — the value
      // is structurally typed, so it may be a generator or a lazy cursor, not a
      // `Map` — and an infinite one would spin here synchronously with no yield
      // point, blocking the whole event loop rather than one episode: no catch,
      // no flag, no log line.
      //
      // ⚠️ Counting distinct ACCEPTED keys does not bound it. A repeated entry
      // lands on the `duplicate` arm below, which leaves `ids.size` unchanged
      // just as `ids.set` on an existing key would have — so an iterable
      // repeating one valid entry advances no accepted-key count and never
      // terminates for any episode with two or more surfaces. `seen` is the fix
      // and the reason it is a separate variable.
      //
      // A resolver cannot legitimately answer about more surfaces than it was
      // handed, so the requested count is the ceiling — and it is not a timer:
      // no deadline, no timer handle, none of the failure modes a clock in this
      // file would bring.
      //
      // ⚠️ `seen` is not independently falsifiable today, and that is worth
      // stating rather than leaving for someone to rediscover by mutating it and
      // seeing nothing go red. Every path below advances exactly one of
      // `ids.size`, `unusable`, `foreign`, `duplicate` — note those, NOT the four
      // violation counters logged further down, whose set the accept path
      // advances none of — so a bound over their sum terminates too, and
      // swapping `seen` for it kills no test. `seen` is what stops that from
      // being a load-bearing coincidence: a later edit adding a `continue` that
      // advances nothing would silently restore the hang, and the hang is a
      // blocked event loop, not a failed episode.
      //
      // (The literal pre-`seen` bound — `ids.size + unusable + foreign` — is a
      // different thing and does NOT terminate: a repeat lands on the `duplicate`
      // arm, which that sum does not count. It hangs the runner rather than
      // failing a test, which is why the test below asserts a yield COUNT.)
      //
      // ⚠️ `overAnswered` is NOT a diagnostic, and an earlier version of this
      // comment said it was — it is the ONLY counter that fires on its own case.
      // The `break` runs before the offending entry is classified, so an answer
      // that is complete and valid plus one extra entry leaves `foreign`,
      // `duplicate` and `unusable` all zero. Drop it from the verdict below and
      // a contract-breaking store's answer is stamped onto `object_cmp` with no
      // marker and no log line at all.
      if (++seen > counts.surfaces) {
        overAnswered++;
        break;
      }
      // The KEY half of the contract, and unchecked it is the worse hole of the
      // two. A store that normalizes keys on the way out (lowercases, re-trims,
      // NFC-folds) returns a full, well-formed map that misses on EVERY
      // `storeId`: a total, permanent, unmarked abstain across every episode,
      // with no log line anywhere. That is the all-or-nothing collapse this seam
      // prohibits, arriving through the one arm the value check cannot see. An
      // entry for a surface nobody asked about is not an abstain; it is garbage.
      //
      // Checked against `requested`, our own copy — never against the set the
      // resolver was handed, which it can mutate. Validating against an oracle
      // the subject of the validation controls is not validation.
      if (typeof surface !== "string" || !requested.has(surface)) {
        foreign++;
        continue;
      }
      // A `Map` cannot produce a duplicate key; a generator can, and within
      // budget it would silently last-write-win. That is one surface resolving
      // two ways inside one episode — the precise thing batching exists to
      // prevent — landing on the one column the publish gate stamps from.
      if (ids.has(surface)) {
        duplicate++;
        continue;
      }
      // Read ONCE, through `unknown`. The declared type says this is a string,
      // so the guard is vacuous to the compiler and a later "simplification" to
      // `entity.entityId.trim()` would type-check — and a second read of a
      // getter or a Proxy can return a different value than the one the guard
      // approved, which is how a blank id would land past the blank check.
      const raw: unknown = entity?.entityId;
      const id = typeof raw === "string" ? raw.trim() : "";
      if (id === "") {
        unusable++;
        continue;
      }
      // THE ONE mint of a `ResolvedEntityId` (#5032), and it sits here because
      // this is the only place an id is validated — non-empty after trim, for a
      // surface we asked about, not a duplicate. The assertion is the cast that
      // the brand exists to make deliberate: everywhere else a bare `string`
      // cannot become one, so `subjectComparableValue(subject)` — passing a
      // SURFACE where an id is required — stops compiling.
      ids.set(surface, id as ResolvedEntityId);
    }
    // A blank or non-string id is a store CONTRACT violation, not an abstain,
    // and the difference is the whole point of the split: an abstain will not
    // change on replay, a store bug will. Treating it as an abstain would be the
    // one path where an infrastructure failure silently loses the marker that
    // makes its rows findable. Failing the batch is also the same verdict the
    // all-or-nothing rule above gives a partial answer, which this is.
    // FOUR separate counters, not one. They have four different remediations —
    // fix your id generation, stop normalizing keys, stop answering about
    // surfaces nobody asked for, de-duplicate — and a single tally would send an
    // operator after whichever cause the message happened to name first.
    if (unusable > 0 || foreign > 0 || overAnswered > 0 || duplicate > 0) {
      log.warn(
        {
          workspaceId: episode.workspaceId,
          episodeId: episode.id,
          ...counts,
          unusable,
          foreign,
          overAnswered,
          duplicate,
          // Beside the violation counts so `1 of 400` reads differently from
          // `400 of 400`. The surfaces themselves are claim content and stay out
          // of the line; `episodeId` is the handle for a replay.
          answered: ids.size,
        },
        "brain reconcile: the entity store broke its contract, so the batch is treated as failed and this episode's candidates flagged — an abstain will not change on replay, a store bug will. `unusable`: ids that were blank or not strings; an id must be a non-empty, GLOBALLY unique string. `foreign`: keys that are not surfaces this episode asked about, byte-for-byte — a store that normalizes keys on the way out answers nothing at all. `overAnswered`: more entries than surfaces requested, so iteration was cut short. `duplicate`: one surface answered twice, which would resolve it two ways inside a single episode",
      );
      return { kind: "failed" };
    }
    return { kind: "answered", ids };
  } catch (err) {
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        // What `role` used to carry, at the grain the call now has. A per-call
        // role argument is gone (resolution is role-invariant BY TYPE), so what
        // is worth recording is which positions the failed set was drawn from —
        // a property of the surface set, not of any one lookup. The surfaces
        // themselves are claim content and stay out of the line.
        ...counts,
        err: errorMessage(err),
      },
      "brain reconcile: entity resolver threw — treating the batch as failed and flagging this episode's candidates provisional",
    );
    return { kind: "failed" };
  }
}

interface WriteContext {
  readonly item: PreparedCandidate;
  readonly episode: ReconcileEpisodeRef;
  readonly grantTokens: readonly string[];
  readonly producer: string;
  readonly sourcePrincipal: string | null;
  readonly extractedAt: Date | null;
  readonly now: () => Date;
}

/** Corroborate an existing live claim, or create the draft plus its edges. */
async function writeCandidate(
  tx: ReconcileExecutor,
  ctx: WriteContext,
): Promise<ReconcileOutcome> {
  const { item, episode } = ctx;

  // `$7`, the last bind below, is "the INCOMING claim is itself an
  // observation" — which lifts the statement's class exclusion. Full rationale
  // on the statement (#5332); the two things true only at this call site:
  //
  //   The EPISODE's source, never a read-back of `provenance.source`. At this
  //   point the row does not exist and this function is the writer that will
  //   put the episode source there, so the episode is the earlier truth and the
  //   only one available. "Warehouse-class episode" and "observation" name one
  //   predicate here, because the stored discriminator is a copy of this value.
  //
  //   TRUE is the PERMISSIVE value, so an `episode.source` this region cannot
  //   classify binds FALSE and gets the exclusion. That falls out of
  //   `isWarehouseDerivedSource` unchanged — its doc already declines to claim a
  //   class it cannot see — and the direction it lands in is the recoverable
  //   one: an unclassifiable producer mints its own row instead of strengthening
  //   an observation, i.e. a duplicate draft rather than a silent absorption.
  //
  // ⚠️ Kept out of the bind list itself so the two lines below stay ADJACENT
  // CODE. `identity-corpus.mutations.ts` anchors on that pair; with prose
  // between them its only unique anchor was a comment, and rewording one would
  // have deadened the mutation silently instead of failing.
  const existing = await tx.query(CORROBORATION_LOOKUP_SQL, [
    episode.workspaceId,
    // The LOOKUP value, which an outage does not withhold — see
    // `PreparedCandidate.comparableForLookups`. Binding the at-rest NULL here
    // would disable this statement's difference veto and merge `-499` into a
    // live `499`. The subject's comparable is the same value at all three sites.
    ...agreementBinds(item.keys, item.comparableForLookups, item.subjectComparable),
    isWarehouseDerivedSource(episode.source),
  ]);
  const existingId = firstId(existing.rows);
  if (existingId !== null) {
    // Strengthen: one more piece of evidence for a belief Atlas already holds.
    // Nothing about the fact itself changes — not its grant, not its review
    // state, not its validity.
    //
    // That sentence was the assumption #5332 falsified, and the lookup's class
    // arm is what makes it true again. It is correct for two claims of the same
    // kind, and it was WRONG when the incumbent was a machine reading of a
    // warehouse row and the newcomer was a person speaking: their testimony
    // became an edge on a row ADR-0042 never serves. The one remaining hit on
    // an OBSERVATION is a warehouse re-read of the same row, where "one more
    // piece of evidence" is exactly what the edge means — and is what
    // `observation-reap.ts` measures freshness by.
    //
    // Both grant directions land here, and they are safe for different reasons:
    //
    //   NARROWER episode than the fact's grant — safe outright. `brain_episodes`
    //   is ACL-gated in its own right by the same predicate, so walking the edge
    //   cannot read an episode the reader is not entitled to.
    //
    //   WIDER episode than the fact's grant — safe but not yet CORRECT, and
    //   deliberately not fixed here (#4823). A claim first seen in a private
    //   channel and then restated in a public one keeps the private grant, so
    //   the direction is fail-closed: information is withheld, never disclosed.
    //   The correction happens at PUBLISH, where `promoteBrainFacts` unions in
    //   the grants of every episode on a `provenance` edge
    //   (`widenGrantFromEvidence`). ADR-0036 §T5 puts widening only at the
    //   review gate and makes a grant an immutable per-version snapshot, so an
    //   unattended ingest pass — this one — is precisely where it must NOT
    //   happen. Recording the edge here is what makes the gate able to do it.
    //
    //   ⚠️ That widening is SAFE only because the two rows are the same claim,
    //   and SUBJECT HOMONYMY is the case where they are not (#5032). This edge
    //   is where the hazard is created: a public episode about one `Acme Corp`
    //   becomes evidence for a private fact about another, and publish then
    //   discloses the private claim's BODY to the public audience —
    //   `promotion.ts`'s `widenGrantFromEvidence` carries the corrected safety
    //   argument. `subject_cmp` on the lookup above is what stops the match
    //   whenever a store can prove the subjects are different entities; where it
    //   cannot (every extractor-supplied subject, permanently) the residue is
    //   disclosed at the review gate rather than prevented.
    //
    // Nor its CARDINALITY: a claim first stored `multi` and re-asserted `single`
    // stays `multi` and earns no tension edges. Upgrading it would supersede by
    // side-effect from a corroboration, and supersession is M2's — deliberately
    // not a stage that runs unattended on every re-observation.
    const edge = await tx.query(INSERT_PROVENANCE_EDGE_SQL, [
      episode.workspaceId,
      existingId,
      episode.id,
    ]);
    return { kind: "corroborated", factId: existingId, evidenceAdded: edge.rows.length > 0 };
  }

  const provisional = item.resolutionFailed;
  // `satisfies`, not a bare object literal: the payload has three downstream
  // readers already scheduled (#4772's review surface filters on `provisional`,
  // #4773's retrieval, #4769's classifier) and `jsonb` enforces nothing at rest,
  // so the named shape is the only thing that turns a renamed key into a compile
  // error rather than a blank field in a UI.
  const provenance = {
    // Producer detail first so the structural keys below always win — a
    // producer may enrich the payload, never rewrite where the claim came from.
    ...(item.candidate.detail ?? {}),
    source: episode.source,
    sourceId: episode.sourceId,
    episodeId: episode.id,
    actor: ctx.sourcePrincipal,
    producer: ctx.producer,
    // Through the same guard as the other two timestamps: an INVALID Date's
    // `toISOString()` throws synchronously, and this call sits inside the
    // transaction, so an unguarded one would roll a whole episode back over a
    // bad event time the nullable column is already built to absorb.
    occurredAt: isoOrNull(episode.occurredAt),
    extractedAt: isoOrNull(ctx.extractedAt),
    reconciledAt: ctx.now().toISOString(),
    // No `entityIds` (#5031). BOTH ids are COLUMNS since #5032 — `object_cmp`
    // and `subject_cmp`, where the SQL can actually compare them — so a jsonb
    // copy would be a second truth nothing reads and nothing keeps in step.
    //
    // Present ONLY when it is true, so a reviewer's filter on the key is not
    // fooled by every fact carrying `provisional: false`.
    ...provisionalFragment(provisional),
  } satisfies BrainFactProvenance;

  const validFrom = ctx.item.candidate.validFrom ?? null;

  const inserted = await tx.query(INSERT_FACT_SQL, [
    episode.workspaceId,
    item.subject,
    item.predicate,
    item.object,
    isoOrNull(validFrom),
    isoOrNull(ctx.extractedAt),
    episode.id,
    JSON.stringify(provenance),
    JSON.stringify(ctx.grantTokens),
    // The AT-REST value, the one bind an outage withholds: this is what the
    // publish gate compares between two stored rows to stamp `valid_to`.
    ...agreementBinds(item.keys, item.comparableAtRest, item.subjectComparable),
  ]);
  const factId = firstId(inserted.rows);
  if (factId === null) {
    // `RETURNING id` on a plain INSERT that did not throw — unreachable, and a
    // silent `return` here would report a fact that does not exist. Throwing
    // rolls the whole episode back, which is the only honest outcome.
    throw new Error(
      `brain reconcile: fact insert returned no id (workspace ${episode.workspaceId}, episode ${episode.id})`,
    );
  }

  await tx.query(INSERT_PROVENANCE_EDGE_SQL, [episode.workspaceId, factId, episode.id]);

  // (The post-insert unkeyed-claim warn #5020 emitted here is gone. #5047 moved
  // the signal to the PREPARATION loop and turned it into a refusal: the
  // `MALFORMED_CLAIM` guard now blocks a candidate whose `slotKey` is null, so
  // no such row reaches this function and a line describing a stored one would
  // describe a row that cannot exist. `brain_facts`' three key columns are
  // `NOT NULL` as of migration 0194, which is the same statement made by the
  // database.)

  let tensionEdges = 0;
  // The producer's hint, and since #5027 the ONLY thing it still gates. It no
  // longer reaches `INSERT_FACT_SQL`, so it can no longer reach a `valid_to`
  // stamp — what it buys is an ADVISORY `in-tension-with` edge, which is
  // recoverable in both directions (a missing one costs a reviewer a hint; a
  // spurious one costs a reviewer a glance). An LLM guess is worth exactly that
  // much, which is why it kept this consumer and lost the other.
  //
  // ⚠️ Since #5438 the hint decides more than whether the scan RUNS — it also
  // decides how far the scan reaches, because the anchor arm leaves the claim's
  // own slot. `anchorReach` is where a producer bounds that (#5467); this gate
  // is unchanged and still asks only whether to scan at all.
  if ((item.candidate.predicateCardinality ?? "multi") === "single") {
    const rivals = await tx.query(TENSION_CANDIDATES_SQL, [
      episode.workspaceId,
      // The LOOKUP value again. The edges are ADVISORY, so the conservative
      // direction here is to keep finding rivals during an outage rather than
      // to go quiet — a spurious edge costs a reviewer a glance.
      ...agreementBinds(item.keys, item.comparableForLookups, item.subjectComparable),
      factId,
      TENSION_EDGE_CAP,
      // #5438's anchor arm, and it is deliberately LAST. `agreementBinds` is
      // spread in the MIDDLE of this list, so every placeholder after it moves
      // when that tuple widens; appending here adds a bind that cannot push the
      // `::uuid` slots along. This is the episode the NEW claim came from — the
      // anchor arm flags a rival only from a DIFFERENT one, because one message
      // routinely yields several claims about one subject and they are not
      // contradictions.
      episode.id,
      // #5467, the tenth bind the docstring above reserved. TRUE says the
      // producer's per-claim hint licenses the ANCHOR arm as well as the slot,
      // which is what every producer got for free between #5438 and #5467 and
      // what all but one still gets. `correction.ts` binds FALSE and the arm
      // then has to find an approved entry in `brain_predicate_cardinality`.
      //
      // Spelled as `!== "curated-only"` rather than `=== "producer-hint"` so an
      // absent field — every existing caller, and `FactCandidate` makes it
      // optional — keeps the old behaviour rather than silently acquiring the
      // bound. A widening default would subtract edges from producers that never
      // asked, and a missing advisory edge is indistinguishable from agreement.
      item.candidate.anchorReach !== "curated-only",
    ]);
    for (const row of rivals.rows) {
      const rivalId = rowId(row);
      if (rivalId === null) continue;
      const edge = await tx.query(INSERT_TENSION_EDGE_SQL, [
        episode.workspaceId,
        factId,
        rivalId,
      ]);
      if (edge.rows.length > 0) tensionEdges++;
    }
    if (tensionEdges > 0) {
      log.info(
        {
          workspaceId: episode.workspaceId,
          episodeId: episode.id,
          factId,
          subject: item.subject,
          predicate: item.predicate,
          tensionEdges,
        },
        "brain reconcile: recorded advisory in-tension-with edges for a single-cardinality predicate — nothing was superseded",
      );
    }
  }

  return { kind: "created", factId, provisional, tensionEdges };
}

/**
 * The optional half of the payload, built through an ANNOTATED helper.
 *
 * Not inlined as `...(cond ? { … } : {})`. A conditional spread is exempt from
 * excess-property checking, so `satisfies BrainFactProvenance` on the enclosing
 * literal catches a renamed REQUIRED key and nothing at all on these two — which
 * are precisely the keys #4772's review surface filters on. An annotated
 * fragment restores the check.
 */
function provisionalFragment(
  provisional: boolean,
): Pick<BrainFactProvenance, "provisional" | "unresolved"> {
  // The two keys are written TOGETHER or not at all — the one place that is
  // true, which is why `unresolved` is widened here from the boolean the
  // preparation loop carries rather than threaded through it as an array.
  return provisional ? { provisional: true, unresolved: BOTH_ROLES } : {};
}

function rowId(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

function firstId(rows: readonly unknown[]): string | null {
  return rows.length === 0 ? null : rowId(rows[0]);
}

/**
 * `Date | null` admits an INVALID Date, whose `toISOString()` throws
 * synchronously — mid-transaction, where it would roll back a whole episode
 * over one bad timestamp. A producer's unparseable date degrades to "no valid
 * time" instead, which is what the nullable column already means.
 */
function isoOrNull(value: Date | null): string | null {
  if (value === null || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

/**
 * The default transaction runner: one dedicated connection off the internal
 * pool, manual BEGIN/COMMIT/ROLLBACK, and the client destroyed if the ROLLBACK
 * itself fails so a dirty socket cannot poison the next borrower — the same
 * mechanics as `withWorkspaceAdminLocks` / `withDemoSeedLock`.
 *
 * Never nest another pool checkout inside `fn`: the internal pool is bounded
 * (max 5) and a nested checkout under a held connection is the starvation
 * deadlock those two functions document.
 */
export const withBrainTransaction: ReconcileTransactionRunner = async <T>(
  fn: (tx: ReconcileExecutor) => Promise<T>,
): Promise<T> => {
  const client = await getInternalDB().connect();
  let rollbackErr: Error | null = null;
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: async (sql: string, params?: unknown[]) => {
        const res = await client.query(sql, params);
        return { rows: res.rows as readonly unknown[] };
      },
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rbErr: unknown) => {
      rollbackErr = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      log.warn(
        // Scrubbed: a pg error can carry a credentialed connection URL, and a
        // log line is the one place it must not appear verbatim.
        { err: errorMessage(rollbackErr) },
        "brain reconcile: ROLLBACK failed — the client will be destroyed",
      );
    });
    throw err;
  } finally {
    client.release(rollbackErr ?? undefined);
  }
};
