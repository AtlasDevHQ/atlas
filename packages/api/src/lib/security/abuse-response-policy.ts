/**
 * Abuse-prevention RESPONSE POLICY seam — the core-resident holder for the
 * graduated multi-tenant warn→throttle→suspend engine that physically lives
 * in `@atlas/ee` (`ee/src/abuse-prevention/`).
 *
 * ## Why this exists
 *
 * The documented enterprise boundary (`docs/development/enterprise-gating.md`)
 * places abuse-prevention *response* in `/ee`. The graduated response engine
 * (sliding-window escalation, dwell-time cooldown, suspension, admin
 * reinstatement, persisted `abuse_events`) is multi-tenant SaaS machinery; on a
 * single-tenant self-hosted deploy it produces only false positives. So it
 * moved behind this seam, with a fully-inert `NOOP_ABUSE_RESPONSE_POLICY`
 * default so non-enterprise behavior is unchanged.
 *
 * ## Why a SYNC policy holder (and an Effect Tag too)
 *
 * Two classes of call site reach the response engine, and they need different
 * seams:
 *
 *   1. **Effect route handlers** (`api/routes/admin-abuse.ts`) resolve the
 *      engine through the `AbuseResponse` Context.Tag (`yield* AbuseResponse`),
 *      exactly like `SlaMetrics` / `MaskingPolicy` — a Noop layer answers
 *      `available: false` so the route renders the 404 `not_available`
 *      envelope when EE isn't loaded.
 *
 *   2. **Synchronous, non-Effect hot-path call sites** — `auth/audit.ts`
 *      (`recordQueryEvent`, fired after every query) and
 *      `billing/agent-gate.ts` (`checkAbuseStatus`, on the chat gate) — are
 *      plain function calls. Routing those through Effect would force
 *      `audit.ts` / `agent-gate.ts` (and their many callers) into the Effect
 *      runtime for a fire-and-forget counter bump. So those call sites resolve
 *      the engine through THIS sync holder: a module-level singleton that EE
 *      registers at layer-construction time and that defaults to a no-op.
 *
 * The two seams stay coherent because the EE `AbuseResponseLive` layer both
 * binds the Tag AND calls `setAbuseResponsePolicy(...)` in its factory — so the
 * sync holder is populated exactly when (and only when) the EE layer is built,
 * i.e. enterprise enabled. See `ee/src/abuse-prevention/policy.ts`.
 *
 * ## Boundary discipline
 *
 * Core NEVER imports `@atlas/ee`. This holder is the inversion point: core
 * defines the interface + the inert default; EE registers the live impl from
 * the one permitted boot seam. Baseline detection/config stays in core
 * (`./abuse-baseline`); only the graduated *response* is gated here.
 */

import type {
  AbuseLevel,
  AbuseStatus,
  AbuseDetail,
  AbuseEvent,
  AbuseEventsStatus,
  AbuseThresholdConfig,
  AbuseRestoreStatus,
} from "@useatlas/types";
import type { ReinstatedLevel } from "./abuse-baseline";

/**
 * The graduated-response surface. Every method is what a sync (non-Effect)
 * caller needs; the Effect `AbuseResponse` Tag wraps these same operations for
 * route handlers. The default implementation
 * (`NOOP_ABUSE_RESPONSE_POLICY`) is fully inert — it never escalates a
 * workspace, lists nothing, and treats every persistence path as unavailable.
 */
