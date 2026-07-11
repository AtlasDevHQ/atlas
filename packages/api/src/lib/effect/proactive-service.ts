/**
 * ProactiveService — composite Context.Tag for the proactive-chat
 * capabilities the admin routes reach (#3999 / WS5 of #3984).
 *
 * Proactive chat is a paid Business-tier surface (PRD #2291), so its
 * implementation lives in `@atlas/ee/proactive/*`. The five admin route
 * files stay in core (EE contributes Layers, never routes — every EE
 * feature follows this), and reach the relocated logic through this one
 * composite Tag, mirroring `AbuseResponse` / `MarketplaceVeneer`.
 *
 * It spans the most lib functions of the current EE features: quota,
 * pause registry, classifier-review CRUD, public-dataset CRUD, the
 * activation announcement, and the platform channel directory.
 * (`AnswerMeter` stays a sibling Tag — see `lib/proactive/answer-meter.ts`
 * — because its `createAnswerMeterTestLayer` seam is shared by core route
 * tests + `__test-utils__`.)
 *
 * The `NoopProactiveServiceLayer` default fails every method with
 * `EnterpriseError` (→ 403 `enterprise_required`). In practice it is
 * never reached through a route: each handler runs an enterprise gate
 * first — the four `runEffect` routes `yield* ProactiveGate` (deployment
 * EE flag), and `admin-proactive.ts` calls its inline `gateEnterprise()`
 * (value-level `isEnterpriseEnabled`) — then the per-tier
 * `requireFeatureEntitlement(…, "proactive")` ladder (#4064). The EE
 * `ProactiveServiceLive` (`ee/src/proactive/service.ts`) overrides this
 * Tag when enterprise is enabled, via `ee/src/layers.ts`.
 *
 * The route-execution model differs across the surface:
 *   - the four `runEffect` routes `yield* ProactiveService`;
 *   - `admin-proactive.ts` (the `runHandler`/`createRoute` path) reaches
 *     it through `runEnterprise(...)`, the established bridge for a
 *     non-Effect handler that needs an EE Tag (admin-router, middleware,
 *     wizard, agent all use it).
 */

import { Context, Effect, Layer } from "effect";
import { EnterpriseError } from "@atlas/api/lib/effect/errors";
import type {
  ProactiveQuotaStatus,
  PauseDecision,
  IsPausedInput,
  PauseWriteInput,
  ExpirePausesInput,
  UpsertReviewInput,
  UpsertReviewResult,
  PublicDatasetEntry,
  PublicRefusedRollupRow,
  AnnouncementOutcome,
  AmendmentNoticeInput,
  AmendmentNoticeOutcome,
  ChannelDirectoryResult,
} from "@atlas/api/lib/proactive/types";

export interface ProactiveServiceShape {
  // ── analytics (admin-proactive-analytics.ts) ──────────────────────
  /** Monthly classifier-quota snapshot. Fails open internally; never throws. */
  readonly getWorkspaceQuotaStatus: (
    workspaceId: string,
  ) => Effect.Effect<ProactiveQuotaStatus, EnterpriseError>;

  // ── pause registry (admin-proactive-pauses.ts) ────────────────────
  readonly isPaused: (
    input: IsPausedInput,
  ) => Effect.Effect<PauseDecision, EnterpriseError>;
  readonly persistPause: (
    input: PauseWriteInput,
  ) => Effect.Effect<void, EnterpriseError>;
  readonly expirePauses: (
    input: ExpirePausesInput,
  ) => Effect.Effect<void, EnterpriseError>;

  // ── classifier review (admin-proactive-events.ts) ─────────────────
  /** Channel id of the classify row backing a verdict, or null when absent. */
  readonly lookupClassifyChannel: (
    workspaceId: string,
    messageId: string,
  ) => Effect.Effect<string | null, EnterpriseError>;
  readonly upsertClassificationReview: (
    input: UpsertReviewInput,
  ) => Effect.Effect<UpsertReviewResult, EnterpriseError>;

  // ── public dataset (admin-proactive-public-dataset.ts) ────────────
  readonly getAllowlist: (
    workspaceId: string,
  ) => Effect.Effect<PublicDatasetEntry[], EnterpriseError>;
  readonly addEntry: (
    workspaceId: string,
    entityName: string,
    denyMetrics: string[],
  ) => Effect.Effect<void, EnterpriseError>;
  readonly removeEntry: (
    workspaceId: string,
    entityName: string,
  ) => Effect.Effect<{ removed: boolean }, EnterpriseError>;
  readonly summarizePublicRefused: (
    workspaceId: string,
    sinceMs: number,
  ) => Effect.Effect<PublicRefusedRollupRow[], EnterpriseError>;

