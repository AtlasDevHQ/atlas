/**
 * The **warehouse producer's cadence trigger** (#5228, ADR-0039).
 *
 * ADR-0039 answered *when it runs* outright — *"on enrollment, and on a cadence
 * thereafter. Cadence stops being frightening once scope is human-chosen"* — and
 * #5042 shipped only the operator-initiated `POST /api/v1/admin/brain-enrollment/produce`.
 * This is the second trigger, with the enablement, cadence and audit answers
 * `alias-proposal.ts`'s deferral asked for.
 *
 * ## What it runs, and why it is not narrower
 *
 * A full producer run over the workspace's whole reach, per tick, exactly as the
 * button does. **There is deliberately no per-pair or per-entity narrowing, and
 * that is a correctness decision rather than a scope cut.**
 *
 * `planWarehouseEmission` evaluates ADR-0037 §4's fail-closed ambiguity rule
 * *across the entities it is producing from*, and "the entities it is producing
 * from" is the reach it was handed. Hand it a narrower reach and the rule is
 * evaluated over a narrower set — so a dimension name enrolled on two entities,
 * which a full run REFUSES on both sides, is EMITTED by a run narrowed to one of
 * them. That is the irreversible direction: `warehouse-producer.ts` states it as
 * *"a missing warehouse fact is recoverable; a wrong `valid_to` stamp is not"*.
 * A narrowed plan is not a cheaper way to compute the same answer; it computes a
 * different one. `__tests__/brain-warehouse-cadence.test.ts` measures that
 * difference rather than asserting it here.
 *
 * The whole-reach re-read is affordable in the units ADR-0039 protects. The
 * scarce resource is the REVIEW QUEUE, and `reconcile.ts` corroborates an
 * unchanged value instead of minting a fresh draft — so re-reading a dimension
 * nothing touched costs a warehouse row and no queue at all. What it costs in
 * warehouse load is bounded twice over: by `WAREHOUSE_ROW_CAP` per entity, and
 * by the enrollment set being small by construction.
 *
 * ## Which makes the on-enrollment trigger a question about LATENCY, not scope
 *
 * ADR-0039's *"on enrollment"* is served by the reach being re-read at the top
 * of every run: a pair enrolled at any point is in the next tick's run, and the
 * operator who enrolled it can have it immediately by pressing the button that
 * sits on the same screen (`admin-brain-enrollment.ts` puts the two verbs there
 * on purpose). A third code path that runs the same full reach with a third
 * principal would add a trigger and no capability — and both existing triggers
 * now share the one lock, which a third would have to be wired into too.
 *
 * ## Enablement is explicit and OFF by default
 *
 * `ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED`, workspace-scoped, default `"false"` —
 * the opposite default from its coverage-snapshot and audience-sync neighbours,
 * and the split is ADR-0040's: **availability is automatic, authority never is.**
 * Those two cycles COUNT things and resolve rosters. This one files claims into a
 * queue a human has to drain, which is the one resource ADR-0039 exists to
 * protect, so a workspace gets scheduled runs only after somebody said so.
 *
 * A workspace that has enrolled nothing is never considered at all
 * ({@link WAREHOUSE_CADENCE_WORKSPACES_SQL}): with an empty reach the producer's
 * only possible output is an empty report, and enumerating every tenant to
 * produce one is a fleet-wide read for a guaranteed no-op.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  runWarehouseProducer,
  type WarehouseProducerReport,
} from "@atlas/api/lib/brain/warehouse-producer";
import {
  withWarehouseRunLock,
  type WarehouseRunLockOutcome,
} from "@atlas/api/lib/brain/warehouse-run-lock";

const log = createLogger("brain.warehouse-cadence");

/**
 * The principal a SCHEDULED run travels under.
 *
 * ⚠️ Not the attribution. `WAREHOUSE_PRODUCER_PRINCIPAL` (`system:warehouse-producer`)
 * is what every emitted claim is attributed to, and it is the same on both
 * triggers deliberately — the human's authority was spent at enrollment and is
 * recorded in `brain_enrollment.enrolled_by`. This is the OTHER field: who asked
 * for the run, which `runWarehouseProducer` carries as `triggeredBy` into
 * `provenance.detail` and into every log line the run emits.
 *
 * It has to be distinguishable from an operator's, because the two lead to
 * different questions. A refusal under an operator's id has somebody to ask; the
 * same refusal under this one has been recurring unattended and its first
 * occurrence is older than the log line in front of you. The `system:` prefix is
 * what makes the split greppable, and it is the same prefix the attribution
 * principal already uses.
 */
