/**
 * Cardinality as a property of the canonical predicate — the store, the
 * write-path allowlist, and the one live read (#5027, ADR-0037 §3, migration
 * 0192).
 *
 * ## What this replaces
 *
 * `brain_facts.predicate_cardinality` was believed unpopulated. It was not:
 * `extract.ts` wrote the MODEL's per-claim guess and `correction.ts` inherited
 * it onto every replacement. The publish gate's collision rule then required
 * `'single'` on BOTH sides, and the two sides came from two INDEPENDENT model
 * calls on two different messages, against a prompt that says *"When unsure
 * answer 'multi'"*. Supersession therefore fired at roughly
 * P(model says `single`)².
 *
 * An unpopulated column fails predictably. That one failed **stochastically, on
 * an irreversible operation** — a `valid_to` stamp no verb restores. The fourth
 * independent cause of #5000's symptom, and the only one that is not a
 * string-matching problem.
 *
 * ## The both-sides clause is not fixed; it is deleted
 *
 * `p.predicate_cardinality = 'single' AND d.predicate_cardinality = 'single'`
 * collapses to {@link cardinalitySingleSql} — ONE lookup on the shared
 * `predicate_key`. The collision predicate already requires
 * `p.predicate_key = d.predicate_key` and `p.workspace_id = d.workspace_id`, so
 * a single EXISTS against the draft side answers for both. Two rows in one slot
 * can no longer disagree, because they no longer each carry an opinion. The
 * cause is made **unrepresentable**, not merely repaired.
 *
 * ## `single` requires positive evidence
 *
 * Absent → `multi`. Ambiguity → `multi`. There is no backfill and there must
 * never be one: an UNCURATED predicate never supersedes, which is today's
 * conservative behaviour made deterministic. A predicate whose cardinality
 * depends on the subject's type (`located in` — one HQ, many offices) is simply
 * never marked `single`, so it never has to be adjudicated at all.
 *
 * **We under-supersede deterministically rather than supersede stochastically.**
 * The accepted cost, stated rather than discovered: `single` will be rare and
 * slow to accumulate, so supersession stays mostly unfired for a long time.
 *
 * ## Three sources, and this slice ships exactly one PRODUCER
 *
 * {@link CARDINALITY_SOURCE_CLASSES} is the allowlist — a fourth producer must
 * earn its arm in a migration rather than inherit one.
 *
 * Enforced by the CHECK, and by the TS tuple at compile time. NOT by a runtime
 * refusal: unlike `cardinality`, an out-of-vocabulary `source_class` arriving
 * through a cast reaches the INSERT and comes back as a thrown `23514`. Stated
 * rather than fixed, because the tuple has no untyped producer today — #5042 and
 * #5025 are both TS call sites — and a refusal arm nothing can reach is one more
 * spelling of this vocabulary to keep in step with the tuple and the CHECK.
 * Revisit if a source class ever arrives from a request body. The three
 * sources:
 *
 *   1. `warehouse_structural` — a dimension of one row is `single` BY
 *      CONSTRUCTION (ADR-0037 §3(d)1). Authoritative, not a hint. Its producer
 *      is #5042 (M5) and does not exist yet; the arm is declared here so that
 *      producer lands on a door rather than cutting one.
 *   2. `correction_event` — a human superseding a slot has asserted BY THEIR
 *      ACTION that it holds one value (§3(d)2). Repeat-gated.
 *      **This is the source #5027 implements**, and it PROPOSES: it may only
 *      ever write `pending`. See {@link proposeFromCorrectionEvents}.
 *   3. `human` — direct authoring at the vocabulary's gate (§3(d)3). Writes
 *      `approved` directly, because the human IS the approval. #5025 owns its
 *      UI; the primitive is here so this slice's own falsification tests can
 *      stand up an approved entry through the shipped door rather than a raw
 *      INSERT.
 *
 * ## Why the producer path may not write `approved`, and why it may not write
 * ## `multi` either
 *
 * A `single` entry is **retroactively destructive**: flipping `reports to` makes
 * every existing published pair in that slot supersedable at the NEXT publish,
 * with no per-row record of the regime the fact was written under (ADR-0037 §6,
 * widened by §3 from *newly-colliding* to *newly-supersedable*). So no producer
 * decides it. Auto-approve is also structurally unavailable: §6 reaches it only
 * at an ENTITY position, and a predicate is not one.
 *
 * A producer proposing `multi` is refused for a different reason — it asserts
 * NOTHING (absent already means `multi`) while OCCUPYING the predicate's only
 * slot, which would block the `single` proposal that does carry information. A
 * stored `multi` is meaningful only from a human: it records the question being
 * declined, which is what stops a producer re-proposing it.
 *
 * ## No advisory lock, and that is structural rather than an omission
 *
 * Every `vocabulary.ts` primitive is a check-then-write or a
 * clear-then-rebuild, atomic only inside a transaction — which is why that
 * module REFUSES to run outside one. Nothing here has that shape: every write
 * below is a single-row `INSERT … ON CONFLICT`, atomic on its own, with no
 * derived relation to rebuild. Taking 0189's namespace anyway would buy nothing
 * and would add a second lock-order edge reaching into `correction.ts`, where
 * the proposer runs.
 *
 * ## What this module is NOT
 *
 * Not the approval UI (#5025). Not the warehouse producer (#5042). Not the drop
 * of `brain_facts.predicate_cardinality` (#5028) — that column is `NOT NULL`
 * with a live CHECK, so this slice stops reading and writing it and the drop is
 * one release later, per `db/migrations/README.md`'s two-phase discipline.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { comparableDifferentSql } from "@atlas/api/lib/brain/object-cmp";
import { HUMAN_SOURCE } from "@atlas/api/lib/brain/sources";
import type { ReconcileExecutor } from "@atlas/api/lib/brain/reconcile";
import type { PredicateCardinality } from "@atlas/api/lib/brain/types";

const log = createLogger("brain-cardinality");

/**
 * The executor every statement here runs through — structurally satisfied by a
 * `pg` client, a pool, and a test literal, on {@link
 * "@atlas/api/lib/brain/vocabulary".VocabularyExecutor}'s precedent.
 *
 * Declared locally rather than imported so this module's public surface names
 * no vocabulary type: a caller of the cardinality store should not have to
 * reason about the alias closure to satisfy it. A `reconcile.ts` `tx` must
 * always satisfy this one, because `correction.ts` hands this module the same
 * `tx` it hands `reconcileFacts` — that direction is pinned below. The reverse
 * is neither needed nor checked.
 */
