/**
 * Scheduler-driven Tier-2 per-install OpenAPI re-discovery (#2978, v0.0.3).
 *
 * The AUTOMATED sibling of the manual admin "Refresh now" (#3002): on a timer it
 * walks every installed `openapi-generic` datasource whose per-install
 * `spec_refresh_interval` (#2977) has elapsed since its last check, re-probes the
 * spec endpoint, re-normalizes to an {@link OperationGraph}, updates the persisted
 * per-install snapshot, records the structured drift diff (#2976), and bumps the
 * `spec_last_checked_at` watermark. All of that is the shared core in
 * `openapi/rediscover.ts` — this module is just the periodic loop + due-selection +
 * fail-soft + audit around it.
 *
 * ## Scope guard — Tier-2, NOT Tier-1
 * `scheduler/openapi-spec-refresh.ts` is the TIER-1 shared, cross-workspace cache
 * refresh (#2970): it conditional-GETs PUBLIC catalog specs (Stripe/GitHub/Notion)
 * into a process-local cache and NEVER mutates any workspace's persisted snapshot.
 * THIS module is Tier-2: per-install, customer-configurable, and it DOES mutate the
 * persisted per-install snapshot + records a drift diff. The two loops are
 * orthogonal — Tier-1 keeps the shared working set warm; Tier-2 keeps each
 * private/custom install's own snapshot current. Tier-2 is the arm the Tier-1
 * docstring names (#2978 scheduler + #2979 breaking-change signal).
 *
 * ## Egress posture
 * Re-discovery goes through `performRediscovery` → `probeSpec`, which runs the
 * identical SSRF guard + redirect-revalidating `guardedFetch` + #3034 host-match
 * credential gate as a resolve-time probe. Scheduled probing is therefore the SAME
 * server-side egress as resolve-time, just on a timer — the same fail-closed SSRF
 * guard (private/internal targets blocked unless `ATLAS_OPENAPI_ALLOW_INTERNAL_HOSTS`
 * opts out) and the per-tenant `base_url_override` host gate.
 *
 * ## Due-selection (per-install interval, not a global TTL)
 * Unlike `byot-catalog-refresh.ts` (one global TTL) the interval is PER INSTALL, so
 * a single `now() - $1::interval` SQL gate doesn't fit. A coarse SQL pre-filter
 * selects non-`off` candidates ordered least-recently-checked-first (bounded by
 * `batchSize`); the precise "interval elapsed?" decision is `evaluateSpecRefreshDue`
 * in `openapi/spec-refresh.ts`, the single source of truth for the interval grammar
 * and the `max(spec_last_checked_at, snapshot.probedAt)` activity watermark.
 *
 * ## Fail-soft
 * Per-install failures are isolated: a down/slow upstream (the probe is
 * `AbortSignal.timeout`-bounded) stamps the watermark — the persisted negative-cache
 * that defers its next re-probe by a full interval — leaves the live snapshot
 * UNTOUCHED, and never aborts the loop or the workspace's other installs. A persist
 * failure deliberately does NOT stamp, so the next tick retries rather than
 * negatively-caching a half-applied refresh.
 *
 * ## Lifecycle
 * Scheduled by `registerPeriodicFiber` in `effect/layers.ts` (#4195): a
 * `forkScoped` fiber that runs an initial cycle on boot then repeats on the
 * configured cadence, gated on an internal DB (it reads `workspace_plugins`) and
 * interrupted cleanly on layer-scope shutdown. `Schedule.spaced` spaces ticks by
 * completion, so a slow cycle never overlaps the next.
 *
 * Like every other per-process scheduler here (BYOT, Tier-1, semantic-expert), this
 * takes no distributed lock — it relies on the deploy invariant that each regional
 * API service runs `numReplicas: 1` (`deploy/README.md`: "intentional, not
 * aspirational"). Re-discovery is idempotent regardless (a duplicate re-probe writes
 * the same snapshot + watermark), so the worst case under an accidental scale-up is
 * duplicate egress + audit rows, not corruption. A cross-scheduler distributed
 * singleton is the right home for replica gating if that invariant is ever lifted.
 *
 * @see ./periodic-db-job.ts — the shared DB-cycle skeleton this job's cycle uses.
 * @see ../effect/layers.ts — `registerPeriodicFiber`, the fiber scheduler.
 * @see ./openapi-spec-refresh.ts — the Tier-1 sibling this is deliberately NOT.
 * @see ../openapi/rediscover.ts — the shared re-probe → snapshot → diff core.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { internalQuery } from "@atlas/api/lib/db/internal";
import { runPeriodicDbCycle } from "@atlas/api/lib/scheduler/periodic-db-job";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { OPENAPI_GENERIC_CATALOG_ID, type OpenApiSnapshot } from "@atlas/api/lib/openapi/catalog";
import { evaluateSpecRefreshDue } from "@atlas/api/lib/openapi/spec-refresh";
import {
  resolveDriftAlertWrite,
  MAX_STORED_DRIFT_REASONS,
  type BreakingAssessment,
  type DriftAlertWrite,
} from "@atlas/api/lib/openapi/breaking-change";
import type { SpecDiffRecord, SpecDiffSummary } from "@atlas/api/lib/openapi/diff";
import type { RediscoveryResult } from "@atlas/api/lib/openapi/rediscover";

const log = createLogger("openapi-install-rediscover");

/**
 * Reserved system-actor string for every audit row written by the Tier-2
 * re-discovery scheduler. Matches `^system:[a-z0-9][a-z0-9_-]*$` (enforced by
 * `assertSystemActor`). Distinct from the Tier-1 cache and the BYOT job so forensic
 * queries can isolate this loop's writes.
 */