export const WAREHOUSE_CADENCE_PRINCIPAL = "system:warehouse-cadence";

/**
 * Default cadence: daily.
 *
 * A day is where the two costs cross. Below it the queue grows faster than a
 * reviewer drains it — every changed value is a draft *and* a tension edge
 * (ADR-0037 §4) — and above it a published claim can be a working week behind
 * the warehouse it was read from, which is the staleness a cadence exists to
 * remove. It is also the cadence at which a warehouse dimension a human chose to
 * enroll actually moves: enrollment selects for slow, curated, business-meaning
 * columns, not for event streams.
 */
export const DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * The shortest cadence the knob may express.
 *
 * ⚠️ **The floor is a constant for `WAREHOUSE_ROW_CAP`'s reason, and the value
 * above it is a setting for a reason the row cap does not have.** Lengthening
 * the cadence is safe and unbounded — a workspace that wants weekly, or none,
 * can have it, and only the operator knows their reviewers. Shortening it is the
 * direction that multiplies drafts per unit of human review time, which is
 * exactly what raising the row cap does, and `WAREHOUSE_ROW_CAP`'s comment
 * refuses that as *"a claim about how much a human can review."* So the knob is
 * open in the safe direction and stopped by a constant in the unsafe one.
 *
 * An hour, rather than something rounder, because the floor's job is to make the
 * pathological setting unreachable rather than to second-guess a legitimate one:
 * a per-minute cadence turns the producer into a polling loop against a customer
 * warehouse, and an hour is already three orders of magnitude below the volume
 * at which review capacity is the binding constraint.
 */
export const MIN_WAREHOUSE_CADENCE_INTERVAL_MS = 60 * 60_000;

/**
 * Is the cadence switched on for this scope?
 *
 * No argument reads the PLATFORM value — the fiber's own boot gate, an
 * operator's process-wide off switch. With one it reads the workspace override.
 *
 * ⚠️ **`=== "true"`, not `!== "false"`.** Its neighbours in the registry default
 * ON and are written the other way round; copying their spelling here would make
 * every unset workspace opted-in, which is the sweep ADR-0039 rejects arriving
 * as a default rather than as a feature.
 */
export function isWarehouseCadenceEnabled(workspaceId?: string): boolean {
  return getSettingAuto("ATLAS_BRAIN_WAREHOUSE_CADENCE_ENABLED", workspaceId) === "true";
}

/**
 * Cadence knob, in ms, clamped to {@link MIN_WAREHOUSE_CADENCE_INTERVAL_MS}.
 * Non-positive / unparseable values fall back to the default with a warn.
 */
export function getWarehouseCadenceIntervalMs(): number {
  const raw = getSettingAuto("ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS");
  if (raw === undefined || raw === "") return DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    log.warn(
      { raw },
      "ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS is non-positive or unparseable — using the default",
    );
    return DEFAULT_WAREHOUSE_CADENCE_INTERVAL_MS;
  }
  const requested = hours * 60 * 60_000;
  if (requested < MIN_WAREHOUSE_CADENCE_INTERVAL_MS) {
    log.warn(
      { raw, floorHours: MIN_WAREHOUSE_CADENCE_INTERVAL_MS / 60 / 60_000 },
      "ATLAS_BRAIN_WAREHOUSE_CADENCE_INTERVAL_HOURS is below the floor — clamping. A shorter cadence files drafts faster than a human can review them",
    );
    return MIN_WAREHOUSE_CADENCE_INTERVAL_MS;
  }
  return requested;
}

