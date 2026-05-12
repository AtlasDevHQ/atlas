/**
 * Scheduler-driven periodic refresh for BYOT discovery catalogs (#2284).
 *
 * #2271 ships the Postgres L2 cache so BYOT model catalogs survive pod
 * restarts and stay consistent across pods. But the catalog only refreshes
 * on demand: an admin clicks "Refresh now", or the cache ages past TTL on a
 * request that finds it stale. For workspaces admins rarely visit, the
 * catalog ages indefinitely — the next visitor sees yesterday's model list.
 * This module closes that gap with a daily cycle that walks
 * `workspace_model_config` and refreshes any `(org_id, provider, region)`
 * whose `fetched_at` is older than the TTL.
 *
 * Design notes:
 *   - Sequential per-row refresh (one upstream call at a time so a noisy
 *     workspace can't burn another's rate limit). "Operates within existing
 *     scheduler concurrency limits (no separate worker)" is satisfied by
 *     running at most one provider call per tick — naturally bounded to 1.
 *   - In-memory exponential backoff on consecutive failures. A workspace
 *     with a rotated-and-broken key would otherwise be retried 365 times a
 *     year. Pod restart resets the backoff state — acceptable trade-off vs
 *     the migration that a persistent counter would require.
 *   - Dormancy gate deferred to #2377. `organization.last_active_at` does
 *     not exist on the Better-Auth-managed `organization` table; until then
 *     the daily TTL itself acts as a coarse dormancy gate (a workspace
 *     nobody is touching ages out once a day, not 144 times a day).
 *   - Every per-row outcome is audit-logged via the existing
 *     `model_config.catalog_refresh*` actions. Cycle-level
 *     `catalog_refresh_cycle` emits every tick — the absence of a cycle row
 *     over a 48 h window is the "scheduler stopped" signal (mirroring the
 *     F-27 audit-purge invariant).
 *
 * Lifecycle mirrors `ee/src/audit/purge-scheduler.ts`: setInterval-based
 * with `unref()` so it doesn't pin the process, an initial tick on start,
 * and a single-running guard so double-start is a no-op.
 *
 * @see ee/src/audit/purge-scheduler.ts
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import type { AdminActionType } from "@atlas/api/lib/audit/actions";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import {
  type ByotRefreshCycleResult,
  type ByotCatalogRefreshSkipReason,
} from "@useatlas/types";

export type { ByotRefreshCycleResult } from "@useatlas/types";

const log = createLogger("byot-catalog-refresh");

/**
 * Reserved system-actor string for every audit row written by the BYOT
 * catalog refresh scheduler. Matches `^system:[a-z0-9][a-z0-9_-]*$` (enforced
 * by `assertSystemActor` in `audit/admin.ts`). A rename surfaces breakage at
 * the forensic-query layer.
 */
export const BYOT_CATALOG_REFRESH_ACTOR = "system:byot-catalog-refresh" as const;

/** 24h — both the default tick interval and the staleness gate. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Bound per-tick runtime; backlog catches up across ticks via `NULLS FIRST`. */
const DEFAULT_BATCH_SIZE = 100;

/** Failures past this exponent stay at the cap. 2^5 = exactly 32 days. */
const MAX_BACKOFF_EXPONENT = 5;
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
  _backoff.set(key, {
    failureCount,
    nextEligibleAt: now + computeBackoffMs(failureCount),
  });
}

function recordSuccess(key: string): void {
  _backoff.delete(key);
}

/** Test-only: reset all in-memory backoff state. */
export function _resetBackoffForTests(): void {
  _backoff.clear();
}

/** Test-only: pure backoff math for unit tests. */
export const _computeBackoffMsForTests = computeBackoffMs;

// ---------------------------------------------------------------------------
// Stale-row query
// ---------------------------------------------------------------------------

const BYOT_PROVIDERS = ["anthropic", "openai", "bedrock"] as const;
type ByotProvider = (typeof BYOT_PROVIDERS)[number];

/**
 * Discriminated by provider so bedrock's region only exists where meaningful.
 * Anthropic/OpenAI callers can't accidentally read a stray region.
 */
type StaleRow =
  | { provider: "anthropic"; orgId: string }
  | { provider: "openai"; orgId: string }
  | { provider: "bedrock"; orgId: string; bedrockRegion: string | null };

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
  // milliseconds → `now() - $1::bigint * interval '1 ms'` so the threshold
  // is configurable without inlining the int into a string literal.
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

  const result: StaleRow[] = [];
  for (const r of rows) {
    if (!(BYOT_PROVIDERS as readonly string[]).includes(r.provider)) continue;
    if (r.provider === "bedrock") {
      result.push({ provider: "bedrock", orgId: r.org_id, bedrockRegion: r.bedrock_region });
    } else if (r.provider === "anthropic") {
      result.push({ provider: "anthropic", orgId: r.org_id });
    } else {
      result.push({ provider: "openai", orgId: r.org_id });
    }
  }
  return result;
}

