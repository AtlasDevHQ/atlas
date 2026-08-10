/**
 * The curated identity vocabulary — approved edges, and the derived
 * effective-target closure `alias` reads (#5022, ADR-0037 §6, migration 0189).
 *
 * `lib/brain/identity.ts` owns `key = alias(lexicalNorm(surface))`: the inner
 * lexical layer, the composition ({@link slotKey}), and the SHAPE of the outer
 * one. This module is the outer one's data — the store, its two write
 * primitives, the closure recomputation, and the loader that turns the closure
 * into a {@link ClaimVocabulary}.
 *
 * ## Two relations, and the split is the reversibility
 *
 * | | What it is | Written by |
 * |---|---|---|
 * | `brain_vocabulary_edge` | the human's decisions; at-most-one-parent; never rewritten by another approval | approval / removal only |
 * | `brain_vocabulary_target` | the transitive closure of those edges — what `alias` reads | derived, recomputed wholesale |
 *
 * ADR-0037 §6 retracts T3's "forest invariant" by name for being
 * self-contradictory — it stated depth-1 (*every canonical target is itself
 * unaliased*) AND asserted composition works, and approving `price → unit
 * price` after `is priced at → price` makes `price` an aliased target. The only
 * reconciliation under one relation is path compression at approval time, and
 * compression has two consequences the design cannot pay: it writes edges
 * nobody approved in that action, and it DESTROYS the reversibility T3 called
 * the sole thing keeping a bad alias from being as irreversible as a `valid_to`
 * stamp. After compressing, removing `price → unit price` cannot restore `is
 * priced at → price`, because that edge is gone.
 *
 * Split, removal is a RECOMPUTATION rather than a destructive write: drop
 * `price → unit price`, rebuild the closure from the edges that remain, and
 * `is priced at` lands back on `price`. That chain — approve, approve, remove
 * the second, assert the first is restored — is the only shape that falsifies
 * this, which is why `vocabulary-pg.test.ts` runs it through a COMPRESSED chain
 * and a single-edge test would be vacuous.
 *
 * ## Position-scoped, and why the schema and the type both say so
 *
 * Every row is keyed on `slot_position`, and {@link loadClaimVocabulary} hands
 * back three independent lookups. A position-agnostic vocabulary would not
 * merely PERMIT cross-position composition, it would COMPEL it: `owned by →
 * platform` plus `platform → platform team` puts two edges in one chain, the
 * closure composes them, and a PREDICATE approval has re-keyed SUBJECTS
 * workspace-wide — silently, and in the direction nothing can undo. The overlap
 * is not hypothetical: warehouse predicates are bare common nouns (`price`,
 * `owner`, `status`, `tier`, `region`), the population most likely to also be
 * subject or object norms.
 *
 * Counter-case recorded rather than re-argued (#5022): T3 §3 chose ONE
 * namespace so a curated entry and an uncurated key stay directly comparable,
 * and this reintroduces a second space to keep from colliding. Three forests is
 * three enforcement paths that can drift — which is why both enforcement paths
 * that matter (at-most-one-parent, cycle refusal) are single-sited here rather
 * than per position.
 *
 * ## No ACL arm, and it is derived rather than chosen
 *
 * Nothing here takes a reader. All three identity consumers are already
 * workspace-scoped with no grant arm, and the INPUT does not exist: grant-scoped
 * aliasing needs `alias(norm, reader)` at a seam materialized at write time by
 * an ingest fiber that has no reader. ADR-0037 §6 names the cost — the
 * vocabulary is the one piece of brain state with no ACL, permanently, and
 * per-team terminology is refused by that decision rather than unimplemented.
 *
 * ## What this module is NOT
 *
 * Not the approval flow. `lib/brain/vocabulary-decide.ts` (#5023) owns the
 * proposal queue, the `decideAmendment`-shaped seam these primitives run
 * inside, the auto-approve split (warehouse-derived entity edges may
 * auto-approve; extractor- and seam-proposed edges queue), and #4507's
 * permanent rejection memory. Not the UI (#5025). Not cardinality (#5027) —
 * see {@link recomputeEffectiveTargets} for the room left for it. Not the
 * import-time merge of two workspaces' vocabularies (#5036).
 *
 * ## WIRED for reading since #5023
 *
 * {@link loadWorkspaceVocabulary} is the production entry point, and it has
 * four call sites: the extraction fiber (`extract.ts` — THE ingest path) and
 * the three `correctFact` entry points. Until #5023 every one of them named
 * `identityVocabulary` and no shipped path consulted these tables at read time;
 * the earlier version of this block said so at length, and deleting it rather
 * than editing it is deliberate — a warning that has come true is not a
 * warning.
 *
 * What that turns on is worth stating once, in the module that owns it: two
 * spellings of one claim now key into ONE slot, so they corroborate instead of
 * duplicating, earn tension edges against each other, and become supersedable
 * at the publish gate. Every one of those is the point, and every one of them
 * is a behaviour change on a live corpus.
 */

