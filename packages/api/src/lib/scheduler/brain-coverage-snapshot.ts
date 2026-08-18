/**
 * The denominator-snapshot cycle (#5213, ADR-0041).
 *
 * ADR-0041 § The surface: *"Denominators come from scheduled cycles writing dated
 * snapshots (the `registerPeriodicFiber` pattern), read by the page and stamped
 * 'as of \<date\>' — never live vendor calls on page view. The page's correctness
 * claim must not couple its availability to five vendors' rate limits, and the
 * date is part of the statement."*
 *
 * This module is that cycle: per class, per workspace, enumerate the survey units
 * the granted credentials can see and hand the result to
 * {@link persistCoverageSnapshot}, which owns the write and the never-zero rule.
 *
 * ## The registry is `Record<EpisodeSourceClass, …>` and that is load-bearing
 *
 * ADR-0041 § Correctness is the product: *"Totality at compile time: the coverage
 * representation is keyed `Record<EpisodeSourceClass, …>`, so a class added
 * without a coverage answer is a compile error, not a silently missing row."*
 *
 * The three entry kinds are what make the totality mean something. Collapsing
 * `not-surveyable` and `awaiting-connector` to `null` would say the same thing
 * about `human` — which has positively declared it has no enumerable units — and
 * about `transcript`, which HAS a declared denominator that nothing has been
 * written to enumerate yet. Only the second is a gap, and only a shape that can
 * tell them apart can say so.
 *
 * ## Enablement is per workspace, re-read inside the cycle
 *
 * `registerPeriodicFiber`'s `gate` is evaluated once at boot and is the
 * operator's process-wide switch. {@link isCoverageSnapshotEnabled} is called
 * again per workspace here, which is where a tenant's decision lives — the
 * `brain_audience_sync` split, unchanged.
 *
 * @see ../brain/coverage-enumeration.ts — the shape and the write
 * @see ../effect/layers.ts — `registerPeriodicFiber`, the fiber scheduler
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { getBotToken, getInstallationByOrg, listSlackInstalledOrgIds } from "@atlas/api/lib/slack/store";
import { resolveSlackHistoryToken } from "@atlas/api/lib/brain/ingest/slack/connector";
import { enumerateSlackCoverage } from "@atlas/api/lib/brain/ingest/slack/coverage";
import { enumerateWarehouseCoverage } from "@atlas/api/lib/brain/coverage-warehouse";
import {
  SURVEYABLE_SOURCE_CLASSES,
  persistCoverageSnapshot,
  recordClassScanFailure,
  type CoverageEnumeration,
  type SurveyableSourceClass,
} from "@atlas/api/lib/brain/coverage-enumeration";
import type { EpisodeSourceClass } from "@atlas/api/lib/brain/sources";

const log = createLogger("brain.coverage-snapshot");

/**
 * Default cadence: hourly.
 *
 * A denominator is a roster, not a feed — channels are created and bots invited
 * on a human timescale — and every cycle costs one `conversations.list` walk plus
 * a bounded probe rotation per Slack workspace. Hourly keeps a newly created
 * channel's appearance well inside a working day while leaving the vendor call
 * budget an order of magnitude under the ingest cycle's.
 *
 * ⚠️ This is NOT the "class's sync cadence" ADR-0041 measures staleness against.
 * That constant now has a declaration site — `class-contract.ts`'s
 * `VendorActivityMetadata`, claimed by #5214 — and it is a DIFFERENT number for a
 * different question: this is how often the ROSTER is re-enumerated, that is how
 * far a source may move ahead of our evidence before it is called stale. They
 * are an hour and a day respectively today, and a consumer must not substitute
 * either for the other.
 */
export const DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS = 60 * 60_000;