function regionForKey(row: StaleRow): string {
  return row.provider === "bedrock" ? row.bedrockRegion ?? "" : "";
}

function providerOfRow(row: StaleRow): ByotProvider {
  return row.provider;
}

// ---------------------------------------------------------------------------
// EE module probe — cached once per pod lifetime
// ---------------------------------------------------------------------------

interface EeModule {
  getWorkspaceModelConfigRaw: (
    orgId: string,
  ) => Effect.Effect<RawWorkspaceConfig | null, { readonly _tag: string } | Error>;
  ModelConfigDecryptError: new (...args: never) => Error;
  parseBedrockCredentialBundle: (apiKey: string) => unknown;
}

type EeProbeResult = { kind: "ok"; module: EeModule } | { kind: "unavailable"; reason: "missing" | "import_error"; error: string };

let _eeProbe: Promise<EeProbeResult> | null = null;

function probeEeModule(): Promise<EeProbeResult> {
  if (_eeProbe) return _eeProbe;
  _eeProbe = (async () => {
    try {
      const mod = (await import("@atlas/ee/platform/model-routing")) as unknown as EeModule;
      return { kind: "ok" as const, module: mod };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Cannot find module") || message.includes("Cannot find package")) {
        return { kind: "unavailable" as const, reason: "missing" as const, error: message };
      }
      // Distinct from "missing" so a build/syntax error doesn't pose as a
      // self-hosted-without-EE install. The cycle audits this as a failure
      // (not a deliberate ee_unavailable skip).
      log.warn(
        { err: message },
        "EE module import failed with non-missing error — every row this cycle will fail",
      );
      return { kind: "unavailable" as const, reason: "import_error" as const, error: message };
    }
  })();
  return _eeProbe;
}

/** Test-only: clear the cached EE probe so a fresh import is attempted. */
export function _resetEeProbeForTests(): void {
  _eeProbe = null;
}

// ---------------------------------------------------------------------------
// Per-row refresh
// ---------------------------------------------------------------------------

interface RawWorkspaceConfig {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  bedrockRegion: string | null;
}

type LoadRawConfigResult =
  | { kind: "ok"; config: RawWorkspaceConfig }
  | { kind: "no_config" }
  | { kind: "decrypt_failed" }
  | { kind: "ee_unavailable" }
  | { kind: "unavailable"; error: string };

async function loadRawConfig(orgId: string): Promise<LoadRawConfigResult> {
  const probe = await probeEeModule();
  if (probe.kind === "unavailable") {
    return probe.reason === "missing"
      ? { kind: "ee_unavailable" }
      : { kind: "unavailable", error: probe.error };
  }

  const program = probe.module.getWorkspaceModelConfigRaw(orgId).pipe(
    Effect.map((config) =>
      config ? ({ kind: "ok" as const, config }) : ({ kind: "no_config" as const }),
    ),
    Effect.catchTag("ModelConfigDecryptError", () =>
      Effect.succeed({ kind: "decrypt_failed" as const }),
    ),
    Effect.catchAll((err) =>
      Effect.succeed({ kind: "unavailable" as const, error: errorMessage(err) }),
    ),
  );
  return await Effect.runPromise(program);
}

type RefreshOutcome =
  | { kind: "refreshed"; modelCount: number; source: "fresh" | "cache" }
  | { kind: "skipped"; reason: ByotCatalogRefreshSkipReason }
  | { kind: "failed"; error: string };

interface CatalogResponse {
  models: ReadonlyArray<unknown>;
  fetchedAt: string;
  source: "fresh" | "cache";
}

/**
 * Fetch a fresh catalog for one row. Returns `null` on the bedrock malformed
 * bundle (the caller maps that to a skip); otherwise resolves to the upstream
 * response or throws. Errors are caught one level up so a single bad row
 * can't sink the cycle.
 */