export interface CardinalityExecutor {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>;
}

/**
 * Compile-time pin: a `reconcile.ts` `tx` must satisfy this module's executor.
 *
 * The same three lines `vocabulary.ts` carries, and for the same reason — the
 * interchangeability above is a stated invariant, and `correction.ts` hands
 * this module the transaction runner's `tx`. Costs a TYPE-ONLY import, which is
 * erased, so nothing about the runtime layering changes.
 */
type _ReconcileExecutorIsACardinalityExecutor =
  ReconcileExecutor extends CardinalityExecutor ? true : never;
const _executorsInterchangeable: _ReconcileExecutorIsACardinalityExecutor = true;
void _executorsInterchangeable;

/** ADR-0037 §3(d)'s three sources, in the order the ADR names them. */
export const CARDINALITY_SOURCE_CLASSES = [
  "warehouse_structural",
  "correction_event",
  "human",
] as const;
export type CardinalitySourceClass = (typeof CARDINALITY_SOURCE_CLASSES)[number];

/**
 * The sources that PROPOSE rather than decide.
 *
 * Derived from the tuple above by exclusion rather than listed, so a fourth
 * source added to {@link CARDINALITY_SOURCE_CLASSES} is a producer by default
 * and has to be exempted deliberately. The failure directions are asymmetric: a
 * new producer wrongly admitted to the decide path writes `approved` and stamps
 * `valid_to` on beliefs no human retired, where a new one wrongly held to the
 * propose path merely waits for a review.
 */
export type CardinalityProposerClass = Exclude<CardinalitySourceClass, "human">;

export const CARDINALITY_STATUSES = ["pending", "approved", "rejected"] as const;
export type CardinalityStatus = (typeof CARDINALITY_STATUSES)[number];

/**
 * One workspace's entry for one canonical predicate.
 *
 * ⚠️ **It does NOT carry the predicate key, and that is a prohibition rather
 * than an omission.** The caller supplied the key to look the row up, so
 * returning it is redundant — and `keys-not-on-the-wire.test.ts` scans for
 * exactly this shape, because a fact-shaped TYPE that grows a key field is one
 * `c.json(record)` away from putting a canonical predicate key on the wire.
 * A consumer that can branch on a key is what makes an alias un-removable
 * (ADR-0037 §6), and #5025's review UI is the consumer this record exists for.
 * Render the SURFACE.
 */
export interface PredicateCardinalityRecord {
  readonly cardinality: PredicateCardinality;
  readonly status: CardinalityStatus;
  readonly sourceClass: CardinalitySourceClass;
  readonly proposedBy: string;
}

/** Why a write was refused. Every arm is a REFUSAL, never a silent no-op. */
export type CardinalityRefusal =
  /** The caller supplied no usable canonical predicate. */
  | "degenerate-key"
  /** A producer proposed `multi`, which asserts nothing and occupies the slot. */
  | "producer-proposed-multi"
  /**
   * The write named no author.
   *
   * A separate arm rather than a silent default, because `proposed_by` is what
   * an audit of a retroactive re-key reads first (migration 0192) and
   * {@link CardinalityDeclarationInput.authoredBy} says the human path's entire
   * authority is that a person took it. An unattributed row is not that.
   */
  | "unattributed"
  /** The predicate already has an entry — pending, approved, or rejected. */
  | "already-decided";