/**
 * How many distinct failure reasons the cycle result carries.
 *
 * A per-class scan failure is at most one per class, but a per-WORKSPACE write
 * failure is one per tenant — so a fleet-wide database fault would otherwise
 * build the same sentence a thousand times into a span attribute. The first few
 * name the fault; the log lines carry the rest, one per workspace, with the
 * cycle id to group them.
 *
 * ⚠️ The bound applies to the PER-WORKSPACE arms only. The class-wide scan arm
 * pushes unconditionally, because there is at most one per class and it must
 * never be crowded out by five workspace faults — so a cycle can carry more than
 * this many reasons, and they are not de-duplicated.
 */
const FAILURE_REASONS_MAX = 5;

/**
 * Is the denominator snapshot switched on for this scope?
 *
 * No argument reads the PLATFORM value — the fiber's own gate, an operator's
 * process-wide off switch. With one it reads the workspace override.
 *
 * Default ON: the snapshot is a read-only availability measurement over sources
 * the workspace has already connected, and ADR-0040's rule is that availability
 * is automatic while authority never is. Nothing here produces a claim, writes a
 * fact, or discloses anything a count does not.
 */
export function isCoverageSnapshotEnabled(workspaceId?: string): boolean {
  return getSettingAuto("ATLAS_BRAIN_COVERAGE_SNAPSHOT_ENABLED", workspaceId) !== "false";
}

/** Cadence knob, in ms. Non-positive / unparseable values fall back with a warn. */
export function getCoverageSnapshotIntervalMs(): number {
  const raw = getSettingAuto("ATLAS_BRAIN_COVERAGE_SNAPSHOT_INTERVAL_MINUTES");
  if (raw === undefined || raw === "") return DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS;
  const minutes = Number.parseFloat(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    log.warn(
      { raw },
      "ATLAS_BRAIN_COVERAGE_SNAPSHOT_INTERVAL_MINUTES is non-positive or unparseable — using the default",
    );
    return DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS;
  }
  return minutes * 60_000;
}

/**
 * The workspaces whose warehouse denominator this cycle enumerates: every
 * workspace holding a PUBLISHED semantic entity.
 *
 * Not "every workspace with an enrollment". The denominator's whole job is to
 * count the pairs NOBODY enrolled — that is ADR-0041 state 2 for this class — so
 * dispatching on enrollment would give a workspace that has enrolled nothing a
 * denominator of zero, i.e. the page would report full coverage of an empty
 * universe to exactly the workspace that has not started.
 *
 * `status = 'published'` matches `loadEnrollableEntities`' own mode: the producer
 * reads what is live, and a developer-mode draft is not something the Atlas
 * should be counting a denominator from.
 */
export const WAREHOUSE_WORKSPACES_SQL = `SELECT DISTINCT org_id
     FROM semantic_entities
    WHERE status = 'published'
    ORDER BY org_id`;

async function listWarehouseWorkspaces(): Promise<readonly string[]> {
  const rows = await internalQuery<{ org_id: string }>(WAREHOUSE_WORKSPACES_SQL, []);
  return rows.map((r) => r.org_id);
}

/**
 * One class's answer to "how do I enumerate you?".
 *
 * Three kinds, and the two refusals are deliberately distinct — see the module
 * header.
 */
export type ClassEnumerationPlan =
  | {
      readonly kind: "enumerates";
      readonly listWorkspaces: () => Promise<readonly string[]>;
      readonly enumerate: (workspaceId: string) => Promise<CoverageEnumeration>;
    }
  /** The class declared it has no enumerable units (`CLASS_CONTRACTS.human`). */
  | { readonly kind: "not-surveyable" }
  /**
   * The class HAS a declared denominator and no enumerator has been written yet.
   * A gap, and the shape says so — `#5213` ships chat and warehouse; transcript
   * and email follow their connectors' coverage work.
   */
  | { readonly kind: "awaiting-connector" };

