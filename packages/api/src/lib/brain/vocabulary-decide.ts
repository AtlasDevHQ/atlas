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
 * The condition under which the cost returns is worth naming, because #5024 was
 * where it would: ADR-0037 §7 puts the drift re-key — a sequential rewrite of
 * every affected `brain_facts` row — inside this transaction. **#5024 landed it
 * there and did not move it**, so the guarantee above still holds unqualified:
 * `applying` never commits, no row is ever observed in it, and `claimed_at` is
 * a token nothing can take over. See {@link rekeyDriftedFacts} for why that was
 * the choice rather than the default.
 *
 * If that rewrite is ever moved OUT of this transaction to keep it short,
 * `applying` becomes observable, `claimed_at` becomes a real takeover token, and
 * every paragraph of `decide.ts`'s compensation machinery becomes load-bearing
 * here too — along with the `applying`-is-unreachable assertion in
 * `vocabulary-decide-pg.test.ts`, which would flip from a property to a bug. The
 * column exists so that change is a code change rather than a migration on a hot
 * table.
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
 * What it did NOT buy before #5024, stated because an earlier version of this
 * block claimed it and the claim did not survive reading: it was not what
 * avoided a 40P01 against that importer. The rows this module held under a
 * lock-second ordering were `brain_vocabulary_proposal` rows, and the importer
 * never reads that table at all (bundle-scope classifies it `stays`) — so there
 * was no second orderable resource and no wait-for cycle could form. The
 * importer's real deadlock hazard was one layer down, against `approveAliasEdge`,
 * which takes this lock itself before touching a row;
 * `migrate-roundtrip-pg.test.ts` carries THAT pair (#5022).
 *
 * **A second orderable resource exists now.** ADR-0037 §7's drift re-key
 * rewrites `brain_facts` — a table the importer DOES write — inside this
 * transaction. Locking first is what keeps a future re-discovery a no-op.
 *
 * Be precise about what that is worth today, because the tempting stronger claim
 * is false: **no interleaving falsifies the order.** Every actor takes its
 * advisory locks before it UPDATEs a row, and the importer only INSERTs
 * `brain_facts` (an uncommitted INSERT blocks no UPDATE), so no wait-for cycle
 * is reachable for either ordering. The inverted order is a LATENT hazard —
 * reachable the moment the importer UPDATEs an existing fact row before taking
 * 5022. It is pinned as an INVARIANT in `vocabulary-decide-pg.test.ts` ("decide
 * locks first"), and `vocabulary-rekey-pg.test.ts` only exercises the
 * decide-vs-concurrent-writer pair for absence of 40P01.
 *
 * ## The SECOND namespace, and why publish needs one at all (#5024)
 *
 * {@link lockIdentityMutation} takes {@link IDENTITY_MUTATION_LOCK_NAMESPACE}
 * (5024) immediately after the vocabulary lock, in that fixed order. The publish
 * gate takes 5024 and nothing else; the region importer takes 5022 and nothing
 * else. Nothing that holds 5024 ever asks for 5022, so no cycle can form.
 *
 * It exists because the publish gate READ collision pairs unlocked and stamped
 * `valid_to` afterwards, so a REMOVAL landing in that window retired a belief
 * whose collision no longer held. Publish takes 5024 before its first read now,
 * which is what closed it. `lib/brain/identity.ts` carries the full
 * argument, including why neither 4771 nor 5022 could serve.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  IDENTITY_MUTATION_LOCK_NAMESPACE,
  IDENTITY_MUTATION_LOCK_SQL,
  IDENTITY_MUTATION_LOCK_RESET_SQL,
  IDENTITY_MUTATION_LOCK_TIMEOUT_SQL,
  SLOT_COLUMNS,
  identityKeySql,
  isSlotPosition,
  lexicalNorm,
  type SlotPosition,
} from "@atlas/api/lib/brain/identity";
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
import { isPairVisible } from "@atlas/api/lib/brain/vocabulary-visibility";
import {
  emptySide,
  loadPairPopulation,
  type EmptySide,
  type PairPopulation,
} from "@atlas/api/lib/brain/vocabulary-surfaces";

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
  /**
   * Correlates this decision's server-side lines with the originating request.
   *
   * Threaded rather than omitted because the refusals here are the ones an
   * operator gets asked about — *"an admin says they cannot remove this edge"* —
   * and without it the 409 the approver saw cannot be joined to the log line
   * that explains it.
   *
   * ⚠️ Every refusal line on BOTH verbs stamps it, plus the removal's visibility
   * gate and the authored-edge success line. It briefly reached only the removal
   * gate, which made this docstring describe an intent rather than the state —
   * an operator joining on it would have found the removal 409s and silently
   * missed every authoring refusal, which is the worse half to lose since the
   * authoring path is the one with five distinct refusals.
   */
  readonly requestId?: string;
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
      // read and the claim that follows it are one atomic decision.
      //
      // BOTH namespaces since #5024, in the fixed order 5022 → 5024. The
      // vocabulary lock is what makes the check-then-write pairs atomic; the
      // identity lock is what serializes the drift re-key below against the
      // publish gate's SELECT-then-STAMP — which took no advisory lock at all
      // until #5024 put it on this same namespace. The module header's note
      // that this seam's lock is "not what avoids a 40P01 against the region
      // importer" is now HALF stale and the surviving half matters: the re-key
      // writes `brain_facts`, which the importer does write, so the ordering
      // here is what keeps that a no-op — see the header.
      await lockIdentityMutation(tx, workspaceId);

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
// Author (#5087)
// ---------------------------------------------------------------------------

/** One edge a human writes directly. Norms, picked — never typed. */
export interface AliasAuthoringInput {
  readonly position: SlotPosition;
  /** The norm being aliased away. Re-normed before anything reads it. */
  readonly fromNorm: string;
  /** The norm it is authored onto. */
  readonly toNorm: string;
}

/** Why direct authoring was refused. */
export type AliasAuthoringRefusal =
  /** The author does not clear the owner/admin bar. */
  | "not-entitled"
  /** The author's workspace is not the target. A scope escalation. */
  | "workspace-mismatch"
  /**
   * One or both norms have no live claim at that position for this reader.
   *
   * Its own member rather than a `degenerate-norm` reuse, because the two are
   * opposite diagnoses: `degenerate-norm` says the string asserts nothing,
   * this says the string is fine and the CORPUS has never produced it. An
   * approver told the first would retype; told the second they go look for the
   * spelling that does exist, which is the correct next action.
   */
  | "empty-population"
  /** Permanent rejection memory — this pair was rejected or removed before. */
  | "previously-rejected"
  /**
   * Malformed before the corpus was ever consulted.
   *
   * NARROWED to the two members this path can actually produce, rather than
   * inheriting `AliasProposalRefusal` wholesale. `confidence-out-of-range` and
   * `warehouse-key-at-predicate` are producer-shaped and unreachable here — this
   * seam sets confidence itself and never accepts a source class — so admitting
   * them made the route map two dead codes and made the OpenAPI 400 advertise
   * causes that cannot occur. Same narrowing `resolveDirection`'s two members
   * get twenty lines down, for the same reason.
   */
  | Extract<AliasProposalRefusal, "degenerate-norm" | "self-edge">
  /** The vocabulary itself refused the edge. */
  | AliasApprovalRefusal
  /** A direction that contradicts an existing directed proposal for the pair. */
  | "direction-conflict"
  | "direction-not-in-pair";

/** What direct authoring did. */
export type AliasAuthoringOutcome =
  /** The edge is approved and in force. `id` is the proposal row behind it. */
  | { readonly kind: "authored"; readonly id: string; readonly convergedOnProposal: boolean }
  /** The pair is already an approved edge. Nothing to author. */
  | { readonly kind: "already_approved"; readonly id: string }
  /**
   * A decision on this pair is in flight in another transaction (`applying`).
   *
   * Unreachable while the workspace lock is held by every writer, and reported
   * rather than thrown for {@link AliasDecisionOutcome.not_decidable}'s reason:
   * *"nothing for you to decide"* is a truthful answer, and retrying it into a
   * second apply is the thing the claim exists to prevent.
   */
  | { readonly kind: "not_decidable"; readonly id: string }
  | {
      readonly kind: "refused";
      readonly refusal: AliasAuthoringRefusal;
      readonly message: string;
    };

/** {@link authorAliasEdge}'s seams. Both default to the real thing. */
export interface AliasAuthoringDeps extends AliasDecideDeps {
  /**
   * The population check. Defaults to {@link loadPairPopulation}.
   *
   * Injectable because the refusal it drives is the one AC whose falsifier has
   * to observe a corpus state — and because it must run on the SAME `tx` as the
   * write, which a caller cannot arrange from outside.
   */
  readonly loadPopulation?: typeof loadPairPopulation;
}

/**
 * The AUTHORING bar — owner/admin at EVERY position.
 *
 * ⚠️ Deliberately stricter than {@link approverEntitled}, which grants any
 * authenticated member the predicate position. That is not an inconsistency and
 * the difference is worth stating, because the obvious tidy-up is to call the
 * existing function:
 *
 *   - **Approving** a predicate alias adjudicates evidence a producer gathered
 *     from inside the brain's own ACL'd corpus. The reviewer is checking a
 *     claim somebody else made, and the content (a verb phrase) discloses
 *     nothing.
 *   - **Authoring** one creates the assertion from nothing. There is no
 *     evidence, no producer and no threshold — the entire authority is that a
 *     person took it — and what it produces is a workspace-wide re-key.
 *
 * ADR-0037 §6 says exactly this: *"direct human authoring is admitted, on the
 * owner/admin entitlement"* — the only owner/admin gate the brain has
 * (`acl.ts:1015-1019` is the same bar, spelled for the audit override).
 *
 * `unauthenticated-local` clears it, matching `approverEntitled` and
 * `correctFact`: that deployment has DECLARED the local operator is the only
 * identity there is. `unresolved` clears neither.
 */
function authorEntitled(ctx: BrainPrincipalContext): boolean {
  if (ctx.origin === "unauthenticated-local") return true;
  if (ctx.origin !== "authenticated") return false;
  return ctx.role === "owner" || ctx.role === "admin";
}

/**
 * Write one alias edge directly — a `human`-sourced proposal DECIDED `approved`
 * in the same transaction (#5087, ADR-0037 §6 as amended 2026-08-06).
 *
 * ## Why this is new machinery and not a compose
 *
 * {@link proposeAliasEdge} and {@link decideAliasProposal} each open their OWN
 * transaction. Calling them in sequence gives two commits, and the window
 * between them is not academic: a crash there leaves a `pending` human proposal
 * that no queue existed to show (the Pending pane is child 3), and a re-key
 * failure in the second leaves a committed proposal for an edge that was never
 * applied. One transaction is the only shape in which *"authored means in
 * force"* holds by construction.
 *
 * ## Why it writes THROUGH the proposal table rather than calling
 * {@link approveAliasEdge} directly
 *
 * The direct spelling is one line shorter and it has a hole. **Rejection memory
 * lives on the proposal row.** A hand-authored edge later removed would leave
 * nothing to stamp `rejected` on — `rejectProposal` needs a row — so the next
 * producer run re-proposes the pair a human just deleted, and the removal does
 * not stick. That is #4507's failure returning through the one path authoring
 * exists to serve, and it is why ADR-0037 §6's amendment names the proposal
 * table explicitly.
 *
 * ## Converging on an existing pending row is FORCED, not preferred
 *
 * Migration 0190 has a unique constraint on the unordered pair, so a second row
 * for a pair already queued cannot be inserted at all. The choice is therefore
 * between converging and refusing — and converging is also the honest reading:
 * a human authoring a pair a producer already proposed IS deciding that
 * proposal. The row keeps the producer's `source_class`, because the proposal
 * genuinely came from there; what the human supplies is the decision and the
 * direction.
 *
 * ## Order of checks
 *
 * Entitlement and shape are refused BEFORE the transaction opens — they need no
 * corpus and a scope escalation must not read a row under another workspace's
 * identity. The population check runs INSIDE it, on the same `tx`, so the
 * corpus it observes is the one the re-key will rewrite.
 *
 * @throws when the underlying write fails — including a closure that does not
 *   converge (`VocabularyClosureError`). The transaction has already rolled
 *   back, so there is no proposal row and no edge.
 */
export async function authorAliasEdge(
  workspaceId: string,
  input: AliasAuthoringInput,
  author: BrainPrincipalContext,
  deps: AliasAuthoringDeps = {},
): Promise<AliasAuthoringOutcome> {
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const newProposalId = deps.newProposalId ?? randomUUID;
  const loadPopulation = deps.loadPopulation ?? loadPairPopulation;
  const { position } = input;

  if (author.workspaceId !== workspaceId) {
    log.error(
      { workspaceId, authorWorkspaceId: author.workspaceId, position, requestId: deps.requestId },
      "Alias authoring refused — the author's workspace is not the target",
    );
    return {
      kind: "refused",
      refusal: "workspace-mismatch",
      message:
        `The author's workspace (${author.workspaceId}) is not the target (${workspaceId}). ` +
        "One workspace's admin never authors another's vocabulary.",
    };
  }

  if (!authorEntitled(author)) {
    log.warn(
      { workspaceId, position, origin: author.origin, role: author.role, requestId: deps.requestId },
      "Alias authoring refused — the author does not clear the owner/admin bar",
    );
    return {
      kind: "refused",
      refusal: "not-entitled",
      message:
        author.origin === "authenticated"
          ? `Authoring an alias needs the owner or admin entitlement; this reader is ` +
            `"${author.role ?? "no org role"}". Direct authoring creates an assertion from no ` +
            "evidence at all and re-keys the workspace, so ADR-0037 §6 puts it behind the only " +
            "owner/admin gate the brain has — a bar higher than APPROVING a predicate alias, " +
            "where a producer gathered the evidence and a reviewer is only adjudicating it."
          : `Authoring an alias needs a resolved reader identity; this one is "${author.origin}". ` +
            "An unresolvable identity at a write that re-keys a corpus is refused rather than assumed.",
    };
  }

  // Re-normed, never trusted — `approveAliasEdge`'s reason, applied before the
  // corpus is consulted so the population check and the write ask about the
  // same string.
  const fromNorm = lexicalNorm(input.fromNorm);
  const toNorm = lexicalNorm(input.toNorm);

  if (fromNorm === "" || toNorm === "") {
    return {
      kind: "refused",
      refusal: "degenerate-norm",
      message:
        `An alias edge needs two non-empty norms; "${input.fromNorm}" → "${input.toNorm}" ` +
        `normalizes to "${fromNorm}" → "${toNorm}". A surface made only of separators asserts ` +
        "nothing and has no slot to alias.",
    };
  }
  if (fromNorm === toNorm) {
    return {
      kind: "refused",
      refusal: "self-edge",
      message:
        `"${input.fromNorm}" and "${input.toNorm}" both normalize to "${fromNorm}", so they ` +
        "already share an identity key and there is nothing to alias.",
    };
  }

  try {
    return await withTransaction(async (tx) => {
      // 5022 then 5024, the fixed order every writer here takes.
      await lockIdentityMutation(tx, workspaceId);

      // THE population check, on the same `tx` and therefore the same snapshot
      // as the write. See `vocabulary-surfaces.ts` for why an edge whose norm no
      // fact ever produced is the failure that looks exactly like success.
      const population = await loadPopulation(tx, author, { position, fromNorm, toNorm });
      const empty = emptySide(population);
      if (empty !== null) {
        log.warn(
          {
            workspaceId,
            position,
            fromNorm,
            toNorm,
            fromClaims: population.from.claims,
            toClaims: population.to.claims,
            emptySide: empty,
            decision: population.decision,
            requestId: deps.requestId,
          },
          "Alias authoring refused — a side has no live claim at this position",
        );
        return {
          kind: "refused",
          refusal: "empty-population",
          message: emptyPopulationMessage(position, population, empty),
        };
      }

      const existing = await findProposalByPair(tx, workspaceId, position, fromNorm, toNorm);

      if (existing !== undefined) {
        // Rejection memory FIRST, exactly as `proposeAliasEdge` orders it. A
        // pair a human rejected or REMOVED is refused forever, and authoring is
        // not an exemption from that — it is the path the removal was protecting
        // against being undone by a producer, and letting it undo the removal
        // itself would make the rule mean nothing.
        //
        // ⚠️ This is a real cost and it is the one an operator will hit: a pair
        // removed by mistake cannot be re-authored. 0190's rejection memory is
        // permanent by design (#4507), so the recovery is a database console —
        // which is why the removal confirmation carries the blast-radius preview
        // rather than being a bare button.
        if (existing.status === "rejected") {
          log.warn(
            { workspaceId, position, fromNorm, toNorm, proposalId: existing.id, requestId: deps.requestId },
            "Alias authoring refused — the pair carries permanent rejection memory",
          );
          return {
            kind: "refused",
            refusal: "previously-rejected",
            message:
              `"${fromNorm}" and "${toNorm}" were previously rejected or removed at the ${position} ` +
              "position, and that decision is permanent (#4507): the rejected row is what stops a " +
              "producer re-proposing what a human removed, so authoring over it would make every " +
              "removal undoable by the next run. Re-establishing this merge needs the rejection " +
              "cleared at the database.",
          };
        }
        if (existing.status === "approved") {
          return { kind: "already_approved", id: existing.id };
        }
        if (existing.status !== "pending") {
          return { kind: "not_decidable", id: existing.id };
        }
      }

      // The proposal row. INSERTED when the pair is new, converged on when a
      // producer already queued it — 0190's unordered-pair constraint makes
      // that not a choice (see the docstring).
      const row =
        existing ??
        (await insertAuthoredProposal(tx, workspaceId, newProposalId(), position, {
          fromNorm,
          toNorm,
          proposedBy: recordedApprover({ kind: "human", ctx: author }) ?? LOCAL_OPERATOR_ACTOR,
        }));

      // Routed through `resolveDirection` rather than passing the authored pair
      // straight to `approveProposal`. For a freshly inserted row it agrees by
      // construction; for a CONVERGED one it is what refuses to silently flip a
      // producer's directed proposal — the same protection an approval gets, and
      // skipping it here would make authoring the way around it.
      const resolved = resolveDirection(row, { fromNorm, toNorm });
      if (!resolved.ok) {
        return {
          kind: "refused",
          // Narrowed to the two members `resolveDirection` can return for a
          // SUPPLIED direction. `direction-required` is unreachable — authoring
          // always supplies one — and admitting it to the union would put a
          // refusal in the type that no caller can render a sentence for.
          refusal:
            resolved.refusal === "direction-conflict"
              ? "direction-conflict"
              : "direction-not-in-pair",
          message: resolved.message,
        };
      }

      const decided = await approveProposal(tx, workspaceId, row, resolved, {
        kind: "human",
        ctx: author,
      });

      switch (decided.kind) {
        case "approved":
          log.info(
            {
              workspaceId,
              position,
              fromNorm,
              toNorm,
              proposalId: decided.id,
              convergedOnProposal: existing !== undefined,
              sourceClass: row.source_class,
              requestId: deps.requestId,
            },
            "Alias edge authored directly — a human-decided proposal and its edge committed together",
          );
          return {
            kind: "authored",
            id: decided.id,
            convergedOnProposal: existing !== undefined,
          };
        case "not_decidable":
          return { kind: "not_decidable", id: decided.id };
        case "refused":
          // Unreachable: `approveProposal` refuses only through the thrown
          // `AliasApplyRefusedError` the outer catch converts. Kept so a future
          // arm cannot compile into an authored-but-not-applied report.
          return { kind: "refused", refusal: "already-aliased", message: decided.message };
        case "rejected":
          throw new Error(
            `authorAliasEdge: the approve path reported a rejection for proposal ${decided.id} ` +
              `(workspace ${workspaceId}). That transition is unreachable from here — refusing ` +
              "rather than reporting an authoring that removed an edge.",
          );
      }
    });
  } catch (err) {
    if (err instanceof AliasApplyRefusedError) {
      log.warn(
        { workspaceId, position, fromNorm, toNorm, refusal: err.refusal, requestId: deps.requestId },
        `Alias authoring refused by the vocabulary — ${err.refusalMessage}`,
      );
      return { kind: "refused", refusal: err.refusal, message: err.refusalMessage };
    }
    throw err;
  }
}

/** Why a removal was refused. */
export type AliasRemovalRefusal =
  | "not-entitled"
  | "workspace-mismatch"
  | "degenerate-norm"
  /** No approved edge joins this pair at this position. */
  | "not-in-force";

/** What a removal did. */
export type AliasRemovalOutcome =
  /**
   * The edge is gone, the closure is rebuilt, the corpus is re-keyed, and the
   * pair carries permanent rejection memory. `id` is the row that holds it.
   */
  | { readonly kind: "removed"; readonly id: string; readonly memoryCreated: boolean }
  /** The pair was already rejected or removed. Idempotent, not an error. */
  | { readonly kind: "already_removed"; readonly id: string }
  | {
      readonly kind: "refused";
      readonly refusal: AliasRemovalRefusal;
      readonly message: string;
    };

/**
 * Remove one approved edge from the *In force* pane, leaving rejection memory
 * (#5087).
 *
 * ## Why this exists rather than a bare `decideAliasProposal(rejected)` call
 *
 * For an edge this seam authored or approved there IS a proposal row, and
 * rejecting it by id is exactly right. But an edge copied by the region importer
 * has NO proposal row — #5035's bundle scope classifies
 * `brain_vocabulary_proposal` as `stays`, so edges travel and proposals do not.
 * Removing such an edge through `removeAliasEdge` alone drops it with nothing to
 * stamp `rejected` on, and the next producer run re-proposes the pair a human
 * just deleted. That is #4507's failure, and it would arrive through the exact
 * surface the grill added to make removal recoverable.
 *
 * So the memory is CREATED when it is absent: a `human` row recording the edge
 * that exists, immediately rejected in the same transaction. The row is inserted
 * `approved` rather than `pending` because that is what it describes — an edge
 * already in force — and because {@link rejectProposal}'s `approved → rejected`
 * arm is the transition that performs the removal and the re-key.
 *
 * ## Addressed by PAIR, not by proposal id
 *
 * The pane renders norms, and the removal request should carry what the pane
 * rendered. It also makes the call direction-agnostic — `findProposalByPair`
 * asks 0190's unordered-pair question, and the edge's own stored order decides
 * which norm is the child — so a UI that transposed the pair removes the right
 * edge instead of failing to find one.
 *
 * @throws when the underlying write fails. The transaction rolls back whole, so
 *   the edge is still in force and nothing was stamped.
 */
export async function removeInForceAliasEdge(
  workspaceId: string,
  input: AliasAuthoringInput,
  remover: BrainPrincipalContext,
  deps: AliasDecideDeps = {},
): Promise<AliasRemovalOutcome> {
  const withTransaction = deps.withTransaction ?? withBrainTransaction;
  const newProposalId = deps.newProposalId ?? randomUUID;
  const { position } = input;

  if (remover.workspaceId !== workspaceId) {
    log.error(
      { workspaceId, removerWorkspaceId: remover.workspaceId, position, requestId: deps.requestId },
      "Alias removal refused — the remover's workspace is not the target",
    );
    return {
      kind: "refused",
      refusal: "workspace-mismatch",
      message:
        `The remover's workspace (${remover.workspaceId}) is not the target (${workspaceId}). ` +
        "One workspace's admin never edits another's vocabulary.",
    };
  }

  // The AUTHORING bar, not the approving one. A removal is the graver verb of
  // the two — it drops an edge somebody approved, re-keys the corpus back, and
  // writes memory no producer can undo — so admitting it at the lower predicate
  // bar would make the strictness of {@link authorEntitled} decorative: the same
  // reader could not author `a → b` but could delete it.
  if (!authorEntitled(remover)) {
    log.warn(
      { workspaceId, position, origin: remover.origin, role: remover.role, requestId: deps.requestId },
      "Alias removal refused — the remover does not clear the owner/admin bar",
    );
    return {
      kind: "refused",
      refusal: "not-entitled",
      message:
        remover.origin === "authenticated"
          ? `Removing an alias needs the owner or admin entitlement; this reader is ` +
            `"${remover.role ?? "no org role"}". A removal drops an edge a human approved, ` +
            "re-keys every affected claim back, and writes permanent rejection memory — the same " +
            "authority direct authoring needs, in the other direction."
          : `Removing an alias needs a resolved reader identity; this one is "${remover.origin}".`,
    };
  }

  const fromNorm = lexicalNorm(input.fromNorm);
  const toNorm = lexicalNorm(input.toNorm);
  if (fromNorm === "" || toNorm === "" || fromNorm === toNorm) {
    return {
      kind: "refused",
      refusal: "degenerate-norm",
      message:
        `A removal needs two distinct non-empty norms; "${input.fromNorm}" → "${input.toNorm}" ` +
        `normalizes to "${fromNorm}" → "${toNorm}".`,
    };
  }

  return withTransaction(async (tx) => {
    await lockIdentityMutation(tx, workspaceId);

    // ⚠️ THE VISIBILITY GATE, and its absence was a disclosure hole rather than
    // an omission. Everything below this line answers questions about a specific
    // pair, and the answers differ — a real edge removes, an imagined one is
    // refused — so without this a reader could learn whether an entity edge
    // exists by naming it, which is precisely the population the *In force*
    // pane's scoping withholds. See {@link isPairVisible}.
    //
    // Folded into the SAME refusal as "not in force", deliberately:
    // `admin-brain-facts.ts`'s retract 404 is the precedent —
    // *"deliberately indistinguishable, so the response cannot confirm the
    // existence of a fact the reader may not see"* — and a distinct
    // `not-visible` arm would restore in words the oracle this closes in rows.
    //
    // Runs on the SAME `tx` as the write, so the corpus it reads is the one the
    // removal is about, and it runs BEFORE any proposal row is read.
    const visible = await isPairVisible(
      tx,
      position,
      remover,
      { fromNorm, toNorm },
      { requestId: deps.requestId },
    );
    if (!visible) {
      log.warn(
        {
          workspaceId,
          position,
          fromNorm,
          toNorm,
          origin: remover.origin,
          role: remover.role,
          requestId: deps.requestId,
        },
        "Alias removal refused — the pair is not visible to this reader at this position (reported as not-in-force, which is also what an absent edge returns)",
      );
      return { kind: "refused", refusal: "not-in-force", message: notInForceMessage(position) };
    }

    const existing = await findProposalByPair(tx, workspaceId, position, fromNorm, toNorm);
    if (existing !== undefined) {
      if (existing.status === "rejected") return { kind: "already_removed", id: existing.id };
      if (existing.status !== "approved") {
        // A `pending` row is not an in-force edge — it is child 3's queue item —
        // and an `applying` one is a decision in flight. Neither is removable
        // here, and reporting them as "not in force" is truthful: the pane this
        // call serves shows approved edges only.
        // Shares the sentence for `notInForceMessage`'s reason: a reader who
        // could tell "there is a PENDING proposal for this pair" from "no such
        // edge" has learned the pair exists, which at an entity position is the
        // confidential bit.
        return { kind: "refused", refusal: "not-in-force", message: notInForceMessage(position) };
      }
      const rejected = await rejectProposal(tx, workspaceId, existing, {
        kind: "human",
        ctx: remover,
      });
      return removalFromDecision(rejected, existing.id, false, position);
    }

    // No proposal row. Either the edge does not exist, or it was copied in by
    // the region importer — and only the edge table can say which.
    const stored = await findApprovedEdgeByPair(tx, workspaceId, position, fromNorm, toNorm);
    if (stored === undefined) {
      return { kind: "refused", refusal: "not-in-force", message: notInForceMessage(position) };
    }

    const id = newProposalId();
    // The memory row, recording the edge as it is STORED — `stored.fromNorm` is
    // the child, whatever order the caller asked in. Inserted `approved` and
    // rejected below in the same transaction, so it never commits describing an
    // edge that is still in force.
    await tx.query(
      `INSERT INTO brain_vocabulary_proposal
         (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
          confidence, status, proposed_by, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, 'human', 1, 'approved', $6, $6, now())`,
      [
        id,
        workspaceId,
        position,
        stored.fromNorm,
        stored.toNorm,
        recordedApprover({ kind: "human", ctx: remover }) ?? LOCAL_OPERATOR_ACTOR,
      ],
    );
    const rejected = await rejectProposal(
      tx,
      workspaceId,
      {
        id,
        slot_position: position,
        from_norm: stored.fromNorm,
        to_norm: stored.toNorm,
        directed: true,
        source_class: "human",
        confidence: 1,
        status: "approved",
      },
      { kind: "human", ctx: remover },
    );
    // LOGGED AFTER the reject, not before it. `rejectProposal` can throw — the
    // removal finds no edge, the stamp loses its row — and the whole transaction
    // rolls back, so a line emitted first is a claim of a write that never
    // committed, sitting in the log for an operator to find.
    const outcome = removalFromDecision(rejected, id, true, position);
    log.info(
      { workspaceId, position, fromNorm: stored.fromNorm, toNorm: stored.toNorm, proposalId: id },
      "Alias removal created the rejection memory an imported edge never had — without it the next producer run would re-propose the pair",
    );
    return outcome;
  });
}

/**
 * The ONE "nothing to remove" sentence, shared by four arms.
 *
 * ⚠️ Shared rather than tailored, and that is the guard: it is returned for an
 * edge that does not exist, for one the reader may not see, for one whose
 * decision is still pending or applying, and for one another decision reached
 * first (`removalFromDecision`'s `not_decidable`). If those read differently,
 * the difference IS the
 * oracle — a reader could tell "no such edge" from "an edge you may not see" by
 * comparing prose, having been stopped from telling them apart by outcome.
 *
 * It therefore names no norm. Echoing the requested pair back would be harmless
 * (the caller supplied it) but it invites a future edit to add "…which is
 * aliased onto X", and that sentence is the leak.
 */
function notInForceMessage(position: SlotPosition): string {
  return (
    `No approved edge at the ${position} position matches that pair, so there is nothing to ` +
    "remove. It may never have existed, it may already have been removed, the closure may have " +
    "been rebuilt by a removal further up the chain, or it may involve claims you are not " +
    "entitled to read — this surface does not distinguish those, deliberately."
  );
}

/** Map the shared reject arm's outcome onto this path's narrower union. */
function removalFromDecision(
  outcome: AliasDecisionOutcome,
  id: string,
  memoryCreated: boolean,
  position: SlotPosition,
): AliasRemovalOutcome {
  if (outcome.kind === "rejected") {
    if (!outcome.removedEdge) {
      // `rejectProposal` reports `removedEdge: false` only for a `pending →
      // rejected` transition, which the caller above has already excluded.
      // Thrown rather than reported as a removal, because the one thing this
      // function must never do is tell an approver an edge is gone while it is
      // still shaping identity.
      throw new Error(
        `removeInForceAliasEdge: proposal ${id} was rejected without removing an edge. The row was ` +
          "read as approved and the reject arm disagreed — refusing rather than reporting a " +
          "removal that removed nothing.",
      );
    }
    return { kind: "removed", id, memoryCreated };
  }
  if (outcome.kind === "not_decidable") {
    return { kind: "refused", refusal: "not-in-force", message: notInForceMessage(position) };
  }
  // `approved` and `refused` are both unreachable from the reject arm; the
  // exhaustive throw is what keeps a future arm from compiling into silence.
  throw new Error(
    `removeInForceAliasEdge: unexpected decision outcome "${outcome.kind}" for proposal ${id}.`,
  );
}

/** The stored order of an approved edge joining a pair, in either direction. */
async function findApprovedEdgeByPair(
  tx: VocabularyExecutor,
  workspaceId: string,
  position: SlotPosition,
  a: string,
  b: string,
): Promise<{ fromNorm: string; toNorm: string } | undefined> {
  const { rows } = await tx.query(
    `SELECT from_norm, to_norm FROM brain_vocabulary_edge
      WHERE workspace_id = $1 AND slot_position = $2
        AND LEAST(from_norm, to_norm) = LEAST($3::text, $4::text)
        AND GREATEST(from_norm, to_norm) = GREATEST($3::text, $4::text)`,
    [workspaceId, position, a, b],
  );
  const raw = rows[0];
  if (typeof raw !== "object" || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.from_norm !== "string" || typeof row.to_norm !== "string") return undefined;
  return { fromNorm: row.from_norm, toNorm: row.to_norm };
}

/** The refusal prose, naming WHICH side is empty. */
function emptyPopulationMessage(
  position: SlotPosition,
  population: PairPopulation,
  empty: EmptySide,
): string {
  // ⚠️ The WHOLE opening clause per arm, not a shared `${sides} has no live
  // claim` template. Under the template the `both` arm read *"neither "a" nor
  // "b" has no live claim"* — a double negative asserting the opposite of the
  // refusal it explains — because "neither" already carries the negation.
  // English does not let the two compose, so they do not share a sentence.
  // (The template also carried a ternary whose two branches were the identical
  // string — the remains of a `has`/`have` split that had already been lost,
  // and which no test could distinguish.)
  const clause =
    empty === "both"
      ? `Neither "${population.from.norm}" nor "${population.to.norm}" has a live claim at the ${position} position`
      : empty === "from"
        ? `"${population.from.norm}" has no live claim at the ${position} position`
        : `"${population.to.norm}" has no live claim at the ${position} position`;
  return (
    `${clause} ` +
    `(${population.from.norm}: ${population.from.claims}, ${population.to.norm}: ${population.to.claims}). ` +
    "An alias for a norm the corpus has never produced inserts cleanly, recomputes the closure, " +
    "re-keys zero rows and previews as 0 — indistinguishable from a merge that worked. Pick both " +
    "sides from the surfaces actually present rather than typing a norm: `lexicalNorm` folds case " +
    "and separators, so the spelling you expect is often not the one the pipeline produced." +
    (population.decision === "reader-scoped"
      ? " This position is reader-scoped, so a side you cannot see reads as empty here."
      : "")
  );
}

/** Insert the `human`-sourced row, and hand back the shape the decide path takes. */
async function insertAuthoredProposal(
  tx: VocabularyExecutor,
  workspaceId: string,
  id: string,
  position: SlotPosition,
  input: { readonly fromNorm: string; readonly toNorm: string; readonly proposedBy: string },
): Promise<ProposalRow> {
  await tx.query(
    `INSERT INTO brain_vocabulary_proposal
       (id, workspace_id, slot_position, from_norm, to_norm, directed, source_class,
        confidence, status, proposed_by)
     VALUES ($1, $2, $3, $4, $5, TRUE, 'human', 1, 'pending', $6)`,
    [id, workspaceId, position, input.fromNorm, input.toNorm, input.proposedBy],
  );
  // CONSTRUCTED, not read back. A `RETURNING` round trip would re-narrow values
  // this function just supplied, and every field below is a literal in the
  // INSERT above — so a mismatch would mean the two statements disagree with
  // each other rather than with the database.
  //
  // `directed: TRUE` because a human authoring a merge STATES the direction;
  // there is no evidence to abstain on the way `#5034`'s undirected proposals
  // do. `confidence: 1` for the same reason — it is not a producer's estimate,
  // and the auto-approve threshold never reads a `human` row anyway
  // (`autoApproveEligible` requires an entity position AND a knob-listed source
  // class, and `human` reaching that knob would be an operator decision to
  // auto-approve human proposals, which is a no-op: this path decides them).
  return {
    id,
    slot_position: position,
    from_norm: input.fromNorm,
    to_norm: input.toNorm,
    directed: true,
    source_class: "human",
    confidence: 1,
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Take the workspace vocabulary lock. See the module header for what it buys,
 * and for the precise (narrow) form of the 40P01-against-the-importer claim —
 * a second orderable resource now exists, but no interleaving falsifies the
 * ordering, so it is pinned as an invariant rather than provoked.
 */
async function lockVocabulary(tx: VocabularyExecutor, workspaceId: string): Promise<void> {
  await tx.query(VOCABULARY_LOCK_SQL, [VOCABULARY_LOCK_NAMESPACE, workspaceId]);
}

/**
 * Take the IDENTITY-mutation lock — 5022 first, then 5024, always in that order.
 *
 * Spelled as one function taking both rather than two calls a caller sequences,
 * because the ORDER is the whole guarantee and a caller that could get it wrong
 * eventually will. See {@link IDENTITY_MUTATION_LOCK_NAMESPACE} for the cycle
 * this shape rules out, and #5022's review for the one it actually produced.
 *
 * Taken UNCONDITIONALLY, before the proposal row is read — including on paths
 * that go on to refuse. A lock taken only where the write happens is a lock
 * taken after the read that decides whether to write, which is the ordering the
 * publish gate already demonstrates the cost of. It is cheap to be wrong about
 * here: alias decisions are human-paced and per-workspace.
 */
async function lockIdentityMutation(tx: VocabularyExecutor, workspaceId: string): Promise<void> {
  // 5022 FIRST, and deliberately UNBOUNDED. Producers contend on the vocabulary
  // lock one batch iteration at a time (`proposeAliasEdges` is sequential for
  // exactly that reason), and a bound here would make batch B's decide THROW
  // where it used to wait — killing a whole producer run mid-flight. The propose
  // path takes no bound at all on the same argument, and its test says so.
  await lockVocabulary(tx, workspaceId);

  // 5024 BOUNDED, and reset immediately. `pg_advisory_xact_lock` waits forever
  // rather than erroring, so an unbounded acquisition of the namespace publish
  // also holds is a request that hangs with no signal — and #5025's route builds
  // one of these from an HTTP request.
  //
  // The reset is not tidiness: `SET LOCAL` reverts at COMMIT, not at the next
  // statement, so leaving it set would bound the proposal claim and every row
  // lock the workspace-wide re-key takes below — turning waits that are correct
  // into failures. The first cut of this fix did exactly that. It must be
  // ADJACENT to the acquisition, not merely somewhere after it; the suite
  // asserts `resetAt === identityLockAt + 1` for that reason.
  await tx.query(IDENTITY_MUTATION_LOCK_TIMEOUT_SQL);
  await tx.query(IDENTITY_MUTATION_LOCK_SQL, [IDENTITY_MUTATION_LOCK_NAMESPACE, workspaceId]);
  await tx.query(IDENTITY_MUTATION_LOCK_RESET_SQL);
}

/**
 * ADR-0037 §7's DRIFT RE-KEY — one statement per {@link SlotPosition}, built once.
 *
 * ## What it computes
 *
 * Exactly `slotKey(surface, alias)` (`lib/brain/identity.ts`), transcribed into
 * SQL against the CURRENT closure:
 * `identityKey(alias(identityKey(surface)))`, where `alias(n)` is
 * `COALESCE(closure[n], n)`. The outer `identityKeySql` is the re-norm `slotKey`
 * applies to the vocabulary's answer, and it is not optional — an entry authored
 * as `is priced at → "Priced At"` (an admin typing the canonical DISPLAY form,
 * the likeliest authoring mistake now that this is a reviewed data table) would
 * otherwise write a key that joins nothing, workspace-wide and silently.
 *
 * A surface that norms away yields NULL from the inner `identityKeySql`, so the
 * closure lookup matches no row (`norm = NULL` is never true), the COALESCE
 * stays NULL and the key stays NULL. That is `slotKey`'s "the alias is never
 * consulted for a claim that asserts nothing", reached by the same road.
 *
 * ## Re-derived from the SURFACE, not rewritten from the stored key
 *
 * A `WHERE predicate_key = <old> SET predicate_key = <new>` rewrite is the
 * obvious shape and it is WRONG in the undo direction, which is the direction
 * the vocabulary's whole reversibility argument rests on (ADR-0037 §6).
 *
 * Approval is well-defined key-to-key: adding `a → b` moves exactly the rows
 * keyed `a` onto `b`. Removal is not. Dropping `a`'s parent makes `a` a root
 * again, so of the rows keyed `R`, those whose norm chains through `a` become
 * `a` and the rest stay `R` — and the key column cannot tell the two
 * populations apart, because sharing a key is precisely what it records. Only
 * the retained surface can. One statement that recomputes therefore serves both
 * verbs; two statements would be two spellings of the identity function, which
 * is what #5000 was.
 *
 * This is the ONE sanctioned re-derivation, and it does not contradict §8's
 * *"row-copy paths carry keys verbatim, never re-derive"*. That rule is about
 * copying a row into a workspace whose vocabulary is a DIFFERENT function, where
 * re-deriving fails to over-match — the irreversible direction. Here the
 * vocabulary is this workspace's own, and its change is the trigger. (One edge
 * the rule does touch: a key carried verbatim by a region import (#5035) is
 * re-derived by the next approval in the target region, under the target's
 * vocabulary. That is #5036's merge-on-import question, not this statement's —
 * flagged rather than silently absorbed.)
 *
 * ## Scope: EVERY row, and no index
 *
 * No `status`, `invalidated_at` or `valid_to` filter. #5019 repointed
 * `idx_brain_facts_subject` onto `(workspace_id, subject_key, predicate_key)
 * WHERE invalidated_at IS NULL AND valid_to IS NULL`, and the tombstoned and
 * superseded rows that partial index excludes must still be re-keyed — a row
 * left on a stale key is a row whose surface and key disagree forever, and the
 * next removal's re-derive-from-surface undo would move it somewhere neither
 * vocabulary ever put it.
 *
 * It is a SEQUENTIAL scan and that is the accepted plan, not an oversight:
 * there is no equality on `workspace_id`'s trailing key columns to seek on, PG
 * 16 has no skip scan, and §7's zero-net-new-indexes result is worth more than
 * one workspace-scoped scan on a rare, human-gated act. Do not add an index
 * here.
 *
 * ## `updated_at` IS NOT TOUCHED
 *
 * Every other `UPDATE` in the brain's write path stamps it, so this is the line
 * a future tidy-up puts back. It is projected on the wire (`candidates.ts`) and
 * it is the sort key of the publish preview (`brainFactPreviewSql`), so stamping
 * it here reshuffles every reviewer's draft queue into re-key order. The
 * principle: *`updated_at` means this claim's content or review state moved; a
 * key recomputation moved neither.* Asserted in `vocabulary-rekey-pg.test.ts`,
 * because nothing else pins it.
 *
 * `IS DISTINCT FROM` restricts the WRITE to rows whose key actually moves —
 * NULL-safe on both sides, unlike `<>`. Every row is still EVALUATED, which is
 * what the paragraph above requires; what this avoids is a dead tuple per row
 * per approval on a table the review queue reads constantly. It also makes the
 * `UPDATE`'s row count mean "rows re-keyed", which is the number worth logging.
 */
function rekeyDriftedFactsSql(position: SlotPosition): string {
  const { surface, key } = SLOT_COLUMNS[position];
  const norm = identityKeySql(`f.${surface}`);
  const aliased = `COALESCE((SELECT t.effective_target
                               FROM brain_vocabulary_target t
                              WHERE t.workspace_id = f.workspace_id
                                AND t.slot_position = '${position}'
                                AND t.norm = ${norm}), ${norm})`;
  return `UPDATE brain_facts f
            SET ${key} = ${identityKeySql(aliased)}
          WHERE f.workspace_id = $1
            AND f.${key} IS DISTINCT FROM ${identityKeySql(aliased)}
      RETURNING f.id::text AS id`;
}

export const REKEY_DRIFTED_FACTS_SQL: Readonly<Record<SlotPosition, string>> = Object.freeze({
  // Spelled as three keys rather than built with `Object.fromEntries`, which
  // needed two casts — `Object.keys(...) as SlotPosition[]` and
  // `as Record<SlotPosition, string>`. The second is the dangerous one: it tells
  // the compiler the record is TOTAL, so a `.filter()` slipped into the chain
  // ("only re-key the predicate arm") yields `undefined` at the lookup below,
  // typed `string`, handed straight to `tx.query`. Here a missing position is
  // "Property 'object' is missing" and a fourth `SlotPosition` is a compile
  // error at this definition.
  subject: rekeyDriftedFactsSql("subject"),
  predicate: rekeyDriftedFactsSql("predicate"),
  object: rekeyDriftedFactsSql("object"),
});
/**
 * Run the drift re-key for one position, INSIDE the decide transaction.
 *
 * ## Why it stays in this transaction, stated rather than discovered
 *
 * The module header names the condition under which this seam inherits
 * `decide.ts`'s compensation cost: *if the re-key is ever moved OUT of this
 * transaction to keep it short, `applying` becomes observable, `claimed_at`
 * becomes a takeover token, and every paragraph of `decide.ts`'s compensation
 * machinery becomes load-bearing here too.*
 *
 * #5024 does not move it. ADR-0037 §7 puts the re-key inside the decide
 * transaction, and the reason is not brevity: an approved edge whose rows were
 * not re-keyed is a committed lie about what the corpus collides on, and there
 * is no bounded window in which that is acceptable — `correction.ts`'s
 * re-derive site reads the keys and would disagree with them for the length of
 * it. So the guarantee this slice keeps is the one #5023 shipped: `applying`
 * never commits, no row is ever observed in it, and `claimed_at` stays a
 * token nothing can take over.
 *
 * The price is a workspace-scoped sequential scan holding two advisory locks
 * inside a human-gated request. Paid knowingly: alias decisions are rare and
 * per-workspace, and the alternative trades a bounded latency for an unbounded
 * correctness window.
 */
async function rekeyDriftedFacts(
  tx: VocabularyExecutor,
  workspaceId: string,
  position: SlotPosition,
  proposalId: string,
): Promise<void> {
  let rows: readonly unknown[];
  try {
    // REFUSED, not defaulted. `VocabularyExecutor` is deliberately satisfiable
    // by any `{ query }`, and the earlier `?? []` turned an executor that is not
    // answering as a Postgres client into the line "Drift re-key complete —
    // existing facts now carry the keys this vocabulary decides" with
    // `rekeyed: 0`: a success message for a statement whose result was never
    // observed, which is the exact shape this slice exists to eliminate.
    // `vocabulary.ts`'s lock probe makes the same call for the same reason
    // ("Refusing rather than assuming the lock is held").
    const result = await tx.query(REKEY_DRIFTED_FACTS_SQL[position], [workspaceId]);
    if (!Array.isArray(result.rows)) {
      throw new Error(
        `rekeyDriftedFacts: the executor returned no usable \`rows\` for the ${position} re-key ` +
          `(workspace ${workspaceId}, proposal ${proposalId}). The statement's result was never ` +
          "observed, so whether the corpus was re-keyed is unknown — refusing rather than " +
          "committing an approval that may not have moved a single key.",
      );
    }
    rows = result.rows;
  } catch (err) {
    // LOGGED before it propagates. `decideAliasProposal`'s outer catch narrows
    // on `AliasApplyRefusedError` and re-throws everything else WITHOUT a log
    // line, so without this the workspace, the proposal and the position — all
    // in scope right here — are gone by the time the error surfaces. The classes
    // that arrive here are all operationally distinct and all look identical
    // from the route: `40P01` deadlock, `55P03` lock timeout, `57014` statement
    // cancellation on the scan, `42P01` on a partially-migrated region.
    log.error(
      {
        workspaceId,
        proposalId,
        position,
        err: err instanceof Error ? err.message : String(err),
      },
      "Drift re-key failed — the alias decision is rolling back whole, so no key moved and no edge was applied",
    );
    throw err;
  }
  // COUNTED from `RETURNING`, not from `pg`'s `rowCount`. `VocabularyExecutor`
  // and `ReconcileExecutor` both declare `{ rows }` and `withBrainTransaction`'s
  // wrapper projects exactly that, so `rowCount` does not survive the seam at
  // all — reading it yields `undefined` and logs a re-key that moved thousands
  // of rows as having moved none. `RETURNING` is only as expensive as the rows
  // that actually changed, which the `IS DISTINCT FROM` guard already narrows.
  //
  // Nothing branches on the number. An approval whose re-key moved zero rows is
  // the ordinary case — the workspace may have no facts at that slot yet — and
  // treating it as a failure would refuse the first alias a workspace approves.
  // It is the operator's only signal that the re-key ran and how wide it reached.
  log.info(
    { workspaceId, proposalId, position, rekeyed: rows.length },
    "Drift re-key complete — existing facts now carry the keys this vocabulary decides",
  );
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

  // RE-KEY. ADR-0037 §7, and it runs AFTER the closure is rebuilt and BEFORE
  // the stamp: the statement reads `brain_vocabulary_target`, so running it
  // before `approveAliasEdge` would recompute against the vocabulary this
  // decision is replacing and write the keys it was supposed to move away from
  // — a no-op that looks exactly like a successful re-key.
  await rekeyDriftedFacts(tx, workspaceId, row.slot_position, row.id);

  // STAMP. Conditional on the claim token, so a decision that somehow outlived
  // its claim can never stamp over a takeover's. Unreachable today (the claim
  // and the stamp share a transaction under a workspace lock) and kept because
  // kept FOR the day the re-key moves OUT of this transaction, which is when it
  // becomes reachable — see the module header. #5024 landed the re-key and
  // deliberately kept it INSIDE, so it stays unreachable today; the stamp is
  // what makes that future change a code change rather than a migration on a
  // hot table.
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

    // The UNDO half of the drift re-key, and the reason the statement recomputes
    // from the surface rather than rewriting key-to-key. `removeAliasEdge` has
    // already cleared and rebuilt the position's closure, so recomputing now
    // lands every row on the target the POST-removal vocabulary decides:
    // `is priced at` goes back to `price` while a row whose surface was always
    // `unit price` stays there — a distinction the key column alone cannot make,
    // because sharing a key is exactly what it records. See
    // {@link REKEY_DRIFTED_FACTS_SQL}.
    await rekeyDriftedFacts(tx, workspaceId, row.slot_position, row.id);
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