export type CardinalityWriteResult =
  /**
   * No `predicateKey` on the success arm, for
   * {@link PredicateCardinalityRecord}'s reason: the caller passed it in, so
   * echoing it back is redundant, and a result shape that carries a canonical
   * predicate key is one `c.json(result)` away from putting it on the wire.
   */
  | { readonly ok: true; readonly cardinality: PredicateCardinality }
  | { readonly ok: false; readonly refusal: CardinalityRefusal; readonly message: string };

// ---------------------------------------------------------------------------
// The one live read
// ---------------------------------------------------------------------------

/**
 * **The single load-bearing consumer's arm** — *this fact's canonical predicate
 * is declared `single`*.
 *
 * Read LIVE rather than materialized onto the row, and ADR-0037 §3 §2 gives
 * three reasons that are worth keeping beside the code that depends on them:
 *
 *   - **T2's materialize-at-write rule was protecting a SEAM** — two consumers
 *     disagreeing about what collides. There is one consumer, so there is no
 *     seam.
 *   - **Materializing reproduces the bug being fixed.** A row written before the
 *     entry would carry `multi` and one written after `single`; the both-sides
 *     clause fails, and supersession silently does not fire. The repair would be
 *     a re-keying `UPDATE` on every cardinality change — a cost incurred ONLY
 *     because we materialized.
 *   - **The index cost is nil.** A `(workspace_id, subject_key, predicate_key)`
 *     slot holds a handful of live rows, so this is a filter over a tiny set and
 *     never a seek — the same argument that made three-valued agreement free.
 *
 * **Counter-case declined, recorded rather than re-argued:** materializing would
 * preserve an audit trail — *"what could this fact have superseded, at the
 * time?"* is unanswerable under live reads. Judged not worth reintroducing the
 * disagreement it costs.
 *
 * ## One lookup, and why one side is enough
 *
 * The caller's predicate already carries `p.predicate_key = d.predicate_key` and
 * `p.workspace_id = d.workspace_id`, so an EXISTS against EITHER alias answers
 * for both. That is the whole point: the two sides cannot disagree because there
 * is one row to disagree with.
 *
 * ⚠️ It follows that this builder is only correct inside a predicate that
 * already equates the two sides' keys. Used anywhere the two rows are not known
 * to share a slot, it silently answers about one of them.
 *
 * `status = 'approved'` is not optional decoration. `correction_event` writes
 * `pending`, and a pending row is a PROPOSAL — reading it here would let a
 * repeat-gated heuristic stamp `valid_to` with no human anywhere in the loop,
 * which is the whole thing §3(d) exists to prevent.
 *
 * A NULL `predicate_key` (a surface that norms away — permanent and legal, per
 * `identityKey`'s ⚠️) matches no row, so such a fact never supersedes. That is
 * the fail-closed direction and the same one the identity arms already take.
 *
 * `alias` is interpolated; callers pass a plain identifier they control — the
 * same contract as `brainFactStatusClause` and `comparableDifferentSql`.
 */
export function cardinalitySingleSql(alias: string): string {
  return `EXISTS (
       SELECT 1 FROM brain_predicate_cardinality c
        WHERE c.workspace_id = ${alias}.workspace_id
          AND c.predicate_key = ${alias}.predicate_key
          AND c.cardinality = 'single'
          AND c.status = 'approved')`;
}

/**
 * One predicate's entry, or `null`.
 *
 * ⚠️ `null` means ABSENT-**or-unreadable**, never "readable and `multi`". Two
 * drift arms below also answer `null` — a row this module cannot narrow, and a
 * row with no usable author. Both warn; the second's warning is about the
 * PUBLISH GATE rather than about this reader, and that is what makes it the
 * dangerous one: `cardinalitySingleSql` never consults `proposed_by`, so such a
 * row can still stamp `valid_to` while this reports no entry. A caller that
 * reads `null` as *uncurated* is making the exact inference it exists to
 * prevent.
 *
 * For DISPLAY and for a proposer's own pre-check. The publish gate does not call
 * it — it reads {@link cardinalitySingleSql} inside its own statement, because a
 * separate round trip would be a second spelling of "what collides".
 */