/**
 * The registry's shape — total over `EpisodeSourceClass`, and CORRELATED.
 *
 * A plain `Record<EpisodeSourceClass, ClassEnumerationPlan>` gave totality and
 * nothing else, so `human: { kind: "enumerates", … }` type-checked. That is not
 * a hypothetical: the class would then reach `persistCoverageSnapshot` (whose
 * parameter says `SurveyableSourceClass`) and die on
 * `ck_brain_coverage_snapshot_class` — a CHECK violation counted as one more
 * failed class, indistinguishable from a transient database fault.
 *
 * The mapped type ties the plan to the class, in BOTH directions: a
 * non-surveyable class may declare ONLY `not-surveyable`, and a surveyable one
 * may NOT declare it. The second half was missing at first, and it matters for
 * the same reason: `chat: { kind: "not-surveyable" }` type-checked and silently
 * removed chat's roster forever, since the loop just `continue`s and no arm
 * records an attempt. Only a runtime test caught it, and only for the production
 * registry — never for a double, which is the gap the mapped type exists to close.
 */
export type ClassEnumerationPlans = {
  readonly [K in EpisodeSourceClass]: K extends SurveyableSourceClass
    ? Exclude<ClassEnumerationPlan, { readonly kind: "not-surveyable" }>
    : { readonly kind: "not-surveyable" };
};

/**
 * THE registry. Total over `EpisodeSourceClass` by construction — a new class
 * without an entry is a compile error, and a non-surveyable class with an
 * enumerator is too.
 */
export const CLASS_ENUMERATION_PLANS = {
  chat: {
    kind: "enumerates",
    listWorkspaces: listSlackInstalledOrgIds,
    enumerate: async (workspaceId: string) => {
      let token: string;
      try {
        token = await resolveSlackHistoryToken({ getInstallationByOrg, getBotToken }, workspaceId);
      } catch (err) {
        // A recorded refusal, NOT a throw: the previous dated roster stays, and
        // the page says "enumeration unavailable since <date>" with this
        // sentence beside it. `resolveSlackHistoryToken`'s own two messages are
        // written for an admin ("no Slack connection", "credential could not be
        // read") — but `getInstallationByOrg`/`getBotToken` sit under the same
        // call and can throw pg or decrypt errors, whose text can echo a
        // connection string. This string is STORED and rendered, so it is
        // scrubbed like every other one on that path.
        return {
          ok: false,
          error: `Atlas could not read this workspace's Slack credential to enumerate chat coverage — the previous reading is kept, and it retries on the next cycle (${errorMessage(err)})`,
        };
      }
      return enumerateSlackCoverage({ workspaceId, token });
    },
  },
  transcript: { kind: "awaiting-connector" },
  email: { kind: "awaiting-connector" },
  warehouse: {
    kind: "enumerates",
    listWorkspaces: listWarehouseWorkspaces,
    enumerate: (workspaceId: string) => enumerateWarehouseCoverage({ workspaceId }),
  },
  human: { kind: "not-surveyable" },
} as const satisfies ClassEnumerationPlans;

/**
 * What one cycle did, for the span attributes and the audit line.
 *
 * ⚠️ The counters are per (CLASS, WORKSPACE), not per workspace — a tenant with
 * both Slack and a published semantic layer contributes two enumerations. They
 * are named for what they measure because the alternative is a span attribute an
 * operator reads as a tenant count and derives a wrong "how much of the fleet is
 * covered" from.
 */
