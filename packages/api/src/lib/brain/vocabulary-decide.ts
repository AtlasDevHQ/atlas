/**
 * The alias decision seam — who approves an alias, and what approval means
 * (#5023, ADR-0037 §6, migration 0190).
 *
 * `lib/brain/vocabulary.ts` owns the vocabulary's DATA: the two relations, the
 * write primitives, the closure recomputation, and the loader. This module owns
 * the AUTHORITY over those primitives — the proposal queue, the permanent
 * rejection memory, the auto-approve split, and the one transaction all three
 * of them run inside.
 *
 * ## The publish gate cannot be this authority, and that is a decision
 *
 * `admin-brain-facts.ts` is explicit — *"There is no approve verb here, and
 * that is the design."* For a `brain_facts` row, approval IS
 * `/api/v1/admin/publish`: a content-mode promotion of `status='draft'` rows,
 * with `check-brain-fact-promotion.sh` refusing every other status-writing
 * shape. **An alias is not a `brain_facts` row and has no `status`**, so
 * ADR-0036's reasoning does not transfer — the publish gate's entire guarantee
 * is built on a column the vocabulary does not have.
 *
 * The shape it takes instead is `decide.ts`'s: ONE seam owning
 * `pending → approved | rejected` for every caller, **claim → apply → stamp**,
 * so *"approved means applied"* holds by construction rather than by caller
 * discipline. Recorded as a cost, not a free win: this is a SECOND approval
 * authority in one product, with its own queue and its own idempotency story.
 *
 * ## Where this seam is BETTER than the one it is modelled on, and why
 *
 * `decide.ts:36-41` carries a qualified guarantee — the reject arm treats a
 * stale claim as claimable, so a still-live apply can land YAML *after* a
 * takeover rejected the row. #5023's issue records inheriting that as an
 * accepted cost.
 *
 * **This slice does not inherit it.** A semantic amendment's apply mutates YAML
 * on disk and therefore cannot share a transaction with its claim and stamp; an
 * alias apply is a DB write, so all three are one transaction here. `applying`
 * never commits, a crash rolls the decision back whole, and there is no
 * compensation path because there is nothing to compensate.
 *
 * The condition under which the cost returns is worth naming, because #5024 is
 * where it would: ADR-0037 §7 puts the drift re-key — a sequential rewrite of
 * every affected `brain_facts` row — inside this transaction. If that rewrite
 * is ever moved OUT of it to keep the transaction short, `applying` becomes
 * observable, `claimed_at` becomes a takeover token, and every paragraph of
 * `decide.ts`'s compensation machinery becomes load-bearing here too. The
 * column exists so that change is a code change rather than a migration on a
 * hot table.
 *
 * ## Two authority postures, and collapsing them is the mistake to avoid
 *
 * T5's claim that entity edges *"invent no new authority"* is WITHDRAWN — in
 * #5009's correction comment and in T11's resolution §3(d) (#5016), which is
 * where a reader checking this should look. ADR-0037 §6 carries the posture
 * that REPLACED it, not the withdrawal itself, and has no lettered
 * subsections. One namespace and one key function, but not one posture:
 *
 *   - A **predicate** alias is proposed from evidence inside the brain's own
 *     ACL'd corpus, so an approver's entitlement is expressible in the grant
 *     grammar. Its content discloses nothing either — `is priced at → priced
 *     at` is a verb phrase an approver could have guessed.
 *   - An **entity** edge's evidence is a WAREHOUSE ROW, and that grammar has no
 *     arm for warehouse RLS (`acl.ts` makes not double-gating tier-1 a design
 *     decision, so no such arm can be added without reopening it). Its content
 *     differs in kind as well: `project atlas → nova` **is** the confidential
 *     bit.
 *
 * Both postures are enforced here, at two different points:
 *
 *   1. **Auto-approve** ({@link autoApproveEligible}) is reachable only at an
 *      ENTITY position — structurally, and an operator cannot widen that — and,
 *      under the shipped knob, only from a warehouse primary key. The source
 *      half IS widenable, which is why the position half is the one spelled in
 *      code rather than in settings. `warehouse_key` at the
 *      predicate position is refused at propose time — a predicate is a verb
 *      phrase and has no primary key, so the class cannot honestly arise there,
 *      and admitting it would route predicate aliases through the arm reserved
 *      for evidence outside the grant grammar.
 *   2. **The human bar** ({@link approverEntitled}) is owner/admin at an entity
 *      position — §6's *"direct human authoring is admitted, on the owner/admin
 *      entitlement"*, which is the only owner/admin gate the brain has — and any
 *      authenticated member at the predicate position, where the content
 *      discloses nothing and the entitlement is expressible.
 *
 * What is NOT here, and is the other half of the entity posture: §6 also has
 * entity-position proposals gated on the approver being able to see BOTH
 * evidence rows. That needs evidence on the proposal, and #5034 owns the
 * proposal query that would put it there. Stated rather than silently skipped,
 * because "entity edges need owner/admin" reads like the whole posture and is
 * only half of it.
 *
 * ## Rejection memory is what makes removal mean anything
 *
 * The vocabulary's reversibility rests on REMOVAL (ADR-0037 §6), and a producer
 * RE-RUNS. Without suppression the next run re-writes what a human removed, and
 * the vocabulary is not reversible for exactly the population entity edges add.
 * So a removal is not a delete — it is `approved → rejected` on the SAME
 * proposal row, and migration 0190's unique constraint on the unordered pair is
 * what makes the re-proposal structurally impossible rather than a race between
 * a SELECT and an INSERT.
 *
 * The identity a rejection remembers is the UNORDERED pair. Direction is not
 * fixed until approval, so an ordered identity would let a producer route
 * around a rejection by emitting the pair the other way — without any intent
 * to. See 0190's header.
 *
 * ## Lock order, and what it actually buys HERE
 *
 * {@link VOCABULARY_LOCK_SQL} is taken on the workspace BEFORE any proposal row
 * is read or written, in both the propose and the decide transaction.
 *
 * What that buys is the atomicity of two check-then-write pairs this module
 * owns: the rejection-memory read followed by the INSERT, and the proposal read
 * followed by the claim. Without it, two concurrent proposals of one pair both
 * see no rejected row and race the unique index, and two concurrent decisions
 * on one row both read it `pending`. It also serializes the whole
 * claim → apply → stamp against the region importer's EDGE writes on the same
 * workspace, since both take this namespace.
 *
 * What it does NOT buy, stated because an earlier version of this block claimed
 * it and the claim does not survive reading: it is not what avoids a 40P01
 * against that importer. The rows this module would hold under a lock-second
 * ordering are `brain_vocabulary_proposal` rows, and the importer never reads
 * that table at all (bundle-scope classifies it `stays`) — so there is no
 * second orderable resource and no wait-for cycle can form. The importer's real
 * deadlock hazard is one layer down, against `approveAliasEdge`, which takes
 * this lock itself before touching a row; `migrate-roundtrip-pg.test.ts` carries
 * THAT pair (#5022) and would not fail if this seam's ordering regressed.
 *
 * The inversion becomes reachable at #5024, when ADR-0037 §7's drift re-key puts
 * a `brain_facts` rewrite — a table the importer DOES write — inside this
 * transaction. Locking first now is what makes that a no-op rather than a
 * re-discovery. This module's own ordering assertions are in
 * `vocabulary-decide-pg.test.ts`, and they assert an INVARIANT, not a deadlock.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import { isSlotPosition, lexicalNorm, type SlotPosition } from "@atlas/api/lib/brain/identity";
import {
  VOCABULARY_LOCK_NAMESPACE,
  VOCABULARY_LOCK_SQL,
  approveAliasEdge,
  removeAliasEdge,
  type AliasApprovalRefusal,
  type VocabularyExecutor,
} from "@atlas/api/lib/brain/vocabulary";
import {
  withBrainTransaction,
  type ReconcileTransactionRunner,
} from "@atlas/api/lib/brain/reconcile";

const log = createLogger("brain-vocabulary-decide");

/**
 * Where a proposal came from — the ONLY input to auto-approve eligibility.
 *
 * Deliberately a closed set matching migration 0190's CHECK rather than a free
 * string: the auto-approve knob reads these names, so a typo in a producer
 * would otherwise silently make its edges ineligible (safe) or, once the knob
 * is widened, silently eligible (not).
 */
