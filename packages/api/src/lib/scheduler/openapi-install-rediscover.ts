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
 * `setInterval`-based with `unref()` (doesn't pin the process), an initial cycle on
 * start, a single-running guard (double-start is a no-op), and an in-flight guard so
 * a slow cycle never overlaps the next tick — mirrors `byot-catalog-refresh.ts` +
 * `openapi-spec-refresh.ts`. No-op without an internal DB (it reads
 * `workspace_plugins`).
 *
 * Like every other per-process scheduler here (BYOT, Tier-1, semantic-expert), this
 * takes no distributed lock — it relies on the deploy invariant that each regional
 * API service runs `numReplicas: 1` (`deploy/README.md`: "intentional, not
 * aspirational"). Re-discovery is idempotent regardless (a duplicate re-probe writes
 * the same snapshot + watermark), so the worst case under an accidental scale-up is
 * duplicate egress + audit rows, not corruption. A cross-scheduler distributed
 * singleton is the right home for replica gating if that invariant is ever lifted.
 *
 * @see ./byot-catalog-refresh.ts — the periodic-fiber pattern this follows.
 * @see ./openapi-spec-refresh.ts — the Tier-1 sibling this is deliberately NOT.
 * @see ../openapi/rediscover.ts — the shared re-probe → snapshot → diff core.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { withEffectSpan } from "@atlas/api/lib/tracing";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { OPENAPI_GENERIC_CATALOG_ID, type OpenApiSnapshot } from "@atlas/api/lib/openapi/catalog";
import { evaluateSpecRefreshDue } from "@atlas/api/lib/openapi/spec-refresh";
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
) => {
  const { persistRediscoverySnapshot } = await import("@atlas/api/lib/openapi/rediscover");
  await persistRediscoverySnapshot(workspaceId, installId, snapshot, diffRecord, lastCheckedAtIso);
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
  | { readonly kind: "refreshed"; readonly operationCount: number; readonly drift: SpecDiffSummary | null }
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
    case "ok":
      try {
        await deps.persistSuccess(
          row.workspace_id,
          row.install_id,
          result.snapshot,
          result.diffRecord,
          nowIso,
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
      return { kind: "refreshed", operationCount: result.snapshot.operationCount, drift: result.drift };
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
 * isolated and counted. Returns the structured {@link RediscoverCycleResult}.
 */
export const runOpenApiInstallRediscoverCycle = (
  opts: RediscoverCycleOptions = {},
): Effect.Effect<RediscoverCycleResult> =>
  // Span the whole cycle so a slow/failing upstream re-probe shows up in the trace
  // waterfall alongside the other scheduler ticks.
  withEffectSpan(
    "atlas.scheduler.openapi_install_rediscover",
    {},
    Effect.gen(function* () {
      if (!hasInternalDB()) {
        const result: RediscoverCycleResult = { status: "success", ...ZERO_COUNTS };
        emitCycleAudit(result);
        return result;
      }

      const nowFn = opts.now ?? Date.now;
      const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
      const query = opts.query ?? defaultQuery;
      const deps: CycleDeps = {
        rediscover: opts.rediscover ?? defaultRediscover,
        persistSuccess: opts.persistSuccess ?? defaultPersistSuccess,
        stampChecked: opts.stampChecked ?? defaultStampChecked,
      };

      const fetchResult = yield* Effect.tryPromise({
        try: () => query(batchSize),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(
        Effect.map((rows) => ({ ok: true as const, rows })),
        Effect.catchAll((err) => {
          log.error(
            { err: errorMessage(err) },
            "OpenAPI rediscover: failed to query due candidates",
          );
          return Effect.succeed({ ok: false as const, error: errorMessage(err) });
        }),
      );

      if (!fetchResult.ok) {
        const failed: RediscoverCycleResult = {
          status: "failure",
          ...ZERO_COUNTS,
          error: fetchResult.error,
        };
        emitCycleAudit(failed);
        return failed;
      }

      const rows = fetchResult.rows;
      const result: RediscoverCycleResult = { status: "success", ...ZERO_COUNTS, inspected: rows.length };

      if (rows.length === 0) {
        emitCycleAudit(result);
        return result;
      }

      // Stamp one ISO timestamp for the whole cycle so every watermark written this
      // tick is consistent (and the due-calc uses the same instant).
      const nowMs = nowFn();
      const nowIso = new Date(nowMs).toISOString();

      log.info({ count: rows.length }, "OpenAPI rediscover: cycle starting");

      // Sequential — one upstream probe at a time (concurrency: 1), so a noisy
      // install can't fan out egress and a fiber interrupt cancels cleanly
      // mid-cycle. Each probe is `AbortSignal.timeout`-bounded, so a slow upstream
      // delays (but does not stall) the rest; per-install failures are contained.
      yield* Effect.forEach(
        rows,
        (row) =>
          Effect.gen(function* () {
            const outcome = yield* Effect.tryPromise({
              try: () => runInstall(row, nowMs, nowIso, deps),
              catch: (err) => (err instanceof Error ? err : new Error(String(err))),
            }).pipe(
              // runInstall is designed never to throw; this is belt-and-braces so a
              // surprise defect counts as a failure rather than aborting the loop.
              // Phase it "rediscover": runInstall stamps internally on its own fault
              // paths, so a defect that escapes it left nothing persisted.
              Effect.catchAll((err) =>
                Effect.succeed({ kind: "failed" as const, phase: "rediscover" as const, error: errorMessage(err) }),
              ),
            );

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
          }),
        { concurrency: 1 },
      );

      log.info({ ...result }, "OpenAPI rediscover: cycle complete");
      emitCycleAudit(result);
      return result;
    }),
    (result) => ({
      "atlas.openapi_rediscover.status": result.status,
      "atlas.openapi_rediscover.inspected": result.inspected,
      "atlas.openapi_rediscover.due": result.due,
      "atlas.openapi_rediscover.refreshed": result.refreshed,
      "atlas.openapi_rediscover.failed": result.failed,
    }),
  );

// ---------------------------------------------------------------------------
// Lifecycle (setInterval-based, mirrors byot-catalog-refresh.ts + openapi-spec-refresh.ts)
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;
/** A still-running cycle, so a slow tick (network I/O) never overlaps the next one. */
let _inFlight = false;

function runCycleWithDefectGuard(): void {
  if (_inFlight) {
    log.debug("OpenAPI rediscover cycle still in flight — skipping this tick");
    return;
  }
  _inFlight = true;
  Effect.runPromise(runOpenApiInstallRediscoverCycle())
    .catch((err: unknown) => {
      // The cycle catches its own errors; this only fires on an unexpected defect so
      // the loop survives and the next tick still runs.
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "OpenAPI rediscover cycle defected past its internal catch",
      );
    })
    .finally(() => {
      _inFlight = false;
    });
}

/**
 * Start the Tier-2 OpenAPI re-discovery scheduler. Runs an initial cycle
 * immediately, then repeats at the configured interval. No-op if already running or
 * if the internal DB is unavailable (it reads `workspace_plugins`). A non-positive /
 * non-finite `intervalMs` falls back to the configured default rather than
 * hot-looping `setInterval`.
 */
export function startOpenApiInstallRediscoverScheduler(intervalMs?: number): void {
  if (_running) {
    log.debug("OpenAPI rediscover scheduler already running — skipping start");
    return;
  }
  if (!hasInternalDB()) {
    log.debug("No internal database — OpenAPI rediscover scheduler not started");
    return;
  }

  const interval =
    intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : getInstallRediscoverIntervalMs();
  _running = true;
  log.info({ intervalMs: interval }, "Starting OpenAPI install rediscover scheduler");

  runCycleWithDefectGuard();
  _timer = setInterval(runCycleWithDefectGuard, interval);
  _timer.unref();
}

export function stopOpenApiInstallRediscoverScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  log.info("OpenAPI install rediscover scheduler stopped");
}

export function isOpenApiInstallRediscoverSchedulerRunning(): boolean {
  return _running;
}

/** Test-only: reset scheduler state. */
export function _resetOpenApiInstallRediscoverScheduler(): void {
  stopOpenApiInstallRediscoverScheduler();
  _inFlight = false;
}

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
