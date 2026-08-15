/**
 * Denominator snapshots — the per-class enumeration seam and its persistence
 * (#5213, ADR-0041).
 *
 * ## What this module is
 *
 * ADR-0041 puts the Coverage Surface's denominators behind SCHEDULED CYCLES
 * writing dated snapshots, "never live vendor calls on page view". This module
 * owns the shape those cycles produce ({@link CoverageEnumeration}), the write
 * that lands it ({@link persistCoverageSnapshot}), and the reads the page will
 * compose ({@link readCoverageSnapshot}, {@link readCoverageUnits}).
 *
 * It owns NO vendor knowledge. Each class's enumerator is a separate module —
 * `ingest/slack/coverage.ts` for chat, `coverage-warehouse.ts` for the warehouse
 * — and the registry that pairs classes with enumerators lives in the scheduler
 * job (`lib/scheduler/brain-coverage-snapshot.ts`), so nothing here imports a
 * vendor client and the enumerators can import these types without a cycle.
 *
 * ## The one rule that shapes every write below
 *
 * **A failed cycle never zeroes or deletes the prior snapshot.** ADR-0041: "a
 * failed snapshot load is 'enumeration unavailable since \<date\>', never zero;
 * the false-all-clear direction throws." So {@link persistCoverageSnapshot}
 * takes an OUTCOME rather than a unit list, and the failure arm touches
 * `brain_coverage_cycle` only. There is no code path from a refusal to a DELETE.
 *
 * That is also why the sweep is keyed on `cycle_at` rather than on a set
 * difference computed in TypeScript: the delete can only remove rows the SAME
 * transaction just declined to re-stamp, so a partial write cannot retire a unit
 * it never looked at.
 *
 * ## Labels are decided HERE, at write time, and again at read time
 *
 * ADR-0041's label rule is a READ-time policy and #5214 owns the surface that
 * applies it. This module applies {@link coverageLabelPolicy} anyway, before the
 * insert, and stores `NULL` whenever it answers `count-only`. The issue's AC-6
 * says why: nothing here should make over-disclosure the path of least
 * resistance, and the disclosure facts travel beside the row so a reader can
 * re-derive the decision rather than trust it.
 *
 * ⚠️ This is NOT a structural guarantee that a mailbox address can never be
 * stored: `coverageLabelPolicy` names a unit of ANY surveyable class under the
 * deliberate-act clause, `email` included. No email enumerator ships here; when
 * one lands it must not assert `deliberateAct` for a mailbox, because the policy
 * would name it if it did.
 *
 * @see ../db/migrations/0202_brain_coverage_snapshot.sql — the tables and the
 *   green-is-evidence CHECK
 * @see ./class-contract.ts — `coverageLabelPolicy`, the class's declared
 *   denominator and staleness capability
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { withBrainTransaction } from "@atlas/api/lib/brain/reconcile";
import { coverageLabelPolicy, type ClassContractLogMeta } from "@atlas/api/lib/brain/class-contract";
import type { EpisodeSourceClass } from "@atlas/api/lib/brain/sources";

const log = createLogger("brain.coverage-enumeration");

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The classes that can hold a snapshot row.
 *
 * `human` is absent because `CLASS_CONTRACTS.human` declares itself
 * non-surveyable: no credential enumerates "the set of humans who might state
 * something", and a unit of that class would be a PERSON. Migration 0202's CHECK
 * refuses it at the database and `coverage-enumeration.test.ts` pins this list
 * against `CLASS_CONTRACTS`, so the two cannot drift.
 */
export const SURVEYABLE_SOURCE_CLASSES = Object.freeze([
  "chat",
  "transcript",
  "email",
  "warehouse",
] as const);

/** A class a survey unit may belong to — {@link SURVEYABLE_SOURCE_CLASSES}'s member type. */
export type SurveyableSourceClass = (typeof SURVEYABLE_SOURCE_CLASSES)[number];

/**
 * Compile-time tie to the closed class set, in `sources.ts`'s and
 * `class-contract.ts`'s shape (`_CLASS_AXIS_IN_SYNC`, `_CONTRACT_KEYS_IN_SYNC`).
 *
 * The runtime test pins this list against `CLASS_CONTRACTS`, which is a
 * different and equally necessary guarantee — that the two DECLARATIONS agree.
 * This one holds the weaker, earlier property that a member of this list is a
 * class at all. {@link isSurveyableSourceClass} cannot supply it: a `value is T`
 * predicate narrows to an INTERSECTION, so a member that is not an
 * `EpisodeSourceClass` still compiles through it.
 */
const _SURVEYABLE_IS_A_CLASS: SurveyableSourceClass extends EpisodeSourceClass ? true : never =
  true;
void _SURVEYABLE_IS_A_CLASS;

/**
 * The two states a STORED unit can be in.
 *
 * ADR-0041 names three; the third — **unenumerable** — deliberately has no
 * member here and no row in the table. It is the map edge, "shown as a mark,
 * never a number: any denominator that includes it is fabricated". Its marks are
 * {@link CoverageDegradedArm}s on the cycle record.
 *
 * ⚠️ `surveyed` is NOT "in the perimeter". It is in the perimeter AND evidence
 * observed — ADR-0040 rule 3, green is evidence never configuration. The
 * derivation lives in {@link surveyUnitState} and is pinned by a database CHECK
 * so a second writer cannot decide it differently.
 */
export type SurveyUnitState = "surveyed" | "enumerated";

/**
 * ADR-0041's map edge, enumerated.
 *
 * Each member names an ARM of an enumeration that could not be performed — not a
 * unit, and never a count. The page renders them as marks ("there are channels
 * beyond what these credentials can see"), which is the only honest rendering:
 * "any denominator that includes it is fabricated".
 *
 * A closed vocabulary rather than free text so the surface can render each one
 * with its own sentence, and so a new edge has to be added deliberately rather
 * than arriving as an unrecognised string the page prints raw.
 */
