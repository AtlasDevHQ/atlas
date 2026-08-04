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
 * and a two-edge test would be vacuous.
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
 */

import { createLogger } from "@atlas/api/lib/logger";
import {
  identityAlias,
  lexicalNorm,
  SLOT_POSITIONS,
  type AliasLookup,
  type ClaimVocabulary,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";

const log = createLogger("brain-vocabulary");

/**
 * The executor every statement here runs through.
 *
 * Structurally satisfied by a `pg` client, a pool, and a test literal —
 * declared locally rather than imported from `reconcile.ts` so the store has no
 * dependency on the ingest stage. Same shape on purpose: the write primitives
 * are meant to run inside #5023's decide transaction, which is a `reconcile.ts`
 * transaction runner's `tx`.
 */
export interface VocabularyExecutor {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/**
 * Advisory-lock namespace for vocabulary mutation — this issue's number, the
 * convention `RECONCILE_LOCK_NAMESPACE` (4771) set. DISTINCT from reconcile's,
 * so approving an alias does not serialize against ingest, and from the publish
 * gate's for the same reason.
 */
const VOCABULARY_LOCK_NAMESPACE = 5022;

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
const VOCABULARY_LOCK_SQL = `SELECT pg_advisory_xact_lock($1, hashtext($2))`;

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
 */
const MAX_CHAIN_DEPTH = 64;

/** One approved edge, as callers supply it. */
export interface AliasEdgeInput {
  readonly position: SlotPosition;
  /** The norm being aliased away. Re-normed before it is written. */
  readonly fromNorm: string;
  /** The norm it is approved onto. Re-normed before it is written. */
  readonly toNorm: string;
  /** The approver, or `null` for an auto-approved warehouse-derived edge. */
  readonly approvedBy?: string | null;
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
  | {
      readonly ok: false;
      readonly refusal: AliasApprovalRefusal;
      readonly message: string;
      /**
       * For `already-aliased`: the target the norm is currently approved onto.
       * Carried because the only correct repair is to REMOVE that edge first,
       * and a refusal that does not name it makes the operator guess.
       */
      readonly existingTarget?: string;
    };

/**
 * Approve one alias edge, and recompute the position's closure.
 *
 * MUST run inside a transaction — the check-then-insert and the recompute are
 * one atomic decision, and the advisory lock below is a `_xact_` lock that is
 * released at commit. #5023 supplies that transaction from the decide seam.
 *
 * ## Three refusals, and none of them is a rewrite
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

  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);

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
    [workspaceId, position, fromNorm, toNorm, input.approvedBy ?? null],
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
 * be dropped while its closure row exists. That is the point: the FK makes
 * "remove an edge without recomputing" unrepresentable, rather than a caller
 * obligation somebody eventually forgets. {@link recomputeEffectiveTargets}
 * clears the whole position first, so this ordering falls out of calling it.
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
  if (norm === "") return false;

  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);

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
 * parent. That is the definition of "transitive closure" restated as a query,
 * and it fails loudly on both the reachable cause (a cycle that got in behind
 * these primitives) and the unreachable one (a cap set below real depth).
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
  await clearEffectiveTargets(tx, workspaceId, position);

  await tx.query(
    // `roots` is its own CTE rather than a `DISTINCT ON` in the INSERT's own
    // SELECT, because `ORDER BY depth` would then name a column the select list
    // does not carry — which Postgres rejects under DISTINCT. Splitting it also
    // keeps the two constant columns out of the deduplication.
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
    throw new Error(
      `Vocabulary closure did not converge at the ${position} position: "${row.norm}" resolves to ` +
        `"${row.effective_target}", which is itself aliased. The approved edges are cyclic or the ` +
        `chain is deeper than ${MAX_CHAIN_DEPTH}; the transaction is rolled back rather than ` +
        "committing a closure that keys claims onto a target nobody approved.",
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

  const vocabulary = {} as Record<SlotPosition, AliasLookup>;
  for (const position of SLOT_POSITIONS) {
    const entries = byPosition.get(position);
    vocabulary[position] =
      entries === undefined || entries.size === 0
        ? identityAlias
        : (norm) => entries.get(norm) ?? norm;
  }
  return vocabulary;
}