import { createLogger } from "@atlas/api/lib/logger";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";
import {
  identityAlias,
  lexicalNorm,
  type AliasLookup,
  type ClaimVocabulary,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";

const log = createLogger("brain-vocabulary");

/**
 * The executor every statement here runs through.
 *
 * Structurally satisfied by a `pg` client, a pool, and a test literal.
 *
 * Declared locally rather than re-exported from `reconcile.ts` so this module's
 * public surface names no ingest type — a consumer of the vocabulary store
 * should not have to reason about the reconcile stage to satisfy it.
 *
 * The shapes must nonetheless stay interchangeable, because #5023 hands these
 * primitives a `reconcile.ts` transaction runner's `tx`. The assertion below
 * makes drift a compile error instead of a discovery; it costs a TYPE-ONLY
 * import, which is erased, so nothing about the runtime layering changes.
 */
export interface VocabularyExecutor {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/** Compile-time pin: a `reconcile.ts` `tx` must satisfy this module's executor. */
type _ReconcileExecutorIsAVocabularyExecutor =
  ReconcileExecutor extends VocabularyExecutor ? true : never;
const _executorsInterchangeable: _ReconcileExecutorIsAVocabularyExecutor = true;
void _executorsInterchangeable;

/**
 * Advisory-lock namespace for vocabulary mutation — this issue's number, the
 * convention `RECONCILE_LOCK_NAMESPACE` (4771) set. DISTINCT from reconcile's,
 * so approving an alias does not serialize against ingest.
 *
 * Exported so the region importer can take the same lock — it is the one other
 * vocabulary mutation path, and an unlocked writer makes the claim below false.
 *
 * It WAS not distinct from the publish gate's, because until #5024 the publish
 * gate took no advisory lock at all. It is now: ADR-0037 §7's separate
 * identity-mutation namespace exists as `IDENTITY_MUTATION_LOCK_NAMESPACE`
 * (`lib/brain/identity.ts`, 5024), publish takes that one, and this one stays
 * what it always was — vocabulary mutation, held by the decide seam and the
 * region importer.
 *
 * The ORDER between the two is fixed and load-bearing: the one caller that takes
 * both (`vocabulary-decide.ts`) takes THIS one first. Nothing holding 5024 ever
 * asks for 5022, so no wait-for cycle can form. See
 * {@link IDENTITY_MUTATION_LOCK_NAMESPACE} for why neither this namespace nor
 * reconcile's 4771 could serve publish, and #5022's own review for the 40P01 a
 * lock-redundancy argument produced when it got this wrong.
 */
export const VOCABULARY_LOCK_NAMESPACE = 5022;

/**
 * Taken on the WORKSPACE, not on `(workspace, position)`.
 *
 * The finer key would allow more concurrency and buys nothing real — vocabulary
 * writes are human-paced — while the coarse one makes a claim the finer one
 * cannot: no two vocabulary mutations in a workspace interleave, so the
 * check-then-write in {@link approveAliasEdge} is atomic against every other
 * mutation and not merely against same-position ones. The at-most-one-parent
 * primary key would hold anyway; the CYCLE check would not. Two concurrent
 * approvals of `a → b` and `b → a` each see an acyclic store, and without this
 * lock both commit.
 */
export const VOCABULARY_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, hashtext($2))`;

/**
 * Proof that {@link VOCABULARY_LOCK_SQL} actually took hold — i.e. that the
 * caller is inside an explicit transaction.
 *
 * `pg_advisory_xact_lock` is released at COMMIT. On an autocommit executor (a
 * bare pool) each statement IS its transaction, so the lock is taken and dropped
 * within the lock statement itself and a follow-up query sees nothing.
 *
 * Scoped to `classid`, `objid` AND `objsubid = 2` — all three. `classid` alone
 * would let a session-level lock in THIS namespace for a DIFFERENT workspace
 * make the probe pass — and this namespace has more than one holder, since
 * {@link VOCABULARY_LOCK_NAMESPACE} is exported and the region importer takes
 * it before its own insert loop.
 * `objid` is the `hashtext` of the workspace id, so the probe asks the exact
 * question the caller needs answered: is MY lock, on MY workspace, still held?
 *
 * The `& 4294967295` is not decoration. `hashtext` returns a SIGNED int4 and is
 * negative for roughly half of all inputs, while `pg_locks.objid` is an UNSIGNED
 * oid holding the same 32 bits — so a bare `::oid` cast raises `OID out of
 * range` on any workspace whose hash happens to be negative, turning the deny
 * point into a hard failure for half the fleet. Caught by the different-workspace
 * control, which is why that test exists.
 *
 * A STRONG SIGNAL rather than a proof, and the gap is worth naming: a pooled
 * connection handed back with an open transaction keeps the lock, so a later
 * `pool.query` reusing that backend would pass. That is a leaked transaction —
 * a bug in its own right — not a shape this module can be asked to survive.
 *
 * Measured against this repo's Postgres: 0 rows on a pool, 1 inside BEGIN.
 */
const VOCABULARY_LOCK_HELD_SQL = `SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND pid = pg_backend_pid()
    AND classid = $1 AND objid = (hashtext($2)::bigint & 4294967295)::oid
    AND objsubid = 2`;

/**
 * Take the vocabulary lock and refuse to continue outside a transaction.
 *
 * Every primitive here is a check-then-write or a clear-then-rebuild, and both
 * are only atomic inside one. Outside, the damage is not theoretical and not
 * loud: {@link removeAliasEdge} would COMMIT an empty closure between its DELETE
 * and its rebuild, so a concurrent {@link loadClaimVocabulary} in that window
 * gets `identityAlias` and keys a whole episode un-aliased — the corpus-wide
 * under-match this module refuses to degrade into anywhere else. If the process
 * dies in the window the state is permanent, and nothing logs.
 *
 * Enforced rather than documented because the mistake is one argument away: a
 * `VocabularyExecutor` is structurally satisfied by a pool ON PURPOSE (that is
 * what lets {@link loadClaimVocabulary} take one), so nothing in the type
 * distinguishes the two.
 */
async function lockWorkspaceVocabulary(
  tx: VocabularyExecutor,
  workspaceId: string,
  operation: string,
): Promise<void> {
  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);
  const held = await tx.query(VOCABULARY_LOCK_HELD_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);

  // Narrowed, not cast-and-dereferenced. `VocabularyExecutor` is satisfied by a
  // test literal by design, and `{ rows: [] }` is a shape real mocks in this
  // repo return — an unguarded `rows[0].n` would answer the one function whose
  // job is legibility with a raw TypeError.
  const probe = held.rows[0] as { n?: unknown } | undefined;
  const lockCount = typeof probe?.n === "number" ? probe.n : Number.NaN;
  if (!Number.isFinite(lockCount)) {
    log.error({ workspaceId, operation }, "Vocabulary lock probe returned no usable count");
    throw new Error(
      `${operation} could not verify the vocabulary advisory lock (workspace ${workspaceId}): ` +
        `the probe returned ${probe === undefined ? "no row" : `a row whose \`n\` is a ${typeof probe.n}`}` +
        ", so this executor is not answering as a Postgres client. Refusing rather than assuming " +
        "the lock is held.",
    );
  }
  // `< 1`, deliberately NOT `=== 0`. This is the deny point, and a deny point
  // written in the permissive polarity is how the fix becomes the defect: every
  // value that is not exactly `0` would otherwise read as "lock held".
  if (lockCount < 1) {
    log.error({ workspaceId, operation }, "Vocabulary mutation attempted outside a transaction");
    throw new Error(
      `${operation} must run inside a transaction (workspace ${workspaceId}). Its check-then-write ` +
        "and the closure rebuild are one atomic decision, and on an autocommit connection a failed " +
        "rebuild leaves the closure COMMITTED EMPTY while the approved edges still claim one — " +
        "which silently keys every claim un-aliased. Wrap the call in BEGIN/COMMIT (#5023's decide " +
        "transaction) and retry.",
    );
  }
}

/**
 * How far a chain may be walked before the walk is treated as broken.
 *
 * NOT a design limit on vocabulary depth — an at-most-one-parent acyclic store
 * cannot produce a chain longer than its node count, and a curated vocabulary is
 * human-authored. It is a liveness guard so a store that has SOMEHOW become
 * cyclic (a hand-written INSERT, a restore that bypassed these primitives)
 * makes a recursive CTE terminate instead of spinning. Reaching it is a
 * corruption signal, and {@link recomputeEffectiveTargets} converts it into a
 * thrown error rather than a quietly truncated closure — see the convergence
 * check there.
 *
 * WHICH cycles die on the CHECK instead of the convergence query is decided by
 * DIVISIBILITY, not parity — an earlier version of this comment said "even" and
 * was measured on a 2-cycle then generalised, which a 6-cycle disproves. A node
 * in a cycle of length L walked to depth D lands back on ITSELF iff `L | D`, and
 * 64's divisors are the powers of two. So cycles of length 2, 4, 8, 16, 32 and
 * 64 trip `ck_brain_vocabulary_target_not_self` before the convergence check can
 * run, and every other length — 3, 5, 6, 10, … — reaches it.
 *
 * Measured against this repo's Postgres: a 2- and a 4-cycle trip the CHECK; a 6-
 * and a 10-cycle insert cleanly and are caught by the convergence query. Both
 * outcomes abort the transaction, so nothing corrupt commits either way — only
 * one carries an actionable message. Changing this constant therefore changes
 * WHICH cycle lengths get the good error, and is a behaviour change rather than
 * a tuning knob.
 */
export const MAX_CHAIN_DEPTH = 64;

/** One approved edge, as callers supply it. */
export interface AliasEdgeInput {
  readonly position: SlotPosition;
  /** The norm being aliased away. Re-normed before it is written. */
  readonly fromNorm: string;
  /** The norm it is approved onto. Re-normed before it is written. */
  readonly toNorm: string;
  /**
   * The approver, or `null` for an auto-approved warehouse-derived edge.
   *
   * REQUIRED and nullable rather than optional: optional-and-nullable gives
   * three input states for two meanings, and the omitted one would silently
   * record an auto-approval. Migration 0189 calls this "the one column an audit
   * of a workspace-wide re-key reads first", so every caller states the
   * auto-approve decision out loud.
   */
  readonly approvedBy: string | null;
}

/** Why an approval was refused. */
export type AliasApprovalRefusal =
  /** Either endpoint norms away to nothing — a surface that asserts nothing. */
  | "degenerate-norm"
  /** Both endpoints norm to the same thing; the edge would say nothing. */
  | "self-edge"
  /** `fromNorm` already has an approved parent. Approvals never rewrite. */
  | "already-aliased"
  /** `toNorm`'s chain already reaches `fromNorm`. */
  | "would-cycle";

/**
 * Named once and used in BOTH arms below, so the split cannot silently un-split.
 *
 * The gain is narrower than it first looks, and worth stating precisely rather
 * than overclaiming: renaming the union member is caught EITHER way, because
 * excess-property checking rejects `existingTarget` against the arm that no
 * longer declares it. What the alias adds is cover for a typo confined to the
 * `Exclude` literal alone — which readmits `already-aliased` without its
 * required field and, in a codebase with no consumer reading it yet, is silent.
 * `Extract` makes that typo resolve to `never` and the constructor stops
 * compiling. One line, so worth it; not the compile-time guarantee an earlier
 * version of this comment claimed.
 */
type AlreadyAliased = Extract<AliasApprovalRefusal, "already-aliased">;

export type AliasApprovalResult =
  | {
      readonly ok: true;
      readonly position: SlotPosition;
      readonly fromNorm: string;
      readonly toNorm: string;
    }
  /**
   * Its own arm so `existingTarget` is REQUIRED exactly where it is meaningful.
   * As a shared optional field, a consumer narrowing to `already-aliased` still
   * got `string | undefined` and had to reach for `!` or a `?? "unknown"` — i.e.
   * exactly the "makes the operator guess" outcome the field exists to prevent.
   *
   * The target is the norm's RAW approved parent, not its effective target: the
   * only correct repair is to remove the edge that exists, and under a
   * compressed chain the closure's root is a different (and un-removable) norm.
   */
  | {
      readonly ok: false;
      readonly refusal: AlreadyAliased;
      readonly message: string;
      readonly existingTarget: string;
    }
  | {
      readonly ok: false;
      readonly refusal: Exclude<AliasApprovalRefusal, AlreadyAliased>;
      readonly message: string;
    };

/**
 * A closure rebuild that did not converge — the approved edges are cyclic, or
 * deeper than {@link MAX_CHAIN_DEPTH}.
 *
 * A named class rather than a bare `Error` because #5023's decide seam has to
 * tell "this workspace's vocabulary is corrupt" (do not retry; surface to an
 * operator) from "the database is unreachable" (retry). Matches the module's
 * neighbours — `CorrectionRefusedError`, `BrainAsOfInvalidError` — which are
 * plain classes rather than `Data.TaggedError`, since none of this is Effect.
 */
export class VocabularyClosureError extends Error {
  readonly position: SlotPosition;
  readonly norm: string;
  /**
   * The target the norm resolved to, or `null` when the norm had NO closure row
   * at all — the half-rebuilt case {@link loadClaimVocabulary} refuses. Both are
   * "this workspace's vocabulary is corrupt", so both carry the same type: a
   * seam that branched correctly on one and fell through to "database
   * unreachable" on the other would defeat the reason the class exists.
   */
  readonly effectiveTarget: string | null;

  constructor(
    message: string,
    details: { position: string; norm: string; effectiveTarget: string | null },
  ) {
    super(message);
    this.name = "VocabularyClosureError";
    this.position = details.position as SlotPosition;
    this.norm = details.norm;
    this.effectiveTarget = details.effectiveTarget;
  }
}

/**
 * The two refusals that need no database — the endpoint norms alone decide them.
 *
 * Split out so {@link mergeApprovedEdges} enforces them from the SAME source
 * rather than from a second copy. That matters more here than the usual DRY
 * argument: the two paths disagree about almost everything else —
 * `approveAliasEdge` re-norms and `mergeApprovedEdges` must not; the approval
 * recomputes the closure per edge and the merge once per position — and the
 * rules they DO share are exactly the ones a reader would assume had drifted.
 *
 * Lock position differs between the callers, and either is safe.
 * `approveAliasEdge` screens BEFORE taking the lock; `mergeApprovedEdges` takes
 * it once for the whole batch before its first insert, so this runs under it.
 * Neither ordering matters here: a caller refused at this point has touched no
 * row, so there is nothing for the lock to make atomic.
 *
 * Takes the raw inputs beside the normed ones purely for the MESSAGE — an
 * approver who typed `Priced At` needs to see what they typed, not only what it
 * normed to. On the import path the two are equal by construction, because
 * `validateBundle` refuses a non-norm rather than rewriting another region's
 * decision (ADR-0037 §8).
 */
function screenAliasNorms(
  rawFrom: string,
  rawTo: string,
  fromNorm: string,
  toNorm: string,
): { readonly refusal: Exclude<AliasApprovalRefusal, AlreadyAliased>; readonly message: string } | null {
  if (fromNorm === "" || toNorm === "") {
    return {
      refusal: "degenerate-norm",
      message:
        `An alias edge needs two non-empty norms; ` +
        `"${rawFrom}" → "${rawTo}" normalizes to "${fromNorm}" → "${toNorm}". ` +
        "A surface made only of separators asserts nothing and has no slot to alias.",
    };
  }

  if (fromNorm === toNorm) {
    return {
      refusal: "self-edge",
      message:
        `"${rawFrom}" and "${rawTo}" both normalize to "${fromNorm}", so they ` +
        "already share an identity key and there is nothing to alias.",
    };
  }

  return null;
}

/**
 * The outcome of the two refusals that DO need the store — at-most-one-parent,
 * and the cycle walk.
 *
 * `existingTarget` is required on its own arm for the reason
 * {@link AliasApprovalResult} gives at length: as a shared optional field, every
 * consumer that narrowed to `already-aliased` still had to reach for `!` or a
 * `?? "unknown"`, which is the "makes the operator guess" outcome the field
 * exists to prevent. {@link mergeApprovedEdges} is the consumer that proves the
 * point — it reads `existingTarget` to tell an idempotent re-import from a
 * discarded decision, and that read must not be able to compile against
 * `undefined`.
 */
type AliasEdgeAdmission =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: AlreadyAliased;
      readonly existingTarget: string;
      readonly message: string;
    }
  | { readonly ok: false; readonly refusal: "would-cycle"; readonly message: string };

/**
 * Ask the store whether one edge may be written. Writes nothing.
 *
 * MUST be called with the workspace vocabulary lock already held — both checks
 * are the read half of a check-then-write, and {@link lockWorkspaceVocabulary}
 * is what makes the pair atomic. Not re-taken here: this is a private helper
 * with two call sites, both of which lock first, and a third acquisition would
 * imply to a reader that it were safe to call unlocked.
 */
async function admitAliasEdge(
  tx: VocabularyExecutor,
  workspaceId: string,
  position: SlotPosition,
  fromNorm: string,
  toNorm: string,
): Promise<AliasEdgeAdmission> {
  const existing = await tx.query(
    `SELECT to_norm FROM brain_vocabulary_edge
      WHERE workspace_id = $1 AND slot_position = $2 AND from_norm = $3`,
    [workspaceId, position, fromNorm],
  );
  const existingRow = existing.rows[0] as { to_norm: string } | undefined;
  if (existingRow !== undefined) {
    return {
      ok: false,
      refusal: "already-aliased",
      existingTarget: existingRow.to_norm,
      message:
        `"${fromNorm}" is already approved onto "${existingRow.to_norm}" at the ${position} ` +
        "position, and an approval never rewrites a previously approved edge. Remove that edge " +
        "first — removal recomputes the closure and restores what it was hiding.",
    };
  }

  // Walk UP from the proposed parent. With at-most-one-parent the walk is a
  // single chain, so reaching `fromNorm` means this edge would close a cycle.
  const chain = await tx.query(
    `WITH RECURSIVE chain AS (
       SELECT to_norm AS node, 1 AS depth
         FROM brain_vocabulary_edge
        WHERE workspace_id = $1::text AND slot_position = $2::text AND from_norm = $3::text
       UNION ALL
       SELECT e.to_norm, c.depth + 1
         FROM chain c
         JOIN brain_vocabulary_edge e
           ON e.workspace_id = $1::text AND e.slot_position = $2::text AND e.from_norm = c.node
        WHERE c.depth < $5::int
     )
     SELECT 1 AS hit FROM chain WHERE node = $4::text LIMIT 1`,
    [workspaceId, position, toNorm, fromNorm, MAX_CHAIN_DEPTH],
  );
  if (chain.rows.length > 0) {
    return {
      ok: false,
      refusal: "would-cycle",
      message:
        `Approving "${fromNorm}" → "${toNorm}" at the ${position} position would close a cycle: ` +
        `"${toNorm}" already resolves through "${fromNorm}". A cyclic vocabulary has no effective ` +
        "target, so `alias` would stop being a function.",
    };
  }

  return { ok: true };
}

/**
 * Approve one alias edge, and recompute the position's closure.
 *
 * MUST run inside a transaction — the check-then-insert and the recompute are
 * one atomic decision, and the advisory lock below is a `_xact_` lock that is
 * released at commit. #5023 supplies that transaction from the decide seam.
 *
 * ## Four refusals, and none of them is a rewrite
 *
 * An approval NEVER retargets a previously approved edge (ADR-0037 §6). There
 * is no upsert here and there must not be one: the whole reversibility argument
 * rests on approved edges being the durable record of what a human decided, and
 * an `ON CONFLICT DO UPDATE` would silently overwrite one decision with another
 * at the exact moment an operator believed they were adding.
 *
 * The four live in the two helpers above rather than inline, because since
 * #5036 the import merge answers to the same four. Which one produces which is
 * worth keeping straight: {@link screenAliasNorms} decides `degenerate-norm` and
 * `self-edge` from the norms alone, {@link admitAliasEdge} decides
 * `already-aliased` and `would-cycle` from the store.
 *
 * At-most-one-parent is enforced twice, deliberately. The primary key is what
 * holds under concurrency; the explicit read is what turns "unique violation on
 * brain_vocabulary_edge_pkey" into a typed refusal naming the existing target.
 * Deleting the explicit check does not make the write succeed — it makes it
 * THROW instead of refusing, which is a different observable outcome and is
 * what `vocabulary-pg.test.ts` asserts on.
 *
 * Cycle refusal has no structural twin: a CHECK cannot read other rows, and the
 * `not_self` CHECK covers only length 1. Longer cycles are caught by walking up
 * from the proposed PARENT and asking whether the chain reaches the proposed
 * CHILD.
 */
export async function approveAliasEdge(
  tx: VocabularyExecutor,
  workspaceId: string,
  // ⚠️ `approvedAt?: never` is a BARRIER against {@link ArrivingAliasEdge}, not
  // a field. That type extends this one, so without it
  // `approveAliasEdge(tx, ws, arrivingEdge)` type-checks perfectly — and then
  // silently does the one thing a row-copy must never do: the INSERT below omits
  // `approved_at`, so the column falls to its `now()` default and a decision
  // made in another region a year ago is re-dated to the migration. The subtype
  // relation is what makes the mistake reachable, so the barrier belongs here
  // rather than in a comment on the caller. Every existing caller passes an
  // object literal with no `approvedAt` and is unaffected.
  input: AliasEdgeInput & { readonly approvedAt?: never },
): Promise<AliasApprovalResult> {
  const { position } = input;
  // Re-normed, never trusted. `alias` composes over `lexicalNorm`, and an
  // approver typing the canonical DISPLAY form (`Priced At`) is the likeliest
  // authoring mistake once this is a reviewed data table — `slotKey` re-norms
  // the ANSWER for the same reason, but a stored non-norm would also make the
  // closure's joins miss, which `slotKey` cannot repair.
  const fromNorm = lexicalNorm(input.fromNorm);
  const toNorm = lexicalNorm(input.toNorm);

  const screened = screenAliasNorms(input.fromNorm, input.toNorm, fromNorm, toNorm);
  if (screened !== null) return { ok: false, ...screened };

  await lockWorkspaceVocabulary(tx, workspaceId, "approveAliasEdge");

  const admission = await admitAliasEdge(tx, workspaceId, position, fromNorm, toNorm);
  if (!admission.ok) return admission;

  await tx.query(
    `INSERT INTO brain_vocabulary_edge
       (workspace_id, slot_position, from_norm, to_norm, approved_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, position, fromNorm, toNorm, input.approvedBy],
  );

  await recomputeEffectiveTargets(tx, workspaceId, position);

  return { ok: true, position, fromNorm, toNorm };
}