export async function readPredicateCardinality(
  executor: CardinalityExecutor,
  workspaceId: string,
  predicateKey: string,
): Promise<PredicateCardinalityRecord | null> {
  const { rows } = await executor.query(
    `SELECT cardinality, status, source_class, proposed_by
       FROM brain_predicate_cardinality
      WHERE workspace_id = $1 AND predicate_key = $2`,
    [workspaceId, predicateKey],
  );
  // Guarded on the VALUE, never cast. `CardinalityExecutor` is satisfied by a
  // test literal BY DESIGN — that is what lets the mutators take a `tx` and this
  // reader take a pool — so nothing in the type stops `{ rows: [{}] }` or
  // `{ rows: [null] }` reaching here, and the two go wrong differently. A bare
  // `rows[0] as Record<…>` passes `=== undefined` on the NULL row and then
  // throws a raw TypeError on the first field read — from the one function
  // whose job is legibility. And the shorter cast a reader is likelier to
  // write, `rows[0] as PredicateCardinalityRecord`, skips the per-field
  // narrowers below entirely and hands back a record whose `readonly
  // cardinality` is `undefined`: the type's own invariant violated at its
  // single construction point.
  const first = rows[0];
  const row: Record<string, unknown> | undefined =
    typeof first === "object" && first !== null ? (first as Record<string, unknown>) : undefined;
  if (row === undefined) {
    if (rows.length > 0) {
      log.warn(
        { workspaceId, predicateKey, row: typeof first },
        "brain cardinality: the entry read returned a row this module cannot narrow — reading it as ABSENT; the projection drifted",
      );
    }
    return null;
  }
  if (typeof row.proposed_by !== "string" || row.proposed_by === "") {
    log.warn(
      { workspaceId, predicateKey, proposedBy: row.proposed_by },
      // Says what THIS reader does, not what the publish gate does.
      // `cardinalitySingleSql` filters on `cardinality` and `status` and never
      // reads `proposed_by`, so an approved `single` row with no author still
      // stamps `valid_to` while this answers ABSENT — the
      // disclosure-lists-one-set-while-the-transaction-stamps-another hazard,
      // arriving from the reader side. Both write paths refuse an empty author
      // and 0192 CHECKs it, so reaching this arm means a row was written around
      // all three.
      "brain cardinality: entry has no usable author — this reader answers ABSENT, but the publish gate does NOT consult `proposed_by`, so an approved `single` row can still supersede while a reviewer sees no entry. Repair the row",
    );
    return null;
  }
  return {
    // Narrowed against the CHECK's own vocabulary rather than cast. The CHECK
    // makes an out-of-vocabulary value unreachable from the database, so a
    // mismatch here is query drift — reported for `narrowStatus`'s reason
    // rather than silently taken, because the conservative arm and the drifted
    // one are the same value and nothing else would ever say so.
    cardinality: narrowCardinality(row.cardinality, { workspaceId, predicateKey }),
    status: narrowStatus(row.status, { workspaceId, predicateKey }),
    sourceClass: narrowSourceClass(row.source_class, { workspaceId, predicateKey }),
    proposedBy: row.proposed_by,
  };
}

function narrowCardinality(
  raw: unknown,
  meta: { workspaceId: string; predicateKey: string },
): PredicateCardinality {
  if (raw === "single" || raw === "multi") return raw;
  log.warn(
    { ...meta, cardinality: raw },
    "brain cardinality: entry carries a cardinality outside the vocabulary — reading it as `multi`, which never supersedes",
  );
  return "multi";
}

function narrowStatus(
  raw: unknown,
  meta: { workspaceId: string; predicateKey: string },
): CardinalityStatus {
  if (typeof raw === "string" && (CARDINALITY_STATUSES as readonly string[]).includes(raw)) {
    return raw as CardinalityStatus;
  }
  // `pending`, NOT `rejected`, and this is the same correction `narrowSourceClass`
  // below already carries. `rejected` reads to #5025's reviewer as "a human
  // adjudicated this predicate and declined" — authority nobody exercised — and
  // it drops the row out of the queue that would resolve it. `pending` is the
  // least authoritative value: nobody has decided.
  //
  // Neither arm risks a stamp, and the earlier justification ("neither
  // supersedes nor re-proposes") was not this function's to make: supersession
  // is decided by `cardinalitySingleSql`, which never calls this reader, and
  // re-proposal is stopped by the primary key's `ON CONFLICT DO NOTHING`.
  log.warn(
    { ...meta, status: raw },
    "brain cardinality: entry carries a status outside the vocabulary — reading it as `pending`, so a reviewer is never told a decision was made that nobody made",
  );
  return "pending";
}

function narrowSourceClass(
  raw: unknown,
  meta: { workspaceId: string; predicateKey: string },
): CardinalitySourceClass {
  if (typeof raw === "string" && (CARDINALITY_SOURCE_CLASSES as readonly string[]).includes(raw)) {
    return raw as CardinalitySourceClass;
  }
  // `correction_event`, NOT `human`, and the difference is which way the label
  // is allowed to be wrong. An earlier cut chose `human` as "the class with no
  // automated re-proposal path" — but nothing about the CLASS provides that
  // property; the primary key does, through `ON CONFLICT DO NOTHING`. What
  // `human` DOES do is tell #5025's reviewer that a person authored a row a
  // machine wrote, on the screen where they decide whether to approve a flag
  // whose blast radius is retroactive and irreversible. Inflating apparent
  // authority is the one direction a drifted label must not fail in.
  log.warn(
    { ...meta, sourceClass: raw },
    "brain cardinality: entry carries a source class outside the allowlist — reading it as `correction_event`, the least authoritative class, so a reviewer is never told a machine-written row was human-authored",
  );
  return "correction_event";
}