async function fetchCatalogForRow(
  row: StaleRow,
  apiKey: string,
  bedrockBundle: unknown | null,
): Promise<CatalogResponse> {
  if (row.provider === "anthropic") {
    const { getAnthropicCatalog } = await import("@atlas/api/lib/anthropic-catalog");
    return await getAnthropicCatalog(row.orgId, apiKey, { refresh: true });
  }
  if (row.provider === "openai") {
    const { getOpenAICatalog } = await import("@atlas/api/lib/openai-catalog");
    return await getOpenAICatalog(row.orgId, apiKey, { refresh: true });
  }
  // bedrock — `bedrockBundle` is the parsed JSON cred (caller guarantees
  // non-null here; the malformed case short-circuits before this fetch).
  const { getBedrockCatalog } = await import("@atlas/api/lib/bedrock-catalog");
  const region = row.bedrockRegion;
  // Cast: BedrockRegion is a string-literal union from @useatlas/types. We
  // accept the DB-stored region as-is — if it's not a member of the union,
  // the fetcher rejects on the upstream call and the row enters backoff
  // like any other failure.
  return await getBedrockCatalog(
    row.orgId,
    region as Parameters<typeof getBedrockCatalog>[1],
    bedrockBundle as Parameters<typeof getBedrockCatalog>[2],
    { refresh: true },
  );
}

async function refreshOne(row: StaleRow, now: number): Promise<RefreshOutcome> {
  const key = backoffKey(row.orgId, row.provider, regionForKey(row));
  if (isInBackoff(key, now)) {
    return { kind: "skipped", reason: "in_backoff" };
  }

  const configResult = await loadRawConfig(row.orgId);
  if (configResult.kind === "decrypt_failed") return { kind: "skipped", reason: "decrypt_failed" };
  if (configResult.kind === "ee_unavailable") return { kind: "skipped", reason: "ee_unavailable" };
  if (configResult.kind === "unavailable") return { kind: "failed", error: configResult.error };
  if (configResult.kind === "no_config") return { kind: "skipped", reason: "missing_byot_key" };

  const config = configResult.config;
  if (!config.apiKey || config.provider !== row.provider) {
    return { kind: "skipped", reason: "missing_byot_key" };
  }

  // Bedrock-specific preconditions: region must exist (saved on the config
  // row OR projected from the SQL JOIN), and the cred bundle must parse.
  let bedrockBundle: unknown = null;
  if (row.provider === "bedrock") {
    const probe = await probeEeModule();
    if (probe.kind === "unavailable") {
      return probe.reason === "missing"
        ? { kind: "skipped", reason: "ee_unavailable" }
        : { kind: "failed", error: probe.error };
    }
    const region = config.bedrockRegion ?? row.bedrockRegion;
    if (!region) return { kind: "skipped", reason: "missing_byot_key" };
    // Mutate the discriminated row so the fetcher uses the resolved region.
    row = { provider: "bedrock", orgId: row.orgId, bedrockRegion: region };
    bedrockBundle = probe.module.parseBedrockCredentialBundle(config.apiKey);
    if (!bedrockBundle) return { kind: "skipped", reason: "malformed_bedrock_bundle" };
  }

  try {
    const result = await fetchCatalogForRow(row, config.apiKey, bedrockBundle);
    return { kind: "refreshed", modelCount: result.models.length, source: result.source };
  } catch (err) {
    return { kind: "failed", error: errorMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

const ZERO_COUNTS = {
  inspected: 0,
  refreshed: 0,
  failed: 0,
  skippedDecryptFailed: 0,
  skippedInBackoff: 0,
  skippedMissingKey: 0,
  skippedEeUnavailable: 0,
  skippedMalformedBundle: 0,
} as const;

function zeroResult(): ByotRefreshCycleResult {
  return { status: "success", ...ZERO_COUNTS };
}

interface CycleOptions {
  staleThresholdMs?: number;
  batchSize?: number;
  /** Override `Date.now()` for tests. */
  nowFn?: () => number;
}

/**
 * Run a single refresh cycle. Errors are caught and surfaced as `status:
 * "failure"` (stale-row query failed) or per-row `failed` counts — the
 * scheduler must not throw out of the tick or the `setInterval` loop dies.
 */
export const runByotCatalogRefreshCycle = (
  opts: CycleOptions = {},
): Effect.Effect<ByotRefreshCycleResult> =>
  Effect.gen(function* () {
    if (!hasInternalDB()) {
      const result = zeroResult();
      emitCycleAudit(result);
      return result;
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
      const failed: ByotRefreshCycleResult = {
        status: "failure",
        ...ZERO_COUNTS,
        error: fetchResult.error,
      };
      emitCycleAudit(failed);
      return failed;
    }

    const rows = fetchResult.rows;
    const result: ByotRefreshCycleResult = { status: "success", ...ZERO_COUNTS, inspected: rows.length };

    if (rows.length === 0) {
      emitCycleAudit(result);
      return result;
    }

    log.info({ count: rows.length }, "BYOT catalog refresh: cycle starting");

    // Sequential — one upstream provider call at a time. `Effect.forEach`
    // with `{ concurrency: 1 }` stays in the Effect chain so a fiber
    // interrupt cancels cleanly mid-cycle.
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.tryPromise({
            try: () => refreshOne(row, now()),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          }).pipe(
            Effect.catchAll((err) =>
              Effect.succeed({ kind: "failed" as const, error: errorMessage(err) }),
            ),
          );

          const key = backoffKey(row.orgId, row.provider, regionForKey(row));
          if (outcome.kind === "refreshed") {
            recordSuccess(key);
            result.refreshed++;
            emitPerRowAudit({
              action: ADMIN_ACTIONS.model_config.catalogRefresh,
              orgId: row.orgId,
              status: "success",
              metadata: {
                provider: providerOfRow(row),
                modelCount: outcome.modelCount,
                source: outcome.source,
                triggeredBy: "scheduler",
              },
            });
          } else if (outcome.kind === "skipped") {
            countSkip(result, outcome.reason);
            emitPerRowAudit({
              action: ADMIN_ACTIONS.model_config.catalogRefreshSkip,
              orgId: row.orgId,
              status: skipStatus(outcome.reason),
              metadata: { provider: providerOfRow(row), reason: outcome.reason },
            });
          } else {
            recordFailure(key, now());
            result.failed++;
            emitPerRowAudit({
              action: ADMIN_ACTIONS.model_config.catalogRefresh,
              orgId: row.orgId,
              status: "failure",
              metadata: {
                provider: providerOfRow(row),
                error: outcome.error,
                triggeredBy: "scheduler",
              },
            });
          }
        }),
      { concurrency: 1 },
    );

    log.info({ ...result }, "BYOT catalog refresh: cycle complete");
    emitCycleAudit(result);
    return result;
  });