export interface CoverageSnapshotCycleResult {
  /**
   * `degraded` when part of the cycle ran and part did not — an enumeration
   * refused, a write failed, or ONE class's workspace scan failed while another
   * class's succeeded. `failure` is reserved for the cycle establishing nothing
   * at all: every class that has an enumerator failed to list its workspaces.
   *
   * The split matters because `failure` is what an operator pages on. One
   * class's scan failing while another enumerated five hundred workspaces is not
   * "the cycle could not establish which workspaces to look at" — it is exactly
   * `degraded`'s sentence.
   *
   * ⚠️ `error` is non-null whenever a failure counter moves: the FIRST failure of
   * a cycle is always recorded, and {@link FAILURE_REASONS_MAX} only drops the
   * sixth and later. The scan arm is uncapped, so a class-wide fault always
   * names itself even behind five workspace faults.
   *
   * Holds in production, where a `failure` report implies a refused outcome. An
   * injected `persist` that returned `failure` for an `ok` one would move the
   * counter and push nothing.
   */
  readonly status: "success" | "degraded" | "failure";
  /** (class, workspace) pairs this cycle attempted. */
  readonly enumerationsAttempted: number;
  /** (class, workspace) pairs skipped because the workspace switched it off. */
  readonly enumerationsSkippedDisabled: number;
  /** (class, workspace) pairs whose roster this cycle wrote. */
  readonly enumerationsSucceeded: number;
  /** (class, workspace) pairs whose roster this cycle could NOT write. */
  readonly enumerationsFailed: number;
  readonly unitsWritten: number;
  readonly unitsRetired: number;
  readonly unitsSurveyed: number;
  /** Map-edge marks recorded across every class this cycle. */
  readonly mapEdges: number;
  /**
   * (class, workspace) pairs whose roster COLLAPSED this cycle — most or all of
   * the prior units retired under a clean success.
   *
   * Separate from `enumerationsFailed` because nothing failed: the write
   * succeeded and the number it wrote is the suspect one. A non-zero value is
   * "verify the enumerator before trusting this denominator", which is a
   * different instruction from "something is broken".
   */
  readonly rostersCollapsed: number;
  readonly error: string | null;
}

const ZERO = {
  enumerationsAttempted: 0,
  enumerationsSkippedDisabled: 0,
  enumerationsSucceeded: 0,
  enumerationsFailed: 0,
  unitsWritten: 0,
  unitsRetired: 0,
  unitsSurveyed: 0,
  mapEdges: 0,
  rostersCollapsed: 0,
  error: null,
} as const;

/** Injection seam for the tests. */
export interface CoverageSnapshotDeps {
  readonly plans?: ClassEnumerationPlans;
  readonly persist?: typeof persistCoverageSnapshot;
  /**
   * The class-wide arm. Injected beside {@link persist} rather than folded into
   * it because the two reach different row sets — one workspace versus every
   * workspace of a class — and a double that could not tell them apart would
   * hide precisely the omission this seam was added to close.
   */
  readonly recordScanFailure?: typeof recordClassScanFailure;
  readonly isEnabled?: (workspaceId?: string) => boolean;
  readonly now?: () => Date;
}

/**
 * Run one denominator-snapshot cycle over every surveyable class.
 *
 * Every per-workspace fault is caught per workspace: a refused enumeration and a
 * failed write both record an attempt, count an `enumerationsFailed`, and let the
 * loop move on — one workspace's revoked Slack token must not stop another
 * workspace's warehouse roster being refreshed. Only `listWorkspaces()` throwing
 * is class-wide.
 *
 * ⚠️ It does not therefore never reject. The per-workspace `isEnabled` read sits
 * outside every `try`, which is exactly why the fiber wraps this in
 * `Effect.tryPromise` rather than `Effect.promise`.
 */
