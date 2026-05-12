/**
 * Scheduler-driven periodic refresh for BYOT discovery catalogs (#2284).
 *
 * Background — #2271 ships the Postgres L2 cache so BYOT model catalogs
 * survive pod restarts and stay consistent across pods. But the catalog
 * only refreshes on demand: an admin clicks "Refresh now", or the cache
 * ages past TTL on a request that finds it stale. For workspaces admins
 * rarely visit, the catalog ages indefinitely — the next visitor sees
 * yesterday's model list. This module closes that gap with a daily cycle
 * that walks `workspace_model_config` and refreshes any
 * `(org_id, provider, region)` whose `fetched_at` is older than the TTL.
 *
 * Design notes:
 *   - Sequential per-row refresh. One upstream call at a time so a noisy
 *     workspace can't burn another's rate limit. The acceptance criterion
 *     "Operates within the existing scheduler concurrency limits (no
 *     separate worker)" is satisfied by running at most one provider call
 *     per cycle tick — naturally bounded to 1.
 *   - In-memory exponential backoff on consecutive failures. A workspace
 *     with a rotated-and-broken key would otherwise be retried 365 times
 *     a year. Pod restart resets the backoff state — acceptable trade-off
 *     vs the migration that a persistent counter would require.
 *   - Dormancy gate is intentionally deferred. `organization.last_active_at`
 *     does not exist on the Better-Auth-managed `organization` table; adding
 *     it is filed as a follow-up rather than done inline (scope guard, see
 *     the PR description). Until then, the staleness threshold itself acts
 *     as a coarse dormancy gate — a workspace nobody is touching ages out
 *     once a day, not 144 times a day.
 *   - Every per-row outcome is audit-logged via the existing
 *     `model_config.catalog_refresh*` actions so triage can join the
 *     scheduler's view of a workspace with the human admin's. Cycle-level
 *     `catalog_refresh_cycle` emits even at zero rows — the absence of a
 *     cycle row over the daily window is the "scheduler stopped" signal.
 *
 * Lifecycle mirrors `ee/src/audit/purge-scheduler.ts`: setInterval-based
 * with `unref()` so it doesn't pin the process, an initial tick on start,
 * and a single-running guard so double-start is a no-op.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";

const log = createLogger("byot-catalog-refresh");

/**
 * Reserved system-actor string for every audit row written by the BYOT
 * catalog refresh scheduler. Matches the `^system:[a-z0-9][a-z0-9_-]*$`
 * pattern enforced by `assertSystemActor` in `audit/admin.ts`. Pinned
 * here so a future rename of the module surfaces the breakage at the
 * audit-row level (forensic queries filter on this literal).
 */
export const BYOT_CATALOG_REFRESH_ACTOR = "system:byot-catalog-refresh" as const;

/** 24h — both the default scheduler tick interval and the staleness gate. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Cap the per-cycle batch so a backlogged install doesn't run for hours. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * Backoff cap. After N consecutive failures, the next eligible time sits
 * 2^N days out, capped at this value. 5 → ~32 days max gap; enough that a
 * permanently-broken workspace doesn't churn but not so long that a fix
 * doesn't get picked up.
 */
const MAX_BACKOFF_EXPONENT = 5;

/** Base backoff unit. Failure 1 skips 1 day, failure 2 skips 2 days, etc. */
const BACKOFF_BASE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory backoff state
// ---------------------------------------------------------------------------

interface BackoffEntry {
  failureCount: number;
  nextEligibleAt: number; // epoch ms
}

const _backoff = new Map<string, BackoffEntry>();

function backoffKey(orgId: string, provider: string, region: string): string {
  return `${orgId}::${provider}::${region}`;
}

function computeBackoffMs(failureCount: number): number {
  const clampedExponent = Math.min(failureCount - 1, MAX_BACKOFF_EXPONENT);
  return BACKOFF_BASE_MS * Math.pow(2, Math.max(0, clampedExponent));
}