function countSkip(result: ByotRefreshCycleResult, reason: ByotCatalogRefreshSkipReason): void {
  switch (reason) {
    case "decrypt_failed":
      result.skippedDecryptFailed++;
      return;
    case "in_backoff":
      result.skippedInBackoff++;
      return;
    case "missing_byot_key":
      result.skippedMissingKey++;
      return;
    case "ee_unavailable":
      result.skippedEeUnavailable++;
      return;
    case "malformed_bedrock_bundle":
      result.skippedMalformedBundle++;
      return;
  }
}

/**
 * Audit `status` for a skip. Deliberate suppressions (in_backoff, missing
 * key, ee_unavailable) are `success` — they're working as designed.
 * Corruption (`decrypt_failed`, `malformed_bedrock_bundle`) is `failure`
 * because an admin needs to re-enter the key.
 */
function skipStatus(reason: ByotCatalogRefreshSkipReason): "success" | "failure" {
  return reason === "decrypt_failed" || reason === "malformed_bedrock_bundle"
    ? "failure"
    : "success";
}

// ---------------------------------------------------------------------------
// Audit emission — one helper, four call sites
// ---------------------------------------------------------------------------

interface AuditArgs {
  action: AdminActionType;
  orgId: string;
  status: "success" | "failure";
  metadata: Record<string, unknown>;
}

function emitPerRowAudit(args: AuditArgs): void {
  try {
    logAdminAction({
      actionType: args.action,
      targetType: "model_config",
      targetId: args.orgId,
      scope: "platform",
      systemActor: BYOT_CATALOG_REFRESH_ACTOR,
      status: args.status,
      metadata: args.metadata,
    });
  } catch (err) {
    // logAdminAction is fire-and-forget by contract — belt-and-braces so a
    // future audit-module regression can't tear down the cycle loop.
    log.warn(
      { err: errorMessage(err), orgId: args.orgId, action: args.action },
      "BYOT catalog refresh: per-row audit emission threw",
    );
  }
}

function emitCycleAudit(result: ByotRefreshCycleResult): void {
  try {
    logAdminAction({
      actionType: ADMIN_ACTIONS.model_config.catalogRefreshCycle,
      targetType: "model_config",
      targetId: "scheduler",
      scope: "platform",
      systemActor: BYOT_CATALOG_REFRESH_ACTOR,
      status: result.status,
      metadata: { ...result },
    });
  } catch (err) {
    log.error(
      { err: errorMessage(err) },
      "BYOT catalog refresh: cycle audit emission threw — original counts preserved in pino",
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle (setInterval-based, mirrors ee/audit/purge-scheduler.ts)
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
 * Start the BYOT catalog refresh scheduler. Runs an initial cycle
 * immediately, then repeats at the configured interval. No-op if already
 * running or if the internal DB is unavailable.
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
 * cycle and returns the result. The result's `status` field distinguishes
 * a healthy cycle from one that died in the stale-row query — the admin
 * route uses that to surface 500 vs 200.
 */
export async function triggerByotCatalogRefreshCycle(): Promise<ByotRefreshCycleResult> {
  return Effect.runPromise(runByotCatalogRefreshCycle());
}