export const COVERAGE_DEGRADED_ARMS = Object.freeze([
  /**
   * The public-channel roster could not be read at all — most often a token
   * without `channels:read`. The perimeter half still enumerated, so the ratio
   * exists; what is missing is everything BEYOND membership, which is exactly
   * the map edge.
   */
  "chat-public-roster-unreadable",
  /** The public-channel roster hit its page bound: there are channels past it. */
  "chat-public-roster-truncated",
  /**
   * The vendor-activity probe was refused for a reason other than "not a member"
   * — so some units carry no vendor-side reading this cycle and their staleness
   * is "unverified since", not "current".
   */
  "chat-activity-unreadable",
  /**
   * Vendor conversation ids this deploy's id pattern does not recognise were
   * dropped from the roster.
   *
   * A MARK rather than only a log line, on `warehouse-entity-unreadable`'s
   * reasoning: the units are gone from the denominator and swept by the write,
   * so the count is lower than the truth and the page would otherwise render it
   * as complete. If Slack ever mints a public-conversation id prefix the pattern
   * does not admit, EVERY row fails and the whole roster empties under a green
   * success — this is the arm that says so.
   */
  "chat-unit-ids-unrecognised",
  /** The semantic-layer walk hit its entity bound: there are entities past it. */
  "warehouse-entity-bound-reached",
  /**
   * One or more entities' dimensions could not be read this cycle, so their
   * pairs are absent from the denominator AND swept by the write.
   *
   * A separate arm from the bound above, because the two shrink the map for
   * different reasons and only this one is a fault. Without it the loss is
   * invisible AND flattering: a broken entity removes its unsurveyed pairs from
   * the denominator, which RAISES the ratio while the page shows a fresher date.
   */
  "warehouse-entity-unreadable",
] as const);

/** One arm of an enumeration that could not be performed — see {@link COVERAGE_DEGRADED_ARMS}. */
export type CoverageDegradedArm = (typeof COVERAGE_DEGRADED_ARMS)[number];

/**
 * One survey unit, as an enumerator observed it this cycle.
 *
 * Note what is NOT here: `state`. It is derived from `inPerimeter` and
 * `newestEvidenceAt` by {@link surveyUnitState} and re-checked by the database,
 * so an enumerator cannot assert `surveyed` for a unit that has produced no
 * evidence — which is the configuration-as-green failure ADR-0040 rule 3 exists
 * to forbid.
 */
export interface EnumeratedSurveyUnit {
  /** The vendor-side id. Counted always; named only under a label clause. */
  readonly unitId: string;
  /**
   * The unit's human-readable surface, or `null` when the enumerator has none.
   *
   * Supplying one is not the same as disclosing it: {@link persistCoverageSnapshot}
   * runs {@link coverageLabelPolicy} over the class and the facts below, and
   * stores `NULL` unless a clause admits it.
   */
  readonly label: string | null;
  /** Did a deliberate act put this unit inside the perimeter? */
  readonly inPerimeter: boolean;
  /**
   * ADR-0041's first label clause — install-form entry, membership, exclusion,
   * enrollment. Usually but NOT always equal to {@link inPerimeter}: an admin's
   * exclusion is a deliberate act that takes a unit OUT of the perimeter, and
   * the channel stays nameable because the admin named it.
   */
  readonly deliberateAct: boolean;
  /** The vendor's answer about THIS unit — ADR-0041's second label clause. */
  readonly vendorReportsPublic: boolean;
  /** Our newest observed evidence, or `null` when there is none. */
  readonly newestEvidenceAt: Date | null;
  /**
   * The vendor-side activity reading, tri-state on purpose.
   *
   * `{ probed: false }` means this cycle did not ask — the probe rotation is
   * bounded, so most units are unprobed on most cycles — and the write COALESCEs
   * the stored value forward. Collapsing it to `Date | null` would make every
   * unprobed unit look like a probed-and-silent one and wipe the reading the
   * last cycle paid for.
   */
  readonly activity: { readonly probed: false } | { readonly probed: true; readonly at: Date | null };
}

/**
 * What one class's enumeration produced — or its refusal.
 *
 * A discriminated union rather than a units array plus an error field, because
 * the failure arm must be structurally incapable of carrying units: a caller
 * that could pass `{ error, units: [] }` would write a zeroed roster, which is
 * the one thing ADR-0041 forbids by name.
 */
export type CoverageEnumeration =
  | {
      readonly ok: true;
      readonly units: readonly EnumeratedSurveyUnit[];
      /** Map-edge marks for THIS cycle. Empty means a complete map of what the credentials see. */
      readonly degraded: readonly CoverageDegradedArm[];
    }
  | {
      readonly ok: false;
      /**
       * Operator- and admin-facing. Stored verbatim in `last_error` and rendered
       * beside "enumeration unavailable since \<date\>", so it has to say what to
       * do — never a stack trace and never a bare code.
       */
      readonly error: string;
    };

/**
 * ADR-0040 rule 3, as a function: green is evidence, never configuration.
 *
 * Exported so the enumerators' tests and the persistence agree by one
 * derivation rather than by two spellings of `&&`. The database re-checks it
 * (`ck_brain_coverage_snapshot_state_is_evidence`), which is what makes storing
 * `state` beside its inputs safe rather than redundant.
 */