/**
 * The workspaces a cadence tick considers: those that have enrolled something.
 *
 * Deliberately NOT the coverage snapshot's *"every workspace with a published
 * semantic entity"*. That cycle computes a DENOMINATOR and must count the pairs
 * nobody enrolled; this one PRODUCES, and its reach is the enrollment table by
 * ADR-0039's rule. A workspace with an empty reach can only produce an empty
 * report, so including it would be a fleet-wide read for a guaranteed no-op.
 *
 * Enablement is read per workspace afterwards rather than joined in here: the
 * setting resolves through a four-tier chain (workspace override → platform
 * override → env → default) that a `SELECT` over the `settings` table cannot
 * reproduce, and a query that got it subtly wrong would silently run — or
 * silently skip — a tenant the admin surface says the opposite about.
 */
export const WAREHOUSE_CADENCE_WORKSPACES_SQL = `SELECT DISTINCT workspace_id
     FROM brain_enrollment
    ORDER BY workspace_id`;

/**
 * ⚠️ The `hasInternalDB()` check lives HERE rather than at the top of the cycle,
 * and the difference is not stylistic. As an early return in
 * {@link runWarehouseCadenceCycle} it short-circuited before any injected seam
 * was consulted, so every test that injects `listWorkspaces` — which is every
 * test of this cycle's actual behaviour — passed vacuously against a zeroed
 * result it never produced. Here, the only thing that needs a database is the
 * only thing that asks for one.
 *
 * An absent internal DB answers "no enrolled workspaces", which is true: nothing
 * can be enrolled without one. It is deliberately not a `failure` — a
 * self-hosted deployment with no internal DB is a supported configuration, not
 * an outage.
 */
async function listEnrolledWorkspaces(): Promise<readonly string[]> {
  if (!hasInternalDB()) return [];
  const rows = await internalQuery<{ workspace_id: string }>(
    WAREHOUSE_CADENCE_WORKSPACES_SQL,
    [],
  );
  return rows.map((r) => r.workspace_id);
}

/** How many distinct failure reasons the cycle result carries. */
const FAILURE_REASONS_MAX = 5;

export interface WarehouseCadenceCycleResult {
  /**
   * `failure` only when the workspace scan itself failed — the cycle produced
   * nothing and knows nothing. `degraded` when at least one workspace's run
   * threw but others ran. `success` otherwise, INCLUDING a cycle whose every
   * workspace declined the lock: declining is the lock working.
   */
  readonly status: "success" | "degraded" | "failure";
  readonly workspacesConsidered: number;
  readonly workspacesSkippedDisabled: number;
  readonly workspacesAttempted: number;
  /**
   * Runs that found the lock held — a concurrent operator press, or a previous
   * tick still running.
   *
   * ⚠️ Reported separately from `workspacesSucceeded` and never folded into it.
   * A tick where every workspace declined is byte-identical at rest to a tick
   * that ran cleanly and found nothing to say, and the remedies are opposite: the
   * first means runs are overrunning the cadence, the second means the warehouse
   * is quiet.
   */
  readonly workspacesDeclinedLocked: number;
  readonly workspacesSucceeded: number;
  readonly workspacesFailed: number;
  readonly created: number;
  readonly corroborated: number;
  readonly refusals: number;
  /** The first few distinct faults, scrubbed. `null` when nothing failed. */
  readonly error: string | null;
}

/** Every I/O seam the cycle touches, each defaulted to its production wiring. */
export interface WarehouseCadenceDeps {
  readonly listWorkspaces?: () => Promise<readonly string[]>;
  readonly isEnabled?: (workspaceId: string) => boolean;
  readonly runProducer?: (params: {
    readonly workspaceId: string;
    readonly triggeredBy: string;
    readonly requestId: string;
  }) => Promise<WarehouseProducerReport>;
  readonly withLock?: <T>(
    workspaceId: string,
    fn: () => Promise<T>,
  ) => Promise<WarehouseRunLockOutcome<T>>;
  readonly now?: () => Date;
}