// ---------------------------------------------------------------------------
// The write-path allowlist
// ---------------------------------------------------------------------------

/** {@link proposePredicateCardinality}'s inputs. */
export interface CardinalityProposalInput {
  /** `slotKey(surface, vocabulary.predicate)` — never a hand-normalized string. */
  readonly predicateKey: string | null;
  /**
   * `"single"`, and the type says so rather than the runtime alone.
   *
   * A producer proposing `multi` asserts NOTHING — absent already means `multi`
   * — while occupying the predicate's only slot, so it blocks the `single`
   * proposal that carries information. {@link proposePredicateCardinality}
   * still refuses it at runtime, because the CHECK's allowlist has to hold for
   * a caller that reaches this through a cast or from untyped data; narrowing
   * here makes the refusal unreachable from every ordinary TS caller instead of
   * merely refused after the fact.
   */
  readonly cardinality: "single";
  readonly sourceClass: CardinalityProposerClass;
  /** The producer id. */
  readonly proposedBy: string;
}

/**
 * A PRODUCER's proposal — writes `pending`, never `approved`.
 *
 * Idempotent by the primary key: `ON CONFLICT DO NOTHING` makes a re-run a
 * no-op, which is what lets the correction-event proposer run on every
 * supersede without a check-then-write and therefore without a lock. The same
 * clause is the **rejection memory** — a `rejected` row occupies the predicate's
 * only slot, so a producer cannot re-propose what a human declined, and the
 * refusal is structural rather than a race between a SELECT and an INSERT
 * (#4507, on 0190's terms).
 *
 * `RETURNING 1` is how the caller learns whether the row was new — a suppressed
 * conflict returns no row — and the two outcomes are reported differently
 * because "a proposal was raised" is a thing to log once and "the predicate was
 * already decided" is not a thing to log at all. It returns a LITERAL rather
 * than the key it just wrote: `keys-not-on-the-wire.test.ts` reads RETURNING
 * lists, and the caller already holds the key it passed in.
 */
export async function proposePredicateCardinality(
  executor: CardinalityExecutor,
  workspaceId: string,
  input: CardinalityProposalInput,
): Promise<CardinalityWriteResult> {
  const { predicateKey } = input;
  if (predicateKey === null || predicateKey === "") {
    return {
      ok: false,
      refusal: "degenerate-key",
      message:
        "A cardinality entry needs a canonical predicate, and this surface normalizes away to nothing. " +
        "Such a claim has no slot, so there is no population an entry could describe — and an entry " +
        "written under an empty key would describe EVERY degenerate predicate in the workspace at once.",
    };
  }
  if (input.proposedBy === "") return unattributed(predicateKey);
  // `CardinalityProposalInput` narrows this to `"single"`, so the branch is dead
  // for a typed caller — that IS the guarantee. The `as string` buys legibility
  // rather than compilability (`!== "single"` against a `"single"` type compiles
  // clean; only a comparison with NO overlap is an error): it says out loud that
  // this arm serves untyped callers, and keeps the block from narrowing to
  // `never` for the next reader. It is not dead for a caller that
  // arrived through a cast, `JSON.parse`, or a producer's config, and those
  // yield ARBITRARY strings: `!==` rather than `=== "multi"` is what keeps
  // `"Multi"`, `"sometimes"`, `"SINGLE"` and `""` inside the refusal contract
  // instead of letting them reach the INSERT and return as a thrown 23514 from
  // `ck_brain_predicate_cardinality_value`. `cardinality.test.ts` drives those
  // four, because a fixture of `"multi"` alone is refused by the OLD predicate
  // too and cannot falsify the widening.
  if ((input.cardinality as string) !== "single") {
    return {
      ok: false,
      refusal: "producer-proposed-multi",
      message:
        `A producer may propose only \`single\` for "${predicateKey}", and this asked for ` +
        `\`${String(input.cardinality)}\`. Absent from this table already MEANS ` +
        "`multi`, so the row asserts nothing while occupying the predicate's only slot — blocking the " +
        "`single` proposal that would carry information. A stored `multi` is a human declining the " +
        "question, and only direct authoring may record it.",
    };
  }

  const { rows } = await executor.query(
    `INSERT INTO brain_predicate_cardinality
       (workspace_id, predicate_key, cardinality, status, source_class, proposed_by)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     ON CONFLICT (workspace_id, predicate_key) DO NOTHING
     RETURNING 1 AS inserted`,
    [workspaceId, predicateKey, input.cardinality, input.sourceClass, input.proposedBy],
  );
  if (rows.length === 0) {
    return {
      ok: false,
      refusal: "already-decided",
      message:
        `"${predicateKey}" already has a cardinality entry in this workspace — pending, approved, or ` +
        "rejected. A producer never overwrites one: a rejected entry is a human's decision that this " +
        "predicate is not single-valued, and re-proposing over it is exactly what the rejection memory " +
        "exists to stop.",
    };
  }
  return { ok: true, cardinality: input.cardinality };
}