/**
 * One approved edge arriving from another region, as a row-copy path supplies
 * it (ADR-0037 §8).
 *
 * Extends {@link AliasEdgeInput} rather than restating it, so the merge and the
 * approval cannot drift about what an edge IS. The single addition is
 * `approvedAt`: an approval MINTS one (the column defaults to `now()`), while a
 * row-copy carries the source region's, because the timestamp is part of the
 * decision being copied and a re-stamp would date every migrated decision to the
 * migration.
 */
export interface ArrivingAliasEdge extends AliasEdgeInput {
  /**
   * The SOURCE region's approval timestamp, carried verbatim.
   *
   * ⚠️ Callers must have validated this parses — it is bound straight into a
   * `timestamptz`, so an unparseable string is a Postgres THROW that aborts the
   * whole import, which is the failure mode this module exists to replace with
   * typed refusals. The one caller validates it in `validateBundle`'s
   * `missingTimestamps` at the wire boundary.
   */
  readonly approvedAt: string;
}

/**
/**
 * One arriving edge the merge would not write, and everything needed to
 * re-author it by hand.
 *
 * The refused edge is a HUMAN's approved decision that this region is dropping,
 * and #5036 makes the log the entire recovery path — so the payload is the
 * whole edge, not a norm pair. An operator reading one of these has to be able
 * to reconstruct the source row without the bundle, which by then may be
 * deleted (`stays` cleanup, #4458).
 */
