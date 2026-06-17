/**
 * Abuse prevention — anomaly detection with graduated response.
 *
 * Detects abusive query patterns per workspace using sliding window counters:
 * - Query rate (rapid-fire requests)
 * - Error rate (high failure ratio)
 * - Unique tables accessed (scanning unusual breadth)
 *
 * Graduated response: warn (log + webhook) → throttle (inject delays) → suspend.
 *
 * All state is in-memory with periodic flush to the internal DB for persistence
 * across restarts. Thresholds are configurable via env vars or atlas.config.ts.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { abuseEscalations } from "@atlas/api/lib/metrics";
import { hasInternalDB, internalExecute, internalQuery } from "@atlas/api/lib/db/internal";
import { isLoadTestWorkspace } from "@atlas/api/lib/auth/load-test-allowlist";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  ABUSE_LEVELS,
  ABUSE_TRIGGERS,
  asRatio,
  type AbuseCounters,
  type AbuseLevel,
  type AbuseRestoreStatus,
  type AbuseTrigger,
  type AbuseEvent,
  type AbuseEventsStatus,
  type AbuseStatus,
  type AbuseThresholdConfig,
  type AbuseDetail,
} from "@useatlas/types";

// Local literal tuple, not imported from `@useatlas/types`'s value
// export — the scaffold template builds against the registry copy,
// and a fresh value export there breaks scaffold CI until the next
// types publish (see #useatlas/types-scaffold-gotcha). `satisfies`
// pins this to the canonical union so a drift fails compile.
export const ABUSE_RESTORE_STATUSES = [
  "pending",
  "ok",
  "db_unavailable",
  "load_failed",
] as const satisfies readonly AbuseRestoreStatus[];
export type { AbuseRestoreStatus };

/**
 * A non-`"none"` abuse level — exactly the states a reinstate can lift
 * (`"warning"` / `"throttled"` / `"suspended"`). Named here rather than
 * inlining `Exclude<AbuseLevel, "none">` everywhere so the F-33 audit
 * metadata shape (`metadata.previousLevel: ReinstatedLevel`) and the
 * `reinstateWorkspace` return type stay in lockstep as `ABUSE_LEVELS`
 * evolves — a new level gets picked up automatically by every
 * consumer, no drift between mock fixtures and prod code.
 */
export type ReinstatedLevel = Exclude<AbuseLevel, "none">;
import { errorRatePct, splitIntoInstances } from "./abuse-instances";

const log = createLogger("abuse");

// ---------------------------------------------------------------------------
// Enum drift coercion
// ---------------------------------------------------------------------------
// A drifted abuse_events row must never crash the admin page, so we validate
// level / trigger_type against the canonical tuples, coerce unknowns to safe
// defaults, and warn on drift. Callers that care about the *distinction*
// between a genuine `none` and a drift-coerced `none` (e.g. restoreAbuseState
// — where the difference is fail-open vs fail-safe) read `levelDrifted`.

const LEVEL_SET: ReadonlySet<string> = new Set(ABUSE_LEVELS);
const TRIGGER_SET: ReadonlySet<string> = new Set(ABUSE_TRIGGERS);

function isAbuseLevel(v: unknown): v is AbuseLevel {
  return typeof v === "string" && LEVEL_SET.has(v);
}

function isAbuseTrigger(v: unknown): v is AbuseTrigger {
  return typeof v === "string" && TRIGGER_SET.has(v);
}

interface CoercedAbuseEnums {
  level: AbuseLevel;
  trigger: AbuseTrigger;
  /** True when `rawLevel` was not a member of `ABUSE_LEVELS` — caller may skip or escalate. */
  levelDrifted: boolean;
  /** True when `rawTrigger` was not a member of `ABUSE_TRIGGERS`. */
  triggerDrifted: boolean;
}

function coerceAbuseEnums(
  rowId: string,
  rawLevel: unknown,
  rawTrigger: unknown,
): CoercedAbuseEnums {
  const levelOk = isAbuseLevel(rawLevel);
  const triggerOk = isAbuseTrigger(rawTrigger);
  if (!levelOk || !triggerOk) {
    log.warn(
      { rowId, rawLevel, rawTrigger },
      "abuse event with drifted enum",
    );
  }
  return {
    level: levelOk ? rawLevel : "none",
    trigger: triggerOk ? rawTrigger : "manual",
    levelDrifted: !levelOk,
    triggerDrifted: !triggerOk,
  };
}

// ---------------------------------------------------------------------------
// Configuration — env var thresholds
// ---------------------------------------------------------------------------

