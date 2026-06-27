/**
 * Abuse-prevention RESPONSE registration (enterprise).
 *
 * Wires the graduated-response engine in `./engine` into the two seams core
 * exposes:
 *
 *   1. The `AbuseResponse` Context.Tag (`AbuseResponseLive`) — Effect route
 *      handlers (`api/routes/admin-abuse.ts`) resolve the engine here.
 *   2. The sync `AbuseResponsePolicy` holder
 *      (`@atlas/api/lib/security/abuse-response-policy`) — non-Effect hot-path
 *      call sites (`audit.ts:recordQueryEvent`,
 *      `agent-gate.ts:checkAbuseStatus`) resolve the engine here.
 *
 * Both are registered when `AbuseResponseLive` is constructed. Since the EE
 * layer is only built when enterprise is enabled (`EELayer` in `./layers`),
 * tying the sync-holder registration to the layer factory means the holder is
 * populated exactly when (and only when) the graduated engine should run —
 * the same lifecycle gate every other EE Live layer uses. Until then, core's
 * `NOOP_ABUSE_RESPONSE_POLICY` keeps non-enterprise behavior unchanged.
 */

import { Effect, Layer } from "effect";
import {
  AbuseResponse,
  type AbuseResponseShape,
} from "@atlas/api/lib/effect/services";
import {
  setAbuseResponsePolicy,
  type AbuseResponsePolicy,
} from "@atlas/api/lib/security/abuse-response-policy";
import { getAbuseConfig } from "@atlas/api/lib/security/abuse-baseline";
import {
  recordQueryEvent,
  checkAbuseStatus,
  listFlaggedWorkspaces,
  getAbuseDetail,
  getAbuseEvents,
  reinstateWorkspace,
  restoreAbuseState,
  getAbuseRestoreStatus,
  abuseCleanupTick,
} from "./engine";

export {
  recordQueryEvent,
  checkAbuseStatus,
  listFlaggedWorkspaces,
  getAbuseDetail,
  getAbuseEvents,
  reinstateWorkspace,
  restoreAbuseState,
  getAbuseRestoreStatus,
  abuseCleanupTick,
  _resetAbuseState,
} from "./engine";

/**
 * Build the sync policy object delegating every method to the engine. This is
 * what the non-Effect hot-path call sites reach through
 * `getAbuseResponsePolicy()`. `getAbuseConfig` delegates to the core baseline
 * (the engine re-exports it from there) so the config surface is identical
 * across the Tag, the policy holder, and the baseline.
 */
export function makeAbuseResponsePolicyLive(): AbuseResponsePolicy {
  return {
    recordQueryEvent,
    checkAbuseStatus,
    listFlaggedWorkspaces,
    getAbuseDetail,
    getAbuseEvents,
    reinstateWorkspace,
    getAbuseConfig,
    restoreAbuseState,
    getAbuseRestoreStatus,
    abuseCleanupTick,
  };
}

/**
 * Live `AbuseResponse` Tag layer. Wraps the engine functions as Effects for
 * the route handlers AND registers the sync policy holder as a side effect of
 * layer construction (see module docstring for why this is the registration
 * point).
 */
export const AbuseResponseLive: Layer.Layer<AbuseResponse> = Layer.sync(
  AbuseResponse,
  () => {
    // Register the sync holder when this layer is built (= enterprise enabled).
    setAbuseResponsePolicy(makeAbuseResponsePolicyLive());
    return {
      available: true,
      listFlaggedWorkspaces: () => Effect.sync(() => listFlaggedWorkspaces()),
      getAbuseDetail: (workspaceId, priorLimit, eventLimit) =>
        Effect.promise(() => getAbuseDetail(workspaceId, priorLimit, eventLimit)),
      getAbuseEvents: (workspaceId, limit) =>
        Effect.promise(() => getAbuseEvents(workspaceId, limit)),
      reinstateWorkspace: (workspaceId, actorId) =>
        Effect.sync(() => reinstateWorkspace(workspaceId, actorId)),
      getAbuseConfig: () => Effect.sync(() => getAbuseConfig()),
    } satisfies AbuseResponseShape;
  },
);