export type VocabularyMergeRefusal =
  | {
      readonly edge: ArrivingAliasEdge;
      readonly refusal: AlreadyAliased;
      /** What this region holds for `edge.fromNorm` instead. */
      readonly existingTarget: string;
      readonly message: string;
    }
  | {
      readonly edge: ArrivingAliasEdge;
      readonly refusal: Exclude<AliasApprovalRefusal, AlreadyAliased>;
      readonly message: string;
    };

/**
 * What a merge did, counted so that `applied + duplicate + refusals.length`
 * equals the number of edges supplied.
 *
 * That total is a CONTRACT, not an incidental property: `migrate.ts` reconciles
 * the target's counters against the manifest count and ABORTS the migration
 * before cutover when they disagree. Every arriving edge therefore lands in
 * exactly one of the three.
 */
export interface VocabularyMergeResult {
  /** Edges written — decisions this region did not previously hold. */
  readonly applied: number;
  /**
   * Edges already present with the SAME target. Not a loss and not a refusal:
   * the destination already holds the decision the source is offering, which is
   * what an idempotent re-import looks like from the inside.
   */
  readonly duplicate: number;
  readonly refusals: readonly VocabularyMergeRefusal[];
  /** Positions whose closure was rebuilt — those, and only those, that gained an edge. */
  readonly positionsRecomputed: readonly SlotPosition[];
}

