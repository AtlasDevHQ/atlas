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
 * resistance. A mailbox address that was never written cannot leak through a
 * future reader that forgot the policy, and the disclosure facts travel beside
 * the row so that reader can still re-derive the decision rather than trust it.
 *
 * @see ../db/migrations/0201_brain_coverage_snapshot.sql — the tables and the
 *   green-is-evidence CHECK
 * @see ./class-contract.ts — `coverageLabelPolicy`, the class's declared
 *   denominator and staleness capability
 */

import { createLogger } from "@atlas/api/lib/logger";
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
 * something", and a unit of that class would be a PERSON. Migration 0201's CHECK
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
  /** The semantic-layer walk hit its entity bound: there are entities past it. */
  "warehouse-entity-bound-reached",
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
         -- ⚠️ COALESCE, and the argument order is the whole point: an UNPROBED
         -- unit passes NULL here and must keep the reading a previous cycle
         -- paid a Slack call for. EXCLUDED first means a probe that found the
         -- channel newly active wins; NULL falling through to the stored value
         -- means an unprobed cycle changes nothing.
         --
         -- The cost, accepted: a channel whose newest message was DELETED keeps
         -- the older reading until the next probe overwrites it. Nulling
         -- instead would lose every reading on every unprobed cycle, which is
         -- most cycles for most channels.
         vendor_activity_at =
           COALESCE(EXCLUDED.vendor_activity_at, brain_coverage_snapshot.vendor_activity_at),
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

/** What one persisted cycle changed — the scheduler's per-class tally. */
export interface CoveragePersistReport {
  readonly status: "success" | "failure";
  /** Units written this cycle. Zero on a failure, and no row was touched. */
  readonly written: number;
  /** Units the cycle did not re-observe and therefore retired. Zero on a failure. */
  readonly retired: number;
  /** How many of the written units are `surveyed`. */
  readonly surveyed: number;
  /** How many carry a label. Always ≤ `written`; the rest are counted, never named. */
  readonly labelled: number;
  readonly degraded: readonly CoverageDegradedArm[];
}

/**
 * Land one class's enumeration for one workspace.
 *
 * The whole write is one transaction: roster upserts, the sweep, and the cycle
 * record commit together, so a page can never read a half-swept roster stamped
 * with a fresh success. A failure arm writes only `brain_coverage_cycle` and
 * touches no roster row at all.
 *
 * @throws whatever the database throws. The caller (the scheduled job) records it
 *   as a failed tick; swallowing it here would report a green cycle that wrote
 *   nothing, which is M1's failure shape.
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
    await internalQuery(RECORD_FAILURE_SQL, [workspaceId, sourceClass, cycleIso, outcome.error]);
    log.warn(
      { workspaceId, sourceClass, err: outcome.error },
      "brain coverage: enumeration failed — the previous dated roster is kept as-is, and the surface reads 'enumeration unavailable since' its last success",
    );
    return { status: "failure", written: 0, retired: 0, surveyed: 0, labelled: 0, degraded: [] };
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
 */
export async function readCoverageSnapshot(
  workspaceId: string,
): Promise<readonly CoverageClassSnapshot[]> {
  const rows = await internalQuery<Record<string, unknown>>(READ_SNAPSHOT_SQL, [workspaceId]);
  const out: CoverageClassSnapshot[] = [];
  for (const row of rows) {
    const sourceClass = row.source_class;
    if (!isSurveyableSourceClass(sourceClass)) {
      // Unreachable through the writers (migration 0201's CHECK) and therefore a
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
      surveyed: asCount(row.surveyed),
      enumerated: asCount(row.enumerated),
      inPerimeterWithoutEvidence: asCount(row.blind),
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
  readonly vendorActivityAt: string | null;
  readonly vendorActivityCheckedAt: string | null;
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
  return rows.map((r) => ({
    unitId: String(r.unit_id),
    // Narrowed fail-closed: an unrecognised state renders as `enumerated`, never
    // as a `surveyed` no writer recorded. The CHECK makes it unreachable; the
    // narrowing is what keeps the type honest if it ever is not.
    state: r.state === "surveyed" ? "surveyed" : "enumerated",
    inPerimeter: r.in_perimeter === true,
    label: typeof r.unit_label === "string" && r.unit_label !== "" ? r.unit_label : null,
    newestEvidenceAt: isoOrNull(r.newest_evidence_at),
    vendorActivityAt: isoOrNull(r.vendor_activity_at),
    vendorActivityCheckedAt: isoOrNull(r.vendor_activity_checked_at),
  }));
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

function readDegradedArms(
  raw: unknown,
  workspaceId: string,
  sourceClass: SurveyableSourceClass,
): readonly CoverageDegradedArm[] {
  if (!Array.isArray(raw)) return [];
  const out: CoverageDegradedArm[] = [];
  const unknown: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    if (DEGRADED_SET.has(entry)) {
      out.push(entry as CoverageDegradedArm);
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

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}