export const ALIAS_SOURCE_CLASSES = [
  /** A warehouse primary key: two surfaces are the same row. Certain. */
  "warehouse_key",
  /** An extractor's guess that two spellings name one thing. */
  "extractor",
  /** The alias-proposal query over the brain's own corpus (#5034). */
  "seam",
  /** A human authoring the edge directly (ADR-0037 §6). */
  "human",
] as const;
export type AliasSourceClass = (typeof ALIAS_SOURCE_CLASSES)[number];

/** Narrow an untrusted value to an {@link AliasSourceClass} without a cast. */
export function isAliasSourceClass(value: unknown): value is AliasSourceClass {
  return typeof value === "string" && (ALIAS_SOURCE_CLASSES as readonly string[]).includes(value);
}

/**
 * The entity positions — where an edge's evidence lives OUTSIDE the grant
 * grammar, and where both authority postures differ from the predicate's.
 *
 * Derived from the position rather than carried on the proposal, so a producer
 * cannot mislabel it: `subject` and `object` name instances, `predicate` names
 * a relation. That is the whole distinction T11 §3(d) (#5016) rests on.
 */
function isEntityPosition(position: SlotPosition): boolean {
  return position === "subject" || position === "object";
}

/** One proposed alias, as a producer or a human supplies it. */
export interface AliasProposalInput {
  readonly position: SlotPosition;
  /** Re-normed before it is stored, for `approveAliasEdge`'s reason. */
  readonly fromNorm: string;
  readonly toNorm: string;
  /**
   * Whether the producer can say which spelling is canonical.
   *
   * `false` when neither side is warehouse-derived — `priced at` vs `is priced
   * at` is #5000's own case, and nothing in the evidence prefers one. Approving
   * an undirected proposal REQUIRES a supplied direction; the seam refuses
   * rather than picking, because picking is the silent workspace-wide re-key
   * the vocabulary exists to put a human in front of.
   */
  readonly directed: boolean;
  readonly sourceClass: AliasSourceClass;
  /** 0–1. The threshold half of the auto-approve knob reads this. */
  readonly confidence: number;
  /** The producer name or the authoring user id. Recorded verbatim. */
  readonly proposedBy: string;
}

/** Why a proposal was refused before it ever reached the queue. */
export type AliasProposalRefusal =
  /** Either endpoint norms away to nothing — a surface that asserts nothing. */
  | "degenerate-norm"
  /** Both endpoints norm to the same thing; the pair proposes nothing. */
  | "self-edge"
  /** Confidence outside 0–1 — a producer bug, not a low-confidence edge. */
  | "confidence-out-of-range"
  /**
   * `warehouse_key` at the PREDICATE position. A warehouse primary key backs an
   * entity instance; a predicate is a verb phrase and has none, so the class
   * cannot honestly arise there — and admitting it would route a predicate
   * alias through the auto-approve arm reserved for evidence that lives outside
   * the grant grammar.
   */
  | "warehouse-key-at-predicate";

/**
 * What happened to a proposal. A discriminated union so a producer handles
 * every terminal state explicitly — the counters in
 * {@link proposeAliasEdges} are exactly this union, tallied.
 */
export type AliasProposalOutcome =
  /**
   * A new row was queued `pending`. `autoApprove` reports ELIGIBILITY, not a
   * decision: this seam's decide arm is the only writer of `approved`, so the
   * caller routes an eligible row through {@link decideAliasProposal} rather
   * than trusting an insert-time stamp. Same split as
   * `insertSemanticAmendment`, for the same reason.
   */
  | { readonly kind: "queued"; readonly id: string; readonly autoApprove: boolean }
  /** An identical pair is already awaiting review; converged on that row. */
  | { readonly kind: "already_pending"; readonly id: string }
  /** The pair is already an approved edge. Nothing to propose. */
  | { readonly kind: "already_approved"; readonly id: string }
  /**
   * Permanent rejection memory: a human rejected or REMOVED this pair, so the
   * insert is refused forever. `id` is the existing decided row.
   */
  | { readonly kind: "rejected"; readonly id: string }
  /** Malformed — see {@link AliasProposalRefusal}. Never queued. */
  | {
      readonly kind: "refused";
      readonly refusal: AliasProposalRefusal;
      readonly message: string;
    };

/**
 * Who is deciding.
 *
 * Two arms rather than a nullable user id, because the two carry different
 * ENTITLEMENTS and the type is where that should be visible. `auto` is not "a
 * human we do not know" — it is the case where no human entitlement is
 * expressible at all, which is precisely why it is confined to a warehouse
 * primary key.
 */
export type AliasApprover =
  /** The auto-approve path. Records `approved_by = NULL` on the edge. */
  | { readonly kind: "auto"; readonly producer: string }
  /** A human, carried as the brain's own principal context. */
  | { readonly kind: "human"; readonly ctx: BrainPrincipalContext };

/**
 * The recorded approver, or `null` for the machine path.
 *
 * `ctx.userId` alone would be WRONG on a self-hosted no-auth deployment. There
 * `unauthenticated-local` is the only origin there is — {@link approverEntitled}
 * admits it deliberately, on `correctFact`'s reasoning — and its `userId` is
 * `null`, so every human approval would land `approved_by = NULL`: the value
 * migration 0189 defines as "auto-approved, no human", at the column it calls
 * the one an audit of a workspace-wide re-key reads first. A human re-key would
 * be indistinguishable from a machine one, permanently.
 *
 * `correction.ts` solved this already and the sentinel is copied from it rather
 * than invented: that deployment declared it has no ids to record, so the class
 * is recorded instead of an id.
 */
const LOCAL_OPERATOR_ACTOR = "local-operator";