/**
 * Merge another region's approved edges into this one's (#5036, ADR-0037 §8 §4).
 *
 * > Union the approved edges; refuse any edge that would close a cycle or
 * > violate at-most-one-parent; log every refusal; recompute the effective-target
 * > closure at the destination.
 *
 * MUST run inside a transaction, for {@link approveAliasEdge}'s reasons exactly.
 *
 * ## Why the importer could not keep using `ON CONFLICT DO NOTHING`
 *
 * Every other merge rule in the importer is destination-wins-silently — fact and
 * episode dedup is an id-skip, `fact_audience_member` is `DO NOTHING` — and for
 * ordinary workspace data that is right, because the destination's row and the
 * source's row are the same row. A vocabulary edge is not data; it is a HUMAN
 * REVIEW DECISION, and two regions can hold contradictory ones legitimately.
 * Silently keeping the destination's discards the other region's review work
 * with no record that it existed.
 *
 * ## The forest invariant holds per-vocabulary and nothing enforced it across two
 *
 * Canonical direction is arbitrary, so a source that curated `price → priced at`
 * and a destination that curated `priced at → price` are BOTH valid forests
 * whose union is a 2-cycle. A cyclic store has no effective target, so the
 * closure rebuild does not terminate meaningfully — `alias` stops being a
 * function. Refusing the arriving edge is what keeps the destination a forest at
 * every step; the losing decision survives as a log line rather than as
 * corruption.
 *
 * ## Destination wins, and the alternative is recorded rather than lost
 *
 * The refusal always falls on the ARRIVING edge, which is the same asymmetry
 * `approveAliasEdge` applies to a second approval. The counter-case — queue the
 * conflict for human review instead — is real and was rejected for one reason:
 * it blocks a region migration on human attention, which is the one thing a
 * cutover cannot wait for. Logging is what makes the choice affordable.
 *
 * ## Order, and how far determinism goes
 *
 * Edges are applied in the order supplied, and that is deterministic in
 * practice: `export.ts` orders them `slot_position, from_norm ASC`. Order still
 * MATTERS. For any bundle this product exported the arriving set is itself a
 * valid forest, so in practice no two arrivals conflict — but NOTHING UPSTREAM
 * ENFORCES THAT: `validateBundle` screens each edge independently, with no
 * duplicate-`fromNorm` and no intra-bundle cycle check, so a hand-built or
 * corrupted bundle can conflict with itself, and the merge decides those against
 * rows this same transaction has already written. Group 6 of
 * `vocabulary-merge-pg.test.ts` pins that arm.
 *
 * Separately, a cycle formed jointly with destination edges can be closable by
 * more than one arrival, and which of them is refused depends on which is seen
 * first. Both outcomes leave a forest, both are logged; a bundle in another
 * order may pick the other edge.
 *
 * ## No re-norming, and no version stamp
 *
 * Both norms are written exactly as they arrive. ADR-0037 §8 makes a row-copy
 * path carry values verbatim, and `validateBundle` refuses a non-norm at the
 * door rather than rewriting another region's decision — so re-norming here
 * would be a second, silent canonicalizer over data already proven canonical.
 *
 * Nor is anything stamped per row to record which vocabulary an edge came from.
 * The approved-edge set IS the durable record of every decision and the keys are
 * re-derivable from it; a per-row version would be a third representation to
 * keep consistent, and an imported row would carry a FOREIGN version that means
 * nothing in this region.
 */
