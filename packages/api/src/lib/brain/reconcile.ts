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
 * load-bearing; see the byte-exactness note below for what a paraphrase costs.
 *
 * Two writers racing on the same claim would defeat a bare read-then-insert, so
 * the transaction opens by taking a per-workspace transaction-scoped advisory
 * lock. The rejected alternative was a partial UNIQUE index on
 * `(workspace_id, subject, predicate, object) WHERE invalidated_at IS NULL` plus
 * `ON CONFLICT DO NOTHING`: structurally stronger, but it needs a migration to
 * a table this milestone is still shaping, and it would make an ordinary
 * bi-temporal case (the same SPO re-asserted over a different validity window,
 * which M2 owns) unrepresentable rather than merely unusual. The lock is
 * reversible; the index would be a decision M2 has to live with. Revisit it
 * when M2 settles supersession.
 *
 * Identity is BYTE-EXACT on the trimmed, resolved SPO — deliberately, so the
 * lookup is served by `idx_brain_facts_subject` and so that deciding whether
 * `Alice` and `alice` are one entity stays the ENTITY RESOLVER's job. A
 * `lower()` comparison here would silently take that decision away from the
 * seam that exists to make it.
 *
 * The cost of byte-exactness, stated because it is easy to over-read the
 * paragraph above: dedupe is only as good as the producer's determinism. Two
 * passes that phrase one claim differently ("is" vs "is on") are two claims
 * here, and a pass whose entity resolution CHANGES between runs will miss its
 * own earlier row. The reviewer collapses those; nothing in this stage can.
 * `extract.ts` pins its model call to `temperature: 0` for exactly this reason.
 *
 * ## What this slice does NOT do
 *
 * A fact's grant is INHERITED from its episode verbatim — a claim is never more
 * visible than the evidence behind it. Deriving a grant from source membership
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
 * in tension with. The edges are ADVISORY (M2 owns clustering and arbitration),
 * so a subject/predicate that somehow accumulated hundreds of live objects
 * should surface the newest few for a reviewer rather than write a fan of
 * edges nobody reads.
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
   * Omit for the conservative default (`multi` — values coexist). `single`
   * additionally earns the advisory tension edges below; wrongly coexisting is
   * recoverable at the review gate, wrongly superseding destroys a belief.
   */
  readonly predicateCardinality?: PredicateCardinality;
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
// NOTE for the next editor: none of these may name `status`.
// `scripts/check-brain-fact-promotion.sh` refuses any statement that touches
// `brain_facts` and mentions the column — including in a WHERE clause — and
// that over-breadth is deliberate. The fact insert omits `status` on purpose:
// migration 0180 defaults it to `draft`, and that default IS the review gate
// applying itself (#4769). Asking for `draft` explicitly would be the same
// value written by a second, ungated writer.

/** The per-workspace serialization point — see the module header. */
export const RECONCILE_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, hashtext($2))`;

/**
 * Does a live fact already assert exactly this claim? Served by
 * `idx_brain_facts_subject` (partial on `invalidated_at IS NULL`).
 *
 * Deliberately NOT filtered by review state: a claim re-observed after it was
 * published must corroborate the published fact, not mint a fresh draft
 * duplicate of it. Deliberately not filtered by grant either — a narrower
 * re-observation is recorded as EVIDENCE and never widens the existing fact's
 * `visible_to`, because a grant is immutable per fact version (0180).
 */
export const CORROBORATION_LOOKUP_SQL = `SELECT id
     FROM brain_facts
    WHERE workspace_id = $1
      AND subject = $2
      AND predicate = $3
      AND object = $4
      AND invalidated_at IS NULL
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
 */
export const INSERT_FACT_SQL = `INSERT INTO brain_facts
         (workspace_id, subject, predicate, object, valid_from, extracted_at,
          source_episode_id, provenance, visible_to, predicate_cardinality)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::uuid, $8::jsonb,
               ARRAY(SELECT jsonb_array_elements_text($9::jsonb)), $10)
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
 */
export const TENSION_CANDIDATES_SQL = `SELECT id
     FROM brain_facts
    WHERE workspace_id = $1
      AND subject = $2
      AND predicate = $3
      AND object <> $4
      AND invalidated_at IS NULL
      AND id <> $5::uuid
    ORDER BY ingested_at DESC
    LIMIT $6`;

/**
 * The advisory edge. `in-tension-with` is SURFACED with both provenances and
 * never ranked (ADR-0036) — writing it is not an arbitration, and nothing here
 * supersedes, invalidates, or reorders anything. M2 owns the clustering that
 * reads these.
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
  // carrying a second one whose author believed it was doing something, and the
  // resulting fact is narrower than intended FOREVER (grants are immutable per
  // fact version). `logGrantAnomalies` is the seam `acl.ts` built for exactly
  // this, and this is the write path that holds the row.
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

    prepared.push({
      kind: "prepared",
      subject: resolvedSubject?.canonical ?? subject,
      predicate,
      object: resolvedObject?.canonical ?? object,
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

interface PreparedCandidate {
  readonly kind: "prepared";
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
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
    item.subject,
    item.predicate,
    item.object,
  ]);
  const existingId = firstId(existing.rows);
  if (existingId !== null) {
    // Strengthen: one more piece of evidence for a belief Atlas already holds.
    // Nothing about the fact itself changes — not its grant, not its review
    // state, not its validity. (The new episode may be narrower than the fact's
    // own grant; that is safe because `brain_episodes` is ACL-gated in its own
    // right by the same predicate, so walking the edge cannot read an episode
    // the reader is not entitled to.)
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

  const cardinality: PredicateCardinality = item.candidate.predicateCardinality ?? "multi";
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
    cardinality,
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

  let tensionEdges = 0;
  if (cardinality === "single") {
    const rivals = await tx.query(TENSION_CANDIDATES_SQL, [
      episode.workspaceId,
      item.subject,
      item.predicate,
      item.object,
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