export const OPENAPI_REDISCOVER_ACTOR = "system:openapi-install-rediscover" as const;

/** Default global tick: 1 hour — matches the MIN per-install interval so an hourly
 * install is honored. Most installs use daily/weekly, so the hourly query is a cheap
 * no-op in the common case. */
export const DEFAULT_REDISCOVER_INTERVAL_MS = 60 * 60 * 1000;

/** Bound per-tick work; the backlog catches up across ticks via `NULLS FIRST` ordering. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * The global tick interval (ms). Reads `ATLAS_OPENAPI_REDISCOVER_INTERVAL_HOURS`,
 * defaults to 1h. Mirrors `getExpertSchedulerIntervalMs` so the cadence is
 * operator-tunable without a code change. NOTE: this is the LOOP wake cadence, NOT
 * the per-install interval (which lives in each install's `spec_refresh_interval`).
 */
export function getInstallRediscoverIntervalMs(): number {
  const raw = process.env.ATLAS_OPENAPI_REDISCOVER_INTERVAL_HOURS;
  if (!raw) return DEFAULT_REDISCOVER_INTERVAL_MS;
  const hours = Number.parseFloat(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_REDISCOVER_INTERVAL_MS;
  return hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/**
 * A `workspace_plugins` row this loop considers. `config` is the raw JSONB; the
 * credential stays encrypted (decrypted only inside `performRediscovery`). A `type`
 * (not `interface`) so it satisfies `internalQuery`'s `Record<string, unknown>`
 * row constraint.
 */
export type DueCandidateRow = {
  readonly workspace_id: string;
  readonly install_id: string;
  readonly config: Record<string, unknown> | null;
};

/**
 * The coarse SQL pre-filter: every non-archived generic OpenAPI datasource install,
 * across all workspaces, whose `spec_refresh_interval` is set and not `'off'`,
 * ordered most-overdue-first so a backlog drains fairly under the batch cap. The
 * canonical stored interval is exactly `'off'`/`'daily'`/`'weekly'`/`'<N>h'` (see
 * `normalizeSpecRefreshInterval`), so excluding `'off'` here is safe; a drifted value
 * slips through and is rejected app-side by `evaluateSpecRefreshDue` (defense in
 * depth). `$1` is the catalog id (a code constant, never client input).
 *
 * **Ordering matches the due-check watermark.** The order key is
 * `GREATEST(spec_last_checked_at, openapi_snapshot.probedAt)` — the SAME effective
 * activity `evaluateSpecRefreshDue` compares against — so a freshly-installed
 * datasource (no watermark yet but a recent `probedAt`) sorts by its `probedAt` and
 * does NOT crowd genuinely-overdue installs out of the batch. Ordering by the bare
 * watermark `NULLS FIRST` would repeatedly select those not-yet-due fresh rows
 * (which `runInstall` returns `not_due` for, without stamping), starving older due
 * rows past the `LIMIT`. ISO-8601 strings sort lexicographically = chronologically;
 * Postgres `GREATEST` ignores NULLs and yields NULL only when both are NULL (a
 * never-probed install → `NULLS FIRST` → most due).
 *
 * **Status-only scope, by design.** This mirrors the datasource RESOLVER
 * (`workspace-datasource.ts`, also `status != 'archived'`, NOT `enabled`): the
 * scheduler must refresh exactly the set the agent is served, or a still-served
 * install would carry a stale snapshot. If the resolver ever gains an `enabled`
 * gate, this predicate must move in lockstep.
 */
const CANDIDATE_QUERY_SQL = `SELECT workspace_id, install_id, config
     FROM workspace_plugins
    WHERE catalog_id = $1
      AND pillar = 'datasource'
      AND status != 'archived'
      AND config->>'spec_refresh_interval' IS NOT NULL
      AND config->>'spec_refresh_interval' <> 'off'
    ORDER BY GREATEST(config->>'spec_last_checked_at', config->'openapi_snapshot'->>'probedAt') ASC NULLS FIRST
    LIMIT $2`;

async function defaultQuery(limit: number): Promise<ReadonlyArray<DueCandidateRow>> {
  return internalQuery<DueCandidateRow>(CANDIDATE_QUERY_SQL, [OPENAPI_GENERIC_CATALOG_ID, limit]);
}

// ---------------------------------------------------------------------------
// Re-discovery + persistence seams (lazily imported defaults)
// ---------------------------------------------------------------------------
// Lazy `import()` keeps the heavy probe/secrets/diff chain out of this module's
// static graph (the scheduler test injects fakes and never triggers it) — mirrors
// the way `byot-catalog-refresh.ts` lazily imports its catalog fetchers.

type RediscoverFn = (
  rawConfig: Record<string, unknown> | null,
  installId: string,
) => Promise<RediscoveryResult>;

type PersistSuccessFn = (
  workspaceId: string,
  installId: string,
  snapshot: OpenApiSnapshot,
  diffRecord: SpecDiffRecord,
  lastCheckedAtIso: string,
  alertWrite: DriftAlertWrite,
) => Promise<void>;

type StampCheckedFn = (
  workspaceId: string,
  installId: string,
  lastCheckedAtIso: string,
) => Promise<void>;

const defaultRediscover: RediscoverFn = async (rawConfig, installId) => {
  const { performRediscovery } = await import("@atlas/api/lib/openapi/rediscover");
  return performRediscovery(rawConfig, installId);
};

const defaultPersistSuccess: PersistSuccessFn = async (
  workspaceId,
  installId,
  snapshot,
  diffRecord,
  lastCheckedAtIso,
  alertWrite,
) => {
  const { persistRediscoverySnapshot } = await import("@atlas/api/lib/openapi/rediscover");
  await persistRediscoverySnapshot(workspaceId, installId, snapshot, diffRecord, lastCheckedAtIso, alertWrite);
};

const defaultStampChecked: StampCheckedFn = async (workspaceId, installId, lastCheckedAtIso) => {
  const { stampSpecLastChecked } = await import("@atlas/api/lib/openapi/rediscover");
  await stampSpecLastChecked(workspaceId, installId, lastCheckedAtIso);
};

// ---------------------------------------------------------------------------
// Per-install processing
// ---------------------------------------------------------------------------

/** Terminal outcome for one candidate install — drives both the tally + the audit. */
type InstallOutcome =
  | { readonly kind: "not_due" }
  | {
      readonly kind: "refreshed";
      readonly operationCount: number;
      readonly drift: SpecDiffSummary | null;
      // #2979 — the breaking assessment when this scheduled refresh RAISED a
      // signal (op === "raise"), else null. Drives the dedicated breaking-drift
      // audit row + the cycle's `breaking` tally; additive/clean refreshes carry null.
      readonly breaking: BreakingAssessment | null;
    }
  | { readonly kind: "probe_failed"; readonly reason: string }
  | { readonly kind: "config_skip"; readonly reason: "decrypt_failed" | "no_url" | "unsupported_auth"; readonly detail?: string }
  // `phase` distinguishes the two failure modes, which have OPPOSITE retry
  // semantics an operator must tell apart: `"rediscover"` (probe/normalize fault)
  // is negative-cached (watermark stamped) → not retried until the full interval
  // elapses; `"persist"` (a good snapshot that failed to write) is NOT stamped →
  // retried on the very next tick.
  | { readonly kind: "failed"; readonly phase: "rediscover" | "persist"; readonly error: string };

interface CycleDeps {
  readonly rediscover: RediscoverFn;
  readonly persistSuccess: PersistSuccessFn;
  readonly stampChecked: StampCheckedFn;
}

/**
 * Stamp the watermark, swallowing (and logging) any write failure so a stamp error
 * never propagates out of {@link runInstall} — the negative-cache write is
 * best-effort; if it fails the worst case is the next tick re-evaluates this install.
 */
async function safeStamp(
  deps: CycleDeps,
  row: DueCandidateRow,
  lastCheckedAtIso: string,
): Promise<void> {
  try {
    await deps.stampChecked(row.workspace_id, row.install_id, lastCheckedAtIso);
  } catch (err) {
    log.warn(
      { workspaceId: row.workspace_id, installId: row.install_id, err: errorMessage(err) },
      "OpenAPI rediscover: failed to stamp spec_last_checked_at watermark",
    );
  }
}

/**
 * Evaluate + (if due) re-discover one install. NEVER throws — every failure path
 * resolves to an {@link InstallOutcome}. On a due install:
 *   - success → persist snapshot + diff + watermark, evict graph cache.
 *   - probe failure → stamp watermark (negative-cache), leave snapshot intact.
 *   - config skip (decrypt/no-url/unsupported auth) → stamp watermark; admin must fix.
 *   - persist failure after a good probe → report failed WITHOUT stamping, so the
 *     next tick retries the persist rather than caching a half-applied refresh.
 */
async function runInstall(
  row: DueCandidateRow,
  nowMs: number,
  nowIso: string,
  deps: CycleDeps,
): Promise<InstallOutcome> {
  const decision = evaluateSpecRefreshDue(row.config, nowMs);
  if (!decision.due) return { kind: "not_due" };

  let result: RediscoveryResult;
  try {
    result = await deps.rediscover(row.config, row.install_id);
  } catch (err) {
    // Unexpected fault during re-probe/normalize — fail-soft: negative-cache it,
    // leave the live snapshot intact.
    await safeStamp(deps, row, nowIso);
    return { kind: "failed", phase: "rediscover", error: errorMessage(err) };
  }

  switch (result.kind) {
    case "ok": {
      // #2979 — classify the drift + resolve the persisted-signal write. The
      // scheduled path RAISES on breaking drift, CLEARS on a clean/additive refresh,
      // and LEAVEs on a baseline. `nowIso` (the cycle's single instant) is the
      // signal's `raisedAt`, so every watermark + alert this tick is consistent.
      const { assessment, write } = resolveDriftAlertWrite(result.diffRecord, "scheduled", nowIso);
      try {
        await deps.persistSuccess(
          row.workspace_id,
          row.install_id,
          result.snapshot,
          result.diffRecord,
          nowIso,
          write,
        );
      } catch (err) {
        // The re-probe succeeded but persisting the fresh snapshot failed. Do NOT
        // stamp the watermark — leaving it stale means the next tick retries the
        // persist instead of negatively-caching a half-applied refresh. Log it
        // directly: unlike the negative-cached paths this one retries immediately,
        // and we're discarding a good snapshot, so a sustained DB problem should be
        // visible beyond the audit row (which writes to the same DB that just failed).
        log.warn(
          { workspaceId: row.workspace_id, installId: row.install_id, err: errorMessage(err) },
          "OpenAPI rediscover: persisting a freshly re-probed snapshot failed — discarding it, will retry next tick",
        );
        return { kind: "failed", phase: "persist", error: errorMessage(err) };
      }
      return {
        kind: "refreshed",
        operationCount: result.snapshot.operationCount,
        drift: result.drift,
        // Only surface the assessment when we actually raised — a clean/additive
        // refresh (write.op === "clear") carries a non-breaking assessment we don't
        // want to mistake for a raised signal downstream.
        breaking: write.op === "raise" ? assessment : null,
      };
    }
    case "probe_failed":
      await safeStamp(deps, row, nowIso);
      return { kind: "probe_failed", reason: result.reason };
    case "decrypt_failed":
    case "no_url":
      await safeStamp(deps, row, nowIso);
      return { kind: "config_skip", reason: result.kind };
    case "unsupported_auth":
      await safeStamp(deps, row, nowIso);
      return { kind: "config_skip", reason: "unsupported_auth", detail: result.rawAuthKind };
  }
}

// ---------------------------------------------------------------------------
// Cycle result + audit
// ---------------------------------------------------------------------------

/** Structured outcome of one scheduler cycle — also the cycle audit row's metadata. */
export interface RediscoverCycleResult {
  status: "success" | "failure";
  /** Candidate rows examined (post SQL pre-filter, pre due-check). */
  inspected: number;
  /** Of `inspected`, how many were actually due (interval elapsed). */
  due: number;
  /** Successful re-probes (snapshot + watermark written). */
  refreshed: number;
  /** Of `refreshed`, how many surfaced BREAKING drift (raised a signal, #2979). */
  breaking: number;
  /** Probe/network/persist failures — fail-soft, snapshot left intact. */
  failed: number;
  /** Selected by the SQL pre-filter but not yet due app-side. */
  skippedNotDue: number;
  /** Due, but un-probeable this cycle: decrypt/no-url/unsupported-auth (admin must fix). */
  skippedConfig: number;
  /** Set only when `status === "failure"` (the candidate query itself threw). */
  error?: string;
}

const ZERO_COUNTS = {
  inspected: 0,
  due: 0,
  refreshed: 0,
  breaking: 0,
  failed: 0,
  skippedNotDue: 0,
  skippedConfig: 0,
} as const;

interface RediscoverCycleOptions {
  /** `Date.now()` override (ms) for due-calc + the watermark stamp. */
  readonly now?: () => number;
  readonly batchSize?: number;
  readonly query?: (limit: number) => Promise<ReadonlyArray<DueCandidateRow>>;
  readonly rediscover?: RediscoverFn;
  readonly persistSuccess?: PersistSuccessFn;
  readonly stampChecked?: StampCheckedFn;
}

/** Drift roll-up tallies for an audit row — the same counts the manual route emits. */
function driftMetadata(drift: SpecDiffSummary | null): Record<string, unknown> {
  if (drift && !drift.baseline) {
    return {
      driftUnchanged: drift.unchanged,
      operationsAdded: drift.counts.operationsAdded,
      operationsRemoved: drift.counts.operationsRemoved,
      operationsChanged: drift.counts.operationsChanged,
      schemasAdded: drift.counts.schemasAdded,
      schemasRemoved: drift.counts.schemasRemoved,
      schemasChanged: drift.counts.schemasChanged,
      fieldsAdded: drift.counts.fieldsAdded,
      fieldsRemoved: drift.counts.fieldsRemoved,
      fieldsRetyped: drift.counts.fieldsRetyped,
    };
  }
  return { baseline: true, ...(drift?.priorParseFailed ? { priorParseFailed: true } : {}) };
}

/**
 * Emit a per-install audit row under the same `connection.probe` action the manual
 * route uses (so an operator filtering by install id sees manual + scheduled probes
 * uniformly), distinguished by `triggeredBy: "scheduler"`. `scope: "platform"` +
 * `workspaceId` in metadata mirrors the BYOT job's system-actor convention — there's
 * no request context, so the `org_id` column is null and the workspace is carried in
 * the target id + metadata. Fire-and-forget; a thrown audit must not sink the loop.
 */
function emitInstallAudit(
  row: DueCandidateRow,
  status: "success" | "failure",
  metadata: Record<string, unknown>,
): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.probe,
      targetType: "connection",
      targetId: row.install_id,
      scope: "platform",
      systemActor: OPENAPI_REDISCOVER_ACTOR,
      status,
      metadata: {
        workspaceId: row.workspace_id,
        installId: row.install_id,
        kind: "openapi-rediscover",
        triggeredBy: "scheduler",
        ...metadata,
      },
    });
  } catch (err) {
    log.warn(
      { workspaceId: row.workspace_id, installId: row.install_id, err: errorMessage(err) },
      "OpenAPI rediscover: per-install audit emission threw",
    );
  }
}