/**
 * The shared refusal for a write that named no author.
 *
 * One spelling, two callers, because the two paths differ only in which field
 * was empty and the operator-facing consequence is identical — a row that
 * licenses (or proposes) an irreversible, retroactive change with nobody
 * recorded as having asked for it.
 */
function unattributed(predicateKey: string): CardinalityWriteResult {
  return {
    ok: false,
    refusal: "unattributed",
    message:
      `A cardinality entry for "${predicateKey}" needs an author. \`proposed_by\` is the first column ` +
      "an audit of a retroactive re-key reads, and a `single` entry makes every existing published pair " +
      "in that slot supersedable at the next publish — a change nobody can be shown to have asked for is " +
      "not one this store will record. Pass a user id, a producer id, or `local-operator`.",
  };
}

/** {@link declarePredicateCardinality}'s inputs. */
export interface CardinalityDeclarationInput {
  readonly predicateKey: string | null;
  readonly cardinality: PredicateCardinality;
  /**
   * The authoring human — a user id, or `local-operator` on a no-auth
   * deployment. Required and non-null: this path's entire authority is that a
   * person took it, so an unattributed declaration is not one.
   */
  readonly authoredBy: string;
}

/**
 * DIRECT HUMAN AUTHORING (ADR-0037 §3(d)3) — writes `approved` in one step,
 * because the human IS the approval.
 *
 * `ON CONFLICT DO UPDATE`, unlike {@link proposePredicateCardinality}'s
 * `DO NOTHING`, and the asymmetry is the authority posture rather than an
 * inconsistency: rejection memory binds PRODUCERS, and a human overriding their
 * own workspace's earlier decision is the thing the gate is for. A human may
 * therefore also write `multi` — the adjudicated record that values coexist,
 * and the only way to take a predicate back out of `single` short of deletion.
 *
 * ⚠️ **The blast radius is retroactive and is disclosed BEFORE approval, not
 * here.** Flipping a predicate to `single` makes every existing published pair
 * in that slot supersedable at the NEXT publish, with no per-row record of the
 * regime each fact was written under. #5025's preview owns showing it — widened
 * by ADR-0037 §3 from *newly-colliding* to *newly-supersedable*, the strictly
 * larger and more dangerous set. This primitive is the write that preview
 * describes; it is not a substitute for it.
 *
 * Entitlement is the CALLER's to enforce — §6's owner/admin gate lives at the
 * route, beside every other entitlement decision, rather than being re-derived
 * by a store primitive that has no request context.
 */
export async function declarePredicateCardinality(
  executor: CardinalityExecutor,
  workspaceId: string,
  input: CardinalityDeclarationInput,
): Promise<CardinalityWriteResult> {
  const { predicateKey } = input;
  if (predicateKey === null || predicateKey === "") {
    return {
      ok: false,
      refusal: "degenerate-key",
      message:
        "A cardinality entry needs a canonical predicate, and this surface normalizes away to nothing. " +
        "There is no slot to describe, and an entry under an empty key would describe every degenerate " +
        "predicate in the workspace at once.",
    };
  }
  if (input.authoredBy === "") return unattributed(predicateKey);

  await executor.query(
    `INSERT INTO brain_predicate_cardinality
       (workspace_id, predicate_key, cardinality, status, source_class, proposed_by,
        reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, 'approved', 'human', $4, $4, now())
     ON CONFLICT (workspace_id, predicate_key) DO UPDATE
        SET cardinality = EXCLUDED.cardinality,
            status = 'approved',
            source_class = 'human',
            -- Overwritten with the author, NOT left as the producer's id. This
            -- path authors OVER a pending proposal, so without it the row
            -- commits saying source_class = human beside a proposed_by naming
            -- the correction-event producer -- a pair 0192's own column comment
            -- makes self-contradictory ("the producer id, OR the human who
            -- authored the row directly"), and the one an audit of a
            -- retroactive re-key reads first.
            proposed_by = EXCLUDED.proposed_by,
            reviewed_by = EXCLUDED.reviewed_by,
            reviewed_at = now()`,
    [workspaceId, predicateKey, input.cardinality, input.authoredBy],
  );
  log.info(
    { workspaceId, predicateKey, cardinality: input.cardinality, authoredBy: input.authoredBy },
    "brain cardinality: a human declared a canonical predicate's cardinality — `single` makes every existing published pair in that slot supersedable at the next publish",
  );
  return { ok: true, cardinality: input.cardinality };
}

