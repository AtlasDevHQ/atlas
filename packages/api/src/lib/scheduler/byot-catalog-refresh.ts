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
 *   - Dormancy gate (#2377). On top of the daily TTL, the stale-row query
 *     skips orgs whose `organization.last_active_at` is older than
 *     `ATLAS_BYOT_DORMANCY_DAYS` (default 30) — a workspace nobody has
 *     touched in a month stops burning provider rate-limit + audit noise on
 *     refreshes its admins will never see. The gate is managed-auth-only
 *     (the `organization` table exists only there) and self-disables when
 *     `ATLAS_BYOT_DORMANCY_DAYS=0`; in both cases the TTL-only legacy query
 *     runs. `last_active_at` is stamped (throttled) on authenticated chat
 *     turns by `markOrgActive` (lib/db/org-activity.ts).
 *   - Every per-row outcome is audit-logged via the existing
 *     `model_config.catalog_refresh*` actions. Cycle-level
 *     `catalog_refresh_cycle` emits every tick — the absence of a cycle row
 *     over a 48 h window is the "scheduler stopped" signal (mirroring the
 *     F-27 audit-purge invariant).
 *
 * Lifecycle: scheduled by `registerPeriodicFiber` in `effect/layers.ts`
 * (#4195) — a `forkScoped` fiber that runs an initial cycle on boot then
 * repeats on the configured cadence, gated on an internal DB and interrupted
 * cleanly on layer-scope shutdown. The scan → forEach → tally → audit cycle
 * body is the shared `runPeriodicDbCycle` skeleton.
 *
 * @see ./periodic-db-job.ts — the shared DB-cycle skeleton this cycle uses.
 * @see ../effect/layers.ts — `registerPeriodicFiber`, the fiber scheduler.
 */

import { Effect } from "effect";
import { createLogger } from "@atlas/api/lib/logger";
import { hasInternalDB, internalQuery } from "@atlas/api/lib/db/internal";
import { runPeriodicDbCycle } from "@atlas/api/lib/scheduler/periodic-db-job";
import { detectAuthMode } from "@atlas/api/lib/auth/detect";
import { buildStaleCatalogQuery } from "@atlas/api/lib/scheduler/byot-catalog-query";
import { logAdminAction, ADMIN_ACTIONS } from "@atlas/api/lib/audit";
import type { AdminActionType } from "@atlas/api/lib/audit/actions";
import { errorMessage } from "@atlas/api/lib/audit/error-scrub";
import { ModelRouter, type ModelRouterShape } from "@atlas/api/lib/effect/services";
import { runEnterprise } from "@atlas/api/lib/effect/enterprise-layer";
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

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 24h — both the default tick interval and the staleness gate. */
const DEFAULT_INTERVAL_MS = ONE_DAY_MS;

/** Bound per-tick runtime; backlog catches up across ticks via `NULLS FIRST`. */
const DEFAULT_BATCH_SIZE = 100;

/** Default dormancy window (#2377): skip orgs idle longer than this. */
const DEFAULT_DORMANCY_DAYS = 30;

/**
 * Resolve the dormancy threshold (ms) from `ATLAS_BYOT_DORMANCY_DAYS`.
 *
 * The contract is a whole number of days. Only an explicit `0` DISABLES the
 * gate (the cycle falls back to the TTL-only query). Every other invalid input
 * — empty, negative, NaN, unparseable, OR a non-integer like `0.5` — fails
 * safe to the 30-day default rather than silently disabling or guessing a
 * fractional window. (A bare `Math.floor` would turn `0.5` into `0` and
 * accidentally disable the gate, so non-integers are rejected outright.)
 */
function getDormancyThresholdMs(): number {
  const raw = process.env.ATLAS_BYOT_DORMANCY_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DORMANCY_DAYS * ONE_DAY_MS;
  const n = Number(raw);
  if (n === 0) return 0; // explicit operator opt-out
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return DEFAULT_DORMANCY_DAYS * ONE_DAY_MS;
  }
  return n * ONE_DAY_MS;
}

/** Test-only: expose the env-driven dormancy resolver. */
export const _getDormancyThresholdMsForTests = getDormancyThresholdMs;

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
  dormancyThresholdMs: number,
): Promise<StaleRow[]> {
  if (!hasInternalDB()) return [];

  // Dormancy gate (#2377). Only joinable when the Better-Auth `organization`
  // table exists — i.e. managed auth. In byot / simple-key / none modes the
  // table is absent (a JOIN would error) and dormancy is moot single-tenant,
  // so we fall back to the TTL-only query. `dormancyThresholdMs <= 0` is the
  // operator opt-out (ATLAS_BYOT_DORMANCY_DAYS=0). The SQL lives in
  // `buildStaleCatalogQuery` so the real-Postgres smoke can assert its
  // row-selection semantics (orphan/NULL/dormant/active) against a live DB.
  const dormancyEnabled = dormancyThresholdMs > 0 && detectAuthMode() === "managed";

  const rows = await internalQuery<StaleRowDb>(
    buildStaleCatalogQuery(dormancyEnabled),
    dormancyEnabled ? [staleThresholdMs, limit, dormancyThresholdMs] : [staleThresholdMs, limit],
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
// ModelRouter Tag probe — replaces the pre-#2565 `EeModule` import probe
// ---------------------------------------------------------------------------

type ModelRouterProbeResult =
  | { kind: "ok"; router: ModelRouterShape }
  | { kind: "unavailable"; reason: "missing" | "probe_error"; error: string };

let _routerProbe: Promise<ModelRouterProbeResult> | null = null;

/**
 * Resolve the `ModelRouter` Tag from `EnterpriseLayer` once per pod
 * lifetime. When EE is not loaded the Tag resolves to the no-op default
 * with `available: false` — the probe reports `kind: "unavailable"` so
 * the cycle audits "ee_unavailable" rather than failing every row.
 */
function probeModelRouter(): Promise<ModelRouterProbeResult> {
  if (_routerProbe) return _routerProbe;
  _routerProbe = (async () => {
    try {
      const router = await runEnterprise(
        Effect.gen(function* () {
          return yield* ModelRouter;
        }),
      );
      if (!router.available) {
        return {
          kind: "unavailable" as const,
          reason: "missing" as const,
          error: "ee module not installed (ModelRouter no-op default)",
        };
      }
      return { kind: "ok" as const, router };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { err: message },
        "ModelRouter Tag resolution failed — every row this cycle will fail",
      );
      return { kind: "unavailable" as const, reason: "probe_error" as const, error: message };
    }
  })();
  return _routerProbe;
}

/** Test-only: clear the cached ModelRouter probe so a fresh resolution is attempted. */
export function _resetEeProbeForTests(): void {
  _routerProbe = null;
}

// ---------------------------------------------------------------------------
// Per-row refresh
// ---------------------------------------------------------------------------

type RawWorkspaceModelConfig =
  import("@atlas/api/lib/auth/credentials").RawWorkspaceModelConfig;

type LoadRawConfigResult =
  | { kind: "ok"; config: RawWorkspaceModelConfig }
  | { kind: "no_config" }
  | { kind: "decrypt_failed" }
  | { kind: "ee_unavailable" }
  | { kind: "unavailable"; error: string };

async function loadRawConfig(orgId: string): Promise<LoadRawConfigResult> {
  const probe = await probeModelRouter();
  if (probe.kind === "unavailable") {
    return probe.reason === "missing"
      ? { kind: "ee_unavailable" }
      : { kind: "unavailable", error: probe.error };
  }

  // The `ModelRouter` Tag returns the typed `credentials` union; the
  // scheduler reads `credentials.bundle` directly for bedrock and
  // `credentials.apiKey` for the rest (#2565). The pre-#2565 path
  // re-parsed a JSON-stringified bundle via
  // `parseBedrockCredentialBundle`; that double-parse is gone now that
  // the cred lives as a typed value all the way through.
  const program = probe.router.getWorkspaceModelConfigRaw(orgId).pipe(
    Effect.map((rawConfig) =>
      rawConfig
        ? ({ kind: "ok" as const, config: rawConfig })
        : ({ kind: "no_config" as const }),
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
  bedrockBundle: unknown,
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
  if (config.provider !== row.provider) {
    return { kind: "skipped", reason: "missing_byot_key" };
  }

  // Pull cred material off the typed `credentials` union. Bedrock's
  // bundle is `null` precisely when the post-decrypt JSON parse failed
  // (the `malformed_bedrock_bundle` skip); other providers carry the
  // raw apiKey string. The fetcher takes both via separate args — the
  // bedrock fetch ignores `apiKey`, the others ignore `bedrockBundle`.
  //
  // Narrow on `row.provider` (the discriminator the rest of the file
  // walks) rather than `config.credentials.provider`: the earlier
  // `config.provider !== row.provider` early-return guarantees they
  // agree, and `row`-side narrowing lets TS resolve `row.bedrockRegion`
  // on the bedrock arm.
  let apiKey = "";
  let bedrockBundle: unknown = null;
  if (row.provider === "bedrock") {
    if (config.credentials.provider !== "bedrock" || !config.credentials.bundle) {
      return { kind: "skipped", reason: "malformed_bedrock_bundle" };
    }
    bedrockBundle = config.credentials.bundle;
    const region = config.bedrockRegion ?? row.bedrockRegion;
    if (!region) return { kind: "skipped", reason: "missing_byot_key" };
    // Mutate the discriminated row so the fetcher uses the resolved region.
    row = { provider: "bedrock", orgId: row.orgId, bedrockRegion: region };
  } else if (config.credentials.provider === "gateway") {
    if (!config.credentials.apiKey) {
      return { kind: "skipped", reason: "missing_byot_key" };
    }
    apiKey = config.credentials.apiKey;
  } else if (config.credentials.provider !== "bedrock") {
    apiKey = config.credentials.apiKey;
    if (!apiKey) return { kind: "skipped", reason: "missing_byot_key" };
  } else {
    // Defensive: row.provider !== "bedrock" but credentials.provider === "bedrock"
    // — should be unreachable since the earlier `config.provider !== row.provider`
    // check fires first. Return a skip rather than a failed so the cycle moves on.
    return { kind: "skipped", reason: "missing_byot_key" };
  }

  try {
    const result = await fetchCatalogForRow(row, apiKey, bedrockBundle);
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
  /**
   * Dormancy gate (#2377): orgs idle longer than this are skipped. Defaults
   * to `ATLAS_BYOT_DORMANCY_DAYS` (30d). `0` disables the gate. Managed-auth
   * only — see `findStaleByotCatalogs`.
   */
  dormancyThresholdMs?: number;
  /** Override `Date.now()` for tests. */
  nowFn?: () => number;
}

/**
 * Run a single refresh cycle. Errors are caught and surfaced as `status:
 * "failure"` (stale-row query failed) or per-row `failed` counts — the
 * scheduler must not throw out of the tick or the repeat loop dies. The
 * scan → guard → forEach → tally → audit choreography is the shared
 * `runPeriodicDbCycle` skeleton (#4195); this function supplies only the
 * BYOT-specific scan query, per-row apply, and per-outcome tally + backoff
 * bookkeeping. The per-tick span is applied by `registerPeriodicFiber` around
 * the fiber, not here (#2945 attribution is preserved via that fiber's
 * `spanResultAttributes`).
 */
export const runByotCatalogRefreshCycle = (
  opts: CycleOptions = {},
): Effect.Effect<ByotRefreshCycleResult> => {
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const dormancyThresholdMs = opts.dormancyThresholdMs ?? getDormancyThresholdMs();
  const now = opts.nowFn ?? Date.now;

  return runPeriodicDbCycle<StaleRow, RefreshOutcome, ByotRefreshCycleResult>({
    log,
    label: "BYOT catalog refresh",
    emptyResult: zeroResult,
    failureResult: (error) => ({ status: "failure", ...ZERO_COUNTS, error }),
    scan: () => findStaleByotCatalogs(staleThresholdMs, batchSize, dormancyThresholdMs),
    // Sequential per-row upstream provider call; `runPeriodicDbCycle` runs
    // these at `{ concurrency: 1 }` so a fiber interrupt cancels cleanly.
    applyRow: (row) => refreshOne(row, now()),
    defectOutcome: (error) => ({ kind: "failed", error }),
    tally: (result, row, outcome) => {
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
    },
    emitCycleAudit,
  });
};

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
// Scheduling — via `registerPeriodicFiber` in `effect/layers.ts` (#4195)
// ---------------------------------------------------------------------------
//
// The BYOT refresh no longer hand-rolls a `setInterval` lifecycle. Its cycle
// body is the shared `runPeriodicDbCycle` skeleton (above); the fiber that
// repeats it — interval, per-tick span, `withFiberDeathLog`, and the
// `hasInternalDB()` enablement gate — is owned by `registerPeriodicFiber`
// (arch-win #100 / #4130), forked `forkScoped` for the pod lifetime and
// interrupted cleanly on layer-scope shutdown. `Schedule.spaced` there spaces
// ticks by completion, so a slow cycle can never overlap the next — the old
// `setInterval` model had no cross-tick overlap guard beyond the daily cadence
// and the in-cycle `{ concurrency: 1 }` (unlike the two OpenAPI siblings, byot
// never carried an `_inFlight` flag). See `scheduler/periodic-db-job.ts` for
// how the DB-cycle skeleton and the fiber scheduler compose.

/**
 * The periodic tick interval (ms) — a daily cadence, mirroring the staleness
 * TTL. `registerPeriodicFiber` reads this once at registration.
 */
export function getByotCatalogRefreshIntervalMs(): number {
  return DEFAULT_INTERVAL_MS;
}

/**
 * Whether the BYOT catalog refresh is active on this pod. Post-#4195 the
 * refresh runs as a `forkScoped` periodic fiber (via `registerPeriodicFiber`)
 * for the whole pod lifetime whenever an internal DB is present — there is no
 * separate start/stop flag, so "running" reflects the registration gate
 * (`hasInternalDB()`), which the admin scheduler surface reports.
 */
export function isByotCatalogRefreshSchedulerRunning(): boolean {
  return hasInternalDB();
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