/**
 * Emit the dedicated breaking-drift attention row (#2979) when a SCHEDULED re-probe
 * raised a signal. Separate from the `connection.probe` success row (which always
 * fires) so an operator can filter the attention condition — `connection.spec_drift_breaking`
 * — without sifting probes. `status: "success"` is deliberate: the re-probe SUCCEEDED;
 * the breaking-change condition is carried by the action type + metadata + the persisted
 * pill, not a failure status (see the action's JSDoc). Reasons are capped to the same
 * sample the persisted alert stores. Fire-and-forget; a thrown audit must not sink the loop.
 */
function emitBreakingDriftAudit(row: DueCandidateRow, assessment: BreakingAssessment): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.breakingDrift,
      targetType: "connection",
      targetId: row.install_id,
      scope: "platform",
      systemActor: OPENAPI_REDISCOVER_ACTOR,
      status: "success",
      metadata: {
        workspaceId: row.workspace_id,
        installId: row.install_id,
        kind: "openapi-rediscover",
        triggeredBy: "scheduler",
        breakingCount: assessment.reasons.length,
        reasons: assessment.reasons.slice(0, MAX_STORED_DRIFT_REASONS),
      },
    });
  } catch (err) {
    log.warn(
      { workspaceId: row.workspace_id, installId: row.install_id, err: errorMessage(err) },
      "OpenAPI rediscover: breaking-drift audit emission threw",
    );
  }
}