function isInBackoff(key: string, now: number): boolean {
  const entry = _backoff.get(key);
  return entry !== undefined && entry.nextEligibleAt > now;
}

function recordFailure(key: string, now: number): void {
  const prev = _backoff.get(key);
  const failureCount = (prev?.failureCount ?? 0) + 1;
  const nextEligibleAt = now + computeBackoffMs(failureCount);
  _backoff.set(key, { failureCount, nextEligibleAt });
}

function recordSuccess(key: string): void {
  _backoff.delete(key);
}

/** Test-only: reset all in-memory backoff state. */
export function _resetBackoffForTests(): void {
  _backoff.clear();
}

// ---------------------------------------------------------------------------
// Stale-row query
// ---------------------------------------------------------------------------

/**
 * The three BYOT direct-discovery providers. Sourced from #2174's catalog
 * audit; if a fourth direct provider lands, this tuple plus the dispatch
 * below are the only places that need an entry.
 */
const BYOT_PROVIDERS = ["anthropic", "openai", "bedrock"] as const;
type ByotProvider = (typeof BYOT_PROVIDERS)[number];

interface StaleRow {
  orgId: string;
  provider: ByotProvider;
  bedrockRegion: string | null;
}

interface StaleRowDb extends Record<string, unknown> {
  org_id: string;
  provider: string;
  bedrock_region: string | null;
}

async function findStaleByotCatalogs(
  staleThresholdMs: number,
  limit: number,
): Promise<StaleRow[]> {
  if (!hasInternalDB()) return [];

  // Mirrors the SQL in the issue body. The interval is parameterized as
  // milliseconds → `now() - $1::int * interval '1 ms'` so the threshold is
  // configurable without inlining the int into the string literal.
  const rows = await internalQuery<StaleRowDb>(
    `SELECT wmc.org_id, wmc.provider, wmc.bedrock_region
     FROM workspace_model_config wmc
     LEFT JOIN workspace_model_catalog wmcat
       ON wmcat.org_id = wmc.org_id AND wmcat.provider = wmc.provider
     WHERE wmc.provider IN ('anthropic', 'openai', 'bedrock')
       AND (wmcat.fetched_at IS NULL OR wmcat.fetched_at < now() - ($1::bigint * interval '1 ms'))
     ORDER BY wmcat.fetched_at NULLS FIRST
     LIMIT $2`,
    [staleThresholdMs, limit],
  );

  return rows
    .filter((r): r is StaleRowDb & { provider: ByotProvider } =>
      (BYOT_PROVIDERS as readonly string[]).includes(r.provider),
    )
    .map((r) => ({
      orgId: r.org_id,
      provider: r.provider,
      bedrockRegion: r.bedrock_region,
    }));
}

// ---------------------------------------------------------------------------
// Per-row refresh
// ---------------------------------------------------------------------------

type SkipReason =
  | "decrypt_failed"
  | "missing_byot_key"
  | "in_backoff"
  | "malformed_bedrock_bundle";

type RefreshOutcome =
  | { kind: "refreshed"; modelCount: number; source: "fresh" | "cache" }
  | { kind: "skipped"; reason: SkipReason }
  | { kind: "failed"; error: string };

interface RawWorkspaceConfig {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  bedrockRegion: string | null;
}

type LoadRawConfigResult =
  | { kind: "ok"; config: RawWorkspaceConfig | null }
  | { kind: "decrypt_failed" }
  | { kind: "unavailable"; error: string };

/**
 * Effectful wrapper around the EE-side `getWorkspaceModelConfigRaw` that
 * folds the `ModelConfigDecryptError` tag into a discriminated result.
 * The EE module is imported dynamically — installations without it have
 * no workspace model configs at all, so the cycle is a no-op there.
 *
 * `Effect.catchTag` lets the dispatch match the upstream tag string-side,
 * which keeps the cross-module `instanceof` check from breaking when the
 * `Data.TaggedError` class identity differs (e.g. under test mocks).
 */