export interface AbuseResponsePolicy {
  /**
   * Record a query event for abuse detection. Called after each query
   * execution (success or failure). No-op when the response engine isn't
   * registered.
   */
  readonly recordQueryEvent: (
    workspaceId: string,
    opts: { success: boolean; tablesAccessed?: string[] },
  ) => void;
  /**
   * Current enforcement level for a workspace, plus the throttle delay when
   * throttled. The Noop always reports `{ level: "none" }`.
   */
  readonly checkAbuseStatus: (workspaceId: string) => {
    level: AbuseLevel;
    throttleDelayMs?: number;
  };
  /** All workspaces with a non-`"none"` enforcement level. Noop → `[]`. */
  readonly listFlaggedWorkspaces: () => AbuseStatus[];
  /** Investigation detail for one flagged workspace. Noop → `null` (route 404s). */
  readonly getAbuseDetail: (
    workspaceId: string,
    priorLimit?: number,
    eventLimit?: number,
  ) => Promise<AbuseDetail | null>;
  /** Recent persisted events + load status. Noop → empty + `"db_unavailable"`. */
  readonly getAbuseEvents: (
    workspaceId: string,
    limit?: number,
  ) => Promise<{ events: AbuseEvent[]; status: AbuseEventsStatus }>;
  /** Manually reinstate a flagged workspace; returns the prior level or `null`. Noop → `null`. */
  readonly reinstateWorkspace: (
    workspaceId: string,
    actorId: string,
  ) => ReinstatedLevel | null;
  /** Current threshold configuration. Baseline-resident, so the Noop returns the real config. */
  readonly getAbuseConfig: () => AbuseThresholdConfig;
  /** Rehydrate in-memory state from persisted events on boot. Noop → no-op. */
  readonly restoreAbuseState: () => Promise<void>;
  /** Last `restoreAbuseState` outcome. Noop → `"db_unavailable"` (never engaged). */
  readonly getAbuseRestoreStatus: () => AbuseRestoreStatus;
  /** Evict stale window data (scheduler tick). Noop → no-op. */
  readonly abuseCleanupTick: () => void;
}

/**
 * Fully-inert default. Registered until (and unless) the EE
 * `AbuseResponseLive` layer overrides it via `setAbuseResponsePolicy`. This is
 * EXACTLY the pre-split self-hosted behavior: `recordQueryEvent` /
 * `checkAbuseStatus` were already short-circuited by the `isSaasDeployment()`
 * guard on a self-hosted deploy, so a no-op here is behavior-identical.
 *
 * `getAbuseConfig` is the one method that returns real data even on the Noop —
 * threshold config is baseline (core-resident), read by the detector
 * regardless of EE. The lazy `require("./abuse-baseline")` keeps this module's
 * import graph free of the settings reader until the config is actually asked
 * for (mirrors the lazy-require pattern used elsewhere in core to keep early
 * modules lean). Note: the live readers of baseline config today are the
 * shim's *direct* re-export from `./abuse-baseline` and the EE layer — this
 * holder method exists for interface symmetry, so a future caller that routes
 * config through the holder gets correct data rather than an inert stub.
 *
 * `restoreAbuseState` is a no-op that leaves the status `"db_unavailable"` —
 * the disengaged-engine signal — so an operator UI reading
 * `getAbuseRestoreStatus()` sees "engine not engaged", not a spurious
 * boot-failure.
 */
export const NOOP_ABUSE_RESPONSE_POLICY: AbuseResponsePolicy = Object.freeze({
  recordQueryEvent: () => {
    // intentionally ignored: no graduated response engine registered (self-hosted / no EE)
  },
  checkAbuseStatus: () => ({ level: "none" as AbuseLevel }),
  listFlaggedWorkspaces: () => [],
  getAbuseDetail: async () => null,
  getAbuseEvents: async () => ({
    events: [] as AbuseEvent[],
    status: "db_unavailable" as AbuseEventsStatus,
  }),
  reinstateWorkspace: () => null,
  getAbuseConfig: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const baseline = require("./abuse-baseline") as typeof import("./abuse-baseline");
    return baseline.getAbuseConfig();
  },
  restoreAbuseState: async () => {
    // intentionally ignored: no engine to rehydrate; status stays "db_unavailable"
  },
  getAbuseRestoreStatus: () => "db_unavailable" as AbuseRestoreStatus,
  abuseCleanupTick: () => {
    // intentionally ignored: no in-memory window state to evict
  },
});

let _policy: AbuseResponsePolicy = NOOP_ABUSE_RESPONSE_POLICY;

/**
 * Register the live graduated-response policy. Called by the EE
 * `AbuseResponseLive` layer factory at layer-construction time so the sync
 * holder's lifecycle is tied to EE layer construction (enterprise enabled),
 * the same way every other Live layer is gated.
 */
export function setAbuseResponsePolicy(policy: AbuseResponsePolicy): void {
  _policy = policy;
}

/** Resolve the currently-registered policy (the Noop until EE registers a live one). */
export function getAbuseResponsePolicy(): AbuseResponsePolicy {
  return _policy;
}

/** Reset to the inert default. For tests only. */
export function _resetAbuseResponsePolicy(): void {
  _policy = NOOP_ABUSE_RESPONSE_POLICY;
}