function emitCycleAudit(result: RediscoverCycleResult): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.connection.specRefreshCycle,
      targetType: "connection",
      targetId: "scheduler",
      scope: "platform",
      systemActor: OPENAPI_REDISCOVER_ACTOR,
      status: result.status,
      metadata: { ...result },
    });
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "OpenAPI rediscover: cycle audit emission threw — counts preserved in pino",
    );
  }
}

/**
 * Run a single re-discovery cycle. Never throws — a failure in the candidate query
 * surfaces as `status: "failure"` + an emitted cycle row; per-install failures are
 * isolated and counted. Returns the structured {@link RediscoverCycleResult}. The
 * scan → guard → forEach → tally → audit choreography is the shared
 * `runPeriodicDbCycle` skeleton (#4195); this function supplies only the
 * rediscover-specific candidate query, per-install apply, and per-outcome tally +
 * drift bookkeeping. The per-tick span is applied by `registerPeriodicFiber` around
 * the fiber, not here — its `spanResultAttributes` preserve the trace attribution.
 */
export const runOpenApiInstallRediscoverCycle = (
  opts: RediscoverCycleOptions = {},
): Effect.Effect<RediscoverCycleResult> => {
  const nowFn = opts.now ?? Date.now;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const query = opts.query ?? defaultQuery;
  const deps: CycleDeps = {
    rediscover: opts.rediscover ?? defaultRediscover,
    persistSuccess: opts.persistSuccess ?? defaultPersistSuccess,
    stampChecked: opts.stampChecked ?? defaultStampChecked,
  };

  // Stamp one ISO timestamp for the whole cycle so every watermark written this
  // tick is consistent (and the due-calc uses the same instant). Resolved up
  // front — the scan doesn't consume it, so hoisting it above the skeleton is
  // behaviorally identical to the pre-#4195 "after the empty check" placement.
  const nowMs = nowFn();
  const nowIso = new Date(nowMs).toISOString();

  return runPeriodicDbCycle<DueCandidateRow, InstallOutcome, RediscoverCycleResult>({
    log,
    label: "OpenAPI rediscover",
    emptyResult: () => ({ status: "success", ...ZERO_COUNTS }),
    failureResult: (error) => ({ status: "failure", ...ZERO_COUNTS, error }),
    scan: () => query(batchSize),
    // Sequential per-install probe; `runPeriodicDbCycle` runs these at
    // `{ concurrency: 1 }`. Each probe is `AbortSignal.timeout`-bounded, so a
    // slow upstream delays (but does not stall) the rest.
    applyRow: (row) => runInstall(row, nowMs, nowIso, deps),
    // runInstall is designed never to throw; this is belt-and-braces so a
    // surprise defect counts as a failure rather than aborting the loop. Phase
    // it "rediscover": runInstall stamps internally on its own fault paths, so a
    // defect that escapes it left nothing persisted.
    defectOutcome: (error) => ({ kind: "failed", phase: "rediscover", error }),
    tally: (result, row, outcome) => {
      switch (outcome.kind) {
        case "not_due":
          result.skippedNotDue++;
          return;
        case "refreshed":
          result.due++;
          result.refreshed++;
          emitInstallAudit(row, "success", {
            operationCount: outcome.operationCount,
            ...driftMetadata(outcome.drift),
          });
          // #2979 — a SCHEDULED breaking re-probe also raises the attention
          // signal: count it + write the dedicated audit row. Additive/clean
          // refreshes carry `breaking: null` and stay quiet.
          if (outcome.breaking) {
            result.breaking++;
            emitBreakingDriftAudit(row, outcome.breaking);
          }
          return;
        case "probe_failed":
          result.due++;
          result.failed++;
          emitInstallAudit(row, "failure", { reason: "probe_failed", probeReason: outcome.reason });
          return;
        case "config_skip":
          result.due++;
          result.skippedConfig++;
          emitInstallAudit(row, "failure", {
            reason: outcome.reason,
            ...(outcome.detail !== undefined ? { authKind: outcome.detail } : {}),
          });
          return;
        case "failed":
          result.due++;
          result.failed++;
          // Surface the retry semantics in the audit `reason`: `persist_failed`
          // retries next tick; `rediscover_fault` is deferred a full interval.
          emitInstallAudit(row, "failure", {
            reason: outcome.phase === "persist" ? "persist_failed" : "rediscover_fault",
            error: outcome.error,
          });
          return;
      }
    },
    emitCycleAudit,
  });
};