  // ── activation announcement + channel directory (admin-proactive.ts) ─
  /**
   * Post the one-shot activation announcement. The EE impl resolves the
   * registered `ChatAnnouncer` (falling back to the null announcer)
   * internally — the route does not handle the announcer port.
   */
  readonly announceActivation: (input: {
    workspaceId: string;
    channelId: string;
  }) => Effect.Effect<AnnouncementOutcome, EnterpriseError>;
  /** List the workspace's chat-platform channels (short-TTL cached). */
  readonly listWorkspaceChannels: (
    workspaceId: string,
  ) => Effect.Effect<ChannelDirectoryResult, EnterpriseError>;

  // ── autonomous-improvement notification (scheduler → seam, #4520) ──
  /**
   * Post ONE proactive notice to a workspace's admins that autonomous
   * improvement queued `count` new pending Amendments. Batched per
   * scheduler tick (not per row) by the caller; `count` is that batch.
   * The EE impl posts to the workspace's proactive announcement channel —
   * the same seam as `announceActivation`, no bespoke channel. The Noop
   * default fails with `EnterpriseError`, which the core caller
   * (`lib/proactive/notify-amendments.ts`) swallows into a clean skip so
   * a non-EE deploy degrades to "no notification" (#4520 AC3).
   */
  readonly notifyAmendmentsPending: (
    input: AmendmentNoticeInput,
  ) => Effect.Effect<AmendmentNoticeOutcome, EnterpriseError>;
}

export class ProactiveService extends Context.Tag("ProactiveService")<
  ProactiveService,
  ProactiveServiceShape
>() {}

const NOT_AVAILABLE_MESSAGE =
  "Proactive chat requires enterprise features to be enabled.";

const notAvailable = (): Effect.Effect<never, EnterpriseError> =>
  Effect.fail(new EnterpriseError(NOT_AVAILABLE_MESSAGE));

/**
 * No-op default for non-EE deploys. Every method fails closed with
 * `EnterpriseError` (→ 403), matching the deployment gate. Never reached
 * through a route (the handlers 403 at `ProactiveGate` —
 * `admin-proactive.ts` at its inline `gateEnterprise()` —
 * /`requireFeatureEntitlement` first); present so the app layer can bind
 * the Tag on a non-EE deploy. The EE `ProactiveServiceLive` overrides it.
 */
export const NoopProactiveServiceLayer: Layer.Layer<ProactiveService> =
  Layer.succeed(ProactiveService, {
    getWorkspaceQuotaStatus: notAvailable,
    isPaused: notAvailable,
    persistPause: notAvailable,
    expirePauses: notAvailable,
    lookupClassifyChannel: notAvailable,
    upsertClassificationReview: notAvailable,
    getAllowlist: notAvailable,
    addEntry: notAvailable,
    removeEntry: notAvailable,
    summarizePublicRefused: notAvailable,
    announceActivation: notAvailable,
    listWorkspaceChannels: notAvailable,
    notifyAmendmentsPending: notAvailable,
  } satisfies ProactiveServiceShape);

/**
 * Test layer factory — substitutes a partial implementation. Methods
 * not provided fail with a descriptive `EnterpriseError` so a test that
 * exercises an unmocked code path fails fast (mirrors
 * `createAnswerMeterTestLayer`).
 */
export function createProactiveServiceTestLayer(
  partial: Partial<ProactiveServiceShape> = {},
): Layer.Layer<ProactiveService> {
  const fail = (method: string) => (): Effect.Effect<never, EnterpriseError> =>
    Effect.fail(
      new EnterpriseError(
        `ProactiveService test stub: ${method}() called but not provided in createProactiveServiceTestLayer()`,
      ),
    );
  return Layer.succeed(ProactiveService, {
    getWorkspaceQuotaStatus:
      partial.getWorkspaceQuotaStatus ?? fail("getWorkspaceQuotaStatus"),
    isPaused: partial.isPaused ?? fail("isPaused"),
    persistPause: partial.persistPause ?? fail("persistPause"),
    expirePauses: partial.expirePauses ?? fail("expirePauses"),
    lookupClassifyChannel:
      partial.lookupClassifyChannel ?? fail("lookupClassifyChannel"),
    upsertClassificationReview:
      partial.upsertClassificationReview ?? fail("upsertClassificationReview"),
    getAllowlist: partial.getAllowlist ?? fail("getAllowlist"),
    addEntry: partial.addEntry ?? fail("addEntry"),
    removeEntry: partial.removeEntry ?? fail("removeEntry"),
    summarizePublicRefused:
      partial.summarizePublicRefused ?? fail("summarizePublicRefused"),
    announceActivation: partial.announceActivation ?? fail("announceActivation"),
    listWorkspaceChannels:
      partial.listWorkspaceChannels ?? fail("listWorkspaceChannels"),
    notifyAmendmentsPending:
      partial.notifyAmendmentsPending ?? fail("notifyAmendmentsPending"),
  } satisfies ProactiveServiceShape);
}
