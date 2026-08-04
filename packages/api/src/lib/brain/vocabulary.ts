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
 * Not the approval flow. #5023 owns the proposal queue, the `decideAmendment`
 * seam these primitives run inside, the auto-approve split (warehouse-derived
 * entity edges may auto-approve; extractor- and seam-proposed edges queue), and
 * #4507's permanent rejection memory. Not the UI (#5025). Not cardinality
 * (#5027) — see {@link recomputeEffectiveTargets} for the room left for it.
 * Not the import-time merge of two workspaces' vocabularies (#5036).
 *
 * ## ⚠️ Not WIRED for reading yet, and that is easy to miss
 *
 * {@link loadClaimVocabulary} has NO production caller. `reconcile.ts` and
 * `correction.ts` take a {@link ClaimVocabulary} and every production call site
 * passes `identityVocabulary`, so no shipped code path consults these tables at
 * read time — the only production WRITER is the region importer
 * (`admin-migrate.ts`). #5023's decide seam is what makes the store readable.
 *
 * Stated because every other doc block around this slice reads as though `alias`
 * consults the closure today, and because it is exactly the line that becomes
 * false at #5023 — which invites its own deletion.
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
 * It is NOT distinct from the publish gate's, because the publish gate takes no
 * advisory lock at all — ADR-0037 §7 says so in as many words, and reserves a
 * separate identity-mutation namespace for the publish-time re-key that does not
 * exist yet. Recorded because an earlier version of this comment claimed a
 * distinction from a lock that has never been written.
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
 * within the lock statement itself and a follow-up query sees nothing. Scoped to
 * `classid = 5022` so a session-level advisory lock held by some other subsystem
 * on the same backend cannot make this pass by accident.
 *
 * Measured against this repo's Postgres: 0 rows on a pool, 1 inside BEGIN.
 */
const VOCABULARY_LOCK_HELD_SQL = `SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND pid = pg_backend_pid()
    AND classid = $1 AND objsubid = 2`;

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
  const held = await tx.query(VOCABULARY_LOCK_HELD_SQL, [VOCABULARY_LOCK_NAMESPACE]);
  if ((held.rows[0] as { n: number }).n === 0) {
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
 * EVEN, and the parity matters. An even-length cycle walked to an even depth
 * lands every node back on ITSELF, so `ck_brain_vocabulary_target_not_self`
 * refuses the closure INSERT before the convergence check can run — measured
 * against this repo's Postgres, not reasoned about. Both abort the transaction,
 * so nothing corrupt commits either way; only the odd-length case reaches the
 * actionable message. Changing this constant to an odd number would move the
 * 2-cycle onto the convergence check and is a behaviour change, not a tuning
 * knob.
 */
const MAX_CHAIN_DEPTH = 64;

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
      readonly refusal: "already-aliased";
      readonly message: string;
      readonly existingTarget: string;
    }
  | {
      readonly ok: false;
      readonly refusal: Exclude<AliasApprovalRefusal, "already-aliased">;
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
  readonly effectiveTarget: string;

  constructor(
    message: string,
    details: { position: SlotPosition; norm: string; effectiveTarget: string },
  ) {
    super(message);
    this.name = "VocabularyClosureError";
    this.position = details.position;
    this.norm = details.norm;
    this.effectiveTarget = details.effectiveTarget;
  }
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
 * At-most-one-parent is enforced twice, deliberately. The primary key is what
 * holds under concurrency; the explicit read is what turns "unique violation on
 * brain_vocabulary_edge_pkey" into a typed refusal naming the existing target.
 * Deleting the explicit check does not make the write succeed — it makes it
 * THROW instead of refusing, which is a different observable outcome and is
 * what `vocabulary-pg.test.ts` asserts on.
 *
 * Cycle refusal has no structural twin: a CHECK cannot read other rows, and the
 * `not_self` CHECK covers only length 1. Longer cycles are caught here by
 * walking up from the proposed PARENT and asking whether the chain reaches the
 * proposed CHILD.
 */
export async function approveAliasEdge(
  tx: VocabularyExecutor,
  workspaceId: string,
  input: AliasEdgeInput,
): Promise<AliasApprovalResult> {
  const { position } = input;
  // Re-normed, never trusted. `alias` composes over `lexicalNorm`, and an
  // approver typing the canonical DISPLAY form (`Priced At`) is the likeliest
  // authoring mistake once this is a reviewed data table — `slotKey` re-norms
  // the ANSWER for the same reason, but a stored non-norm would also make the
  // closure's joins miss, which `slotKey` cannot repair.
  const fromNorm = lexicalNorm(input.fromNorm);
  const toNorm = lexicalNorm(input.toNorm);

  if (fromNorm === "" || toNorm === "") {
    return {
      ok: false,
      refusal: "degenerate-norm",
      message:
        `An alias edge needs two non-empty norms; ` +
        `"${input.fromNorm}" → "${input.toNorm}" normalizes to "${fromNorm}" → "${toNorm}". ` +
        "A surface made only of separators asserts nothing and has no slot to alias.",
    };
  }

  if (fromNorm === toNorm) {
    return {
      ok: false,
      refusal: "self-edge",
      message:
        `"${input.fromNorm}" and "${input.toNorm}" both normalize to "${fromNorm}", so they ` +
        "already share an identity key and there is nothing to alias.",
    };
  }

  await lockWorkspaceVocabulary(tx, workspaceId, "approveAliasEdge");

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
    // NOT collapsed into the "no such edge" answer without a word. The same
    // input gets a typed `degenerate-norm` refusal on the approve side, and
    // returning a bare `false` here would have #5025's UI tell the operator
    // "nothing was aliased" for what is actually a malformed request.
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
 * approved edges. Returns the number of closure rows written.
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
 * It fails loudly on an ODD-length cycle and on a cap set below real depth. An
 * EVEN-length cycle never reaches it: at an even cap every node lands back on
 * itself and `ck_brain_vocabulary_target_not_self` refuses the INSERT first. Both
 * abort the transaction, so no wrong closure commits either way — but only one
 * carries an actionable message, and {@link MAX_CHAIN_DEPTH}'s parity is what
 * decides which. Measured against this repo's Postgres.
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
): Promise<number> {
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

  const written = await tx.query(
    `SELECT count(*)::int AS n FROM brain_vocabulary_target
      WHERE workspace_id = $1 AND slot_position = $2`,
    [workspaceId, position],
  );
  return (written.rows[0] as { n: number }).n;
}

/**
 * Load a workspace's vocabulary as three synchronous lookups.
 *
 * ONE query for all three positions, materialized into maps before any
 * candidate is keyed. That is what lets {@link AliasLookup} stay synchronous —
 * `slotKey` is called per slot per candidate — and it also makes the whole
 * episode read a consistent snapshot rather than three reads that could
 * straddle an approval.
 *
 * A position with no rows gets `identityAlias` itself rather than an
 * empty-map closure. Not an optimization: it means an empty vocabulary and a
 * workspace that has approved nothing are the SAME function, so nothing
 * downstream can start depending on the difference.
 *
 * Reads the closure, never the edges. `brain_vocabulary_target` already holds
 * the root for each aliased norm, so a lookup is one map hit and can neither
 * walk nor compose at read time — the composition happened once, at approval.
 *
 * ⚠️ NO PRODUCTION CALLER yet. Every shipped path resolves to
 * `identityVocabulary`; #5023's decide seam is what puts a real vocabulary in
 * front of ingest. Until then this is exercised only by `vocabulary-pg.test.ts`.
 *
 * ## A partial closure is refused, not silently absorbed
 *
 * Every approved edge contributes exactly one closure row, so a position whose
 * closure is SMALLER than its edge set has been left half-rebuilt — by a
 * mutation that ran outside a transaction before the contract above existed, by
 * a restore, or by a hand-written DELETE. That state is the one wrong answer
 * this loader could give without an error to propagate: too few rows and the
 * position degrades to `identityAlias`, which is byte-identical to "approved
 * nothing" and keys the whole episode un-aliased. The empty/absent equivalence
 * below is deliberate; extending it to PARTIAL is a different claim, and not
 * one this module is willing to make.
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
    `SELECT slot_position, norm, effective_target
       FROM brain_vocabulary_target
      WHERE workspace_id = $1`,
    [workspaceId],
  );

  const byPosition = new Map<string, Map<string, string>>();
  for (const raw of rows) {
    const row = raw as { slot_position: string; norm: string; effective_target: string };
    let entries = byPosition.get(row.slot_position);
    if (entries === undefined) {
      entries = new Map<string, string>();
      byPosition.set(row.slot_position, entries);
    }
    entries.set(row.norm, row.effective_target);
  }

  const edgeCounts = await executor.query(
    `SELECT slot_position, count(*)::int AS n FROM brain_vocabulary_edge
      WHERE workspace_id = $1 GROUP BY slot_position`,
    [workspaceId],
  );
  for (const raw of edgeCounts.rows) {
    const counted = raw as { slot_position: string; n: number };
    const have = byPosition.get(counted.slot_position)?.size ?? 0;
    if (have !== counted.n) {
      log.error(
        { workspaceId, position: counted.slot_position, edges: counted.n, closureRows: have },
        "Vocabulary closure is incomplete — refusing to key an episode against a partial vocabulary",
      );
      throw new Error(
        `Vocabulary closure is incomplete at the ${counted.slot_position} position for workspace ` +
          `${workspaceId}: ${counted.n} approved edges, ${have} closure rows. Every approved edge ` +
          "contributes exactly one closure row, so the position was left half-rebuilt. Run " +
          "recomputeEffectiveTargets for it inside a transaction before ingest resumes — keying " +
          "against a partial closure under-matches corpus-wide and is not visible at rest.",
      );
    }
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