async function loadRawConfig(orgId: string): Promise<LoadRawConfigResult> {
  let mod: typeof import("@atlas/ee/platform/model-routing");
  try {
    mod = await import("@atlas/ee/platform/model-routing");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("Cannot find package")) {
      // EE not installed — no workspace configs exist for this install.
      return { kind: "ok", config: null };
    }
    return { kind: "unavailable", error: message };
  }

  const program = mod.getWorkspaceModelConfigRaw(orgId).pipe(
    Effect.map((config) => ({ kind: "ok" as const, config })),
    Effect.catchTag("ModelConfigDecryptError", () =>
      Effect.succeed({ kind: "decrypt_failed" as const }),
    ),
    Effect.catchAll((err) =>
      Effect.succeed({ kind: "unavailable" as const, error: errorMessage(err) }),
    ),
  );
  return await Effect.runPromise(program);
}

async function refreshAnthropic(
  orgId: string,
  apiKey: string,
): Promise<RefreshOutcome> {
  const { getAnthropicCatalog } = await import("@atlas/api/lib/anthropic-catalog");
  try {
    const result = await getAnthropicCatalog(orgId, apiKey, { refresh: true });
    return { kind: "refreshed", modelCount: result.models.length, source: result.source };
  } catch (err) {
    return { kind: "failed", error: errorMessage(err) };
  }
}

async function refreshOpenai(
  orgId: string,
  apiKey: string,
): Promise<RefreshOutcome> {
  const { getOpenAICatalog } = await import("@atlas/api/lib/openai-catalog");
  try {
    const result = await getOpenAICatalog(orgId, apiKey, { refresh: true });
    return { kind: "refreshed", modelCount: result.models.length, source: result.source };
  } catch (err) {
    return { kind: "failed", error: errorMessage(err) };
  }
}

async function refreshBedrock(
  orgId: string,
  apiKey: string,
  region: string,
): Promise<RefreshOutcome> {
  const { parseBedrockCredentialBundle } = await import("@atlas/ee/platform/model-routing");
  const { getBedrockCatalog } = await import("@atlas/api/lib/bedrock-catalog");

  const bundle = parseBedrockCredentialBundle(apiKey);
  if (!bundle) {
    return { kind: "skipped", reason: "malformed_bedrock_bundle" };
  }
  // Cast: BedrockRegion is a string-literal union from @useatlas/types. We
  // accept the DB-stored region as-is — if it's not a member of the union,
  // the fetcher will reject it on the upstream call and the row enters
  // backoff like any other failure.
  const result = await getBedrockCatalog(
    orgId,
    region as Parameters<typeof getBedrockCatalog>[1],
    bundle,
    { refresh: true },
  );
  return { kind: "refreshed", modelCount: result.models.length, source: result.source };
}