export async function mergeApprovedEdges(
  tx: VocabularyExecutor,
  workspaceId: string,
  edges: readonly ArrivingAliasEdge[],
): Promise<VocabularyMergeResult> {
  // No edges, no lock. Not an optimization — the lock is only meaningful around
  // a write, and taking it here would make every import of a bundle that
  // carries no vocabulary serialize against every open approval in the
  // workspace, for nothing.
  if (edges.length === 0) {
    return { applied: 0, duplicate: 0, refusals: [], positionsRecomputed: [] };
  }

  // ⚠️ TAKEN BEFORE THE FIRST INSERT, AND THE ORDER IS THE POINT.
  //
  // `approveAliasEdge` acquires the advisory lock FIRST and then touches rows. A
  // merge that inserted first and reached the lock only inside
  // `recomputeEffectiveTargets` would acquire the same two resources in the
  // opposite order, so two writers sharing a `from_norm` deadlock: the approver
  // holds the advisory lock and blocks on the merge's uncommitted row, while the
  // merge blocks on the advisory lock. Postgres resolves it with `40P01`, and
  // the victim can be the entire region import.
  //
  // Recorded at length because the acquisition was REMOVED once, on the
  // reasoning that `recomputeEffectiveTargets` takes the same lock anyway. That
  // is wrong in the way lock-ordering arguments usually are: the later lock does
  // not block in the same PLACE, and the displacement IS the bug. Re-taking it
  // in `recomputeEffectiveTargets` costs nothing — `pg_advisory_xact_lock` is
  // re-entrant within a transaction.
  await lockWorkspaceVocabulary(tx, workspaceId, "mergeApprovedEdges");

  let applied = 0;
  let duplicate = 0;
  const refusals: VocabularyMergeRefusal[] = [];
  const positionsTouched = new Set<SlotPosition>();

  for (const edge of edges) {
    const { position, fromNorm, toNorm } = edge;

    // Raw and normed are the same value on purpose — see `screenAliasNorms`.
    const screened = screenAliasNorms(fromNorm, toNorm, fromNorm, toNorm);
    if (screened !== null) {
      refusals.push({ edge, ...screened });
      continue;
    }

    const admission = await admitAliasEdge(tx, workspaceId, position, fromNorm, toNorm);
    if (!admission.ok) {
      // The one case that is not a loss: this region already holds the very
      // decision the source is offering. `existingTarget` is what tells the two
      // apart, and it is why that field is REQUIRED on its arm — read through an
      // optional, a `undefined === toNorm` comparison would be false and every
      // idempotent re-import would report a discarded human decision.
      if (admission.refusal === "already-aliased" && admission.existingTarget === toNorm) {
        duplicate++;
        continue;
      }
      // `ok` is stripped, NOT spread through. `{ edge, ...admission }` compiles
      // — object-literal SPREAD is exempt from excess-property checking, unlike
      // the equivalent inline literal — and pushes a runtime `ok: false` that
      // `VocabularyMergeRefusal` does not declare. The twin in the
      // `screenAliasNorms` branch above does not, because that helper returns no
      // discriminant — so the two arms
      // of one union would carry structurally different shapes: a `toEqual` or a
      // `JSON.stringify` of the recovery payload sees `ok` on `would-cycle` and
      // not on `self-edge`. Destructuring is what makes the declared type and
      // the constructed value the same thing.
      const { ok: _admitted, ...detail } = admission;
      refusals.push({ edge, ...detail });
      continue;
    }

    // ⚠️ The verbatim-write contract is enforced TWO MODULES AWAY, and violating
    // it is silently lossy — so make it audible here without changing it.
    // `validateBundle` refuses a non-norm at the wire boundary, which is why the
    // raw and normed arguments passed to `screenAliasNorms` are the same value;
    // but `lib/` must not import from `api/routes/`, this function is exported,
    // and `screenAliasNorms` cannot catch it — `"Priced At"` is neither empty
    // nor self-equal, so it sails through and lands an alias that can never
    // match anything, which is exactly the silent under-match this module exists
    // to prevent. Not REFUSED, because ADR-0037 §8 forbids rewriting another
    // region's decision on a row-copy path and refusing here would be this
    // module second-guessing a validated wire contract; logged, because a caller
    // that skipped the check should not find out from a lookup that quietly
    // never fires. Costs nothing on the route path, where the predicate is false
    // by construction.
    //
    // ⚠️ POSITIONED AFTER THE ADMISSION CHECKS AND IMMEDIATELY BEFORE THE
    // INSERT, and phrased in the FUTURE TENSE — both for the same reason as the
    // refusal warn below, which this originally contradicted from forty lines
    // above it in the same commit. Emitted at the top of the loop it fired for
    // edges that were then REFUSED or counted as duplicates, claiming a write
    // that never happened and sending an operator hunting rows that do not
    // exist — in the very log stream where the refusal lines are the recovery
    // path, so both lose the same credibility. Here it fires only on the path
    // that actually writes, and only commits to what a COMMIT would make true.
    if (lexicalNorm(fromNorm) !== fromNorm || lexicalNorm(toNorm) !== toNorm) {
      log.warn(
        { workspaceId, position, fromNorm, toNorm },
        "Arriving alias edge is not in lexical-norm form — it WILL be written verbatim per " +
          "ADR-0037 §8 when this transaction commits, and can never match a lookup. The caller " +
          "skipped validateBundle's norm check.",
      );
    }

    await tx.query(
      `INSERT INTO brain_vocabulary_edge
         (workspace_id, slot_position, from_norm, to_norm, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, position, fromNorm, toNorm, edge.approvedBy, edge.approvedAt],
    );

    applied++;
    positionsTouched.add(position);
  }

  // ONE line per refusal, which is a deliberate exception to the aggregate-then-
  // warn rule the importer applies to its per-fact identity losses. The two are
  // different in kind: an identity loss is expected, corpus-sized, and its SIZE
  // is the signal, so per-row lines train an operator to skim. A refusal is rare
  // by construction and each one is a distinct human decision this region
  // dropped — there is no aggregate that would let an operator re-author it, and
  // re-authoring is the entire remedy. `index`/`total` are carried so a
  // truncated log still says how much is missing.
  refusals.forEach((refusal, index) => {
    log.warn(
      {
        workspaceId,
        position: refusal.edge.position,
        fromNorm: refusal.edge.fromNorm,
        toNorm: refusal.edge.toNorm,
        approvedBy: refusal.edge.approvedBy,
        approvedAt: refusal.edge.approvedAt,
        refusal: refusal.refusal,
        // `null` rather than absent for the arms that have no existing target:
        // a missing key and a key whose value is "there is no conflicting edge"
        // read identically in a log aggregator, and only one of them is true.
        existingTarget: refusal.refusal === "already-aliased" ? refusal.existingTarget : null,
        index,
        total: refusals.length,
        reason: refusal.message,
      },
      // ⚠️ FUTURE TENSE, and it is not a stylistic choice. This runs inside the
      // caller's transaction, which is section 9 of ~13 in `importBundle` — the
      // closure rebuild below, the brain's identity refusal, or any driver error
      // can still roll the whole thing back, and then NO edge was dropped
      // because none was applied. Stated in the past tense, a rolled-back import
      // tells an operator to go re-author decisions that are still there, and
      // the retry emits an identical line set with nothing to tell the attempts
      // apart. `admin-migrate.ts`'s identity-loss warn solved the same problem
      // one module over with the same tense — "WILL land ... when this
      // transaction commits" — and this matches it deliberately.
      "Vocabulary merge WILL DROP an arriving alias edge when this transaction commits — a source region's approved decision is not being applied here",
    );
  });

  // Only positions that gained an edge. A position whose every arrival was
  // refused or duplicated has a closure that is already correct, and rebuilding
  // it would be a no-op that reads as "something changed here".
  for (const position of positionsTouched) {
    await recomputeEffectiveTargets(tx, workspaceId, position);
  }

  return { applied, duplicate, refusals, positionsRecomputed: [...positionsTouched] };
}

/**
 * Remove one approved edge, and recompute the position's closure.
 *
 * Returns `false` when there was no such edge — the caller's request named a
 * norm that is not aliased, which is not an error but is also not a removal.
 *
 * ## The clear-then-delete-then-rebuild order is forced, not stylistic
 *
 * `fk_brain_vocabulary_target_edge` is `ON DELETE RESTRICT`, so the edge cannot
 * be dropped while ITS OWN closure row exists. Stated precisely because the FK
 * buys less than "remove-without-recomputing is unrepresentable": a caller could
 * delete one closure row plus its edge and strand the rest. What it does buy is
 * that skipping the rebuild ENTIRELY raises instead of committing a stale
 * closure. {@link recomputeEffectiveTargets} clears the whole position first, so
 * the correct ordering falls out of calling it.
 *
 * ## Why the whole position is rebuilt rather than the removed norm patched
 *
 * With `a → b` and `b → c` the closure holds `a → c` and `b → c`. Deleting
 * `b → c` must move `a` from `c` back to `b` — a row the deletion does not
 * mention. Any patch scoped to the deleted edge misses it, and misses it
 * SILENTLY: `a` keeps keying onto a target nobody approves any more, which is
 * exactly the irreversibility the two-relation split exists to remove.
 */
export async function removeAliasEdge(
  tx: VocabularyExecutor,
  workspaceId: string,
  position: SlotPosition,
  fromNorm: string,
): Promise<boolean> {
  const norm = lexicalNorm(fromNorm);
  if (norm === "") {
    // The CALLER still sees `false` — a typed refusal here needs a return-type
    // change, which belongs with #5025's UI. What this arm buys is that the
    // server side can tell a malformed request from a norm that genuinely has no
    // parent; the approve side gives the same input a typed `degenerate-norm`
    // refusal, and the asymmetry is recorded rather than hidden.
    log.warn(
      { workspaceId, position, fromNorm },
      "Alias removal ignored — the norm is degenerate, not merely unaliased",
    );
    return false;
  }

  await lockWorkspaceVocabulary(tx, workspaceId, "removeAliasEdge");

  const existing = await tx.query(
    `SELECT 1 AS hit FROM brain_vocabulary_edge
      WHERE workspace_id = $1 AND slot_position = $2 AND from_norm = $3`,
    [workspaceId, position, norm],
  );
  if (existing.rows.length === 0) return false;

  // Clears the position's closure, which is what releases the RESTRICT.
  await clearEffectiveTargets(tx, workspaceId, position);

  await tx.query(
    `DELETE FROM brain_vocabulary_edge
      WHERE workspace_id = $1 AND slot_position = $2 AND from_norm = $3`,
    [workspaceId, position, norm],
  );

  await recomputeEffectiveTargets(tx, workspaceId, position);
  return true;
}

/** Drop one position's closure rows. Always paired with a rebuild. */
async function clearEffectiveTargets(
  tx: VocabularyExecutor,
  workspaceId: string,
  position: SlotPosition,
): Promise<void> {
  await tx.query(
    `DELETE FROM brain_vocabulary_target WHERE workspace_id = $1 AND slot_position = $2`,
    [workspaceId, position],
  );
}

/**
 * Rebuild one (workspace, position)'s effective-target closure from its
 * approved edges.
 *
 * Returns nothing. An earlier cut returned the row count from a third query —
 * no caller read it, no test asserted it (`return 0` survived every mutation),
 * and its unguarded `rows[0].n` crashed on an executor that returns `{ rows: [] }`,
 * which is a shape this module's own seam advertises. A round trip spent
 * producing a value nobody consumes is not free; it is a third place to be
 * wrong.
 *
 * MUST run inside a transaction, for {@link approveAliasEdge}'s reason and one
 * of its own: the clear and the rebuild are one decision, and on an autocommit
 * connection a rebuild that throws leaves the position's closure COMMITTED
 * EMPTY. Enforced, not documented — see {@link lockWorkspaceVocabulary}.
 *
 * Idempotent and total for the position: clear, then walk every edge to its
 * root and keep the deepest hop per norm. There is no incremental path and
 * there should not be — see {@link removeAliasEdge} for the row a scoped patch
 * misses.
 *
 * ## `DISTINCT ON (norm) … ORDER BY norm, depth DESC` is the closure
 *
 * The recursive term emits one row per (norm, hop): `a` appears at depth 1
 * pointing at `b` and at depth 2 pointing at `c`. The deepest hop is the root,
 * because the walk stops when a target has no edge of its own.
 *
 * ## The convergence check, and why a silent truncation is the failure to fear
 *
 * {@link MAX_CHAIN_DEPTH} keeps a corrupt cyclic store from spinning, but a cap
 * that merely truncates would write a closure pointing at an INTERMEDIATE node
 * and nothing would say so — `alias` would answer confidently and wrongly, and
 * the rows it keyed would be unrecoverable without a re-key. So the rebuild is
 * verified: no closure row may name a target that itself has an approved
 * parent. That is the definition of "transitive closure" restated as a query.
 *
 * It fails loudly on a cap set below real depth, and on any cycle whose length
 * does NOT divide {@link MAX_CHAIN_DEPTH}. A cycle whose length DOES divide it
 * (2, 4, 8, … for the current 64) never reaches this check: every node lands back
 * on itself and `ck_brain_vocabulary_target_not_self` refuses the INSERT first.
 * Both abort the transaction, so no wrong closure commits either way — but only
 * one carries an actionable message. See {@link MAX_CHAIN_DEPTH}, which has the
 * measurements.
 *
 * ## The room slice C (#5027) needs
 *
 * Cardinality attaches to the CANONICAL PREDICATE — the effective target of a
 * predicate-position norm — and it must NOT live on this table. Every recompute
 * deletes and rebuilds these rows, so a human-set cardinality parked here would
 * be destroyed by the next unrelated approval in the same position. Keeping the
 * derived relation free of authored state is what leaves room for a table of
 * its own keyed on the canonical norm, rather than designing it out.
 */
export async function recomputeEffectiveTargets(
  tx: VocabularyExecutor,
  workspaceId: string,
  position: SlotPosition,
): Promise<void> {
  // Re-taken here rather than assumed from the caller: this function is exported
  // and the region importer calls it directly. `pg_advisory_xact_lock` is
  // re-entrant within a transaction, so the approve/remove paths that already
  // hold it pay nothing, and the probe inside is what makes the contract above
  // enforced rather than merely documented.
  await lockWorkspaceVocabulary(tx, workspaceId, "recomputeEffectiveTargets");

  await clearEffectiveTargets(tx, workspaceId, position);

  await tx.query(
    // `roots` is its own CTE purely for READABILITY — the inline form is legal.
    // An earlier version of this comment claimed Postgres rejects `ORDER BY
    // depth` when `depth` is not in the select list; that rule is `SELECT
    // DISTINCT`'s, and `DISTINCT ON` only requires the ORDER BY to LEAD with the
    // distinct expressions. Disproved against this repo's Postgres rather than
    // reasoned about, and recorded so the split is not defended by a rule that
    // does not exist.
    `INSERT INTO brain_vocabulary_target (workspace_id, slot_position, norm, effective_target)
     WITH RECURSIVE walk AS (
       SELECT from_norm AS norm, to_norm AS target, 1 AS depth
         FROM brain_vocabulary_edge
        WHERE workspace_id = $1::text AND slot_position = $2::text
       UNION ALL
       SELECT w.norm, e.to_norm, w.depth + 1
         FROM walk w
         JOIN brain_vocabulary_edge e
           ON e.workspace_id = $1::text AND e.slot_position = $2::text AND e.from_norm = w.target
        WHERE w.depth < $3::int
     ),
     roots AS (
       SELECT DISTINCT ON (norm) norm, target, depth
         FROM walk
        ORDER BY norm, depth DESC
     )
     SELECT $1::text, $2::text, norm, target FROM roots`,
    [workspaceId, position, MAX_CHAIN_DEPTH],
  );

  const unconverged = await tx.query(
    `SELECT t.norm, t.effective_target
       FROM brain_vocabulary_target t
       JOIN brain_vocabulary_edge e
         ON e.workspace_id = t.workspace_id
        AND e.slot_position = t.slot_position
        AND e.from_norm = t.effective_target
      WHERE t.workspace_id = $1 AND t.slot_position = $2
      LIMIT 1`,
    [workspaceId, position],
  );
  if (unconverged.rows.length > 0) {
    const row = unconverged.rows[0] as { norm: string; effective_target: string };
    log.error(
      { workspaceId, position, norm: row.norm, effectiveTarget: row.effective_target },
      "Vocabulary closure did not converge — the approved edges are cyclic or deeper than MAX_CHAIN_DEPTH",
    );
    // "Refused", not "rolled back": the rollback is the CALLER's transaction to
    // perform, and this function only guarantees it does not return. The
    // transaction contract above is what makes there be one to roll back.
    throw new VocabularyClosureError(
      `Vocabulary closure did not converge at the ${position} position: "${row.norm}" resolves to ` +
        `"${row.effective_target}", which is itself aliased. The approved edges are cyclic or the ` +
        `chain is deeper than ${MAX_CHAIN_DEPTH}; the rebuild is refused rather than committing a ` +
        "closure that keys claims onto a target nobody approved. Roll back and repair the edges.",
      { position, norm: row.norm, effectiveTarget: row.effective_target },
    );
  }
}

/**
 * Load a workspace's vocabulary as three synchronous lookups.
 *
 * ONE query for all three positions, materialized into maps before any
 * candidate is keyed. That is what lets {@link AliasLookup} stay synchronous —
 * `slotKey` is called per slot per candidate — and it also makes the whole
 * episode read a consistent snapshot rather than reads that could straddle an
 * approval.
 *
 * "One query" is load-bearing, not tidiness. A first cut of the completeness
 * check below issued a SECOND statement to count edges and compared the two —
 * and under READ COMMITTED (and on a pool, where each statement is its own
 * transaction) an ordinary approval committing between them made the counts
 * disagree, so the loader raised a corruption alarm against a healthy store.
 * That is the fix-becomes-the-defect shape: a guard against "a partial closure
 * is silently absorbed" that instead loudly rejected a complete one.
 *
 * A position with no rows gets `identityAlias` itself rather than an
 * empty-map closure. Not an optimization: it means an empty vocabulary and a
 * workspace that has approved nothing are the SAME function, so nothing
 * downstream can start depending on the difference.
 *
 * Reads the closure THROUGH the edges — a single LEFT JOIN driven off
 * `brain_vocabulary_edge`. The closure still supplies every answer:
 * `brain_vocabulary_target` holds the root for each aliased norm, so a lookup is
 * one map hit and can neither walk nor compose at read time. Driving off the
 * edge table costs nothing (`fk_brain_vocabulary_target_edge` makes closure ⊆
 * edges, so the join is total) and buys the completeness check for free, in the
 * same snapshot.
 *
 * Reached in production through {@link loadWorkspaceVocabulary}, which supplies
 * the internal pool — see there for why a pool is the correct executor for a
 * READ when the mutators refuse one.
 *
 * ## A partial closure is refused, not silently absorbed
 *
 * Every approved edge contributes exactly one closure row, so an edge with NO
 * closure row has been left half-rebuilt — by a mutation that ran outside a
 * transaction before the contract above existed, by a restore, or by a
 * hand-written DELETE. That state is the one wrong answer this loader could give
 * without an error to propagate: the norm degrades to itself, which is
 * byte-identical to "approved nothing" and keys the whole episode un-aliased.
 * The empty/absent equivalence below is deliberate; extending it to PARTIAL is a
 * different claim, and not one this module is willing to make.
 *
 * A missing JOIN partner is the check, so it names the offending NORM rather
 * than a count, and cannot fire on a healthy store no matter what commits
 * concurrently — the join and the answer come from one snapshot by construction.
 *
 * ## Errors propagate
 *
 * There is no degraded answer here and no catch. Falling back to
 * `identityVocabulary` when the load fails would key every row of the episode
 * into the slot the vocabulary exists to move it OUT of — an under-match today,
 * an over-match the moment an entry merges two spellings, and neither visible
 * afterwards. `identity.ts`'s "a throwing alias is NOT caught" arm is the same
 * decision one layer up; this is where the throw comes from.
 */
export async function loadClaimVocabulary(
  executor: VocabularyExecutor,
  workspaceId: string,
): Promise<ClaimVocabulary> {
  const { rows } = await executor.query(
    `SELECT e.slot_position, e.from_norm AS norm, t.effective_target
       FROM brain_vocabulary_edge e
       LEFT JOIN brain_vocabulary_target t
         ON t.workspace_id = e.workspace_id
        AND t.slot_position = e.slot_position
        AND t.norm = e.from_norm
      WHERE e.workspace_id = $1`,
    [workspaceId],
  );

  const byPosition = new Map<string, Map<string, string>>();
  for (const raw of rows) {
    const row = raw as {
      slot_position: string;
      norm: string;
      effective_target: string | null;
    };
    if (row.effective_target === null) {
      log.error(
        { workspaceId, position: row.slot_position, norm: row.norm },
        "Vocabulary closure is incomplete — refusing to key an episode against a partial vocabulary",
      );
      throw new VocabularyClosureError(
        `Vocabulary closure is incomplete at the ${row.slot_position} position for workspace ` +
          `${workspaceId}: "${row.norm}" is an approved edge with no closure row. Every approved ` +
          "edge contributes exactly one, so the position was left half-rebuilt. Run " +
          "recomputeEffectiveTargets for it inside a transaction before ingest resumes — keying " +
          "against a partial closure under-matches corpus-wide and is not visible at rest.",
        { position: row.slot_position, norm: row.norm, effectiveTarget: null },
      );
    }
    let entries = byPosition.get(row.slot_position);
    if (entries === undefined) {
      entries = new Map<string, string>();
      byPosition.set(row.slot_position, entries);
    }
    entries.set(row.norm, row.effective_target);
  }

  // Built as a literal rather than filled into `{} as Record<…>`: the cast would
  // assert a complete vocabulary over a transiently empty object, and its
  // soundness would rest on `SLOT_POSITIONS` being exhaustive over
  // `SlotPosition` — true, but nothing checks it. The literal is checked.
  const lookupFor = (position: SlotPosition): AliasLookup => {
    const entries = byPosition.get(position);
    return entries === undefined || entries.size === 0
      ? identityAlias
      : (norm) => entries.get(norm) ?? norm;
  };
  return {
    subject: lookupFor("subject"),
    predicate: lookupFor("predicate"),
    object: lookupFor("object"),
  };
}

/**
 * {@link loadClaimVocabulary} against the internal pool — the call every
 * production consumer makes.
 *
 * Exists so the four sites that used to name `identityVocabulary` (#5023: the
 * extraction pipeline and the three `correctFact` entry points) spell one
 * function rather than each reaching for the pool, and so a fifth consumer has
 * an obvious right answer to copy. The pool is the correct executor here and is
 * NOT a loosening of {@link loadClaimVocabulary}'s contract: reading takes no
 * lock and needs no transaction — only the MUTATORS do, and they refuse a pool
 * outright.
 *
 * The DB import is dynamic for the reason `decide.ts` gives at its own seam: it
 * keeps `db/internal` out of this module's static graph, so a suite that
 * partial-mocks the vocabulary store does not have to re-export the pool
 * machinery it never calls. Everything above this line still has no database
 * dependency at all.
 */
export async function loadWorkspaceVocabulary(workspaceId: string): Promise<ClaimVocabulary> {
  const { getInternalDB } = await import("@atlas/api/lib/db/internal");
  return loadClaimVocabulary(getInternalDB(), workspaceId);
}