// ---------------------------------------------------------------------------
// Scheduling — via `registerPeriodicFiber` in `effect/layers.ts` (#4195)
// ---------------------------------------------------------------------------
//
// The Tier-2 re-discovery no longer hand-rolls a `setInterval` lifecycle. Its
// cycle body is the shared `runPeriodicDbCycle` skeleton (above); the fiber
// that repeats it — interval, per-tick span, `withFiberDeathLog`, and the
// `hasInternalDB()` enablement gate — is owned by `registerPeriodicFiber`
// (arch-win #100 / #4130), forked `forkScoped` for the pod lifetime.
// `Schedule.spaced` there spaces ticks by completion, so a slow cycle can never
// overlap the next — subsuming the old `_inFlight` guard. See
// `scheduler/periodic-db-job.ts` for how the two seams compose.
// The loop cadence is `getInstallRediscoverIntervalMs()` (above), which the
// `registerPeriodicFiber` registration reads once at boot.

/**
 * Manual-trigger entry point (admin scheduler page / tests). Runs a single cycle and
 * returns its structured result. `status` distinguishes a healthy cycle from one
 * that died in the candidate query.
 */
export async function triggerOpenApiInstallRediscoverCycle(
  opts: RediscoverCycleOptions = {},
): Promise<RediscoverCycleResult> {
  return Effect.runPromise(runOpenApiInstallRediscoverCycle(opts));
}