async function refreshOne(row: StaleRow, now: number): Promise<RefreshOutcome> {
  const key = backoffKey(row.orgId, row.provider, row.bedrockRegion ?? "");
  if (isInBackoff(key, now)) {
    return { kind: "skipped", reason: "in_backoff" };
  }

  const configResult = await loadRawConfig(row.orgId);
  if (configResult.kind === "decrypt_failed") {
    return { kind: "skipped", reason: "decrypt_failed" };
  }
  if (configResult.kind === "unavailable") {
    return { kind: "failed", error: configResult.error };
  }

  const config = configResult.config;
  if (!config || !config.apiKey || config.provider !== row.provider) {
    return { kind: "skipped", reason: "missing_byot_key" };
  }
  if (row.provider === "bedrock") {
    const region = config.bedrockRegion ?? row.bedrockRegion;
    if (!region) {
      return { kind: "skipped", reason: "missing_byot_key" };
    }
    try {
      return await refreshBedrock(row.orgId, config.apiKey, region);
    } catch (err) {
      return { kind: "failed", error: errorMessage(err) };
    }
  }
  if (row.provider === "anthropic") {
    return await refreshAnthropic(row.orgId, config.apiKey);
  }
  return await refreshOpenai(row.orgId, config.apiKey);
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

export interface ByotRefreshCycleResult {
  inspected: number;
  refreshed: number;
  skippedDecryptFailed: number;
  skippedInBackoff: number;
  skippedMissingKey: number;
  failed: number;
}

const ZERO_RESULT: ByotRefreshCycleResult = {
  inspected: 0,
  refreshed: 0,
  skippedDecryptFailed: 0,
  skippedInBackoff: 0,
  skippedMissingKey: 0,
  failed: 0,
};

interface CycleOptions {
  staleThresholdMs?: number;
  batchSize?: number;
  /** Override `Date.now()` for tests. */
  nowFn?: () => number;
}

/**
 * Run a single refresh cycle. Errors are caught and surfaced as `failed`
 * counts — the scheduler must not throw out of the tick or the
 * `setInterval` loop would die silently.
 */
export const runByotCatalogRefreshCycle = (
  opts: CycleOptions = {},
): Effect.Effect<ByotRefreshCycleResult> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) {
      emitCycleAudit(ZERO_RESULT, "success");
      return ZERO_RESULT;
    }

    const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_INTERVAL_MS;
    const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    const now = opts.nowFn ?? Date.now;

    const fetchResult = yield* Effect.tryPromise({
      try: () => findStaleByotCatalogs(staleThresholdMs, batchSize),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.map((rows) => ({ ok: true as const, rows })),
      Effect.catchAll((err) => {
        log.error({ err: errorMessage(err) }, "BYOT catalog refresh: failed to query stale rows");
        return Effect.succeed({ ok: false as const, error: errorMessage(err) });
      }),
    );

    if (!fetchResult.ok) {
      emitCycleAudit(ZERO_RESULT, "failure", { error: fetchResult.error });
      return ZERO_RESULT;
    }

    const rows = fetchResult.rows;
    const result: ByotRefreshCycleResult = { ...ZERO_RESULT, inspected: rows.length };

    if (rows.length === 0) {
      emitCycleAudit(result, "success");
      return result;
    }

    log.info({ count: rows.length }, "BYOT catalog refresh: cycle starting");

    // Sequential — one upstream provider call at a time. `Effect.forEach`
    // with `{ concurrency: 1 }` is equivalent to a `for...of` but stays in
    // the Effect chain so a fiber interrupt during a long upstream call
    // cancels cleanly.
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.tryPromise({
            try: () => refreshOne(row, now()),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.catchAll((err) => Effect.succeed({ kind: "failed" as const, error: errorMessage(err) })),
          );

          const key = backoffKey(row.orgId, row.provider, row.bedrockRegion ?? "");
          if (outcome.kind === "refreshed") {
            recordSuccess(key);
            result.refreshed++;
            emitRefreshAudit(row, outcome);
          } else if (outcome.kind === "skipped") {
            if (outcome.reason === "decrypt_failed") result.skippedDecryptFailed++;
            else if (outcome.reason === "in_backoff") result.skippedInBackoff++;
            else result.skippedMissingKey++;
            emitSkipAudit(row, outcome.reason);
          } else {
            recordFailure(key, now());
            result.failed++;
            emitFailureAudit(row, outcome.error);
          }
        }),
      { concurrency: 1 },
    );

    log.info({ ...result }, "BYOT catalog refresh: cycle complete");
    emitCycleAudit(result, "success");
    return result;
  });

// ---------------------------------------------------------------------------
// Audit emission
// ---------------------------------------------------------------------------

function emitCycleAudit(
  result: ByotRefreshCycleResult,
  status: "success" | "failure",
  extra: Record<string, unknown> = {},
): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.catalogRefreshCycle,
      targetType: "model_config",
      targetId: "scheduler",
      scope: "platform",
      systemActor: BYOT_CATALOG_REFRESH_ACTOR,
      status,
      metadata: { ...result, ...extra },
    });
  } catch (err) {
    // `logAdminAction` is fire-and-forget by contract, but belt-and-braces
    // a try/catch so a future regression in the audit module can't tear
    // down the cycle loop. The pino line below is the fallback breadcrumb.
    log.error(
      { err: errorMessage(err) },
      "BYOT catalog refresh: cycle audit emission threw — original counts preserved in pino",
    );
  }
}

