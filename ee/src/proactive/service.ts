/**
 * ProactiveServiceLive — EE binding for the composite `ProactiveService`
 * Context.Tag (#3999 / WS5 of #3984).
 *
 * Wraps the relocated proactive-chat lib functions (quota, pause
 * registry, classifier review, public dataset, activation announcement,
 * channel directory) as Effects so the core admin routes resolve them
 * through `yield* ProactiveService` (or `runEnterprise(...)` for the
 * `runHandler` route) without importing `@atlas/ee`. Bound onto the Tag
 * by `ee/src/layers.ts` (`EELayer`) when enterprise is enabled; the core
 * `NoopProactiveServiceLayer` is the non-EE default.
 *
 * Each method uses `Effect.promise` so a rejected DB promise surfaces as
 * a defect → 500 in `runEffect`, preserving the pre-relocation route
 * behavior (the handlers previously wrapped these same calls in
 * `Effect.tryPromise` / `Effect.promise` and let a throw become a 500).
 * The internal fail-open / fail-closed postures of the underlying
 * functions (quota fails open; `isPaused` honours `failOpenOnError`) are
 * unchanged — this layer only adapts the call convention.
 */

import { Effect, Layer } from "effect";
import {
  ProactiveService,
  type ProactiveServiceShape,
} from "@atlas/api/lib/effect/proactive-service";
import { getWorkspaceQuotaStatus } from "./quota";
import { isPaused, persistPause, expirePauses } from "./pause-registry";
import {
  lookupClassifyChannel,
  upsertClassificationReview,
} from "./classification-review";
import {
  getAllowlist,
  addEntry,
  removeEntry,
  summarizePublicRefused,
} from "./public-dataset";
import { announceActivation } from "./announcement-coordinator";
import { getChatAnnouncer } from "./announcer-registry";
import { listWorkspaceChannels } from "./channel-directory";

export const makeProactiveServiceLive = (): ProactiveServiceShape =>
  ({
    getWorkspaceQuotaStatus: (workspaceId) =>
      Effect.promise(() => getWorkspaceQuotaStatus(workspaceId)),
    isPaused: (input) => Effect.promise(() => isPaused(input)),
    persistPause: (input) => Effect.promise(() => persistPause(input)),
    expirePauses: (input) => Effect.promise(() => expirePauses(input)),
    lookupClassifyChannel: (workspaceId, messageId) =>
      Effect.promise(() => lookupClassifyChannel(workspaceId, messageId)),
    upsertClassificationReview: (input) =>
      Effect.promise(() => upsertClassificationReview(input)),
    getAllowlist: (workspaceId) => Effect.promise(() => getAllowlist(workspaceId)),
    addEntry: (workspaceId, entityName, denyMetrics) =>
      Effect.promise(() => addEntry(workspaceId, entityName, denyMetrics)),
    removeEntry: (workspaceId, entityName) =>
      Effect.promise(() => removeEntry(workspaceId, entityName)),
    summarizePublicRefused: (workspaceId, sinceMs) =>
      Effect.promise(() => summarizePublicRefused(workspaceId, sinceMs)),
    announceActivation: ({ workspaceId, channelId }) =>
      Effect.promise(() =>
        announceActivation({
          workspaceId,
          channelId,
          announcer: getChatAnnouncer(),
        }),
      ),
    listWorkspaceChannels: (workspaceId) =>
      Effect.promise(() => listWorkspaceChannels(workspaceId)),
  }) satisfies ProactiveServiceShape;

export const ProactiveServiceLive: Layer.Layer<ProactiveService> = Layer.sync(
  ProactiveService,
  makeProactiveServiceLive,
);
