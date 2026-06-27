/**
 * Abuse prevention — STABLE SEAM (thin delegating shim).
 *
 * This file is the stable import path every consumer keeps reaching for:
 * `auth/audit.ts` (`recordQueryEvent`), `billing/agent-gate.ts`
 * (`checkAbuseStatus`), `api/routes/admin-orgs.ts` + `api/routes/platform-admin.ts`
 * (`checkAbuseStatus` / `getAbuseRestoreStatus` / `ABUSE_RESTORE_STATUSES`),
 * `lib/effect/layers.ts` (`abuseCleanupTick` / `ABUSE_CLEANUP_INTERVAL_MS`),
 * and `lib/auth/migrate.ts` (`restoreAbuseState`). Their signatures are
 * unchanged, so no consumer had to move.
 *
 * Post-#4000 (WS5) the abuse engine is split along the documented enterprise
 * boundary (`docs/development/enterprise-gating.md`):
 *
 *   - **Baseline detection / config** stays in core at `./abuse-baseline`
 *     (threshold parsing, enum-drift coercion, counter sanitization, the
 *     `ReinstatedLevel` type, `ABUSE_RESTORE_STATUSES`,
 *     `ABUSE_CLEANUP_INTERVAL_MS`). Re-exported below so the old import paths
 *     resolve.
 *   - **The graduated multi-tenant warn→throttle→suspend RESPONSE engine**
 *     moved to `@atlas/ee` (`ee/src/abuse-prevention/`). Core never imports
 *     it — instead the engine registers itself, when enterprise is enabled,
 *     into the sync `AbuseResponsePolicy` holder (`./abuse-response-policy`)
 *     and the `AbuseResponse` Effect Tag. This shim's runtime functions all
 *     delegate to `getAbuseResponsePolicy()`, which is the inert
 *     `NOOP_ABUSE_RESPONSE_POLICY` until EE registers a live one.
 *
 * On a non-enterprise deploy the policy is the no-op, which is behavior-
 * identical to the pre-split self-hosted path (the old engine already
 * short-circuited every method via its `isSaasDeployment()` guard).
 *
 * Core never imports `@atlas/ee`; the inversion is enforced by
 * `scripts/check-ee-imports.sh`.
 */

import {
  getAbuseResponsePolicy,
  _resetAbuseResponsePolicy,
} from "./abuse-response-policy";
import type { AbuseLevel } from "@useatlas/types";
import type { ReinstatedLevel } from "./abuse-baseline";

// Re-export baseline surface so the historical import paths keep resolving.
export {
  getAbuseConfig,
  ABUSE_RESTORE_STATUSES,
  ABUSE_CLEANUP_INTERVAL_MS,
} from "./abuse-baseline";
export type { ReinstatedLevel, AbuseRestoreStatus } from "./abuse-baseline";

/**
 * Record a query event for abuse detection. Delegates to the registered
 * response policy (no-op until EE registers the engine). Signature unchanged
 * for `auth/audit.ts`.
 */
export function recordQueryEvent(
  workspaceId: string,
  opts: { success: boolean; tablesAccessed?: string[] },
): void {
  getAbuseResponsePolicy().recordQueryEvent(workspaceId, opts);
}

/**
 * Current enforcement level for a workspace. Delegates to the registered
 * policy (no-op → `{ level: "none" }`). Signature unchanged for
 * `billing/agent-gate.ts`, `admin-orgs.ts`, `platform-admin.ts`.
 */
export function checkAbuseStatus(workspaceId: string): {
  level: AbuseLevel;
  throttleDelayMs?: number;
} {
  return getAbuseResponsePolicy().checkAbuseStatus(workspaceId);
}

/** List flagged workspaces (no-op → `[]`). */
export function listFlaggedWorkspaces() {
  return getAbuseResponsePolicy().listFlaggedWorkspaces();
}

/** Investigation detail for a flagged workspace (no-op → `null`). */
export function getAbuseDetail(
  workspaceId: string,
  priorLimit?: number,
  eventLimit?: number,
) {
  return getAbuseResponsePolicy().getAbuseDetail(workspaceId, priorLimit, eventLimit);
}

/** Recent persisted events + load status (no-op → empty + `db_unavailable`). */
export function getAbuseEvents(workspaceId: string, limit?: number) {
  return getAbuseResponsePolicy().getAbuseEvents(workspaceId, limit);
}

/** Manually reinstate a flagged workspace (no-op → `null`). */
export function reinstateWorkspace(
  workspaceId: string,
  actorId: string,
): ReinstatedLevel | null {
  return getAbuseResponsePolicy().reinstateWorkspace(workspaceId, actorId);
}

/** Rehydrate in-memory state from persisted events on boot (no-op → no-op). */
export function restoreAbuseState(): Promise<void> {
  return getAbuseResponsePolicy().restoreAbuseState();
}

/** Last `restoreAbuseState` outcome (no-op → `db_unavailable`). */
export function getAbuseRestoreStatus() {
  return getAbuseResponsePolicy().getAbuseRestoreStatus();
}

/** Evict stale window data — scheduler tick (no-op → no-op). */
export function abuseCleanupTick(): void {
  getAbuseResponsePolicy().abuseCleanupTick();
}

/**
 * Reset in-memory engine state. For tests. On the no-op policy this resets
 * nothing; engine-internal tests exercise `_resetAbuseState` on the EE engine
 * directly (`ee/src/abuse-prevention/engine.ts`). Kept here so the historical
 * test mock surface stays complete.
 */
export function _resetAbuseState(): void {
  _resetAbuseResponsePolicy();
}