export function surveyUnitState(unit: {
  readonly inPerimeter: boolean;
  readonly newestEvidenceAt: Date | null;
}): SurveyUnitState {
  return unit.inPerimeter && unit.newestEvidenceAt !== null ? "surveyed" : "enumerated";
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

const UPSERT_UNIT_SQL = `INSERT INTO brain_coverage_snapshot
     (workspace_id, source_class, unit_id, state, in_perimeter, unit_label,
      deliberate_act, vendor_reports_public, newest_evidence_at,
      vendor_activity_at, vendor_activity_checked_at, cycle_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz,
           $11::timestamptz, $12::timestamptz)
   ON CONFLICT (workspace_id, source_class, unit_id) DO UPDATE
     SET state = EXCLUDED.state,
         in_perimeter = EXCLUDED.in_perimeter,
         unit_label = EXCLUDED.unit_label,
         deliberate_act = EXCLUDED.deliberate_act,
         vendor_reports_public = EXCLUDED.vendor_reports_public,
         newest_evidence_at = EXCLUDED.newest_evidence_at,
         -- ⚠️ DISCRIMINATE ON vendor_activity_checked_at, NEVER ON
         -- vendor_activity_at — the same discriminant the reader uses, and
         -- getting it wrong here was a fabricated freshness.
         --
         -- An UNPROBED unit passes NULL for both and must keep the reading a
         -- previous cycle paid a Slack call for; that is the CASE's first arm.
         -- A PROBED unit must be believed WHOLE, a NULL reading included,
         -- because an empty history page is a real reading ("this channel has
         -- never had a message", which ADR-0041 calls quiet rather than stale).
         --
         -- A plain COALESCE conflated the two: an emptied channel kept its OLD
         -- reading while the check time advanced to now, so the row asserted
         -- "asked just now, newest message is <old date>" for a channel with
         -- none — and no later probe could ever overwrite it, because only a
         -- probe that FINDS a message produces a non-null.
         vendor_activity_at = CASE
           WHEN EXCLUDED.vendor_activity_checked_at IS NULL
             THEN brain_coverage_snapshot.vendor_activity_at
           ELSE EXCLUDED.vendor_activity_at
         END,
         vendor_activity_checked_at =
           COALESCE(EXCLUDED.vendor_activity_checked_at,
                    brain_coverage_snapshot.vendor_activity_checked_at),
         cycle_at = EXCLUDED.cycle_at`;

/**
 * Rows this cycle did not re-observe.
 *
 * Keyed on `cycle_at` rather than on an id list, so the delete can only reach
 * rows the SAME transaction just declined to stamp. A `NOT IN (…)` over a
 * TypeScript-built array would retire a unit whenever that array was truncated,
 * which is the loud-understatement mutation ADR-0041's fixture charter names.
 */
const SWEEP_SQL = `DELETE FROM brain_coverage_snapshot
    WHERE workspace_id = $1 AND source_class = $2 AND cycle_at < $3::timestamptz
    RETURNING unit_id`;

const RECORD_SUCCESS_SQL = `INSERT INTO brain_coverage_cycle
     (workspace_id, source_class, last_attempt_at, last_success_at, last_error, degraded_arms)
   VALUES ($1, $2, $3::timestamptz, $3::timestamptz, NULL, $4::text[])
   ON CONFLICT (workspace_id, source_class) DO UPDATE
     SET last_attempt_at = EXCLUDED.last_attempt_at,
         last_success_at = EXCLUDED.last_success_at,
         last_error = NULL,
         degraded_arms = EXCLUDED.degraded_arms`;

/**
 * The failure arm. `last_success_at` is deliberately absent from the SET list —
 * it keeps whatever the last successful cycle wrote, which is the date the page
 * renders in "enumeration unavailable since \<date\>".
 *
 * `degraded_arms` is untouched for the same reason: the marks describe the last
 * SUCCESSFUL map, and clearing them on a failure would replace "there are
 * channels we cannot see" with a clean edge nobody established.
 */
const RECORD_FAILURE_SQL = `INSERT INTO brain_coverage_cycle
     (workspace_id, source_class, last_attempt_at, last_success_at, last_error)
   VALUES ($1, $2, $3::timestamptz, NULL, $4)
   ON CONFLICT (workspace_id, source_class) DO UPDATE
     SET last_attempt_at = EXCLUDED.last_attempt_at,
         last_error = EXCLUDED.last_error`;

/**
 * Error text the store will actually accept.
 *
 * Two rules, both from the constraint rather than from taste:
 * `ck_brain_coverage_cycle_error_present` refuses `''` (and
 * `new Error().message` IS `''`), and a `text` column refuses a NUL byte
 * outright — node-pg rejects the parameter, so an error whose message carried
 * one would make the failure-recording statement THROW. Both turn a visible
 * failure into an invisible one through the machinery meant to guarantee every
 * red dot carries a message.
 */
export function storableErrorText(raw: string): StorableErrorText {
  // `errorMessage` scrubs secrets and bounds the length; it does NOT strip
  // NUL, so that is done here — written as an ESCAPE, never as a literal
  // byte. A literal NUL in a source file is itself unsendable to Postgres,
  // which this branch found the hard way in migration 0202's first draft.
  const scrubbed = errorMessage(raw).replaceAll("\u0000", "").trim();
  // THE seam, and the only cast to this brand in the tree. Sound here and only
  // here: both rules above have been applied to the value being returned.
  return (
    scrubbed === ""
      ? "The enumeration failed without reporting a reason — check the coverage-snapshot logs for this workspace and class."
      : scrubbed
  ) as StorableErrorText;
}

declare const storableErrorTextBrand: unique symbol;

/**
 * Error text that has been through {@link storableErrorText} — the ONLY shape
 * the two `last_error` writers below will bind.
 *
 * ⚠️ **A brand, on the OUTPUT rather than on a parameter, for #5230's reason.**
 * `storableErrorText` was `(raw: string) => string`, so nothing at the type
 * level said the two writers had to route through it: `internalQuery`'s bind
 * array is `unknown[]`, and passing `outcome.error` straight into it compiled.
 * The rules it applies are not decoration — a `''` message violates
 * `ck_brain_coverage_cycle_error_present`, and a NUL byte is refused by node-pg
 * outright, so an unsanitized writer makes the one statement whose whole job is
 * recording a failure THROW. A visible failure becomes an invisible one through
 * the machinery meant to guarantee every red dot carries a message.
 *
 * ⚠️ **What the brand does NOT close, stated because a brand invites the wrong
 * confidence.** It stops the two writers below from binding a raw string. It
 * cannot stop a THIRD writer from calling `internalQuery` with its own
 * `last_error` SQL and never mentioning this type at all — the unbranded
 * sibling producer that reopened #5032 twice. That half is carried by
 * `__tests__/coverage-error-text-writers.test.ts`, which reads this file and
 * refuses a `last_error` write outside the two functions below. The two halves
 * are independent and neither is redundant.
 */
export type StorableErrorText = string & { readonly [storableErrorTextBrand]: true };

/**
 * The class-wide failure UPDATE — one of exactly two statements permitted to
 * write `brain_coverage_cycle.last_error`.
 *
 * It exists as a named function rather than an inline `internalQuery` so its
 * `lastError` parameter can be a {@link StorableErrorText}. That is what makes
 * *the storage site cannot accept an unsanitized string* true at the type level
 * rather than in a doc comment.
 *
 * ⚠️ EXPORTED for the `@ts-expect-error` rows in
 * `__tests__/coverage-error-text-writers.test.ts`, and safely so: the only mint
 * for its `lastError` parameter is {@link storableErrorText}, so an outside
 * caller cannot reach it holding a raw string without an explicit cast or a
 * suppression comment. A source-scan assertion about
 * the annotation would be a text match — `lastError: StorableErrorText | string`
 * would satisfy it while gutting the type — which is why the proof is a
 * compile check on the real function rather than a grep for its signature.
 */
export function updateClassFailureRows(params: {
  readonly sourceClass: SurveyableSourceClass;
  /**
   * The cycle instant, as a `Date`. Deliberately NOT a pre-formatted string:
   * `workspaceId`, an ISO string and `lastError` are all `string`-assignable, so
   * only the property NAMES would stop a positional swap, and a malformed
   * timestamp throws at PG inside the very statement the brand was added to
   * protect — taking the `Date` moves that throw client-side, before the write.
   *
   * It removes a stringly-typed parameter from the seam being hardened. It does
   * NOT remove every `.toISOString()`: {@link persistCoverageSnapshot} still
   * computes one for the SUCCESS path, so on the failure arm that instant is
   * serialized twice. An earlier version of this note claimed the conversion was
   * gone from each call site, which is true of `recordClassScanFailure` and not
   * of its sibling.
   */
  readonly cycleAt: Date;
  readonly lastError: StorableErrorText;
  readonly workspaceIds: readonly string[];
}): Promise<{ workspace_id: string }[]> {
  return internalQuery<{ workspace_id: string }>(
    `UPDATE brain_coverage_cycle
        SET last_attempt_at = $2::timestamptz, last_error = $3
      WHERE source_class = $1 AND workspace_id = ANY($4::text[])
      RETURNING workspace_id`,
    [params.sourceClass, params.cycleAt.toISOString(), params.lastError, params.workspaceIds],
  );
}

/**
 * The per-workspace failure upsert — the other of the two. See
 * {@link updateClassFailureRows} for why it is a function.
 *
 * ⚠️ **An UPSERT, so it CREATES a row that did not exist.** That warning lives
 * on {@link recordClassScanFailure} sixty lines down, where it explains why the
 * class-wide writer is an UPDATE and never this: *inventing a row for a
 * workspace this cycle could not even list would assert Atlas tried to enumerate
 * a workspace it never established exists*. A reader who lands on this exported
 * function does not see that, so it is restated here. Call it only for a
 * workspace the cycle actually attempted.
 */
export function recordFailureRow(params: {
  readonly workspaceId: string;
  readonly sourceClass: SurveyableSourceClass;
  /** See {@link updateClassFailureRows}'s `cycleAt` — a `Date`, for the same reason. */
  readonly cycleAt: Date;
  readonly lastError: StorableErrorText;
}): Promise<unknown> {
  return internalQuery(RECORD_FAILURE_SQL, [
    params.workspaceId,
    params.sourceClass,
    params.cycleAt.toISOString(),
    params.lastError,
  ]);
}

/**
 * Record a class-wide scan failure against every workspace already known to hold
 * that class — the arm {@link persistCoverageSnapshot} structurally cannot reach.
 *
 * ## Why this exists
 *
 * When `listWorkspaces()` throws there is no workspace list, so the per-workspace
 * write never runs and NOTHING moves: `last_attempt_at` stays frozen and
 * `last_error` stays NULL for every workspace of that class. The page then keeps
 * rendering a clean, dated, CURRENT statement for as long as the scan keeps
 * failing — precisely the defect the write-failure arm was fixed for, standing
 * one arm over.
 *
 * The rows are enumerable WITHOUT the vendor: `brain_coverage_cycle` already
 * holds one row per (workspace, class) for every workspace ever enumerated.
 *
 * ⚠️ An UPDATE, never an upsert. Inventing a row for a workspace this cycle
 * could not even list would assert Atlas tried to enumerate a workspace it never
 * established exists.
 *
 * ⚠️ And NOT every row of the class. A workspace that switched the cycle OFF
 * would otherwise be told "Atlas could not list the workspaces to enumerate",
 * about a cycle that would never have run for it — while the settings registry
 * promises that turning it off "freezes the coverage page at its last reading".
 * {@link includeWorkspace} is how the caller supplies the same per-workspace
 * decision the normal path reads, which is what makes "reaches exactly the set
 * that can be told, and no more" true of it.
 *
 * ⚠️ COST, stated because an outage is the wrong time to discover it: a
 * fleet-wide UPDATE over one class, once per cycle, for as long as the scan keeps
 * failing. Fine at an hourly cadence and a few thousand tenants; it wants
 * batching well before it is not.
 */
export async function recordClassScanFailure(params: {
  readonly sourceClass: SurveyableSourceClass;
  readonly error: string;
  readonly cycleAt: Date;
  /**
   * The tenant's own decision, read per workspace exactly as the normal path
   * reads it. Omitted means "tell every workspace holding this class".
   */
  readonly includeWorkspace?: (workspaceId: string) => boolean;
}): Promise<number> {
  const known = await internalQuery<{ workspace_id: string }>(
    `SELECT workspace_id FROM brain_coverage_cycle WHERE source_class = $1`,
    [params.sourceClass],
  );
  const include = params.includeWorkspace;
  const targets = known
    .map((r) => r.workspace_id)
    .filter((id) => include === undefined || include(id));
  if (targets.length === 0) return 0;
  const rows = await updateClassFailureRows({
    sourceClass: params.sourceClass,
    cycleAt: params.cycleAt,
    lastError: storableErrorText(params.error),
    workspaceIds: targets,
  });
  if (rows.length > 0) {
    log.warn(
      { sourceClass: params.sourceClass, workspaces: rows.length, known: known.length },
      "brain coverage: a class-wide scan failure was recorded against the workspaces holding this class — their rosters keep their previous readings and the surface now says so",
    );
  } else {
    // ⚠️ `targets` was non-empty (the early return above) and the UPDATE matched
    // NOTHING. Silence here returns 0, which the caller cannot tell from "no
    // workspace holds this class" — so the coverage page keeps rendering a
    // clean, dated, CURRENT statement while the scan keeps failing, which is the
    // exact defect this function exists to prevent, one arm over.
    //
    // Reachable: rows deleted between the SELECT and the UPDATE (a workspace
    // torn down mid-cycle), or the two `internalQuery` calls landing on
    // different databases through a residency/pool mismatch.
    log.warn(
      {
        sourceClass: params.sourceClass,
        targets: targets.length,
        known: known.length,
      },
      "brain coverage: a class-wide scan failure matched NO rows despite having targets — those workspaces' coverage pages will keep rendering their last reading as current",
    );
  }
  return rows.length;
}

/**
 * What one persisted cycle changed — the scheduler's per-class tally.
 *
 * A discriminated union for {@link CoverageEnumeration}'s reason, applied to its
 * sibling: the failure arm must be structurally incapable of reporting counts.
 * As a flat record `{ status: "failure", written: 12 }` type-checked, and the
 * "zero on a failure" invariants lived only in doc comments — on the report the
 * operator's span attributes are built from.
 *
 * The failure arm also carries NO `degraded`, and that is the sharper half:
 * `RECORD_FAILURE_SQL` deliberately leaves `degraded_arms` untouched, so a `[]`
 * here would mean *unknown* while reading as *none* — the map-edge field, whose
 * whole job is to say the map is incomplete, quietly saying it is complete.
 */
export type CoveragePersistReport =
  | { readonly status: "failure" }
  | {
      readonly status: "success";
      /** Units written this cycle. */
      readonly written: number;
      /** Units the cycle did not re-observe and therefore retired. */
      readonly retired: number;
      /** How many of the written units are `surveyed`. */
      readonly surveyed: number;
      /** How many carry a label. Always ≤ `written`; the rest are counted, never named. */
      readonly labelled: number;
      /**
       * Did this cycle retire most or all of the prior roster?
       *
       * On the report rather than only in a log, for the reason round 2 learned
       * the hard way about `error`: a verdict nothing can read is green by
       * construction wherever it is observed. The scheduler puts it on the span,
       * which is where a denominator that just collapsed becomes visible without
       * anyone grepping.
       */
      readonly collapsed: boolean;
      readonly degraded: readonly CoverageDegradedArm[];
    };

/**
 * Land one class's enumeration for one workspace.
 *
 * The whole write is one transaction: roster upserts, the sweep, and the cycle
 * record commit together, so a page can never read a half-swept roster stamped
 * with a fresh success. A failure arm writes only `brain_coverage_cycle` and
 * touches no roster row at all.
 *
 * @throws whatever the database throws. The scheduler catches it per workspace,
 *   counts a failed enumeration and records the attempt through the failure arm;
 *   swallowing it here would report a green cycle that wrote nothing, which is
 *   M1's failure shape.
 */
export async function persistCoverageSnapshot(params: {
  readonly workspaceId: string;
  readonly sourceClass: SurveyableSourceClass;
  readonly outcome: CoverageEnumeration;
  /** The cycle instant. One value for every row, because it is also the sweep key. */
  readonly cycleAt: Date;
  readonly requestId?: string;
}): Promise<CoveragePersistReport> {
  const { workspaceId, sourceClass, outcome, cycleAt } = params;
  const cycleIso = cycleAt.toISOString();

  if (!outcome.ok) {
    // ⚠️ SCRUBBED and NON-EMPTY, and both halves are load-bearing.
    //
    // Scrubbed because this string is STORED in `last_error` and rendered to an
    // admin as `unavailableReason` — and pg error text sometimes echoes the
    // connection string, which is the hazard `error-scrub.ts` exists for
    // (CLAUDE.md: no secrets in responses). `errorMessage` bounds it too, so a
    // stack arriving as a `.message` cannot bloat the row.
    //
    // Non-empty because `ck_brain_coverage_cycle_error_present` refuses `''` —
    // and `new Error().message` IS `''`. Passing it straight through would make
    // the one statement whose entire job is recording a failure THROW, so a
    // visible failure would become an invisible one through the constraint
    // written to guarantee every red dot carries a message. Both rules, and the
    // NUL one, live in {@link storableErrorText} so the two failure writers
    // cannot apply different ones — and since #5247 the TYPE says so rather than
    // this comment: `storableErrorText` returns a {@link StorableErrorText}, and
    // it is the only mint for the two writers' `lastError` parameter.
    const stored = storableErrorText(outcome.error);
    await recordFailureRow({ workspaceId, sourceClass, cycleAt, lastError: stored });
    log.warn(
      { workspaceId, sourceClass, err: stored },
      "brain coverage: enumeration failed — the previous dated roster is kept as-is, and the surface reads 'enumeration unavailable since' its last success",
    );
    return { status: "failure" };
  }

  const meta: ClassContractLogMeta = {
    workspaceId,
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
  };

  let surveyed = 0;
  let labelled = 0;
  const retired = await withBrainTransaction(async (tx) => {
    for (const unit of outcome.units) {
      const state = surveyUnitState(unit);
      if (state === "surveyed") surveyed++;
      // ADR-0041's label rule, applied BEFORE the insert. See the module header
      // for why the write path decides this as well as the read path.
      const decision = coverageLabelPolicy(
        sourceClass,
        { deliberateAct: unit.deliberateAct, vendorReportsPublic: unit.vendorReportsPublic },
        meta,
      );
      const storedLabel =
        decision.policy === "name" && unit.label !== null && unit.label !== "" ? unit.label : null;
      if (storedLabel !== null) labelled++;
      await tx.query(UPSERT_UNIT_SQL, [
        workspaceId,
        sourceClass,
        unit.unitId,
        state,
        unit.inPerimeter,
        storedLabel,
        unit.deliberateAct,
        unit.vendorReportsPublic,
        unit.newestEvidenceAt === null ? null : unit.newestEvidenceAt.toISOString(),
        unit.activity.probed && unit.activity.at !== null ? unit.activity.at.toISOString() : null,
        unit.activity.probed ? cycleIso : null,
        cycleIso,
      ]);
    }
    const swept = await tx.query(SWEEP_SQL, [workspaceId, sourceClass, cycleIso]);
    await tx.query(RECORD_SUCCESS_SQL, [
      workspaceId,
      sourceClass,
      cycleIso,
      [...outcome.degraded],
    ]);
    return swept.rows.length;
  });

  // A COLLAPSE, not only a total wipe. 500 -> 1 retires 499 rows under a clean
  // success with a fresh date, which is the same loud-understatement failure one
  // degree short of zero — and the zero-only condition could not see it.
  const collapsed = retired > 0 && outcome.units.length * COLLAPSE_RATIO < retired;
  if (collapsed) {
    // A SUCCESSFUL-looking empty enumeration is the one shape the union cannot
    // refuse: `{ ok: true, units: [] }` is legal, and it reaches the database as
    // "sweep everything, stamp a fresh success". ADR-0041 calls the result a
    // false statement rather than an error state, and the page cannot tell it
    // from a workspace that genuinely has nothing.
    //
    // LOGGED rather than refused, deliberately: a workspace whose bot was
    // removed from every channel, or whose semantic layer was emptied, really
    // does enumerate to nothing, and refusing would freeze it at "unavailable"
    // with no way back. `error` is the escalation — a total wipe is far more
    // often a broken enumerator than a real event.
    log.error(
      { workspaceId, sourceClass, retired, written: outcome.units.length },
      "brain coverage: a SUCCESSFUL enumeration retired most or all of the prior roster — this class's denominator just collapsed; verify the enumerator before trusting the new number",
    );
  }

  if (outcome.degraded.length > 0) {
    // Logged as well as stored. A map edge is a statement the page makes, and an
    // operator debugging "why does this workspace's denominator look small?"
    // should not have to query the table to find out that a scope is missing.
    log.info(
      { workspaceId, sourceClass, degraded: outcome.degraded },
      "brain coverage: enumeration completed with map edges — parts of this class are beyond what the granted credentials can see",
    );
  }
  return {
    status: "success",
    collapsed,
    written: outcome.units.length,
    retired,
    surveyed,
    labelled,
    degraded: outcome.degraded,
  };
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** One class's dated denominator, as the page composes its statement from. */
export interface CoverageClassSnapshot {
  readonly sourceClass: SurveyableSourceClass;
  /** Units in the perimeter WITH evidence observed. ADR-0041 state 1. */
  readonly surveyed: number;
  /** Units the credentials can see that are not surveyed. ADR-0041 state 2. */
  readonly enumerated: number;
  /**
   * Units inside the perimeter that have produced no evidence yet — a SUBSET of
   * {@link enumerated}, never added to it.
   *
   * Reported separately because it is the M1 sentence: invited, configured,
   * reading nothing. Folding it into `enumerated` would render it identically to
   * a channel nobody ever touched, which is the exact confusion that let a
   * four-day outage look green.
   */
  readonly inPerimeterWithoutEvidence: number;
  /** "As of" — the cycle that produced the counts above, or `null` if none ever succeeded. */
  readonly asOf: string | null;
  readonly lastAttemptAt: string | null;
  /** Non-null exactly when the last attempt failed. Verbatim, admin-facing. */
  readonly unavailableReason: string | null;
  /** ADR-0041's map edges — marks, never numbers. */
  readonly degraded: readonly CoverageDegradedArm[];
}

const READ_SNAPSHOT_SQL = `SELECT c.source_class,
          c.last_attempt_at,
          c.last_success_at,
          c.last_error,
          c.degraded_arms,
          COALESCE(s.surveyed, 0)   AS surveyed,
          COALESCE(s.enumerated, 0) AS enumerated,
          COALESCE(s.blind, 0)      AS blind
     FROM brain_coverage_cycle c
     LEFT JOIN (
       SELECT source_class,
              count(*) FILTER (WHERE state = 'surveyed')::int   AS surveyed,
              count(*) FILTER (WHERE state = 'enumerated')::int AS enumerated,
              count(*) FILTER (WHERE state = 'enumerated' AND in_perimeter)::int AS blind
         FROM brain_coverage_snapshot
        WHERE workspace_id = $1
        GROUP BY source_class
     ) s ON s.source_class = c.source_class
    WHERE c.workspace_id = $1
    ORDER BY c.source_class`;

/**
 * Every class this workspace has ever enumerated, with its dated counts.
 *
 * ⚠️ Driven off `brain_coverage_cycle`, not off the roster, and a LEFT JOIN
 * rather than an inner one. A class whose enumeration has never succeeded has a
 * cycle row and NO roster rows, and it must still appear — as "enumeration
 * unavailable", which is a statement, rather than as an absence, which the page
 * would render as a class nobody connected. Inner-joining would delete exactly
 * the row whose whole job is to say something went wrong.
 *
 * ⚠️ Errors PROPAGATE — `loadEnrollableEntities`' rule. An empty result and a
 * failed read render identically, and only one of them means "nothing is
 * connected". ADR-0041 puts the false-all-clear direction on the throw side.
 *
 * ⚠️ **A LIST, so the argument above covers only the classes that HAVE a cycle
 * row.** A surveyable class that has never run at all is simply absent, and this
 * function says nothing about what that absence means. ADR-0041's totality
 * requirement — "the coverage representation is keyed `Record<EpisodeSourceClass,
 * …>`, so a class added without a coverage answer is a compile error" — is a
 * property of THE PAGE'S representation, which is #5214's, and keying it here
 * would decide that shape from the reader. The obligation this hands #5214, since
 * nothing here can enforce it: seed the record from
 * {@link SURVEYABLE_SOURCE_CLASSES} and render a class with no row as "never
 * enumerated", never as a class nobody connected.
 */
export async function readCoverageSnapshot(
  workspaceId: string,
): Promise<readonly CoverageClassSnapshot[]> {
  const rows = await internalQuery<Record<string, unknown>>(READ_SNAPSHOT_SQL, [workspaceId]);
  const out: CoverageClassSnapshot[] = [];
  for (const row of rows) {
    const sourceClass = row.source_class;
    if (!isSurveyableSourceClass(sourceClass)) {
      // Unreachable through the writers (migration 0202's CHECK) and therefore a
      // hand-edited or future-schema row. Dropped rather than rendered, because
      // the page's shape is `Record<EpisodeSourceClass, …>` and an unrecognised
      // key has no answer — but LOUD, because a silently missing class is a
      // denominator that quietly shrank.
      log.error(
        { workspaceId, sourceClass: String(sourceClass) },
        "brain coverage: a snapshot cycle row names a class this deploy cannot resolve — it is omitted from the coverage statement",
      );
      continue;
    }
    const lastSuccessAt = isoOrNull(row.last_success_at);
    out.push({
      sourceClass,
      surveyed: asCount(row.surveyed, "surveyed", workspaceId),
      enumerated: asCount(row.enumerated, "enumerated", workspaceId),
      inPerimeterWithoutEvidence: asCount(row.blind, "blind", workspaceId),
      asOf: lastSuccessAt,
      lastAttemptAt: isoOrNull(row.last_attempt_at),
      unavailableReason:
        typeof row.last_error === "string" && row.last_error !== "" ? row.last_error : null,
      degraded: readDegradedArms(row.degraded_arms, workspaceId, sourceClass),
    });
  }
  return out;
}

/** One stored survey unit, for the per-class listing. */
export interface CoverageUnitRow {
  readonly unitId: string;
  readonly state: SurveyUnitState;
  readonly inPerimeter: boolean;
  /** `null` when no label clause admitted this unit — counted, never named. */
  readonly label: string | null;
  readonly newestEvidenceAt: string | null;
  /**
   * The vendor-side reading, as the same tri-state {@link EnumeratedSurveyUnit}
   * writes — not the flat `(at, checkedAt)` pair the columns hold.
   *
   * The pair is what the union exists to prevent: it makes the reader re-derive
   * "did we ask?" from `checkedAt !== null`, and it admits `{ at: <date>,
   * checkedAt: null }` — the state
   * `ck_brain_coverage_snapshot_activity_attributed` refuses at the database. That
   * is precisely the axis ADR-0041 forbids guessing on ("current" vs "unverified
   * since"), so the invariant the SQL enforces travels in the type the page
   * consumes rather than stopping at the driver.
   */
  readonly activity:
    | { readonly probed: false }
    | { readonly probed: true; readonly at: string | null; readonly checkedAt: string };
}

const READ_UNITS_SQL = `SELECT unit_id, state, in_perimeter, unit_label, newest_evidence_at,
          vendor_activity_at, vendor_activity_checked_at
     FROM brain_coverage_snapshot
    WHERE workspace_id = $1 AND source_class = $2
    ORDER BY (state = 'surveyed') DESC, unit_label ASC NULLS LAST, unit_id ASC`;

/**
 * One class's stored units.
 *
 * Ordered surveyed-first so the page's list opens on what Atlas actually reads,
 * with the unnamed rows last — they are the ones a reader can do nothing with
 * individually, and their value is in the count above the list.
 */
export async function readCoverageUnits(
  workspaceId: string,
  sourceClass: SurveyableSourceClass,
): Promise<readonly CoverageUnitRow[]> {
  const rows = await internalQuery<Record<string, unknown>>(READ_UNITS_SQL, [
    workspaceId,
    sourceClass,
  ]);
  return rows.map((r) => {
    // `checkedAt` is the discriminant, not `at`: "we asked and the channel is
    // empty" stores a NULL `at` with a real `checkedAt`, and reading `at` as the
    // discriminant would report that unit as never probed forever.
    const checkedAt = isoOrNull(r.vendor_activity_checked_at);
    return {
      unitId: String(r.unit_id),
      // Narrowed fail-closed: an unrecognised state renders as `enumerated`,
      // never as a `surveyed` no writer recorded. The CHECK makes it
      // unreachable; the narrowing keeps the type honest if it ever is not.
      state: r.state === "surveyed" ? "surveyed" : "enumerated",
      inPerimeter: r.in_perimeter === true,
      label: typeof r.unit_label === "string" && r.unit_label !== "" ? r.unit_label : null,
      newestEvidenceAt: isoOrNull(r.newest_evidence_at),
      activity:
        checkedAt === null
          ? ({ probed: false } as const)
          : ({ probed: true, at: isoOrNull(r.vendor_activity_at), checkedAt } as const),
    };
  });
}

/**
 * The probe rotation's due list — perimeter units whose vendor-activity reading
 * is oldest, never-probed first.
 *
 * `brain_slack_channel`'s health rotation model: the ORDER BY is the whole
 * scheduler. Restricted to `in_perimeter` because a vendor-activity probe for
 * chat is a history read, which a bot outside the channel cannot perform — an
 * unprobed state-2 channel is expected, not a gap.
 */
export async function readActivityProbeRotation(params: {
  readonly workspaceId: string;
  readonly sourceClass: SurveyableSourceClass;
  readonly limit: number;
}): Promise<readonly string[]> {
  const rows = await internalQuery<{ unit_id: string }>(
    `SELECT unit_id
       FROM brain_coverage_snapshot
      WHERE workspace_id = $1 AND source_class = $2 AND in_perimeter
      ORDER BY vendor_activity_checked_at ASC NULLS FIRST, unit_id ASC
      LIMIT $3`,
    [params.workspaceId, params.sourceClass, params.limit],
  );
  return rows.map((r) => r.unit_id);
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

/**
 * How far a roster may shrink in one cycle before the write says so.
 *
 * `written * 4 < retired` fires when a cycle retires MORE THAN 80% of a roster —
 * 10 -> 1, and any total wipe — and stays quiet when a handful of channels were
 * archived. A ratio rather than a count because the honest signal is
 * proportional: losing 80 of 100 is alarming and losing 4 of 400 is not.
 */
const COLLAPSE_RATIO = 4;

const SURVEYABLE_SET: ReadonlySet<string> = new Set(SURVEYABLE_SOURCE_CLASSES);

/** Is this value one of the classes that can hold a snapshot row? */
export function isSurveyableSourceClass(value: unknown): value is SurveyableSourceClass {
  return typeof value === "string" && SURVEYABLE_SET.has(value);
}

/**
 * Narrow an {@link EpisodeSourceClass} to a surveyable one, or `null`.
 *
 * Exists so a caller holding the wider class type reaches the snapshot tables
 * through ONE narrowing rather than each writing `cls !== "human"` — which reads
 * as an exclusion of one class rather than as the contract's declared
 * non-surveyability, and would silently admit the next non-surveyable class.
 */
export function surveyableClassOf(cls: EpisodeSourceClass): SurveyableSourceClass | null {
  return isSurveyableSourceClass(cls) ? cls : null;
}

const DEGRADED_SET: ReadonlySet<string> = new Set(COVERAGE_DEGRADED_ARMS);

/** Is this value one of the map-edge marks this deploy can render? */
function isCoverageDegradedArm(value: unknown): value is CoverageDegradedArm {
  return typeof value === "string" && DEGRADED_SET.has(value);
}

function readDegradedArms(
  raw: unknown,
  workspaceId: string,
  sourceClass: SurveyableSourceClass,
): readonly CoverageDegradedArm[] {
  if (!Array.isArray(raw)) {
    // Not `return []` quietly. `degraded_arms` is `NOT NULL DEFAULT '{}'` so this
    // is unreachable through the driver — which is exactly why it must be loud
    // if it ever happens: an empty array here reads as "no map edges", i.e. a
    // COMPLETE map, which is the flattering direction and the one ADR-0041 calls
    // a false statement rather than an error state.
    log.error(
      { workspaceId, sourceClass, rawType: typeof raw },
      "brain coverage: the stored map-edge marks are not an array — reporting no map edges for this class, which reads as a complete map",
    );
    return [];
  }
  const out: CoverageDegradedArm[] = [];
  const unknown: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (isCoverageDegradedArm(entry)) {
      out.push(entry);
      continue;
    }
    unknown.push(entry);
  }
  if (unknown.length > 0) {
    // A stored arm this deploy does not recognise is a map edge that would
    // vanish from the page. Dropping it is right — the surface has no sentence
    // for it — but it must not be silent, because the direction of the loss is
    // "the map looks more complete than it is".
    log.warn(
      { workspaceId, sourceClass, unknownArms: unknown },
      "brain coverage: stored map-edge marks this deploy does not recognise — they are not rendered, so the map reads more complete than it is",
    );
  }
  return out;
}

/**
 * A denominator column, or a LOUD zero.
 *
 * `count(*)::int` reaches node-pg as a `number`, so the fallback is unreachable
 * — which is the reason it logs rather than the reason it can be trusted. A
 * silent `0` on `enumerated` SHRINKS the denominator, and a shrunk denominator
 * raises the ratio: the one direction this whole module is organised against,
 * arriving through the narrowing helper nobody reads.
 */
function asCount(value: unknown, field: string, workspaceId: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  log.error(
    { workspaceId, field, valueType: typeof value },
    "brain coverage: a denominator count came back unreadable — reporting zero for it, which makes this class's coverage look better than it is",
  );
  return 0;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}