// Thresholds resolve through the platform settings registry (#3705): a
// platform DB override wins, env is the fallback tier, registry default last.
// `getAbuseConfig` reads each via `getSettingAuto` per query-event with the key
// as a literal (so the parity-contract reader check sees it), then hands the
// raw value to a pure parser. An operator can retune abuse defense from Admin
// without a redeploy. Platform scope is load-bearing — a tenant must never tune
// the thresholds that defend the region against it.
function parsePosInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePosFloat(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getAbuseConfig(): AbuseThresholdConfig {
  return {
    queryRateLimit: parsePosInt(getSettingAuto("ATLAS_ABUSE_QUERY_RATE"), 200),
    queryRateWindowSeconds: parsePosInt(getSettingAuto("ATLAS_ABUSE_WINDOW_SECONDS"), 300),
    // Value is already a 0–1 fraction (e.g. ATLAS_ABUSE_ERROR_RATE=0.5);
    // `asRatio` brands it so the cross-scale guard in `checkThresholds` +
    // detail-panel comparisons type-checks (#1685).
    errorRateThreshold: asRatio(parsePosFloat(getSettingAuto("ATLAS_ABUSE_ERROR_RATE"), 0.5)),
    uniqueTablesLimit: parsePosInt(getSettingAuto("ATLAS_ABUSE_UNIQUE_TABLES"), 50),
    throttleDelayMs: parsePosInt(getSettingAuto("ATLAS_ABUSE_THROTTLE_DELAY_MS"), 2000),
    // `parsePosInt` rejects `≤ 0` and falls back to the default, so the only way
    // to bypass the cooldown (e.g. for the abuse engine's own unit tests)
    // is `parseNonNegInt` below — a deliberate two-helper split so a typo
    // in a SaaS env file / setting (`ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS=0`)
    // doesn't silently turn the dwell-time guard off in prod.
    escalationCooldownMs:
      parseNonNegInt(getSettingAuto("ATLAS_ABUSE_ESCALATION_COOLDOWN_SECONDS"), 60) * 1000,
  };
}

/**
 * Variant of `parsePosInt` that accepts `0` as a valid value. Only the
 * escalation cooldown is allowed to be disabled this way — explicit opt-in
 * for the abuse engine's own unit tests, where the ladder behaviour is
 * exercised in a tight loop. Production deployments must set a positive
 * value (or omit the var entirely to take the default), so a stray `0` in
 * a SaaS env file does not silently revive the pre-cooldown fast-walk
 * regression. See `getAbuseConfig`.
 *
 * Uses `Number()` + `Number.isInteger` rather than `parseInt` so values
 * like `"0.5"` or `"0s"` fall back to the default instead of silently
 * truncating to `0` and reopening the fast-walk path.
 */
function parseNonNegInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Abuse detection is only useful in multi-tenant SaaS. On a single-tenant
 * self-hosted deploy the operator *is* the user — auto-suspending them on
 * their own queries is pure false positive.
 *
 * Two-step resolution covers all three ways prod can land in SaaS mode:
 *
 *   1. **Env var** — `ATLAS_DEPLOY_MODE=saas` is the canonical Railway
 *      signal and the strongest operator intent (mirrors
 *      `saas-guards.ts:explicitSaasFromEnv`).
 *   2. **Resolved config** — `atlas.config.ts` may pin
 *      `deployMode: "saas"` without the env var (the actual
 *      `deploy/api/atlas.config.ts` does exactly this), and `auto` mode
 *      can resolve to `"saas"` when `isEnterpriseEnabled() &&
 *      hasInternalDB()`. The resolved value lives on `getConfig()`.
 *
 * Either path returning `"saas"` engages the engine. `getConfig()` is
 * loaded via `require()` rather than a static import so the AGPL core
 * (which never depends on `lib/effect`) keeps its lean import graph;
 * mirrors the lazy-load pattern in
 * `settings.ts:resolveDeployModeSnapshot`. Any throw (missing module,
 * pre-init call) falls back to the env-var-only answer so abuse
 * detection never crashes a request path.
 */
function isSaasDeployment(): boolean {
  if (process.env.ATLAS_DEPLOY_MODE === "saas") return true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const configMod = require("@atlas/api/lib/config") as {
      getConfig: () => { deployMode?: string } | null;
    };
    return configMod.getConfig()?.deployMode === "saas";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-memory workspace state
// ---------------------------------------------------------------------------

interface WindowCounter {
  timestamps: number[];
  errorCount: number;
  tables: Set<string>;
}

interface WorkspaceAbuseState {
  level: AbuseLevel;
  trigger: AbuseTrigger | null;
  message: string | null;
  updatedAt: number;
  window: WindowCounter;
  /** Escalation count — how many consecutive windows triggered. */
  escalations: number;
  /**
   * Timestamp of the last `level` transition (ms since epoch). Undefined
   * before the first escalation. Drives `escalationCooldownMs` — the next
   * rung on the ladder (`warning` → `throttled` → `suspended`) only fires
   * once the dwell time at the current level has elapsed.
   */
  lastLevelChangeAt?: number;
}

const workspaceState = new Map<string, WorkspaceAbuseState>();

/**
 * Workspaces that have already had their load-test allowlist skip
 * logged once. Bounded by the size of `ATLAS_LOADTEST_ALLOWED_ORGS`
 * (operator-controlled), so unbounded growth isn't a concern.
 */
const warnedLoadTestSkip = new Set<string>();

// `AbuseRestoreStatus` doc lives in @useatlas/types/abuse.ts (the wire
// boundary). Single-process: `_restoreStatus` reflects the boot
// outcome of *this* Node process. Atlas's deployment model is
// long-lived API processes (Railway/Docker), so this is the right
// granularity. A multi-replica deploy that splits state across
// isolates would need a per-replica surface; not a current concern.
let _restoreStatus: AbuseRestoreStatus = "pending";

/** Read the last `restoreAbuseState` outcome. */
export function getAbuseRestoreStatus(): AbuseRestoreStatus {
  return _restoreStatus;
}

/** Reset all in-memory state. For tests. */
export function _resetAbuseState(): void {
  workspaceState.clear();
  warnedLoadTestSkip.clear();
  _restoreStatus = "pending";
}

/** Get or create workspace state. */
function getState(workspaceId: string): WorkspaceAbuseState {
  let state = workspaceState.get(workspaceId);
  if (!state) {
    state = {
      level: "none",
      trigger: null,
      message: null,
      updatedAt: Date.now(),
      window: { timestamps: [], errorCount: 0, tables: new Set() },
      escalations: 0,
    };
    workspaceState.set(workspaceId, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Sliding window maintenance
// ---------------------------------------------------------------------------

function pruneWindow(w: WindowCounter, windowMs: number): void {
  const cutoff = Date.now() - windowMs;
  const firstValid = w.timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) {
    w.timestamps.splice(0, firstValid);
  } else if (firstValid === -1) {
    w.timestamps.length = 0;
    w.errorCount = 0;
    w.tables.clear();
  }
}

// ---------------------------------------------------------------------------
// Record a query event
// ---------------------------------------------------------------------------

/**
 * Record a query event for abuse detection.
 * Call this after each query execution (success or failure).
 */
export function recordQueryEvent(
  workspaceId: string,
  opts: { success: boolean; tablesAccessed?: string[] },
): void {
  // Self-hosted single-tenant deploys: skip abuse tracking entirely. The
  // detector exists to defend a multi-tenant SaaS region against a
  // single noisy workspace; on self-hosted, the operator IS the user
  // and the detector produces only false positives. See
  // `isSaasDeployment` for the gate.
  if (!isSaasDeployment()) return;

  // #2166 — workspaces in the load-test allowlist
  // (`ATLAS_LOADTEST_ALLOWED_ORGS`) bypass the escalation chain so a
  // designated load-test workspace can't auto-suspend itself while
  // running scenarios that legitimately exceed the rate limits. Same
  // allowlist that gates the self-mint MCP load-test JWT endpoint
  // (`api/routes/me-load-test.ts`) — single source of truth in
  // `lib/auth/load-test-allowlist.ts`. Log the first skip per process
  // so operators see the escape hatch is engaged without log spam.
  if (isLoadTestWorkspace(workspaceId)) {
    if (!warnedLoadTestSkip.has(workspaceId)) {
      warnedLoadTestSkip.add(workspaceId);
      log.info(
        { workspaceId },
        "Abuse tracking skipped (workspace in ATLAS_LOADTEST_ALLOWED_ORGS)",
      );
    }
    return;
  }

  const config = getAbuseConfig();
  const windowMs = config.queryRateWindowSeconds * 1000;
  const state = getState(workspaceId);
  const w = state.window;

  // If workspace is already suspended, skip tracking
  if (state.level === "suspended") return;

  pruneWindow(w, windowMs);

  const now = Date.now();
  w.timestamps.push(now);
  if (!opts.success) w.errorCount++;
  if (opts.tablesAccessed) {
    for (const t of opts.tablesAccessed) w.tables.add(t);
  }

  // Check thresholds
  checkThresholds(workspaceId, state, config);
}

// ---------------------------------------------------------------------------
// Threshold evaluation & escalation
// ---------------------------------------------------------------------------

function checkThresholds(
  workspaceId: string,
  state: WorkspaceAbuseState,
  config: AbuseThresholdConfig,
): void {
  const w = state.window;
  const queryCount = w.timestamps.length;

  // Query rate check
  if (queryCount > config.queryRateLimit) {
    escalate(workspaceId, state, "query_rate", `Query rate ${queryCount} exceeds limit ${config.queryRateLimit} in ${config.queryRateWindowSeconds}s window`);
    return;
  }

  // Error rate check (need at least 10 queries to evaluate)
  if (queryCount >= 10) {
    const errorRate = w.errorCount / queryCount;
    if (errorRate > config.errorRateThreshold) {
      escalate(workspaceId, state, "error_rate", `Error rate ${(errorRate * 100).toFixed(0)}% exceeds threshold ${(config.errorRateThreshold * 100).toFixed(0)}%`);
      return;
    }
  }

  // Unique tables check
  if (w.tables.size > config.uniqueTablesLimit) {
    escalate(workspaceId, state, "unique_tables", `${w.tables.size} unique tables accessed exceeds limit ${config.uniqueTablesLimit}`);
    return;
  }

  // No threshold exceeded — if we had escalations, decay them
  if (state.escalations > 0 && queryCount < config.queryRateLimit * 0.5) {
    state.escalations = Math.max(0, state.escalations - 1);
  }
}

function escalate(
  workspaceId: string,
  state: WorkspaceAbuseState,
  trigger: AbuseTrigger,
  message: string,
): void {
  const config = getAbuseConfig();
  const now = Date.now();
  const prevLevel = state.level;
  state.escalations++;
  state.trigger = trigger;
  state.message = message;
  state.updatedAt = now;

  // Dwell-time gate (#2167-ish — self-suspension during dev). Pre-cooldown,
  // three consecutive over-threshold checks (e.g. three failing-SQL attempts
  // in the same minute) walked the workspace `none → warning → throttled →
  // suspended` in seconds, before warn/throttle had any chance to take
  // effect or for the operator to react. Each level transition now requires
  // `escalationCooldownMs` to have elapsed since the last one — the
  // escalation counter still increments so the metrics + admin UI reflect
  // ongoing pressure, but the ladder advances at most once per cooldown
  // window. Undefined `lastLevelChangeAt` means "no transition yet" → the
  // first rung fires immediately, mirroring the pre-cooldown first-trigger
  // semantics.
  const dwellElapsed =
    state.lastLevelChangeAt === undefined ||
    now - state.lastLevelChangeAt >= config.escalationCooldownMs;

  if (dwellElapsed) {
    if (prevLevel === "none") state.level = "warning";
    else if (prevLevel === "warning") state.level = "throttled";
    else if (prevLevel === "throttled") state.level = "suspended";
  }

  // Only emit event if level changed
  if (state.level !== prevLevel) {
    state.lastLevelChangeAt = now;
    const event: AbuseEvent = {
      id: crypto.randomUUID(),
      workspaceId,
      level: state.level,
      trigger,
      message,
      metadata: {
        queryCount: state.window.timestamps.length,
        errorCount: state.window.errorCount,
        uniqueTables: state.window.tables.size,
        escalations: state.escalations,
      },
      createdAt: new Date().toISOString(),
      actor: "system",
    };

    log.warn(
      { workspaceId, level: state.level, trigger, message, escalations: state.escalations },
      "Abuse level changed: %s → %s",
      prevLevel,
      state.level,
    );

    abuseEscalations.add(1, { level: state.level, trigger });
    persistAbuseEvent(event);
  }
}

// ---------------------------------------------------------------------------
// Workspace abuse status check (called from middleware)
// ---------------------------------------------------------------------------

/**
 * Check the current abuse level for a workspace.
 * Returns the current level and throttle delay if applicable.
 *
 * Allowlisted workspaces (`ATLAS_LOADTEST_ALLOWED_ORGS`) always report
 * `level: "none"` regardless of stored state. `recordQueryEvent` already
 * short-circuits for these workspaces, but pre-allowlist suspensions
 * (in-memory or rehydrated from `abuse_events`) would otherwise keep
 * blocking chat/query indefinitely — the never-suspend semantics need to
 * apply at *read* time too, not just at escalation time.
 */
export function checkAbuseStatus(workspaceId: string): {
  level: AbuseLevel;
  throttleDelayMs?: number;
} {
  // Self-hosted bypass — symmetric with `recordQueryEvent`. The
  // `recordQueryEvent` no-op already prevents new in-memory state from
  // ever escalating past `none` on self-hosted, but this guard lifts any
  // pre-existing state too (e.g. a SaaS deploy that flipped to self-hosted
  // post-`restoreAbuseState`) so the chat/query gate doesn't keep blocking
  // on stale enforcement.
  if (!isSaasDeployment()) return { level: "none" };

  if (isLoadTestWorkspace(workspaceId)) return { level: "none" };

  const state = workspaceState.get(workspaceId);
  if (!state || state.level === "none" || state.level === "warning") {
    return { level: state?.level ?? "none" };
  }

  if (state.level === "throttled") {
    const config = getAbuseConfig();
    return { level: "throttled", throttleDelayMs: config.throttleDelayMs };
  }

  return { level: "suspended" };
}

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

/**
 * List all workspaces with non-"none" abuse levels.
 *
 * Filters out allowlisted workspaces (`ATLAS_LOADTEST_ALLOWED_ORGS`) so
 * the abuse console doesn't render stale-suspended rows for workspaces
 * that every other read path (`checkAbuseStatus`, the platform-admin
 * `abuseLevel` surface, the chat-route gate) reports as `none`. Without
 * this filter, an admin would see a "suspended" workspace in the abuse
 * list, click reinstate, and get back a noop — the in-memory state stays
 * suspended but is shadowed by the allowlist guard, so the read & write
 * paths diverge.
 */
export function listFlaggedWorkspaces(): AbuseStatus[] {
  // Self-hosted bypass — symmetric with `checkAbuseStatus`. Without this,
  // a process that flipped from saas → self-hosted (or rehydrated stale
  // state from `abuse_events`) would still render flagged workspaces in
  // the admin abuse console even though every enforcement path reports
  // `none`. Operators would click reinstate on rows that aren't actually
  // blocking anything, and the read/write paths would diverge.
  if (!isSaasDeployment()) return [];

  const results: AbuseStatus[] = [];
  for (const [workspaceId, state] of workspaceState) {
    if (state.level === "none") continue;
    if (isLoadTestWorkspace(workspaceId)) continue;
    results.push({
      workspaceId,
      workspaceName: null, // Resolved by the admin route
      level: state.level,
      trigger: state.trigger,
      message: state.message,
      updatedAt: new Date(state.updatedAt).toISOString(),
      events: [],
    });
  }
  return results.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Read the full investigation context for a single flagged workspace:
 * current in-memory counters, thresholds, and the split of persisted events
 * into current/prior instances.
 *
 * Returns `null` when the workspace is not currently flagged (level = "none"
 * or unknown workspace) — callers should 404. DB persistence failures degrade
 * to empty `events` rather than throwing: the in-memory status is still worth
 * returning even if the audit trail is momentarily unreachable.
 */
export async function getAbuseDetail(
  workspaceId: string,
  priorLimit = 5,
  eventLimit = 50,
): Promise<AbuseDetail | null> {
  // Self-hosted bypass — symmetric with `checkAbuseStatus` and
  // `listFlaggedWorkspaces`. Returning `null` makes the admin route 404,
  // so a stale detail view can't contradict an enforcement path that's
  // already reporting `none`.
  if (!isSaasDeployment()) return null;

  const state = workspaceState.get(workspaceId);
  if (!state || state.level === "none") return null;

  const config = getAbuseConfig();
  const w = state.window;
  const queryCount = w.timestamps.length;
  // Error rate is only meaningful once we've got a small baseline (mirrors
  // `checkThresholds`). Surface `null` so the UI can show "baseline pending"
  // rather than a misleading 0% / 100%. Arithmetic is delegated to the pure
  // `errorRatePct` helper.
  const errorRate =
    queryCount >= 10 ? errorRatePct(w.errorCount, queryCount) : null;

  const { events, status: eventsStatus } = await getAbuseEvents(workspaceId, eventLimit);
  const { currentInstance, priorInstances } = splitIntoInstances(events, priorLimit);

  return {
    workspaceId,
    workspaceName: null, // Resolved by the admin route (same as listFlaggedWorkspaces).
    level: state.level,
    trigger: state.trigger,
    message: state.message,
    updatedAt: new Date(state.updatedAt).toISOString(),
    counters: {
      queryCount,
      errorCount: w.errorCount,
      errorRatePct: errorRate,
      uniqueTablesAccessed: w.tables.size,
      escalations: state.escalations,
    },
    triggerCounters: triggerCountersFromInstance(currentInstance.events),
    thresholds: config,
    currentInstance,
    priorInstances,
    eventsStatus,
  };
}

/**
 * Pull the at-trigger counters out of the most recent escalation event in
 * the current flag instance.
 *
 * Once a workspace is suspended (or throttled), `recordQueryEvent`
 * short-circuits and the sliding window keeps pruning timestamps older
 * than `queryRateWindowSeconds`. By the time an admin opens the
 * investigation panel — typically minutes later — the live counters read
 * `queries: 0`, `errorRate: —`, `uniqueTables: 0`, while the level + the
 * `state.message` trigger reason still reflect the snapshot at escalation
 * time ("Error rate 75% exceeds threshold 50%"). The mismatch makes the
 * UI nonsensical. `escalate()` already persists the at-trigger counts
 * into `event.metadata`, so we read them back here and surface them as
 * `triggerCounters` for the detail panel to show instead of (or alongside)
 * the live-window row.
 *
 * Returns `null` when the current instance has no events (in-memory state
 * exists but `abuse_events` hasn't been written yet, or the DB load
 * failed). The wire schema accepts `null` and the panel falls back to the
 * live counters in that case.
 *
 * `errorRatePct` is recomputed from the persisted `queryCount` +
 * `errorCount` so the percentage matches the engine's own arithmetic
 * (2-decimal rounding via `errorRatePct`), rather than the truncated `(rate
 * * 100).toFixed(0)` string baked into the human-readable `message` field
 * at escalation time. Below-baseline events (< 10 queries) surface
 * `errorRatePct: null` to match the live-counters contract.
 */
function triggerCountersFromInstance(events: readonly AbuseEvent[]): AbuseCounters | null {
  if (events.length === 0) return null;
  // `splitIntoInstances` orders the current-instance events chronologically
  // (oldest first), so the last entry is the most recent escalation.
  const latest = events[events.length - 1];
  if (!latest) return null;
  const md = latest.metadata;
  // Hostile-input guard — corrupt / pre-schema metadata could land here as
  // `NaN` if any field was string-shaped and refused coercion, or as a
  // negative number from a partial-write race. `errorRatePct` throws on
  // non-finite or negative inputs, which would propagate up and crash
  // `getAbuseDetail()` exactly for the bad-row case this helper exists to
  // tolerate. Clamp counts to non-negative finite integers before any
  // downstream arithmetic. Surfacing the bad row to operators is already
  // covered by the per-row warn in `getAbuseEvents`.
  const queryCount = sanitizeNonNegInt(md.queryCount);
  const errorCount = Math.min(sanitizeNonNegInt(md.errorCount), queryCount);
  const uniqueTablesAccessed = sanitizeNonNegInt(md.uniqueTables);
  const escalations = sanitizeNonNegInt(md.escalations);
  // Mirror the live-counter "needs a baseline" contract — < 10 → null.
  // Below-baseline triggers come from non-error_rate paths (query_rate or
  // unique_tables hitting the limit), so an at-trigger row showing
  // `errorRatePct: null` is honest, not missing.
  const errorRate =
    queryCount >= 10 ? errorRatePct(errorCount, queryCount) : null;
  return {
    queryCount,
    errorCount,
    errorRatePct: errorRate,
    uniqueTablesAccessed,
    escalations,
  };
}

/**
 * Clamp an arbitrary JSON-decoded metadata value to a non-negative
 * integer. Anything non-finite, negative, or non-numeric collapses to
 * `0` — the safe fallback for both the wire counters (which are typed
 * `number`) and the `errorRatePct` precondition (`>= 0` finite).
 */
function sanitizeNonNegInt(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Manually reinstate a suspended or throttled workspace.
 *
 * Returns the previous level (one of "warning" / "throttled" / "suspended")
 * on success so the caller can emit audit metadata capturing the delta
 * without a second getter call, or `null` when the workspace is not
 * currently flagged (404 signal for the route). Returning the level instead
 * of a boolean closes the F-33 audit gap: the admin-action-log row carries
 * `previousLevel` as a first-class field so reviewers can tell a low-impact
 * un-warn from lifting a full suspension without joining `abuse_events`.
 */
export function reinstateWorkspace(
  workspaceId: string,
  actorId: string,
): ReinstatedLevel | null {
  const state = workspaceState.get(workspaceId);
  if (!state || state.level === "none") return null;

  const prevLevel = state.level;
  state.level = "none";
  state.trigger = null;
  state.message = null;
  state.escalations = 0;
  state.updatedAt = Date.now();
  // Reset the window so the workspace gets a clean slate
  state.window = { timestamps: [], errorCount: 0, tables: new Set() };
  // Clear the dwell-time gate too — otherwise a re-flag right after
  // reinstate would still see an "old enough" `lastLevelChangeAt` and the
  // gate would be vacuously satisfied, but worse, the timestamp would now
  // refer to a *prior instance*'s transition, which is misleading in any
  // future restore-time invariant check.
  state.lastLevelChangeAt = undefined;

  const event: AbuseEvent = {
    id: crypto.randomUUID(),
    workspaceId,
    level: "none",
    trigger: "manual",
    message: `Reinstated from ${prevLevel} by admin`,
    metadata: { previousLevel: prevLevel },
    createdAt: new Date().toISOString(),
    actor: actorId,
  };

  log.info(
    { workspaceId, previousLevel: prevLevel, actorId },
    "Workspace reinstated from %s",
    prevLevel,
  );

  abuseEscalations.add(1, { level: "none", trigger: "manual" });
  persistAbuseEvent(event);
  return prevLevel;
}

// ---------------------------------------------------------------------------
// Persistence — abuse events to internal DB
// ---------------------------------------------------------------------------

function persistAbuseEvent(event: AbuseEvent): void {
  if (!hasInternalDB()) return;

  try {
    internalExecute(
      `INSERT INTO abuse_events (id, workspace_id, level, trigger_type, message, metadata, actor, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        event.workspaceId,
        event.level,
        event.trigger,
        event.message,
        JSON.stringify(event.metadata),
        event.actor,
        event.createdAt,
      ],
    );
  } catch (err) {
    // A lost audit row is always an error, not a warning — manual reinstate
    // is a billing-affecting cross-tenant action and compliance reviewers
    // need the trail. Include workspaceId + eventId so on-call can
    // correlate the lost write with the workspace rather than grepping
    // the whole audit table.
    log.error(
      {
        err: err instanceof Error ? err.message : String(err),
        workspaceId: event.workspaceId,
        eventId: event.id,
      },
      "Failed to persist abuse event",
    );
  }
}

/**
 * Load recent abuse events from DB for a workspace.
 *
 * Returns `{ events, status }` so callers can distinguish "really empty" from
 * "DB unreachable" (#1682). Before the diagnostic channel, a DB failure
 * silently produced `events: []` that `getAbuseDetail` passed through — an
 * admin investigating a re-flagged workspace during a DB outage saw a clean
 * slate and could reinstate a repeat offender based on the false empty
 * history. Status values:
 *
 *   - `ok`             — query succeeded (empty is truly empty).
 *   - `db_unavailable` — `hasInternalDB()` is false (self-hosted, no
 *                        DATABASE_URL). Short-circuit, no query attempted.
 *   - `load_failed`    — query threw. In-memory state is still valid; the
 *                        audit trail is momentarily unreachable. UI must
 *                        show a destructive banner so the operator does not
 *                        conclude "never flagged."
 */
export async function getAbuseEvents(
  workspaceId: string,
  limit = 50,
): Promise<{ events: AbuseEvent[]; status: AbuseEventsStatus }> {
  if (!hasInternalDB()) return { events: [], status: "db_unavailable" };

  try {
    const rows = await internalQuery<{
      id: string;
      workspace_id: string;
      level: string;
      trigger_type: string;
      message: string;
      metadata: string;
      actor: string;
      created_at: string;
    }>(
      `SELECT id, workspace_id, level, trigger_type, message, metadata, actor, created_at
       FROM abuse_events
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, limit],
    );

    const events = rows.map((r) => {
      // Per-row try/catch: a single truncated-JSON / old-schema row must not
      // take out the remaining 49 valid rows by bubbling into the outer catch
      // where the indistinguishable "DB outage" path returns []. Mirrors the
      // coerceAbuseEnums pattern used above for level + trigger drift.
      let metadata: Record<string, unknown> = {};
      if (typeof r.metadata === "string") {
        try {
          const parsed = JSON.parse(r.metadata) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          } else {
            // Parsed cleanly but the value is a scalar or array — still a
            // corrupt row from our schema's perspective. Warn + default to
            // {} rather than pass an unusable shape to the UI.
            log.warn(
              { rowId: r.id, parsedType: Array.isArray(parsed) ? "array" : typeof parsed },
              "unexpected abuse_events.metadata shape — using empty object",
            );
          }
        } catch (err) {
          log.warn(
            {
              rowId: r.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "corrupt abuse_events.metadata — using empty object",
          );
        }
      } else if (r.metadata !== null && typeof r.metadata === "object" && !Array.isArray(r.metadata)) {
        // Driver pre-parsed jsonb into a value. Only accept object shapes;
        // arrays and scalars fall through to the empty default.
        metadata = r.metadata as Record<string, unknown>;
      } else if (r.metadata !== null && r.metadata !== undefined) {
        log.warn(
          { rowId: r.id, valueType: Array.isArray(r.metadata) ? "array" : typeof r.metadata },
          "unexpected abuse_events.metadata driver shape — using empty object",
        );
      }
      const { level, trigger } = coerceAbuseEnums(r.id, r.level, r.trigger_type);
      return {
        id: r.id,
        workspaceId: r.workspace_id,
        level,
        trigger,
        message: r.message,
        metadata,
        createdAt: r.created_at,
        actor: r.actor,
      };
    });

    return { events, status: "ok" };
  } catch (err) {
    // The .catch → [] fallback stays — in-memory counters + level in the
    // detail payload are still worth rendering — but it is no longer silent:
    // the `load_failed` status propagates to the UI's destructive banner so
    // the operator treats the empty history as degraded, not benign.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), workspaceId },
      "Failed to load abuse events",
    );
    return { events: [], status: "load_failed" };
  }
}

/** Restore in-memory state from DB on startup. */
export async function restoreAbuseState(): Promise<void> {
  if (!hasInternalDB()) {
    _restoreStatus = "db_unavailable";
    return;
  }

  try {
    // Get the latest event per workspace to restore current level
    const rows = await internalQuery<{
      workspace_id: string;
      level: string;
      trigger_type: string;
      message: string;
      created_at: string;
    }>(
      `SELECT DISTINCT ON (workspace_id) workspace_id, level, trigger_type, message, created_at
       FROM abuse_events
       ORDER BY workspace_id, created_at DESC`,
    );

    let driftSkipped = 0;
    const allowlistSkippedIds: string[] = [];
    for (const row of rows) {
      const { level, trigger, levelDrifted } = coerceAbuseEnums(
        row.workspace_id,
        row.level,
        row.trigger_type,
      );
      // A drifted level collapses to "none" — we can't trust that as "already
      // reinstated" because the stored enforcement state is ambiguous. Skip,
      // but count separately so the restore summary surfaces potential lost
      // enforcement rather than silently dropping it.
      if (levelDrifted) {
        driftSkipped++;
        continue;
      }
      if (level === "none") continue; // Already reinstated
      // Never rehydrate a non-"none" level for an allowlisted workspace.
      // The skip is gated by *current* env-var membership: if the
      // workspace later leaves `ATLAS_LOADTEST_ALLOWED_ORGS` and the
      // process restarts, the next `restoreAbuseState` call will see the
      // same row, find no allowlist match, and rehydrate it. State isn't
      // dropped at the DB layer — only kept out of memory while
      // allowlisted. Same read-time guard inside `checkAbuseStatus`
      // shadows the in-memory ladder when the env var is set, so an
      // operator removing a workspace from the allowlist *without*
      // restarting still sees "Active" until the next escalation.
      if (isLoadTestWorkspace(row.workspace_id)) {
        allowlistSkippedIds.push(row.workspace_id);
        continue;
      }

      const state = getState(row.workspace_id);
      state.level = level;
      state.trigger = trigger;
      state.message = row.message;
      const createdAtMs = new Date(row.created_at).getTime();
      state.updatedAt = createdAtMs;
      // Seed `lastLevelChangeAt` from the last persisted transition so the
      // dwell-time gate is honored across process restarts. Without this,
      // a workspace rehydrated as `warning` could be re-escalated to
      // `throttled` on the very next over-threshold check — the cooldown
      // would treat the missing timestamp as "no transition yet" and
      // collapse the entire ladder back into a fast-walk.
      state.lastLevelChangeAt = createdAtMs;
      // Set escalations based on current level to maintain correct position in the ladder
      state.escalations = level === "warning" ? 1 : level === "throttled" ? 2 : 3;
    }

    const restored = [...workspaceState.values()].filter((s) => s.level !== "none").length;
    const allowlistSkipped = allowlistSkippedIds.length;
    if (restored > 0 || driftSkipped > 0 || allowlistSkipped > 0) {
      log.info(
        // IDs included so an operator who set `ATLAS_LOADTEST_ALLOWED_ORGS`
        // to the wrong workspace ID can recover from logs alone — a
        // bare count like `allowlistSkipped: 17` doesn't tell you
        // *which* 17 got shadowed by an env-var typo.
        { count: restored, driftSkipped, allowlistSkipped, allowlistSkippedIds },
        "Restored abuse state for %d workspaces (%d skipped due to enum drift, %d skipped via allowlist)",
        restored,
        driftSkipped,
        allowlistSkipped,
      );
    }
    _restoreStatus = "ok";
  } catch (err) {
    // Clear any partial state — if the SQL read threw mid-iteration we
    // would otherwise leave a polluted in-memory map (some workspaces
    // rehydrated, the rest missing) under a `load_failed` status that
    // implies "engine started with empty state." Restoring the
    // invariant here means `load_failed` is honest.
    workspaceState.clear();
    _restoreStatus = "load_failed";
    // `log.error` (not `warn`) — a boot-time enforcement-state loss is
    // compliance-significant: every `checkAbuseStatus` will return
    // `"none"` until either the next escalation lands a new in-memory
    // row, or the next boot succeeds. Mirrors the `persistAbuseEvent`
    // catch which is `log.error` for the same audit-trail reason.
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to restore abuse state from DB — starting with empty state",
    );
  }
}

// ---------------------------------------------------------------------------
// Periodic cleanup — evict stale window data (called by SchedulerLayer fiber)
// ---------------------------------------------------------------------------

/** Interval for abuse cleanup. Exported for SchedulerLayer. */
export const ABUSE_CLEANUP_INTERVAL_MS = 300_000;

/**
 * Evict stale abuse detection window data. Called periodically by the
 * SchedulerLayer fiber in lib/effect/layers.ts.
 */
export function abuseCleanupTick(): void {
  const config = getAbuseConfig();
  const windowMs = config.queryRateWindowSeconds * 1000;

  for (const [id, state] of workspaceState) {
    pruneWindow(state.window, windowMs);

    // Remove entries with no activity and level "none"
    if (state.level === "none" && state.window.timestamps.length === 0) {
      workspaceState.delete(id);
    }
  }
}
