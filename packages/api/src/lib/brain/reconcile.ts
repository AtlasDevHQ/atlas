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
 *   - **Flag provisional** — a QUALITY failure. Subject or object entity
 *     resolution failed. The claim is still written as a draft, with
 *     `provenance.provisional = true` naming the unresolved side, because the
 *     reviewer is exactly the right person to settle "is `the deploy box` the
 *     same entity as `deploy-01`?". Dropping it instead would make this stage a
 *     silent fact-dropper, which the issue forbids in both directions.
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
 * Identity is the materialized SLOT KEY of the trimmed, resolved SPO —
 * `alias(lexicalNorm(surface))`, computed by `lib/brain/identity.ts`'s
 * {@link slotKey} once per candidate here and stored on the row (#5020,
 * ADR-0037 §1). It REPLACED a byte-exact comparison of the surface columns, and
 * that is an observable change, not a refactor: `Ships On` and `ships_on` were
 * two slots and are now one, so a claim that used to duplicate silently now
 * corroborates. The retained surface is still exactly what the producer said —
 * only what COUNTS AS THE SAME CLAIM moved.
 *
 * What did NOT move is the entity resolver's job. The lexical layer folds ASCII
 * case and separators and does nothing semantic (no stemming — the corpus
 * carries `led_by` and `leads`, which are INVERSE relations), so deciding that
 * `the deploy box` and `deploy-01` are one entity is still the resolver's
 * decision, made per workspace at a seam built for it. Anything beyond the
 * lexical layer that WOULD take a decision from the resolver arrives as curated
 * vocabulary with a reviewer behind it, never as a rule here — which is why
 * `is priced at` and `priced at` still do not unify.
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
 * ## What the NULLABLE keys cost
 *
 * The acceptance criteria for #5020 also asked for `SET NOT NULL` on all three
 * columns. It is deliberately NOT in this cut: migration 0187's header
 * enumerates three prerequisites, and the third — tightening `MALFORMED_CLAIM`
 * to refuse a candidate whose key is null — is unowned, so the constraint would
 * turn a claim that is storable TODAY into a transaction-killing violation. Read
 * that header before flipping it.
 *
 *   - A surface that norms away (`-`, `___`) has a NULL key, so it corroborates
 *     nothing and earns no tension edge — where byte-exactness would have
 *     matched another `-`. `null = null` is unknown in SQL, and that is the
 *     point: the alternative, a stored `''`, is the one key value that joins
 *     every other degenerate row (migration 0187's header). Never write these
 *     comparisons NULL-safe. This one is PERMANENT and legal; no backfill
 *     repairs it, which is why it is logged at the prepare loop below.
 *   - A row written between 0187 deploying and this code deploying is unkeyed,
 *     and drops out of all three slot consumers. Migration 0188 repeats 0187's
 *     re-runnable backfill in THIS deploy to close exactly that window — the
 *     correctness need arrives here, not at the constraint flip, because here is
 *     where the consumers start depending on the column.
 *   - Every row a region import lands is likewise unkeyed until #5035 carries
 *     keys verbatim on the v3 bundle, and 0188 cannot help: it runs at boot and
 *     an import runs whenever an admin triggers one. Those facts are inert in
 *     all three consumers in the meantime — fail-closed, and #5035's to fix.
 *   - Dedupe is still only as good as the producer's determinism, just at a
 *     coarser grain. Two passes that phrase one claim differently ("is" vs "is
 *     on") remain two claims — that pair is a vocabulary ENTRY, not a
 *     normalization rule — and a pass whose entity resolution CHANGES between
 *     runs still misses its own earlier row. The reviewer collapses those;
 *     nothing in this stage can. `extract.ts` pins its model call to
 *     `temperature: 0` for exactly this reason.
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
import { slotKey, type ClaimVocabulary } from "@atlas/api/lib/brain/identity";
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
 */
const RECONCILE_LOCK_NAMESPACE = 4771;

/**
 * Bound how many existing facts one new `single`-cardinality claim may be put
 * in tension with. The edges are ADVISORY — `lib/brain/tensions.ts` is the
 * clustering that reads them (#4913), and arbitration stays with the human
 * gate — so a subject/predicate that somehow accumulated hundreds of live
 * objects should surface the newest few for a reviewer rather than write a fan
 * of edges nobody reads.
 */
const TENSION_EDGE_CAP = 10;

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
   */
  readonly predicateCardinality?: PredicateCardinality;
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
}

/** A resolved entity. `canonical` is what lands in the fact's SPO column. */
export interface ResolvedEntity {
  readonly canonical: string;
  /** Stable id, when the resolver has one. Recorded in provenance. */
  readonly entityId?: string;
}

/**
 * Subject/object entity resolution — an injected seam, not a hardcoded step.
 *
 * M1 ships {@link passthroughEntityResolver} as the default: there is no entity
 * store yet, so the surface form IS the canonical form. The seam exists now
 * because the FAILURE SEMANTICS are what this slice is pinning — a resolver
 * that returns `null` (or throws) flags the candidate provisional rather than
 * dropping it — and retrofitting that asymmetry after a real resolver lands
 * would mean changing behaviour under live data instead of adding a resolver.
 *
 * Invoked BEFORE the transaction opens (one `Promise.all` per candidate), which
 * is load-bearing for the DB-backed resolver this seam anticipates: it may check
 * out its own connection safely, whereas doing so inside the reconcile
 * transaction is the bounded-pool starvation deadlock
 * {@link withBrainTransaction} warns about.
 */
export type EntityResolver = (
  surface: string,
  context: {
    readonly workspaceId: string;
    readonly role: EntityRole;
  },
) => Promise<ResolvedEntity | null> | ResolvedEntity | null;

/** The M1 default: every non-blank surface form resolves to itself. */
export const passthroughEntityResolver: EntityResolver = (surface) => ({
  canonical: surface,
});

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
   * rest, unfixable without a re-key. A failed entity resolution flags one
   * candidate provisional; a forgotten vocabulary is silent and corpus-wide.
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
   * The candidate itself is not a claim — a blank subject, predicate, or
   * object. Not in the issue's list because it is not a resolution failure: it
   * is a malformed proposal, and unlike an unresolved entity there is nothing
   * for a reviewer to repair (`brain_facts` would happily store `''`, and a
   * three-column claim with an empty column says nothing). The producer's bug
   * is logged with the reason.
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
  | { readonly kind: "blocked"; readonly reason: ReconcileBlockReason };

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
  readonly blocked: Readonly<Record<ReconcileBlockReason, number>>;
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
 * Deliberately NOT filtered by review state: a claim re-observed after it was
 * published must corroborate the published fact, not mint a fresh draft
 * duplicate of it. Deliberately not filtered by grant either — a re-observation
 * at ANY grant, narrower or wider, is recorded as EVIDENCE and never rewrites
 * the existing fact's `visible_to` from here, because a grant is immutable per
 * fact version (0180) and ADR-0036 §T5 admits widening only at the review gate.
 * A wider re-observation is acted on there instead: `promoteBrainFacts` unions
 * the evidence grants in when the draft is published (#4823).
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
 * JSON scalars, `null` included: a surface that norms away has no key, and a
 * sentinel would file every such claim under one slot.
 *
 * `object_cmp` (#5030) is derived here on the same terms and is the ONLY write
 * path that ever produces one — migration 0191 deliberately does not backfill,
 * so a row predating this statement keeps NULL forever and stays `unknown`.
 * That is why the column is on the guard's UPDATE-only list beside the keys: a
 * second writer re-deriving it changes what a claim is provably different from,
 * and difference is what stamps `valid_to`.
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
 * Omitted from the list rather than bound to a literal, so the column falls to
 * its schema default (`'multi'`, 0180) — which is what keeps this statement
 * legal while the column is still `NOT NULL` with a live CHECK. #5028 drops the
 * column one release later, per the two-phase discipline in
 * `db/migrations/README.md`. Re-adding it here is a regression, not a fix.
 */
export const INSERT_FACT_SQL = `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, valid_from, extracted_at,
          source_episode_id, provenance, visible_to,
          subject_key, predicate_key, object_key, object_cmp)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::uuid, $8::jsonb,
               ARRAY(SELECT jsonb_array_elements_text($9::jsonb)),
               $10, $11, $12, $13)
       RETURNING id`;

/**
 * The evidence pointer, fact → episode. `WHERE NOT EXISTS` makes a re-observed
 * claim's edge idempotent, so a repeated pass strengthens once and not twice;
 * the enclosing advisory lock is what makes the guard sound under concurrency.
 * `RETURNING id` is how the caller learns whether the edge was new.
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
 * A NULL key on either side matches nothing — `object_key <> NULL` is unknown,
 * so a degenerate or unkeyed row abstains OUT of tension. That is the weaker
 * direction (#5000's shape, and the reason the acceptance criteria want these
 * columns `NOT NULL` eventually), and it is still strictly better than the
 * over-match a NULL-safe comparison would buy: an edge here is advisory and a
 * missing one costs a reviewer a hint, where a wrong SLOT costs a `valid_to`
 * stamp at the publish gate.
 *
 * The object arm's falsifying case is a DEGENERATE rival, and it is reachable
 * without a region import, a concurrent writer, or `correct_fact`. A live row
 * in this slot whose object is `-` has `object_key IS NULL`, so
 * {@link CORROBORATION_LOOKUP_SQL} does not return it either — `object_key = $4`
 * is unknown, and so is the cmp arm beside it, because a surface of only
 * separators parses to no comparable value — and it survives to this scan. There `object_key <> $4` is
 * unknown — not a rival — while `object <> $4` would be TRUE, wiring a
 * permanent advisory edge from a real claim to a placeholder that asserts
 * nothing. Pinned by `extract-reconcile-pg.test.ts`.
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
 */
export const TENSION_CANDIDATES_SQL = `SELECT id
     FROM brain_facts
    WHERE workspace_id = $1
      AND subject_key = $2
      AND predicate_key = $3
      AND ${objectNotSameSql("object_key", "$4", "object_cmp", "$5")}
      AND invalidated_at IS NULL
      AND valid_to IS NULL
      AND id <> $6::uuid
    ORDER BY ingested_at DESC
    LIMIT $7`;

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
    return {
      episodeBlocked: reason,
      created: 0,
      corroborated: 0,
      provisional: 0,
      blocked,
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
    return { created: 0, corroborated: 0, provisional: 0, blocked, outcomes: [] };
  }

  // ── Per-candidate preparation (no database) ───────────────────────────
  const prepared: PreparedEntry[] = [];
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
      prepared.push({ kind: "blocked", reason: RECONCILE_BLOCK_REASONS.malformedClaim });
      continue;
    }

    const [resolvedSubject, resolvedObject] = await Promise.all([
      tryResolve(resolveEntity, subject, episode.workspaceId, "subject", episode.id),
      tryResolve(resolveEntity, object, episode.workspaceId, "object", episode.id),
    ]);

    const unresolved: EntityRole[] = [];
    if (resolvedSubject === null) unresolved.push("subject");
    if (resolvedObject === null) unresolved.push("object");

    const storedSubject = resolvedSubject?.canonical ?? subject;
    const storedObject = resolvedObject?.canonical ?? object;

    // Materialized ONCE, here, off the RESOLVED surfaces — the strings that land
    // in the SPO columns, so the stored key always describes the stored row.
    // Computing it later, per statement, is how the corroboration lookup and the
    // INSERT would start disagreeing about which slot a claim is in.
    const keys: SlotKeys = {
      subject: slotKey(storedSubject, vocabulary.subject),
      predicate: slotKey(predicate, vocabulary.predicate),
      object: slotKey(storedObject, vocabulary.object),
    };
    // The comparable value, materialized beside the keys and for the same
    // reason: computing it per statement is how the corroboration lookup and
    // the INSERT would start disagreeing about what a claim's value IS.
    //
    // Off the RESOLVED surface, matching the keys above — but note the resolved
    // ENTITY ID takes precedence over any parse of it, because the store is
    // strictly better evidence than the text. `passthroughEntityResolver`
    // supplies no id, so under the SHIPPED default resolver this is the surface
    // parse — `ReconcileRequest.resolveEntity` is an injectable seam, so that is
    // a statement about the default and not about every deployment;
    // #5031 is what makes the first arm live.
    const { value: comparable, reason: comparableReason } = comparableValueWithReason({
      surface: storedObject,
      declared: candidate.objectType,
      entityId: resolvedObject?.entityId,
    });
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
        },
        candidate.objectType?.kind === "money"
          ? "brain reconcile: a producer declared money but the declaration was rejected — the claim landed as `unknown` and will never supersede. Either the declared currency is not an ISO-4217 alphabetic code, or the surface names a DIFFERENT currency; a declaration may supply what the surface lacks but never contradict it"
          : "brain reconcile: a producer declared an object type the surface contradicts — the claim landed as `unknown` and will never supersede. The surface parses as something else, and a declaration may supply what the surface lacks but never override what it states",
      );
    }
    prepared.push({
      kind: "prepared",
      subject: storedSubject,
      predicate,
      object: storedObject,
      keys,
      comparable,
      unresolved,
      entityIds: {
        ...(resolvedSubject?.entityId !== undefined ? { subject: resolvedSubject.entityId } : {}),
        ...(resolvedObject?.entityId !== undefined ? { object: resolvedObject.entityId } : {}),
      },
      candidate,
    });
  }

  if (unresolvedCount(prepared) > 0) {
    log.info(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        producer,
        provisional: unresolvedCount(prepared),
      },
      "brain reconcile: flagged candidates provisional — entity resolution failed, so the reviewer decides",
    );
  }

  // ── The one transaction ───────────────────────────────────────────────
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const outcomes = await withTransaction(async (tx) => {
    await tx.query(RECONCILE_LOCK_SQL, [RECONCILE_LOCK_NAMESPACE, episode.workspaceId]);
    const results: ReconcileOutcome[] = [];
    for (const item of prepared) {
      if (item.kind === "blocked") {
        results.push({ kind: "blocked", reason: item.reason });
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
  for (const outcome of outcomes) {
    // Exhaustive, with a `never` binding: a fourth outcome arm must be counted
    // somewhere, and the compiler is the only reviewer that never forgets.
    switch (outcome.kind) {
      case "created":
        created++;
        if (outcome.provisional) provisional++;
        break;
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

  return { created, corroborated, provisional, blocked, outcomes };
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

/**
 * The four agreement values, in the order all three statements bind them: the
 * three slot keys, then the comparable value (#5030).
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
 * The hazard this docstring used to warn about ARRIVED in #5030 and is kept
 * rather than deleted, because `subject_cmp` (#5032) inherits it verbatim:
 * `TENSION_CANDIDATES_SQL` spreads this in the MIDDLE of its bind list, so
 * widening the tuple without renumbering that statement's trailing placeholders
 * pushes `factId` one placeholder along and hands the slot declared `::uuid` a
 * tagged comparable value instead. In `INSERT_FACT_SQL` the spread is last and
 * pg would at least raise an arity error; **in the rival scan** it would not.
 *
 * ⚠️ The arity buys no COMPILE-time protection, and an earlier version of this
 * docstring claimed it did. `ReconcileExecutor.query` takes `unknown[]`, so a
 * 4-tuple and a 5-tuple spread into an array literal identically. What actually
 * enforces the renumbering is `reconcile.test.ts` — the lexical assertions on
 * `$5`/`$6`/`$7` and the positional `binds[0]![5]` self-exclusion check. Said
 * plainly because #5032's author is the reader who would otherwise rely on it.
 *
 * It does NOT catch subject/predicate/object ORDER drift, since those three
 * members share a type; only a brand would, and a brand buys nothing against
 * `unknown[]`. The comparable value is the one member a swap would be caught on
 * at all, and only behaviourally: it is TAGGED, so bound at a key position it
 * matches nothing a `slotKey` ever produced.
 */
function agreementBinds(
  keys: SlotKeys,
  comparable: ComparableValue,
): readonly [string | null, string | null, string | null, ComparableValue] {
  return [keys.subject, keys.predicate, keys.object, comparable];
}

interface PreparedCandidate {
  readonly kind: "prepared";
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  /** The identity of the claim above — what the two lookups below match on. */
  readonly keys: SlotKeys;
  /**
   * The object's typed canonical value, or `null` for *unknown* (#5030). Not
   * folded into {@link SlotKeys}: a key proves sameness and is a JOIN arm, this
   * proves difference and is a COMPARED value, and the three-valued agreement
   * is exactly the statement that those are different jobs.
   */
  readonly comparable: ComparableValue;
  /** Empty when both sides resolved. */
  readonly unresolved: readonly EntityRole[];
  readonly entityIds: Partial<Record<EntityRole, string>>;
  readonly candidate: FactCandidate;
}

/**
 * A discriminated union rather than an `in`-probed pair: the transaction loop
 * switches on `kind`, so a third preparation outcome is a compile error there
 * instead of a silently-skipped candidate.
 */
type PreparedEntry =
  | PreparedCandidate
  | { readonly kind: "blocked"; readonly reason: ReconcileBlockReason };

function unresolvedCount(prepared: readonly PreparedEntry[]): number {
  return prepared.filter((p) => p.kind === "prepared" && p.unresolved.length > 0).length;
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
 * Resolve one side, converting BOTH a `null` return and a thrown resolver into
 * the same provisional flag.
 *
 * A resolver is injected code: a lookup can time out, a future one will call a
 * store. Letting it throw would abort the whole episode over a QUALITY problem
 * and turn the flag path into a block — inverting the asymmetry this stage
 * exists to hold. Logged (never swallowed) with a narrowed error.
 */
async function tryResolve(
  resolver: EntityResolver,
  surface: string,
  workspaceId: string,
  role: EntityRole,
  episodeId: string,
): Promise<ResolvedEntity | null> {
  try {
    const resolved = await resolver(surface, { workspaceId, role });
    if (resolved === null || resolved.canonical.trim() === "") return null;
    return { ...resolved, canonical: resolved.canonical.trim() };
  } catch (err) {
    log.warn(
      {
        workspaceId,
        episodeId,
        role,
        err: errorMessage(err),
      },
      "brain reconcile: entity resolver threw — treating the entity as unresolved and flagging the candidate provisional",
    );
    return null;
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

  const existing = await tx.query(CORROBORATION_LOOKUP_SQL, [
    episode.workspaceId,
    ...agreementBinds(item.keys, item.comparable),
  ]);
  const existingId = firstId(existing.rows);
  if (existingId !== null) {
    // Strengthen: one more piece of evidence for a belief Atlas already holds.
    // Nothing about the fact itself changes — not its grant, not its review
    // state, not its validity. Both grant directions land here, and they are
    // safe for different reasons:
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

  const provisional = item.unresolved.length > 0;
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
    ...entityIdFragment(item.entityIds),
    // Present ONLY when it is true, so a reviewer's filter on the key is not
    // fooled by every fact carrying `provisional: false`.
    ...provisionalFragment(provisional, item.unresolved),
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
    ...agreementBinds(item.keys, item.comparable),
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

  // A null key is legal, permanent, and invisible everywhere else: the row is
  // stored and then joins nothing — no corroboration, no tension edge, and no
  // supersession at the publish gate — for as long as it exists. No backfill
  // repairs it (0187/0188 write the same NULL), so this line is the only signal
  // such a claim ever produces.
  //
  // Emitted HERE rather than in the preparation loop so it describes a row that
  // exists: everything after this point can still roll the episode back, and on
  // the extraction path a failing episode is retried every cycle until
  // quarantine — which would have re-emitted the identical line for a fact that
  // was never written. `factId` is what makes it actionable.
  //
  // Warned rather than blocked because blocking is a GUARD change: 0187's header
  // item 3 wants `MALFORMED_CLAIM` widened from `trim() === ""` to this
  // predicate, and that is the `SET NOT NULL` prerequisite nobody owns yet.
  // Refusing here unilaterally would drop claims a reviewer can currently see
  // and repair.
  const unkeyed = SLOT_ROLES.filter((role) => item.keys[role] === null);
  if (unkeyed.length > 0) {
    log.warn(
      {
        workspaceId: episode.workspaceId,
        episodeId: episode.id,
        producer: ctx.producer,
        factId,
        unkeyed,
      },
      // Two causes, and the message names both because it cannot distinguish
      // them once the vocabulary is real: the SURFACE norms away (`-`, `___`,
      // and the only reachable cause today), or an alias entry maps a real slot
      // to something that does. Naming only the producer would send an operator
      // after the wrong subsystem the day #5016 lands.
      "brain reconcile: stored a claim with no identity for one or more slots — it will never corroborate, earn a tension edge, or be superseded at publish. Either the producer emitted a surface that norms away (fix the producer, or tighten the MALFORMED_CLAIM guard — migration 0187's header, item 3) or a vocabulary entry maps that slot to nothing",
    );
  }

  let tensionEdges = 0;
  // The producer's hint, and since #5027 the ONLY thing it still gates. It no
  // longer reaches `INSERT_FACT_SQL`, so it can no longer reach a `valid_to`
  // stamp — what it buys is an ADVISORY `in-tension-with` edge, which is
  // recoverable in both directions (a missing one costs a reviewer a hint; a
  // spurious one costs a reviewer a glance). An LLM guess is worth exactly that
  // much, which is why it kept this consumer and lost the other.
  if ((item.candidate.predicateCardinality ?? "multi") === "single") {
    const rivals = await tx.query(TENSION_CANDIDATES_SQL, [
      episode.workspaceId,
      ...agreementBinds(item.keys, item.comparable),
      factId,
      TENSION_EDGE_CAP,
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
 * The two optional halves of the payload, built through ANNOTATED helpers.
 *
 * Not inlined as `...(cond ? { … } : {})`. A conditional spread is exempt from
 * excess-property checking, so `satisfies BrainFactProvenance` on the enclosing
 * literal catches a renamed REQUIRED key and nothing at all on these two — which
 * are precisely the keys #4772's review surface filters on. An annotated
 * fragment restores the check.
 */
function provisionalFragment(
  provisional: boolean,
  unresolved: readonly EntityRole[],
): Pick<BrainFactProvenance, "provisional" | "unresolved"> {
  return provisional ? { provisional: true, unresolved } : {};
}

function entityIdFragment(
  entityIds: Partial<Record<EntityRole, string>>,
): Pick<BrainFactProvenance, "entityIds"> {
  return Object.keys(entityIds).length > 0 ? { entityIds } : {};
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