function recordedApprover(approver: AliasApprover): string | null {
  if (approver.kind === "auto") return null;
  // Switched on the ORIGIN rather than written `ctx.userId ?? SENTINEL`, and
  // the difference is the whole point of the fix: `??` applies the sentinel to
  // every origin whose `userId` happens to be null, so a FOURTH
  // `BrainPrincipalContext` arm (a service token, an API-key principal) would
  // silently inherit "the declared local operator" — the same audit
  // falsification one origin over. Exhaustive, so a new arm is a compile error
  // here instead.
  switch (approver.ctx.origin) {
    case "authenticated":
      return approver.ctx.userId;
    case "unauthenticated-local":
      return LOCAL_OPERATOR_ACTOR;
    case "unresolved":
      // Unreachable: `approverEntitled` refuses this origin before any write.
      // Thrown rather than coalesced, because reaching it means the entitlement
      // check moved and the next thing to happen is an unattributed re-key.
      throw new Error(
        "decideAliasProposal: an unresolved reader reached the approver record. That origin is " +
          "refused by the entitlement check, so this is an ordering regression — refusing rather " +
          "than recording a workspace-wide re-key against no identity.",
      );
  }
}

/** The direction a human sets on an undirected proposal at approval time. */
export interface AliasDirection {
  readonly fromNorm: string;
  readonly toNorm: string;
}

/** Why a decision was refused. */
export type AliasDecisionRefusal =
  /** The approver's workspace is not the proposal's. A scope escalation. */
  | "workspace-mismatch"
  /** The approver does not clear this position's bar. */
  | "not-entitled"
  /**
   * A machine actor attempted a rejection. Its own member rather than a second
   * meaning for `not-entitled`: on an approved row a rejection is a REMOVAL, so
   * a route mapping refusals to responses needs to tell "wrong role" (a 403 a
   * different user could satisfy) from "no actor of this class may ever do
   * this".
   */
  | "machine-may-not-reject"
  /** `auto` reached a proposal the split does not make eligible. */
  | "not-auto-approvable"
  /** The proposal is undirected and no direction was supplied. */
  | "direction-required"
  /** A supplied direction names norms that are not the proposal's pair. */
  | "direction-not-in-pair"
  /** A supplied direction contradicts an already-directed proposal. */
  | "direction-conflict"
  /** The vocabulary itself refused the edge — see {@link AliasApprovalRefusal}. */
  | AliasApprovalRefusal;

/** The outcome of one decision. */
export type AliasDecisionOutcome =
  /** Claim won, edge written, closure recomputed, row stamped `approved`. */
  | { readonly kind: "approved"; readonly id: string }
  /**
   * The row is `rejected`, and `removedEdge` says which transition ran:
   * `pending → rejected` (never applied) or `approved → rejected` — a REMOVAL,
   * which dropped the approved edge and recomputed the closure. Both leave the
   * pair in permanent rejection memory, which is the point: a removal a
   * producer could undo is not a reversal.
   */
  | { readonly kind: "rejected"; readonly id: string; readonly removedEdge: boolean }
  /**
   * No row in a decidable state. Four causes, and the seam does not distinguish
   * them on purpose (each is "nothing for you to decide"): the row is absent,
   * it belongs to another workspace, it is already `rejected`, or the verb has
   * no transition from its current status — an approve on an `approved` row
   * or an `applying` one (the claim is conditional on `pending`, and an
   * approved pair's only remaining transition is removal), and a reject on an
   * `applying` one.
   *
   * Reported truthfully — never retried into a second apply.
   */
  | { readonly kind: "not_decidable"; readonly id: string }
  /** Refused; the transaction rolled back and the row is untouched. */
  | {
      readonly kind: "refused";
      readonly id: string;
      readonly refusal: AliasDecisionRefusal;
      readonly message: string;
    };

/** Test seams. Both default to the real thing. */
export interface AliasDecideDeps {
  /** Defaults to a transaction on the internal pool. */
  readonly withTransaction?: ReconcileTransactionRunner;
  /** Defaults to `randomUUID`. */
  readonly newProposalId?: () => string;
}

// ---------------------------------------------------------------------------
// The auto-approve knob
// ---------------------------------------------------------------------------

/**
 * The confidence bar, or `null` when auto-approval is switched off.
 *
 * `null` rather than a sentinel above 1: `getAutoApproveThreshold` returns 2
 * for "disabled" and every caller then compares against it, which works but
 * makes "disabled" a magic number two call sites have to agree about. A null
 * has one meaning and the compiler makes the caller handle it.
 *
 * An out-of-range or unparseable value DISABLES rather than defaulting to the
 * shipped `1`. A garbled knob must never be more permissive than the operator
 * who garbled it intended.
 */
function aliasAutoApproveThreshold(workspaceId: string): number | null {
  const raw = getSettingAuto("ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD", workspaceId);
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    log.warn(
      { workspaceId, raw },
      "Invalid ATLAS_BRAIN_ALIAS_AUTO_APPROVE_THRESHOLD — must be 0.0–1.0; disabling alias auto-approval for this workspace",
    );
    return null;
  }
  return parsed;
}

/** The eligible source classes. Unrecognized names are logged and dropped. */
function aliasAutoApproveSources(workspaceId: string): ReadonlySet<AliasSourceClass> {
  const raw = getSettingAuto("ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES", workspaceId) ?? "";
  const eligible = new Set<AliasSourceClass>();
  for (const token of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
    if (isAliasSourceClass(token)) eligible.add(token);
    else {
      log.warn(
        { workspaceId, token },
        "ATLAS_BRAIN_ALIAS_AUTO_APPROVE_SOURCES names an unrecognized source class — ignoring",
      );
    }
  }
  return eligible;
}

/**
 * ADR-0037 §6's split, as one predicate.
 *
 * Three conjuncts, and the FIRST is not a knob. `warehouse_key` at the
 * predicate position never reaches here (propose refuses it), but an ENTITY
 * position is not enough on its own either: the split is about the evidence,
 * and only a warehouse primary key is evidence a machine can be certain of.
 * Widening the knob to `extractor` therefore widens what auto-approves at a
 * position the ADR already reasoned about — a real operator decision — while
 * this line is what stops the position alone doing it.
 */
function autoApproveEligible(
  workspaceId: string,
  candidate: {
    /** The stored `slot_position` / the input's `position`. */
    readonly position: string;
    /** The stored `source_class` / the input's `sourceClass`. */
    readonly sourceClass: string;
    readonly confidence: number;
  },
): boolean {
  // Narrowed rather than cast: the decide arm reads these off a database row,
  // and a `source_class` the deployment's enum does not know must fail the
  // split rather than be asserted into it.
  const { position, sourceClass } = candidate;
  if (!isSlotPosition(position) || !isEntityPosition(position)) return false;
  if (!isAliasSourceClass(sourceClass)) return false;
  const threshold = aliasAutoApproveThreshold(workspaceId);
  if (threshold === null) return false;
  // `!(a >= b)` rather than `a < b`: every NaN comparison is false, so the naive
  // spelling reads as "clears the threshold" for exactly the value that means
  // "this could not be read".
  //
  // DEFENSIVE STYLE, NOT A TESTED PROPERTY, and said plainly because the
  // mutation table in `vocabulary-decide-pg.test.ts` would otherwise be expected
  // to carry a row for it. NaN is unreachable here from both directions: propose
  // refuses it outright (`confidence-out-of-range`), and the stored column
  // cannot hold one — Postgres orders NaN above every value, so 0190's
  // `confidence <= 1` CHECK rejects it. The spelling survives because the two
  // reachability arguments are the kind that stop being true quietly.
  if (!(candidate.confidence >= threshold)) return false;
  return aliasAutoApproveSources(workspaceId).has(sourceClass);
}

