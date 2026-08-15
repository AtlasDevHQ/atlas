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
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import { getBotToken, getInstallationByOrg, listSlackInstalledOrgIds } from "@atlas/api/lib/slack/store";
import { resolveSlackHistoryToken } from "@atlas/api/lib/brain/ingest/slack/connector";
import { enumerateSlackCoverage } from "@atlas/api/lib/brain/ingest/slack/coverage";
import { enumerateWarehouseCoverage } from "@atlas/api/lib/brain/coverage-warehouse";
import {
  persistCoverageSnapshot,
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
 * That constant has no declaration site yet (`class-contract.ts` says so on
 * `stalenessVerdict`, and says it belongs THERE rather than in a consumer), and
 * a consumer must not substitute this one for it: this is how often the ROSTER
 * is re-enumerated, which is a different question from how far a source may move
 * before it is called stale.
 */
export const DEFAULT_COVERAGE_SNAPSHOT_INTERVAL_MS = 60 * 60_000;

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
 * THE registry. Total over `EpisodeSourceClass` by construction — a new class
 * without an entry is a compile error.
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
        // sentence beside it. `resolveSlackHistoryToken`'s messages are already
        // written for an admin ("no Slack connection", "credential could not be
        // read"), which is why they travel verbatim.
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
} as const satisfies Record<EpisodeSourceClass, ClassEnumerationPlan>;

/** What one cycle did, for the span attributes and the audit line. */
export interface CoverageSnapshotCycleResult {
  /**
   * `degraded` when at least one (workspace, class) enumeration refused while
   * others succeeded — the cycle ran, and part of the map is older than the rest.
   * `failure` is reserved for the scan itself failing, i.e. the cycle could not
   * establish which workspaces to look at.
   */
  readonly status: "success" | "degraded" | "failure";
  readonly workspacesInspected: number;
  readonly workspacesSkippedDisabled: number;
  readonly classesEnumerated: number;
  readonly classesFailed: number;
  readonly unitsWritten: number;
  readonly unitsRetired: number;
  readonly unitsSurveyed: number;
  /** Map-edge marks recorded across every class this cycle. */
  readonly mapEdges: number;
  readonly error: string | null;
}

const ZERO = {
  workspacesInspected: 0,
  workspacesSkippedDisabled: 0,
  classesEnumerated: 0,
  classesFailed: 0,
  unitsWritten: 0,
  unitsRetired: 0,
  unitsSurveyed: 0,
  mapEdges: 0,
  error: null,
} as const;

/** Injection seam for the tests. */
export interface CoverageSnapshotDeps {
  readonly plans?: Record<EpisodeSourceClass, ClassEnumerationPlan>;
  readonly persist?: typeof persistCoverageSnapshot;
  readonly isEnabled?: (workspaceId?: string) => boolean;
  readonly now?: () => Date;
}

/**
 * Run one denominator-snapshot cycle over every surveyable class.
 *
 * Never rejects for a per-workspace reason — a refused enumeration is recorded
 * against that (workspace, class) and the cycle carries on, because one
 * workspace's revoked Slack token must not stop another workspace's warehouse
 * roster being refreshed. A WRITE failure is different and does propagate out of
 * the per-class loop into the tally as a failed class, with the message logged:
 * a database that cannot be written is not a fact about one tenant.
 */
export async function runCoverageSnapshotCycle(
  deps: CoverageSnapshotDeps = {},
): Promise<CoverageSnapshotCycleResult> {
  if (!hasInternalDB()) return { status: "success", ...ZERO };

  const plans = deps.plans ?? CLASS_ENUMERATION_PLANS;
  const persist = deps.persist ?? persistCoverageSnapshot;
  const isEnabled = deps.isEnabled ?? isCoverageSnapshotEnabled;
  const now = deps.now ?? (() => new Date());

  let workspacesInspected = 0;
  let workspacesSkippedDisabled = 0;
  let classesEnumerated = 0;
  let classesFailed = 0;
  let unitsWritten = 0;
  let unitsRetired = 0;
  let unitsSurveyed = 0;
  let mapEdges = 0;
  let scanError: string | null = null;

  for (const [cls, plan] of Object.entries(plans)) {
    if (plan.kind !== "enumerates") continue;
    // Narrowed rather than cast: only a surveyable class may hold a snapshot
    // row (migration 0201's CHECK), and the registry's `human` entry is
    // `not-surveyable` precisely so this narrowing cannot fail. If it ever does,
    // the class gained an enumerator without gaining a migration.
    const sourceClass = cls as SurveyableSourceClass;

    let workspaces: readonly string[];
    try {
      workspaces = await plan.listWorkspaces();
    } catch (err) {
      // RECORDED AND FALLEN THROUGH — the other classes' scans are independent,
      // and aborting the cycle here would let one class's scan failure freeze
      // every class's roster.
      const message = err instanceof Error ? err.message : String(err);
      scanError = scanError === null ? `${sourceClass}: ${message}` : `${scanError}; ${sourceClass}: ${message}`;
      log.error(
        { sourceClass, err: message },
        "brain coverage: could not list the workspaces for this class — its rosters keep their previous readings this cycle",
      );
      continue;
    }

    for (const workspaceId of workspaces) {
      if (!isEnabled(workspaceId)) {
        workspacesSkippedDisabled++;
        continue;
      }
      workspacesInspected++;
      let outcome: CoverageEnumeration;
      try {
        outcome = await plan.enumerate(workspaceId);
      } catch (err) {
        // An enumerator threw where its contract says it returns a refusal — a
        // database read inside it, most likely. Converted rather than swallowed:
        // the refusal path is the one that keeps the previous roster, which is
        // exactly what a caller wants when an enumerator breaks.
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { workspaceId, sourceClass, err: message },
          "brain coverage: an enumeration threw — recorded as unavailable, and the previous dated roster is kept",
        );
        outcome = {
          ok: false,
          error: `Atlas could not enumerate this workspace's ${sourceClass} coverage (${message}) — the previous reading is kept. It retries on the next cycle.`,
        };
      }

      try {
        const report = await persist({ workspaceId, sourceClass, outcome, cycleAt: now() });
        if (report.status === "failure") {
          classesFailed++;
          continue;
        }
        classesEnumerated++;
        unitsWritten += report.written;
        unitsRetired += report.retired;
        unitsSurveyed += report.surveyed;
        mapEdges += report.degraded.length;
      } catch (err) {
        classesFailed++;
        log.error(
          { workspaceId, sourceClass, err: err instanceof Error ? err.message : String(err) },
          "brain coverage: could not persist a denominator snapshot — this workspace's roster keeps its previous reading",
        );
      }
    }
  }

  const status: CoverageSnapshotCycleResult["status"] =
    scanError !== null ? "failure" : classesFailed > 0 ? "degraded" : "success";
  return {
    status,
    workspacesInspected,
    workspacesSkippedDisabled,
    classesEnumerated,
    classesFailed,
    unitsWritten,
    unitsRetired,
    unitsSurveyed,
    mapEdges,
    error: scanError,
  };
}