/**
 * Decide a producer's pending proposal.
 *
 * The library half of #5025's review action, shipped here rather than left to
 * that slice so the proposer this PR adds lands on a complete
 * propose → decide → read path instead of writing rows nothing can resolve.
 * #5022 shipped a store whose reader had no caller and had to say so at length;
 * a warning that has come true is not a warning.
 *
 * `WHERE status = 'pending'` makes the statement correct on its own terms: two
 * reviewers racing one proposal produce one decision and one no-op, without a
 * lock, because the second UPDATE matches zero rows against the committed row
 * version. Returns whether a row moved.
 *
 * A rejection is NOT a delete. The row stays, occupying the predicate's only
 * slot, and that is the rejection memory — deleting it would readmit the
 * producer's next run.
 */
export async function decidePredicateCardinality(
  executor: CardinalityExecutor,
  workspaceId: string,
  predicateKey: string,
  verdict: Exclude<CardinalityStatus, "pending">,
  reviewedBy: string | null,
): Promise<boolean> {
  const { rows } = await executor.query(
    `UPDATE brain_predicate_cardinality
        SET status = $3, reviewed_by = $4, reviewed_at = now()
      WHERE workspace_id = $1 AND predicate_key = $2 AND status = 'pending'
      RETURNING 1 AS decided`,
    [workspaceId, predicateKey, verdict, reviewedBy],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Source 2 — the repeat-gated correction-event proposer
// ---------------------------------------------------------------------------

/**
 * How many DISTINCT subjects must have been corrected at a predicate before a
 * `single` proposal is raised.
 *
 * Distinct SUBJECTS, not corrections — see {@link CORRECTION_REPEAT_COUNT_SQL},
 * where the choice is load-bearing. Three rather than two because the evidence
 * is circumstantial and the proposal it raises is a claim about the whole
 * predicate: one subject is an anecdote, two is a coincidence a single confused
 * reviewer can produce in an afternoon.
 *
 * A PROPOSAL threshold, never an approval one. Getting it wrong costs a human a
 * queue entry to reject, or costs the workspace a `single` entry it has to
 * author by hand — never a `valid_to` stamp.
 */
export const CORRECTION_REPEAT_THRESHOLD = 3;

/** The producer id recorded on rows this proposer writes. */
export const CORRECTION_EVENT_PRODUCER = "brain:correction-event-cardinality";

/**
 * The repeat gate: how many DISTINCT subjects a human has superseded at this
 * canonical predicate, counting only supersessions whose replacement is
 * PROVABLY different from what it replaced.
 *
 * ## Why DISTINCT subjects rather than corrections
 *
 * A correction event is evidence about a PREDICATE, and only variety across
 * subjects makes it that. A reviewer editing one slot four times has told us
 * something about that slot — most likely that they were fixing their own
 * typing — and nothing whatever about whether `reports to` is single-valued.
 * Counting corrections would make the loudest evidence the least informative
 * kind; counting subjects makes a typo dance in one slot count exactly once,
 * which is the direction the known weak point below needs.
 *
 * ## The provable-difference arm, and the weak point it does NOT close
 *
 * ADR-0037 §3(d) carries the risk in as many words: *a reviewer fixing a typo
 * (`Bob` → `Bobby`) is not asserting single-valuedness, and a repeat gate does
 * not distinguish a typo pattern from a replacement pattern.* It is carried as
 * a falsification target rather than designed away, so this is what the target
 * is measured against rather than a claim to have solved it.
 *
 * {@link comparableDifferentSql} (#5030) requires both sides non-null, the same
 * tag, and unequal. An entity-valued object is `entity:<id>` only when a store
 * resolved it, and there is no store — so `Bob` and `Bobby` are both NULL, the
 * arm is false, and the pair does not count. The same arm also excludes
 * `Bob` → `Carol`, a GENUINE replacement, and that under-count is accepted for
 * the reason the whole slice is built on: an entity-valued object cannot
 * supersede at the publish gate either (ADR-0037 §2), so a `single` entry
 * proposed from such evidence would authorize nothing. The gate is aligned with
 * what supersession can actually act on.
 *
 * **What survives, stated plainly:** a fat-finger on a COMPARABLE object —
 * `499` → `4999` — is provably different and does count. Three such slips
 * across three subjects at one predicate raise a proposal. It is a proposal, a
 * human reads it, and that is the whole mitigation.
 *
 * ## Why the join can identify a human correction at all
 *
 * `brain_edges` records `supersedes` from the replacement fact to the retired
 * one, and it has exactly two writers: this correction verb and the publish
 * gate. Joining the replacement's episode and requiring {@link HUMAN_SOURCE}
 * selects the correction writer without relying on the publish gate being
 * unable to have run — which it currently cannot, since it needs an approved
 * `single` entry that by definition does not exist yet, but which would become
 * a silent dependency the moment one is approved.
 */
export const CORRECTION_REPEAT_COUNT_SQL = `
  SELECT COUNT(DISTINCT n.subject_key)::int AS n
    FROM brain_edges e
    JOIN brain_facts n
      ON n.id = e.from_fact_id AND n.workspace_id = e.workspace_id
    JOIN brain_facts o
      ON o.id = e.to_fact_id AND o.workspace_id = e.workspace_id
    JOIN brain_episodes ep
      ON ep.id = n.source_episode_id AND ep.workspace_id = n.workspace_id
   WHERE e.workspace_id = $1
     AND e.edge_type = 'supersedes'
     AND n.predicate_key = $2
     AND n.subject_key IS NOT NULL
     AND ep.source = $3
     AND ${comparableDifferentSql("n.object_cmp", "o.object_cmp")}
`;

/**
 * Raise a `single` proposal when a workspace's own correction history says the
 * slot holds one value (ADR-0037 §3(d)2).
 *
 * Called from `correction.ts`'s `supersede` verb AFTER its transaction commits,
 * so the `supersedes` edge that triggered the check is one of the events
 * counted. Reading the corpus rather than incrementing a counter is what makes
 * the gate re-derivable: a proposal removed by hand is re-raised by the next
 * correction, and a rejection stops it because the rejected row occupies the
 * slot.
 *
 * **In its own transaction, after the verb's has committed.** A proposal is
 * advisory and the correction is a human's act, so a store failure here must not
 * roll back a correction the user was told succeeded — and a `try`/`catch`
 * INSIDE the verb's transaction could not deliver that, however it were written:
 * a failed statement puts Postgres in `25P02`, every later statement fails, and
 * the correction's own COMMIT fails with it. The catch would swallow the error
 * and lose the correction anyway. (A `SAVEPOINT` would also work and is strictly
 * more machinery for a write that needs no atomicity with the verb at all.) It
 * sits beside the admin-actions audit row, which is post-commit work for the
 * same reason.
 *
 * **THROWS.** The decision that a failed proposal is survivable belongs to the
 * caller that knows a correction is already committed, not to a store primitive
 * — `correction.ts` catches, logs, and returns `corrected`. Swallowing here
 * would also make the falsification tests unable to tell a refused proposal from
 * a broken one.
 *
 * Returns whether a proposal was raised — read by the tests that falsify the
 * gate in both directions. The caller discards it: the `log.info` below is the
 * operator-facing record, and a second line at the call site would say the same
 * thing with less context.
 */
export async function proposeFromCorrectionEvents(
  executor: CardinalityExecutor,
  workspaceId: string,
  predicateKey: string | null,
): Promise<boolean> {
  if (predicateKey === null || predicateKey === "") {
    // Logged rather than returned silently: this module's header says every arm
    // is a refusal and never a silent no-op, and a supersede on a predicate
    // surface that norms away would otherwise produce no proposal and no trace.
    // Unreachable from today's only caller (`correction.ts` guards on non-null),
    // so `debug` — the value is that a SECOND caller inherits a signal instead
    // of a shrug.
    log.debug(
      { workspaceId },
      "brain cardinality: no canonical predicate to propose against — the surface norms away, so this claim has no slot an entry could describe",
    );
    return false;
  }

  const { rows } = await executor.query(CORRECTION_REPEAT_COUNT_SQL, [
    workspaceId,
    predicateKey,
    HUMAN_SOURCE,
  ]);
  const raw = (rows[0] as { n?: unknown } | undefined)?.n;
  const subjects = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(subjects)) {
    // Loud rather than defaulted. Reading an unusable count as 0 would silently
    // retire source 2 for the whole deployment with no symptom anywhere: the
    // proposals simply stop, and nothing distinguishes that from a workspace
    // nobody corrects. Not thrown either — the caller's failure line says the
    // correction survived, which is true, but says nothing about WHICH statement
    // drifted, and this line names it.
    log.warn(
      { workspaceId, predicateKey, count: raw },
      "brain cardinality: the correction repeat gate did not read back as a number — no proposal was raised; diff CORRECTION_REPEAT_COUNT_SQL",
    );
    return false;
  }
  if (subjects < CORRECTION_REPEAT_THRESHOLD) return false;

  const result = await proposePredicateCardinality(executor, workspaceId, {
    predicateKey,
    cardinality: "single",
    sourceClass: "correction_event",
    proposedBy: CORRECTION_EVENT_PRODUCER,
  });
  if (!result.ok) {
    // `already-decided` is the ordinary steady state once a predicate has been
    // adjudicated — every later correction re-derives the same count and hits
    // the same row — so it is `debug`, not `warn`. The other refusals are
    // unreachable from here (the key is non-empty and the cardinality is a
    // literal) and would mean this call site drifted.
    const expected = result.refusal === "already-decided";
    const line = { workspaceId, predicateKey, subjects, refusal: result.refusal };
    if (expected) log.debug(line, "brain cardinality: predicate already adjudicated, no proposal");
    else log.warn(line, "brain cardinality: correction-event proposal refused unexpectedly");
    return false;
  }
  log.info(
    { workspaceId, predicateKey, subjects, threshold: CORRECTION_REPEAT_THRESHOLD },
    "brain cardinality: humans have superseded this predicate across enough distinct subjects to propose `single` — queued for review, and nothing supersedes until it is approved",
  );
  return true;
}