/**
 * The human bar for one position. See the module header for why the two differ.
 *
 * `unauthenticated-local` clears both, matching `correctFact`: that deployment
 * has DECLARED the local operator is the only identity there is, and the admin
 * surface already treats them as such. `unresolved` clears neither — an
 * unresolvable identity is an upstream defect, and the fail-closed direction is
 * the only safe one at a write that re-keys a corpus.
 */
function approverEntitled(position: SlotPosition, ctx: BrainPrincipalContext): boolean {
  if (ctx.origin === "unauthenticated-local") return true;
  if (ctx.origin !== "authenticated") return false;
  if (!isEntityPosition(position)) return true;
  return ctx.role === "owner" || ctx.role === "admin";
}

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

/** The stored shape of a proposal row this module reads back. */
interface ProposalRow {
  readonly id: string;
  /**
   * NARROWED, not asserted — and the asymmetry with `source_class` below is the
   * point rather than an inconsistency.
   *
   * This column decides the ENTITLEMENT bar, and `approverEntitled` fails OPEN
   * on a value it does not recognise: `isEntityPosition` answers `false` for
   * anything outside `subject | object`, so an unknown position would take the
   * PREDICATE arm and clear the bar for any authenticated member — the exact
   * owner/admin gate ADR-0037 §6 puts in front of entity edges, bypassed. An
   * unreadable authority input is refused rather than assumed.
   *
   * `source_class` decides ELIGIBILITY, and that gate already fails CLOSED on an
   * unrecognised value (`isAliasSourceClass` at the eligibility check). Left a
   * `string` deliberately, so a deployment reading a row written by a newer
   * enum queues it for a human instead of refusing to decide it at all.
   */
  readonly slot_position: SlotPosition;
  readonly from_norm: string;
  readonly to_norm: string;
  readonly directed: boolean;
  readonly source_class: string;
  /**
   * Narrowed to `NaN` when the executor hands back something that is not a
   * number, NOT defaulted to the shipped threshold. An unreadable confidence
   * must FAIL every comparison rather than clear one — a fallback in the
   * permissive direction is how a fix becomes the defect at the one comparison
   * deciding whether a human ever sees the edge.
   *
   * Unreachable through a real Postgres client: the column is `NOT NULL double
   * precision` and `pg` parses float8 to a number. It binds a hand-written
   * {@link VocabularyExecutor} — which this module's own seam advertises as a
   * legal shape — for the reason `lockWorkspaceVocabulary` guards `{ rows: [] }`.
   */
  readonly confidence: number;
  readonly status: string;
}

const PROPOSAL_COLUMNS =
  "id, slot_position, from_norm, to_norm, directed, source_class, confidence, status";

/**
 * Narrow one raw row.
 *
 * Two columns are checked and the rest are asserted, which is a weaker claim
 * than "nothing dereferences the driver's shape" — so it is stated rather than
 * implied. The two are the ones whose WRONG value is silently permissive:
 * `slot_position` decides the entitlement bar and fails open, `confidence`
 * decides eligibility and every NaN comparison is false. The remainder
 * (`from_norm`, `to_norm`, `status`, `directed`, `id`) are guarded structurally
 * by migration 0190's NOT NULLs and CHECKs, and a wrong value there produces a
 * visibly wrong answer rather than a quietly permissive one.
 *
 * @throws when `slot_position` is not a position this deployment knows. A row
 *   written outside this seam — a hand-written INSERT, a restore onto a
 *   deployment whose CHECK was dropped — is a corrupt vocabulary, not a
 *   decision to make on a guess.
 */
function toProposalRow(raw: unknown, workspaceId: string): ProposalRow | undefined {
  if (raw === undefined || raw === null) return undefined;
  // `Omit` + re-declared `unknown`, NOT `ProposalRow & { …?: unknown }`. An
  // intersection narrows and never widens (`SlotPosition & unknown` is
  // `SlotPosition`), so the earlier spelling left both guards below statically
  // dead — the compiler already believed the fields, and a tidy-up deleting
  // either check would not have failed to compile. This way the checks are what
  // produce the types, which is what "narrowed" is supposed to mean.
  const row = raw as Omit<ProposalRow, "slot_position" | "confidence"> & {
    readonly slot_position: unknown;
    readonly confidence: unknown;
  };
  if (!isSlotPosition(row.slot_position)) {
    log.error(
      { workspaceId, proposalId: row.id, slotPosition: row.slot_position },
      "Alias proposal carries a slot_position this deployment does not know — refusing to decide it",
    );
    throw new Error(
      `Alias proposal ${row.id} carries slot_position "${String(row.slot_position)}" (workspace ` +
        `${workspaceId}), which is not subject, predicate or object. The position decides which ` +
        "entitlement an approver needs, and an unknown one would take the lower bar — so the row is " +
        "refused rather than decided. It was written outside this seam.",
    );
  }
  return {
    ...row,
    slot_position: row.slot_position,
    confidence: typeof row.confidence === "number" ? row.confidence : Number.NaN,
  };
}

/**
 * Queue one proposed alias, subject to permanent rejection memory.
 *
 * Runs in ONE transaction with the vocabulary lock held, for the same reason
 * the decide arm does: the rejection-memory read and the insert are one
 * decision, and the lock is what makes them atomic against a concurrent
 * approval that is about to write the same pair.
 *
 * Never writes `approved`. An eligible row is reported through
 * `autoApprove` and the caller routes it through {@link decideAliasProposal} —
 * `insertSemanticAmendment`'s split, and it is what makes the decide arm the
 * only writer of an approved edge.
 */
