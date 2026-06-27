/**
 * Abuse-prevention BASELINE — the core-resident half of the abuse engine.
 *
 * This module holds the parts of abuse detection that stay in the AGPL core
 * (`packages/api/src`) after the graduated multi-tenant response engine moved
 * to `@atlas/ee` (see `ee/src/abuse-prevention/`):
 *
 *   - **Threshold config parsing** (`getAbuseConfig` + the `parse*` helpers) —
 *     the sliding-window detector reads its thresholds from the platform
 *     settings registry regardless of whether the EE response engine is
 *     loaded. The config is core because the *detector* is core; only the
 *     warn→throttle→suspend *response* to a breach is enterprise.
 *   - **Enum-drift coercion** (`coerceAbuseEnums` + the `is*` predicates) —
 *     used by both persistence (writing `abuse_events`) and restore
 *     (rehydrating in-memory state). Exported so the EE engine can import the
 *     single canonical implementation rather than forking it.
 *   - **Counter-sanitization** (`sanitizeNonNegInt`) — used by the EE
 *     `getAbuseDetail` to clamp hostile metadata; exported for the same reason.
 *   - The `ReinstatedLevel` type, `ABUSE_RESTORE_STATUSES` const, and the
 *     `ABUSE_CLEANUP_INTERVAL_MS` const — referenced by core (`layers.ts` reads
 *     the interval; routes read the restore statuses), the EE engine, and
 *     tests, so they live here as the shared lower boundary.
 *
 * Why split here: the documented enterprise boundary
 * (`docs/development/enterprise-gating.md`) places abuse-prevention *response*
 * in `/ee`, but the *baseline detector* — counting events, computing rate
 * breaches, parsing thresholds — is a single-tenant-safe primitive that the
 * core can keep. Nothing in this file escalates a workspace or touches the
 * graduated ladder; that all lives behind the `AbuseResponse` Tag / sync
 * policy holder (`abuse-response-policy.ts`) implemented in `@atlas/ee`.
 *
 * Core NEVER imports `@atlas/ee`; the EE engine imports THIS module freely.
 */

import { createLogger } from "@atlas/api/lib/logger";
import { getSettingAuto } from "@atlas/api/lib/settings";
import {
  ABUSE_LEVELS,
  ABUSE_TRIGGERS,
  asRatio,
  type AbuseLevel,
  type AbuseRestoreStatus,
  type AbuseTrigger,
  type AbuseThresholdConfig,
} from "@useatlas/types";

const log = createLogger("abuse-baseline");

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

/**
 * Interval for abuse cleanup. Read by the SchedulerLayer fiber in
 * `lib/effect/layers.ts` (core) and used to schedule `abuseCleanupTick`.
 * Lives in baseline (not the EE engine) so the core scheduler can read it
 * without importing `@atlas/ee` — the tick itself routes through the
 * `AbuseResponse` sync policy holder, which is a no-op until EE registers it.
 */
export const ABUSE_CLEANUP_INTERVAL_MS = 300_000;

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

export function isAbuseLevel(v: unknown): v is AbuseLevel {
  return typeof v === "string" && LEVEL_SET.has(v);
}

export function isAbuseTrigger(v: unknown): v is AbuseTrigger {
  return typeof v === "string" && TRIGGER_SET.has(v);
}

export interface CoercedAbuseEnums {
  level: AbuseLevel;
  trigger: AbuseTrigger;
  /** True when `rawLevel` was not a member of `ABUSE_LEVELS` — caller may skip or escalate. */
  levelDrifted: boolean;
  /** True when `rawTrigger` was not a member of `ABUSE_TRIGGERS`. */
  triggerDrifted: boolean;
}

export function coerceAbuseEnums(
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
 * Clamp an arbitrary JSON-decoded metadata value to a non-negative
 * integer. Anything non-finite, negative, or non-numeric collapses to
 * `0` — the safe fallback for both the wire counters (which are typed
 * `number`) and the `errorRatePct` precondition (`>= 0` finite).
 *
 * Lives in baseline (not the EE engine) because the engine's
 * `triggerCountersFromInstance` consumes it; exported so EE imports the one
 * canonical implementation.
 */
export function sanitizeNonNegInt(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