function emitRefreshAudit(
  row: StaleRow,
  outcome: Extract<RefreshOutcome, { kind: "refreshed" }>,
): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
      targetType: "model_config",
      targetId: row.orgId,
      scope: "platform",
      systemActor: BYOT_CATALOG_REFRESH_ACTOR,
      metadata: {
        provider: row.provider,
        modelCount: outcome.modelCount,
        source: outcome.source,
        triggeredBy: "scheduler",
      },
    });
  } catch (err) {
    log.warn(
      { err: errorMessage(err), orgId: row.orgId, provider: row.provider },
      "BYOT catalog refresh: per-row success audit emission threw",
    );
  }
}

function emitSkipAudit(row: StaleRow, reason: SkipReason): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.catalogRefreshSkip,
      targetType: "model_config",
      targetId: row.orgId,
      scope: "platform",
      systemActor: BYOT_CATALOG_REFRESH_ACTOR,
      status: "failure",
      metadata: { provider: row.provider, reason },
    });
  } catch (err) {
    log.warn(
      { err: errorMessage(err), orgId: row.orgId, provider: row.provider, reason },
      "BYOT catalog refresh: per-row skip audit emission threw",
    );
  }
}

function emitFailureAudit(row: StaleRow, error: string): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.catalogRefresh,
      targetType: "model_config",
      targetId: row.orgId,
      scope: "platform",
      systemActor: BYOT_CATALOG_REFRESH_ACTOR,
      status: "failure",
      metadata: { provider: row.provider, error, triggeredBy: "scheduler" },
    });
  } catch (auditErr) {
    log.warn(
      {
        err: errorMessage(auditErr),
        orgId: row.orgId,
        provider: row.provider,
        originalError: error,
      },
      "BYOT catalog refresh: per-row failure audit emission threw",
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle (setInterval-based, mirroring ee/audit/purge-scheduler.ts)
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

function runCycleWithDefectGuard(): void {
  Effect.runPromise(runByotCatalogRefreshCycle()).catch((err: unknown) => {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "BYOT catalog refresh cycle defected past catchAll — cycle row may not have been emitted",
    );
  });
}

/**
 * Start the BYOT catalog refresh scheduler.
 *
 * Runs an initial cycle immediately, then repeats at the configured interval.
 * No-op if already running or if the internal DB is unavailable.
 */
export function startByotCatalogRefreshScheduler(intervalMs?: number): void {
  if (_running) {
    log.debug("BYOT catalog refresh scheduler already running — skipping start");
    return;
  }
  if (!hasInternalDB()) {
    log.debug("No internal database — BYOT catalog refresh scheduler not started");
    return;
  }

  const interval = intervalMs ?? DEFAULT_INTERVAL_MS;
  _running = true;
  log.info({ intervalMs: interval }, "Starting BYOT catalog refresh scheduler");

  // Initial cycle on boot — non-blocking.
  runCycleWithDefectGuard();

  _timer = setInterval(() => {
    runCycleWithDefectGuard();
  }, interval);
  _timer.unref();
}

export function stopByotCatalogRefreshScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  log.info("BYOT catalog refresh scheduler stopped");
}

export function isByotCatalogRefreshSchedulerRunning(): boolean {
  return _running;
}

/** Test-only: reset scheduler state. */
export function _resetByotCatalogRefreshScheduler(): void {
  stopByotCatalogRefreshScheduler();
}

/**
 * Manual-trigger entry point for the admin scheduler page. Runs a single
 * cycle and returns the result. Rejects if the cycle throws past its own
 * catchAll (defect path) — callers surface that to the admin so they
 * know the manual trigger did not produce a cycle audit row.
 */
export async function triggerByotCatalogRefreshCycle(): Promise<ByotRefreshCycleResult> {
  return Effect.runPromise(runByotCatalogRefreshCycle());
}