export async function proposeAliasEdge(
  workspaceId: string,
  input: AliasProposalInput,
  deps: AliasDecideDeps = {},
): Promise<AliasProposalOutcome> {
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const newProposalId = deps.newProposalId ?? randomUUID;

  // Re-normed, never trusted — `approveAliasEdge`'s reason one layer earlier.
  // Doing it HERE as well as there is what makes the pair identity (and so the
  // rejection memory) match across a producer that emits display forms and one
  // that emits norms; a non-norm stored in the queue would dedup against
  // nothing.
  const fromNorm = lexicalNorm(input.fromNorm);
  const toNorm = lexicalNorm(input.toNorm);

  if (fromNorm === "" || toNorm === "") {
    return {
      kind: "refused",
      refusal: "degenerate-norm",
      message:
        `An alias proposal needs two non-empty norms; "${input.fromNorm}" → "${input.toNorm}" ` +
        `normalizes to "${fromNorm}" → "${toNorm}". A surface made only of separators asserts ` +
        "nothing and has no slot to alias.",
    };
  }

  if (fromNorm === toNorm) {
    return {
      kind: "refused",
      refusal: "self-edge",
      message:
        `"${input.fromNorm}" and "${input.toNorm}" both normalize to "${fromNorm}", so they already ` +
        "share an identity key and there is nothing to propose.",
    };
  }

  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    return {
      kind: "refused",
      refusal: "confidence-out-of-range",
      message:
        `Alias proposal confidence must be between 0 and 1; got ${input.confidence}. This is a ` +
        "producer bug rather than a low-confidence edge — a NaN would compare false against every " +
        "threshold and silently queue what the operator configured to auto-approve.",
    };
  }

  if (input.sourceClass === "warehouse_key" && !isEntityPosition(input.position)) {
    return {
      kind: "refused",
      refusal: "warehouse-key-at-predicate",
      message:
        `A "warehouse_key" alias proposal is only meaningful at an entity position (subject or ` +
        `object); "${fromNorm}" → "${toNorm}" is at the predicate position. A warehouse primary key ` +
        "backs an entity INSTANCE — a predicate is a verb phrase and has none — so accepting this " +
        "would route a predicate alias through the auto-approve arm ADR-0037 §6 and T11 §3(d) " +
        "reserve for evidence that lives outside the grant grammar.",
    };
  }

  return withTransaction(async (tx) => {
    await lockVocabulary(tx, workspaceId);

    const existing = await findProposalByPair(tx, workspaceId, input.position, fromNorm, toNorm);
    if (existing !== undefined) {
      // Rejection memory FIRST, and the order is the guarantee: a pair that was
      // rejected must never be re-queued even if the row could be read as
      // something else. `applying` is folded into `already_pending` because it
      // is a decision in flight, not a slot a second proposal may take.
      if (existing.status === "rejected") {
        log.debug(
          { workspaceId, position: input.position, fromNorm, toNorm, existingId: existing.id },
          "Alias proposal refused — the pair was previously rejected or removed (permanent rejection memory)",
        );
        return { kind: "rejected", id: existing.id };
      }
      if (existing.status === "approved") return { kind: "already_approved", id: existing.id };
      return { kind: "already_pending", id: existing.id };
    }

    const id = newProposalId();
    await tx.query(
      `INSERT INTO brain_vocabulary_proposal
         (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
          confidence, status, proposed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
      [
        id,
        workspaceId,
        input.position,
        fromNorm,
        toNorm,
        input.directed,
        input.sourceClass,
        input.confidence,
        input.proposedBy,
      ],
    );

    return {
      kind: "queued",
      id,
      autoApprove: autoApproveEligible(workspaceId, input),
    };
  });
}

/** What one producer run did. Surfaced so a re-run's suppression is visible. */
export interface AliasProducerCounters {
  /**
   * Left for a human to decide. Includes an eligible row whose auto-approval
   * the vocabulary refused — that row IS queued, and counting it only under
   * `refused` would make this number stop meaning "rows awaiting review".
   */
  queued: number;
  /** Queued AND decided in the same run, through the decide seam. */
  autoApproved: number;
  /** Converged on a row already awaiting review. */
  deduped: number;
  /** Already an approved edge. */
  alreadyApproved: number;
  /**
   * Refused by permanent rejection memory — a human removed or rejected this
   * pair. THE counter that matters on a re-run: a producer whose second pass
   * reports zero here is one whose removals did not stick.
   */
  rejected: number;
  /**
   * Malformed at propose time (never queued), or eligible and refused by the
   * decide seam (queued, and counted under `queued` as well). Because of that
   * second case the counters sum to MORE than `inputs.length` — said plainly,
   * since a producer dashboard adding them up is the thing that trips over it.
   */
  refused: number;
}

/**
 * Run one producer's batch: propose each edge, and route the eligible ones
 * through the decide seam in the same pass.
 *
 * Shaped on `scheduler.ts`'s amendment loop deliberately — propose, branch on
 * the outcome, and route `autoApprove` through the decide seam rather than
 * stamping at insert. The counters are #5023's *"with the count surfaced"*,
 * adopting #4507's rejection memory: a producer that re-runs after a human
 * removed an edge must be able to SAY that it was suppressed, or the
 * suppression is invisible and the next operator debugging a missing alias has
 * nothing to read.
 *
 * Sequential, not `Promise.all`. Every iteration takes the same workspace
 * advisory lock, so a parallel batch would serialize on it anyway while holding
 * N pool connections — and the internal pool is bounded at 5.
 */
export async function proposeAliasEdges(
  workspaceId: string,
  inputs: readonly AliasProposalInput[],
  producer: string,
  deps: AliasDecideDeps = {},
): Promise<AliasProducerCounters> {
  const counters: AliasProducerCounters = {
    queued: 0,
    autoApproved: 0,
    deduped: 0,
    alreadyApproved: 0,
    rejected: 0,
    refused: 0,
  };

  // Every iteration COMMITS on its own — `proposeAliasEdge` opens its own
  // transaction, and an eligible row's approval opens another. So a throw part
  // way through leaves real rows behind, and the counters describing them are
  // the only record of which. Logged before the error propagates, or the caller
  // sees a raw failure and a `rejected: 0` it has no way to read as "unknown"
  // rather than "nothing was suppressed".
  let processed = 0;
  try {
  for (const input of inputs) {
    processed++;
    const outcome = await proposeAliasEdge(workspaceId, input, deps);
    switch (outcome.kind) {
      case "already_pending":
        counters.deduped++;
        break;
      case "already_approved":
        counters.alreadyApproved++;
        break;
      case "rejected":
        counters.rejected++;
        break;
      case "refused":
        log.warn(
          { workspaceId, producer, refusal: outcome.refusal },
          `Alias proposal refused — ${outcome.message}`,
        );
        counters.refused++;
        break;
      case "queued": {
        if (!outcome.autoApprove) {
          counters.queued++;
          break;
        }
        const decided = await decideAliasProposal(
          {
            id: outcome.id,
            workspaceId,
            decision: "approved",
            approver: { kind: "auto", producer },
          },
          deps,
        );
        if (decided.kind === "approved") {
          counters.autoApproved++;
        } else {
          // BOTH counters. The row is still queued for a human — so `queued`
          // must count it, or a producer's `queued` stops meaning "rows I left
          // for review", which is the number the field promises. `refused` is
          // what says the auto-approval was attempted and did not land.
          //
          // Logged at warn because an auto-approve the vocabulary refused (a
          // cycle, an existing parent) is a producer emitting edges that
          // contradict the store, and that is worth seeing.
          log.warn(
            { workspaceId, producer, proposalId: outcome.id, outcome: decided.kind },
            "Alias auto-approval did not land — the proposal stays queued for a human",
          );
          counters.queued++;
          counters.refused++;
        }
        break;
      }
      default: {
        // The counters are documented as "exactly this union, tallied", and a
        // sixth arm compiling into silence is the wrong failure direction for a
        // type whose whole job is making the suppression visible.
        const exhaustive: never = outcome;
        throw new Error(`proposeAliasEdges: unhandled proposal outcome ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  } catch (err) {
    log.error(
      {
        workspaceId,
        producer,
        ...counters,
        processed,
        total: inputs.length,
        err: err instanceof Error ? err.message : String(err),
      },
      "Alias producer batch aborted mid-flight — every proposal counted above is already committed",
    );
    throw err;
  }

  log.info({ workspaceId, producer, ...counters }, "Alias producer batch complete");
  return counters;
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/**
 * A decision, split by verb — and the split is a guard rather than tidiness.
 *
 * `rejected` takes a HUMAN approver only. A machine may approve (that is the
 * whole auto-approve split) but must never reject, because on an `approved` row
 * rejection is a REMOVAL: it drops an edge a human approved, recomputes the
 * closure, and writes permanent rejection memory that no producer can undo. A
 * machine undoing a human decision and making it unrepeatable is the exact
 * inversion this seam exists to prevent, and under one flat shape
 * `{ decision: "rejected", approver: { kind: "auto" } }` typechecked and ran.
 *
 * `direction` is likewise on the approve arm only — it is meaningless on a
 * rejection, and a field that is representable-and-ignored is a field a caller
 * will eventually believe in.
 *
 * The type is the primary guard. {@link decideAliasProposal} re-checks the
 * ACTOR half at runtime — #5025's route will build one of these out of a parsed
 * HTTP body, where the compiler is not in the room — and DISCARDS a direction
 * sent with a rejection rather than refusing it, since there is no decision a
 * direction could change there.
 */
export type AliasDecisionRequest =
  | {
      readonly id: string;
      readonly workspaceId: string;
      readonly decision: "approved";
      readonly approver: AliasApprover;
      /**
       * The direction a human sets. REQUIRED when the proposal is undirected,
       * optional (and checked for agreement) when it is not.
       */
      readonly direction?: AliasDirection;
    }
  | {
      readonly id: string;
      readonly workspaceId: string;
      readonly decision: "rejected";
      readonly approver: Extract<AliasApprover, { kind: "human" }>;
    };

/**
 * Decide one alias proposal — the single seam for `pending → approved` and for
 * `pending | approved → rejected`.
 *
 * ## Three verbs, one seam, and REMOVAL is the third
 *
 * `rejected` on a `pending` row is a plain refusal; `rejected` on an `approved`
 * one is a REMOVAL — it drops the edge, recomputes the closure, and leaves the
 * pair in permanent rejection memory. Modelling removal as a decision rather
 * than a separate verb is what makes "rejected means not applied" true in both
 * directions, and it is why a producer cannot re-emit what a human removed.
 *
 * ## claim → apply → stamp, in one transaction
 *
 * The claim is an atomic conditional update onto `applying`; the apply runs
 * `approveAliasEdge` (which re-takes the same re-entrant lock and recomputes
 * the closure); the stamp is conditional on the claim token. A typed refusal
 * from the vocabulary ROLLS THE TRANSACTION BACK, so the claim is undone and
 * the row is left exactly `pending` — never `applying` and never a lie.
 *
 * @throws when the underlying write fails (including a closure that does not
 *   converge, which arrives as `VocabularyClosureError`). The transaction has
 *   already rolled back; a caller distinguishes "this workspace's vocabulary is
 *   corrupt" from "the database is unreachable" on that class.
 */
export async function decideAliasProposal(
  request: AliasDecisionRequest,
  deps: AliasDecideDeps = {},
): Promise<AliasDecisionOutcome> {
  const { id, workspaceId, decision, approver } = request;
  const direction = request.decision === "approved" ? request.direction : undefined;
  const withTransaction = deps.withTransaction ?? withBrainTransaction;

  // The runtime half of the union above. A machine may approve and must never
  // reject — see {@link AliasDecisionRequest}. Refused before the transaction
  // opens, like the workspace check below, because it is a request nobody with
  // the authority to make it would send.
  if (decision === "rejected" && approver.kind !== "human") {
    log.error(
      { workspaceId, proposalId: id },
      "Alias decision refused — a machine actor attempted a rejection, which on an approved row is a removal",
    );
    return {
      kind: "refused",
      id,
      refusal: "machine-may-not-reject",
      message:
        `Proposal ${id} cannot be rejected by a machine actor. A rejection on an approved row is a ` +
        "REMOVAL — it drops an edge a human approved and writes permanent rejection memory no " +
        "producer can undo. Auto-approval is the only machine authority this seam grants.",
    };
  }

  if (approver.kind === "human" && approver.ctx.workspaceId !== workspaceId) {
    // Refused before the transaction opens: this is a scope escalation attempt,
    // and the row must not even be READ under another workspace's identity.
    log.error(
      { workspaceId, approverWorkspaceId: approver.ctx.workspaceId, proposalId: id },
      "Alias decision refused — the approver's workspace is not the proposal's",
    );
    return {
      kind: "refused",
      id,
      refusal: "workspace-mismatch",
      message:
        `The approver's workspace (${approver.ctx.workspaceId}) is not the proposal's ` +
        `(${workspaceId}). One workspace's reviewer never decides another's vocabulary.`,
    };
  }

  try {
    return await withTransaction(async (tx) => {
      // LOCK FIRST — before any proposal row is read or written, so the row
      // read and the claim that follows it are one atomic decision. See the
      // module header for what this does and does NOT buy; in particular it is
      // not what avoids a 40P01 against the region importer, which never reads
      // this table.
      await lockVocabulary(tx, workspaceId);

      const row = await loadProposal(tx, workspaceId, id);
      if (row === undefined) return { kind: "not_decidable", id };

      const position = row.slot_position;

      if (approver.kind === "human" && !approverEntitled(position, approver.ctx)) {
        // Logged, because this is an authorization denial on a write that
        // re-keys a corpus. The refusal message travels out in the return
        // value, which is the caller's copy — not a server-side record anyone
        // can query when asking who keeps trying to approve entity edges.
        log.warn(
          {
            workspaceId,
            proposalId: id,
            position,
            origin: approver.ctx.origin,
            role: approver.ctx.role,
          },
          "Alias approval refused — the reader does not clear this position's entitlement bar",
        );
        return {
          kind: "refused",
          id,
          refusal: "not-entitled",
          message: entitlementMessage(position, approver.ctx),
        };
      }

      if (decision === "rejected") return rejectProposal(tx, workspaceId, row, approver);

      // Re-checked HERE rather than trusted from propose time: the knob is a
      // live workspace setting and can change between the two, and a producer
      // that cached `autoApprove: true` across a batch would otherwise approve
      // under a policy the operator has already turned off.
      const eligible = autoApproveEligible(workspaceId, {
        position: row.slot_position,
        sourceClass: row.source_class,
        confidence: row.confidence,
      });
      if (approver.kind === "auto" && !eligible) {
        return {
          kind: "refused",
          id,
          refusal: "not-auto-approvable",
          message:
            `Proposal ${id} (${row.source_class}, ${position}) is not eligible for auto-approval. ` +
            "ADR-0037 §6 admits only a warehouse-derived entity edge, and the workspace's " +
            "`ATLAS_BRAIN_ALIAS_AUTO_APPROVE_*` settings narrow that further. It stays queued for " +
            "a human.",
        };
      }

      const resolved = resolveDirection(row, direction);
      if (!resolved.ok) {
        return { kind: "refused", id, refusal: resolved.refusal, message: resolved.message };
      }

      return approveProposal(tx, workspaceId, row, resolved, approver);
    });
  } catch (err) {
    // A vocabulary refusal reaches here THROUGH the rollback, which is the only
    // way a typed refusal can undo the claim the apply arm already wrote. Every
    // other error — a closure that did not converge, an unreachable database —
    // propagates, because those are not decisions and a caller must be able to
    // tell them apart.
    if (err instanceof AliasApplyRefusedError) {
      // An `already-aliased` or `would-cycle` refusal means a caller is
      // proposing edges that contradict the committed vocabulary. Worth a
      // server-side line on the HUMAN path too — `proposeAliasEdges` logs it,
      // but only for the batch arm.
      log.warn(
        { workspaceId, proposalId: id, refusal: err.refusal, approver: approver.kind },
        `Alias approval refused by the vocabulary — ${err.refusalMessage}`,
      );
      return { kind: "refused", id, refusal: err.refusal, message: err.refusalMessage };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Take the workspace vocabulary lock. See the module header for what it buys —
 * and for the 40P01-against-the-importer story it deliberately does NOT claim.
 */
async function lockVocabulary(tx: VocabularyExecutor, workspaceId: string): Promise<void> {
  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);
}

/**
 * Find a proposal by its UNORDERED pair.
 *
 * `LEAST`/`GREATEST` on the ARGUMENTS rather than a caller-sorted pair, so the
 * query asks the same question migration 0190's generated columns answer, in
 * the same way. A caller that sorted the pair itself would be a second
 * implementation of the row's identity — the shape #5000 was.
 */
async function findProposalByPair(
  tx: VocabularyExecutor,
  workspaceId: string,
  position: SlotPosition,
  fromNorm: string,
  toNorm: string,
): Promise<ProposalRow | undefined> {
  const { rows } = await tx.query(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM brain_vocabulary_proposal
      WHERE workspace_id = $1 AND slot_position = $2
        AND pair_low = LEAST($3::text, $4::text) AND pair_high = GREATEST($3::text, $4::text)`,
    [workspaceId, position, fromNorm, toNorm],
  );
  return toProposalRow(rows[0], workspaceId);
}

/** One proposal by id, scoped to its workspace. */
async function loadProposal(
  tx: VocabularyExecutor,
  workspaceId: string,
  id: string,
): Promise<ProposalRow | undefined> {
  const { rows } = await tx.query(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM brain_vocabulary_proposal
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return toProposalRow(rows[0], workspaceId);
}

function entitlementMessage(position: SlotPosition, ctx: BrainPrincipalContext): string {
  if (ctx.origin !== "authenticated") {
    return (
      `An alias decision needs a resolved reader identity; this one is "${ctx.origin}". An ` +
      "unresolvable identity at a write that re-keys a corpus is refused rather than assumed."
    );
  }
  return (
    // "Deciding", not "approving": this refusal is returned for a REJECTION too
    // — which on an approved row is a removal, the graver verb of the two — and
    // the string ships to #5025's 403 body.
    `Deciding an alias at the ${position} position needs the owner or admin entitlement; this ` +
    `reader is "${ctx.role ?? "no org role"}". Subject and object edges are entity edges, and an ` +
    "entity edge's evidence is a warehouse row — a grant the brain's ACL grammar has no arm for " +
    "(T11 §3(d), #5016). Predicate edges carry the lower bar because their evidence lives " +
    "inside the " +
    "brain's own ACL'd corpus and a verb phrase discloses nothing."
  );
}

type ResolvedDirection =
  | { readonly ok: true; readonly fromNorm: string; readonly toNorm: string }
  | { readonly ok: false; readonly refusal: AliasDecisionRefusal; readonly message: string };

/**
 * Fix the edge's direction — the AC's *"approval sets direction where absent"*.
 *
 * An undirected proposal has no canonical side, so approval must supply one and
 * is REFUSED without it. A directed proposal may be confirmed with a matching
 * direction (which is what a UI that always sends one does) but never flipped:
 * a silent flip would let a reviewer who mis-clicked re-key the corpus in the
 * direction opposite to the one they read, and the two are indistinguishable
 * afterwards.
 */
function resolveDirection(row: ProposalRow, direction?: AliasDirection): ResolvedDirection {
  if (direction === undefined) {
    if (!row.directed) {
      return {
        ok: false,
        refusal: "direction-required",
        message:
          `Proposal ${row.id} is undirected — neither "${row.from_norm}" nor "${row.to_norm}" is ` +
          "warehouse-derived, so nothing in the evidence says which spelling is canonical. " +
          "Approval must supply the direction; picking one here would re-key the corpus on a " +
          "guess nobody made.",
      };
    }
    return { ok: true, fromNorm: row.from_norm, toNorm: row.to_norm };
  }

  const fromNorm = lexicalNorm(direction.fromNorm);
  const toNorm = lexicalNorm(direction.toNorm);
  const pair = [row.from_norm, row.to_norm];
  if (!pair.includes(fromNorm) || !pair.includes(toNorm) || fromNorm === toNorm) {
    return {
      ok: false,
      refusal: "direction-not-in-pair",
      message:
        `The supplied direction "${fromNorm}" → "${toNorm}" is not an ordering of proposal ` +
        `${row.id}'s pair ("${row.from_norm}", "${row.to_norm}"). A decision may order the pair a ` +
        "reviewer saw; it may not substitute a different one.",
    };
  }

  if (row.directed && (fromNorm !== row.from_norm || toNorm !== row.to_norm)) {
    return {
      ok: false,
      refusal: "direction-conflict",
      message:
        `Proposal ${row.id} was proposed as "${row.from_norm}" → "${row.to_norm}", and the ` +
        `decision supplies "${fromNorm}" → "${toNorm}". A directed proposal is not flipped at ` +
        "approval: the reviewer read one direction, and re-keying in the other is indistinguishable " +
        "from the one they approved. Reject this proposal and author the edge you want.",
    };
  }

  return { ok: true, fromNorm, toNorm };
}

/** Approve: claim → apply → stamp, all inside the caller's transaction. */
async function approveProposal(
  tx: VocabularyExecutor,
  workspaceId: string,
  row: ProposalRow,
  direction: { readonly fromNorm: string; readonly toNorm: string },
  approver: AliasApprover,
): Promise<AliasDecisionOutcome> {
  // CLAIM. Conditional on `pending`, so an already-decided row (or one a
  // concurrent decision took) yields zero rows and is reported truthfully
  // rather than applied twice. `approved` is deliberately NOT claimable here:
  // an approved pair's only remaining transition is removal.
  const claimed = await tx.query(
    // `::text`, and it is not cosmetic — it is the same spelling
    // `claimPendingAmendment` uses, for the same reason. The `pg` driver parses
    // a `timestamptz` into a JS `Date`, which holds MILLISECONDS while Postgres
    // stores microseconds; round-tripping the parsed value makes the stamp's
    // `claimed_at = $` compare a truncated token against the stored one and
    // never match. Carried as text, the token survives the round trip exactly.
    `UPDATE brain_vocabulary_proposal
        SET status = 'applying', claimed_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
      RETURNING claimed_at::text AS claimed_at`,
    [workspaceId, row.id],
  );
  const claim = claimed.rows[0] as { claimed_at: string } | undefined;
  if (claim === undefined) return { kind: "not_decidable", id: row.id };

  // APPLY. `approveAliasEdge` re-takes the same advisory lock (re-entrant
  // within the transaction, so it costs nothing) and recomputes the closure.
  // `approvedBy` is NULL for the AUTO path only — migration 0189 calls that
  // column "the one column an audit of a workspace-wide re-key reads first", and
  // a machine-path sentinel there would be indistinguishable from a user id.
  // The human path always records something; see {@link recordedApprover} for
  // the third value and why a no-auth deployment needs one.
  const applied = await approveAliasEdge(tx, workspaceId, {
    position: row.slot_position,
    fromNorm: direction.fromNorm,
    toNorm: direction.toNorm,
    approvedBy: recordedApprover(approver),
  });

  if (!applied.ok) {
    // THROWN, not returned. The claim above is already written in this
    // transaction, and only a rollback undoes it — returning the refusal here
    // would COMMIT the claim and strand the row `applying`, invisible to the
    // queue and undecidable forever. `decideAliasProposal` catches this exact
    // class outside the runner and converts it back into the typed refusal the
    // caller sees; the throw's only job is to reach the ROLLBACK first.
    throw new AliasApplyRefusedError(row.id, applied.refusal, applied.message);
  }

  // STAMP. Conditional on the claim token, so a decision that somehow outlived
  // its claim can never stamp over a takeover's. Unreachable today (the claim
  // and the stamp share a transaction under a workspace lock) and kept because
  // #5024 is what makes it reachable — see the module header.
  const stamped = await tx.query(
    `UPDATE brain_vocabulary_proposal
        SET status = 'approved',
            from_norm = $3, to_norm = $4, directed = TRUE,
            reviewed_by = $5, reviewed_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'applying'
        AND claimed_at = $6::timestamptz
      RETURNING id`,
    [
      workspaceId,
      row.id,
      direction.fromNorm,
      direction.toNorm,
      recordedApprover(approver),
      claim.claimed_at,
    ],
  );
  if (stamped.rows.length === 0) {
    // The edge landed but this caller no longer owns the row. Throwing rolls
    // BOTH back, which is the only honest outcome: a committed edge whose
    // proposal says `pending` would be re-approvable, and the second approval
    // would refuse with `already-aliased` for a decision this one made.
    throw new Error(
      `decideAliasProposal: proposal ${row.id} was no longer claimed at stamp time (workspace ` +
        `${workspaceId}). Rolling back rather than committing an approved edge whose proposal row ` +
        "does not record the approval.",
    );
  }

  // `directed = TRUE` above is not bookkeeping. Once approved, the pair HAS a
  // direction — the one this decision set — and leaving the flag false would
  // make a later reader think the stored order was still arbitrary.
  return { kind: "approved", id: row.id };
}

/**
 * Reject: `pending → rejected`, or `approved → rejected` (a REMOVAL).
 *
 * One conditional update in both cases, and the removal runs BEFORE it — the
 * edge must be gone and the closure rebuilt before the row claims it is. An
 * `applying` row is deliberately not rejectable: it is a decision in flight
 * inside another transaction that this one cannot see anyway (the workspace
 * lock serializes them), so admitting it would only make the arm look like it
 * handles a race it structurally cannot reach.
 */
async function rejectProposal(
  tx: VocabularyExecutor,
  workspaceId: string,
  row: ProposalRow,
  // HUMAN only, so "a machine never rejects" holds at the WRITE and not merely
  // at the seam's entry check. The one call site is already narrowed to this by
  // the backstop above, so the tightening is free — and it means a future
  // second caller cannot reintroduce the inversion by skipping the check.
  approver: Extract<AliasApprover, { kind: "human" }>,
): Promise<AliasDecisionOutcome> {
  if (row.status !== "pending" && row.status !== "approved") {
    return { kind: "not_decidable", id: row.id };
  }

  const removedEdge = row.status === "approved";
  if (removedEdge) {
    // Removal is a RECOMPUTATION, not a destructive write: `removeAliasEdge`
    // clears the position's closure, drops the edge, and rebuilds — so an edge
    // this one was hiding lands back on its prior target.
    const removed = await removeAliasEdge(
      tx,
      workspaceId,
      row.slot_position,
      row.from_norm,
    );
    if (!removed) {
      // The proposal says `approved` and the edge is not there. That is a
      // vocabulary written by something other than this seam (a hand-written
      // DELETE, a restore) — surfaced rather than absorbed, because silently
      // stamping `rejected` would leave the operator believing a removal ran.
      log.error(
        {
          workspaceId,
          proposalId: row.id,
          position: row.slot_position,
          fromNorm: row.from_norm,
        },
        "Alias removal found no approved edge for a proposal recorded as approved — the vocabulary was written outside this seam",
      );
      throw new Error(
        `decideAliasProposal: proposal ${row.id} is recorded approved but "${row.from_norm}" has no ` +
          `approved edge at the ${row.slot_position} position (workspace ${workspaceId}). Refusing ` +
          "to stamp a removal that removed nothing.",
      );
    }
  }

  const rejected = await tx.query(
    `UPDATE brain_vocabulary_proposal
        SET status = 'rejected', reviewed_by = $3, reviewed_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = $4
      RETURNING id`,
    [
      workspaceId,
      row.id,
      recordedApprover(approver),
      row.status,
    ],
  );
  if (rejected.rows.length === 0) {
    // Unreachable under the workspace lock, and thrown rather than reported so
    // a removal that already ran cannot commit beside a row that still says
    // `approved` — which would make the pair re-proposable and re-approvable.
    throw new Error(
      `decideAliasProposal: proposal ${row.id} left status "${row.status}" mid-decision (workspace ` +
        `${workspaceId}). Rolling back rather than committing a removal the row does not record.`,
    );
  }

  return { kind: "rejected", id: row.id, removedEdge };
}

/**
 * A vocabulary refusal on its way out through the ROLLBACK.
 *
 * Internal: it exists only so a typed refusal can unwind the transaction that
 * wrote the claim and still reach the caller as a refusal rather than as an
 * error. Not exported, because a caller catching it would be reaching around
 * {@link decideAliasProposal}'s return type for a value that is already in it.
 */
class AliasApplyRefusedError extends Error {
  constructor(
    readonly proposalId: string,
    readonly refusal: AliasApprovalRefusal,
    readonly refusalMessage: string,
  ) {
    super(`alias apply refused (${refusal}): ${refusalMessage}`);
    this.name = "AliasApplyRefusedError";
  }
}