export async function runCoverageSnapshotCycle(
  deps: CoverageSnapshotDeps = {},
): Promise<CoverageSnapshotCycleResult> {
  if (!hasInternalDB()) return { status: "success", ...ZERO };

  const plans = deps.plans ?? CLASS_ENUMERATION_PLANS;
  const persist = deps.persist ?? persistCoverageSnapshot;
  const recordScanFailure = deps.recordScanFailure ?? recordClassScanFailure;
  const isEnabled = deps.isEnabled ?? isCoverageSnapshotEnabled;
  const now = deps.now ?? (() => new Date());

  // One id for every line this cycle emits. The per-workspace warns and errors
  // are otherwise ungroupable — the property `requestId` gives the HTTP side,
  // which a background fiber has no equivalent of until it mints one.
  const cycleId = `cov-${now().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

  let enumerationsAttempted = 0;
  let enumerationsSkippedDisabled = 0;
  let enumerationsSucceeded = 0;
  let enumerationsFailed = 0;
  let unitsWritten = 0;
  let unitsRetired = 0;
  let unitsSurveyed = 0;
  let mapEdges = 0;
  let rostersCollapsed = 0;
  let scansAttempted = 0;
  let scansFailed = 0;
  /**
   * Every reason this cycle could not do part of its job — scan failures AND
   * write failures.
   *
   * Write failures used to increment `classesFailed` and reach `error` never, so
   * a cycle in which every persist threw returned `{ status: "degraded", error:
   * null }` while the status docstring claimed "`error` is non-null either way".
   * A counterfactual comment about the one field an operator reads for the
   * reason.
   */
  const failureReasons: string[] = [];

  // ⚠️ Iterating the SURVEYABLE list rather than the registry's keys, because
  // `Object.entries` widens the key to `string` — so the previous `cls as
  // SurveyableSourceClass` was an unchecked assertion, not the narrowing its
  // comment claimed. Here `sourceClass` is correctly typed with no assertion,
  // and `human` cannot be reached at all rather than being skipped by a
  // `kind` check that a mis-declared registry could defeat.
  for (const sourceClass of SURVEYABLE_SOURCE_CLASSES) {
    const plan = plans[sourceClass];
    if (plan.kind !== "enumerates") continue;
    scansAttempted++;

    let workspaces: readonly string[];
    try {
      workspaces = await plan.listWorkspaces();
    } catch (err) {
      // RECORDED AND FALLEN THROUGH — the other classes' scans are independent,
      // and aborting the cycle here would let one class's scan failure freeze
      // every class's roster.
      scansFailed++;
      const message = errorMessage(err);
      failureReasons.push(`${sourceClass}: ${message}`);
      log.error(
        { cycleId, sourceClass, err: message },
        "brain coverage: could not list the workspaces for this class — its rosters keep their previous readings this cycle",
      );
      // ⚠️ THE ATTEMPT IS RECORDED HERE TOO, and this arm is the reason the
      // fix-vs-finding step exists. Without it a class-wide scan failure moves
      // NOTHING — no `last_attempt_at`, no `last_error`, for any workspace of
      // that class — so the page keeps rendering a clean, dated, CURRENT
      // statement for as long as the scan keeps failing. Which is exactly the
      // defect the per-workspace write arm below was fixed for, standing one arm
      // over and certified by a test that asserted the class wrote nothing.
      try {
        await recordScanFailure({
          sourceClass,
          cycleAt: now(),
          // The tenant's own decision, through the same reader the normal path
          // uses. A workspace that switched the cycle OFF is skipped rather than
          // told an enumeration failed that would never have run for it.
          includeWorkspace: (workspaceId) => isEnabled(workspaceId),
          error: `Atlas could not list the workspaces to enumerate for ${sourceClass} coverage — the previous reading is kept, and it retries on the next cycle (${message})`,
        });
      } catch (recordErr) {
        log.error(
          { cycleId, sourceClass, err: errorMessage(recordErr) },
          "brain coverage: could not record the class-wide scan failure — this class will read 'as of' its last success with no error beside it",
        );
      }
      continue;
    }

    for (const workspaceId of workspaces) {
      if (!isEnabled(workspaceId)) {
        enumerationsSkippedDisabled++;
        continue;
      }
      enumerationsAttempted++;
      let outcome: CoverageEnumeration;
      try {
        outcome = await plan.enumerate(workspaceId);
      } catch (err) {
        // An enumerator threw where its contract says it returns a refusal — a
        // database read inside it, most likely. Converted rather than swallowed:
        // the refusal path is the one that keeps the previous roster, which is
        // exactly what a caller wants when an enumerator breaks.
        const message = errorMessage(err);
        log.error(
          { cycleId, workspaceId, sourceClass, err: message },
          "brain coverage: an enumeration threw — recorded as unavailable, and the previous dated roster is kept",
        );
        outcome = {
          ok: false,
          error: `Atlas could not enumerate this workspace's ${sourceClass} coverage — the previous reading is kept, and it retries on the next cycle (${message})`,
        };
      }

      try {
        const report = await persist({
          workspaceId,
          sourceClass,
          outcome,
          cycleAt: now(),
          requestId: cycleId,
        });
        if (report.status === "failure") {
          enumerationsFailed++;
          // The SURFACE is already right on this path: `persist` ran
          // `RECORD_FAILURE_SQL`, so the date moved and `unavailableReason` says
          // why. What this adds is the OPERATOR's half — the span's `error`
          // attribute, which is what an alert reads.
          if (!outcome.ok && failureReasons.length < FAILURE_REASONS_MAX) {
            // SCRUBBED like its two siblings. `outcome.error` for the chat class
            // embeds `slackReadGet`'s `request_failed: ${message}`, which is raw
            // transport text — a proxy misconfiguration surfaces credentials
            // there. Harmless while nothing read this field; a live leak the
            // moment it reached a span, which it now does.
            failureReasons.push(`${sourceClass}/${workspaceId}: ${errorMessage(outcome.error)}`);
          }
          continue;
        }
        enumerationsSucceeded++;
        unitsWritten += report.written;
        unitsRetired += report.retired;
        unitsSurveyed += report.surveyed;
        mapEdges += report.degraded.length;
        if (report.collapsed) rostersCollapsed++;
      } catch (err) {
        // ⚠️ THE ATTEMPT IS STILL RECORDED, and that is the whole point of this
        // arm. Without it a write failure leaves `last_attempt_at` frozen and
        // `last_error` NULL, so the page keeps rendering a clean, dated, STALE
        // statement with no error state for as long as the failure lasts — M1's
        // shape exactly: green while nothing is happening. The counters were
        // already right; the surface was not.
        enumerationsFailed++;
        const message = errorMessage(err);
        // PUSHED, not only logged: `error` is what an operator reads for the
        // reason. Bounded so a fleet-wide database fault does not build a
        // megabyte-long string out of one message per workspace.
        if (failureReasons.length < FAILURE_REASONS_MAX) {
          failureReasons.push(`${sourceClass}/${workspaceId}: ${message}`);
        }
        log.error(
          { cycleId, workspaceId, sourceClass, err: message },
          "brain coverage: could not persist a denominator snapshot — this workspace's roster keeps its previous reading",
        );
        try {
          await persist({
            workspaceId,
            sourceClass,
            cycleAt: now(),
            requestId: cycleId,
            outcome: {
              ok: false,
              error: `Atlas could not write this workspace's ${sourceClass} coverage roster — the previous reading is kept, and it retries on the next cycle (${message})`,
            },
          });
        } catch (recordErr) {
          // The failure arm writes one row to one table, so reaching here means
          // the database is refusing that too. Logged and dropped — there is
          // nowhere left to record it — but NOT silently, because the page will
          // now read "as of <old date>" with nothing beside it.
          log.error(
            { cycleId, workspaceId, sourceClass, err: errorMessage(recordErr) },
            "brain coverage: could not even record the failed attempt — this class will read 'as of' its last success with no error beside it",
          );
        }
      }
    }
  }

  // ⚠️ `failure` means the cycle established NOTHING — every class that has an
  // enumerator failed to list its workspaces. A partial scan failure is
  // `degraded`, which is what its own docstring says and what the arithmetic
  // previously contradicted: one class's scan failing while another enumerated
  // five hundred workspaces is not "could not establish which workspaces to look
  // at". `error` is non-null in both cases, so nothing alerting on the error
  // text is affected by the demotion.
  const totalScanFailure = scansAttempted > 0 && scansFailed === scansAttempted;
  const status: CoverageSnapshotCycleResult["status"] = totalScanFailure
    ? "failure"
    : scansFailed > 0 || enumerationsFailed > 0
      ? "degraded"
      : "success";
  return {
    status,
    enumerationsAttempted,
    enumerationsSkippedDisabled,
    enumerationsSucceeded,
    enumerationsFailed,
    unitsWritten,
    unitsRetired,
    unitsSurveyed,
    mapEdges,
    rostersCollapsed,
    error: failureReasons.length === 0 ? null : failureReasons.join("; "),
  };
}