/**
 * One cadence tick: every enabled, enrolled workspace gets one locked producer
 * run.
 *
 * ⚠️ **SEQUENTIAL, and the `for` loop is the guard rather than a missing
 * optimisation.** Each locked run pins one of the internal pool's five clients
 * for its whole duration and checks out more inside itself; running workspaces
 * concurrently would let a handful of tenants starve the pool the rest of the
 * process shares. `withWorkspaceAdminLocks` documents the same hazard from the
 * other side.
 *
 * Fail-soft per workspace: a run that throws is counted and logged, and the
 * cycle continues. Only the workspace SCAN failing ends the tick, because a
 * cycle that does not know which workspaces exist has nothing it can honestly
 * do.
 */
export async function runWarehouseCadenceCycle(
  deps: WarehouseCadenceDeps = {},
): Promise<WarehouseCadenceCycleResult> {
  const now = deps.now ?? (() => new Date());
  const isEnabled = deps.isEnabled ?? isWarehouseCadenceEnabled;
  const listWorkspaces = deps.listWorkspaces ?? listEnrolledWorkspaces;
  const runProducer = deps.runProducer ?? runWarehouseProducer;
  const withLock = deps.withLock ?? withWarehouseRunLock;

  const empty = {
    workspacesConsidered: 0,
    workspacesSkippedDisabled: 0,
    workspacesAttempted: 0,
    workspacesDeclinedLocked: 0,
    workspacesSucceeded: 0,
    workspacesFailed: 0,
    created: 0,
    corroborated: 0,
    refusals: 0,
  };

  /**
   * A background fiber has no `requestId`, and the producer's own log lines are
   * keyed by one — `runWarehouseProducer` says so on `WarehouseRunContext.requestId`:
   * a `snapshot-failed` refusal returns successfully and the underlying error
   * exists nowhere but the log. Minting one per cycle is what lets an operator
   * pull a whole tick out of the log, and the `whc-` stem is what distinguishes
   * it at a glance from an HTTP request id.
   */
  const cycleId = `whc-${now().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

  let workspaces: readonly string[];
  try {
    workspaces = await listWorkspaces();
  } catch (err) {
    const message = errorMessage(err);
    log.error(
      { cycleId, err: message },
      "Company-brain warehouse cadence: could not list enrolled workspaces — the tick produced nothing",
    );
    return { status: "failure", ...empty, error: message };
  }

  const counters = { ...empty, workspacesConsidered: workspaces.length };
  const reasons: string[] = [];

  for (const workspaceId of workspaces) {
    if (!isEnabled(workspaceId)) {
      counters.workspacesSkippedDisabled++;
      continue;
    }
    counters.workspacesAttempted++;
    let outcome: WarehouseRunLockOutcome<WarehouseProducerReport>;
    try {
      outcome = await withLock(workspaceId, () =>
        runProducer({
          workspaceId,
          triggeredBy: WAREHOUSE_CADENCE_PRINCIPAL,
          requestId: cycleId,
        }),
      );
    } catch (err) {
      counters.workspacesFailed++;
      const message = errorMessage(err);
      if (reasons.length < FAILURE_REASONS_MAX) reasons.push(message);
      log.error(
        { cycleId, workspaceId, triggeredBy: WAREHOUSE_CADENCE_PRINCIPAL, err: message },
        "Company-brain warehouse cadence: a scheduled producer run failed — the rest of the cycle continues",
      );
      continue;
    }
    if (!outcome.acquired) {
      counters.workspacesDeclinedLocked++;
      continue;
    }
    counters.workspacesSucceeded++;
    counters.created += outcome.value.created;
    counters.corroborated += outcome.value.corroborated;
    counters.refusals += outcome.value.refusals.length;
    log.info(
      {
        cycleId,
        workspaceId,
        triggeredBy: WAREHOUSE_CADENCE_PRINCIPAL,
        enrolled: outcome.value.enrolled,
        created: outcome.value.created,
        corroborated: outcome.value.corroborated,
        refusals: outcome.value.refusals.length,
      },
      "Company-brain warehouse cadence: scheduled producer run completed",
    );
  }

  return {
    status: counters.workspacesFailed > 0 ? "degraded" : "success",
    ...counters,
    error: reasons.length > 0 ? reasons.join("; ") : null,
  };
}
