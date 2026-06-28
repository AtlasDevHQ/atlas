/**
 * Proactive-chat CORE port/type surface (#3999 / WS5 of #3984).
 *
 * The proactive-chat **implementation** lives in `@atlas/ee/proactive/*`
 * (the feature is a paid Business-tier surface — PRD #2291). Core keeps
 * only the type/port contracts that route handlers, the Slack
 * channel-directory adapter, the `ProactiveService` / `AnswerMeter`
 * Context.Tag shapes, and core test infra reference. Keeping these in
 * core is what lets `scripts/check-ee-imports.sh` stay green: the EE
 * implementations import these contracts from core (ee → core, allowed),
 * and no core file ever imports `@atlas/ee` for them.
 *
 * Wire shapes (`@useatlas/types/proactive`) stay the single source of
 * truth and are re-exported here for one-stop import; the interfaces
 * declared in this file are the API-side **port/input** shapes that have
 * no wire representation (DB-row projections, write inputs, the
 * platform-neutral channel-directory port).
 *
 * `AnswerMeter`'s own type surface (meter summary, event rows, cursors)
 * lives in `./answer-meter` alongside the `AnswerMeter` Tag — see that
 * file. This module covers the other proactive modules
 * (channel-directory, classification-review, pause-registry,
 * public-dataset, announcement-coordinator, quota).
 */

import type { ProactiveReviewVerdict } from "./answer-meter";
import type { PauseLayer, ProactiveQuotaStatus } from "@useatlas/types";

// Re-export the canonical wire shapes so consumers import them from one place.
export type {
  PauseLayer,
  PauseDecision,
  PublicDatasetEntry,
  AllowDecision,
  AnnouncementOutcome,
  ProactiveQuotaStatus,
} from "@useatlas/types";

// ---------------------------------------------------------------------------
// channel-directory port (#3463)
// ---------------------------------------------------------------------------

/**
 * One channel row, platform-neutral. Field semantics match the wire
 * schema on `GET /admin/proactive/channels/available`: `isMember` is
 * whether the bot can actually act in the channel (an override on a
 * non-member channel never fires, so pickers warn on it).
 */
export interface ChannelDirectoryChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/**
 * Platform-neutral failure classes, mirrored 1:1 onto the wire `reason`
 * enum (the route serialises these verbatim — keep them OAuth-generic):
 *
 * - `no_chat_installation` — the workspace has no chat-platform install
 *   (or its credential is unreadable); nothing to list.
 * - `missing_scope` — the platform credential lacks the read scope the
 *   listing needs even for its most-degraded retry (#3462/#3466). The
 *   fix is a re-consent on the platform's OAuth flow, so admin UIs
 *   surface a reconnect CTA for this reason specifically.
 * - `platform_error` — any other platform-side failure (rate limit,
 *   revoked token, network). Transient; UIs soft-degrade to manual
 *   channel-id entry.
 */
export type ChannelDirectoryFailureReason =
  | "no_chat_installation"
  | "missing_scope"
  | "platform_error";

export type ChannelDirectoryResult =
  | { ok: true; channels: ChannelDirectoryChannel[] }
  | {
      ok: false;
      reason: ChannelDirectoryFailureReason;
      /** Raw platform error for logs. Never serialised onto the wire. */
      detail?: string;
    };

export interface ChannelDirectoryProvider {
  listWorkspaceChannels(workspaceId: string): Promise<ChannelDirectoryResult>;
}

// ---------------------------------------------------------------------------
// classification-review (#2622)
// ---------------------------------------------------------------------------

export const PROACTIVE_REVIEW_VERDICTS: readonly ProactiveReviewVerdict[] = [
  "misfire",
  "correct",
  "unsure",
];

export interface UpsertReviewInput {
  workspaceId: string;
  messageId: string;
  verdict: ProactiveReviewVerdict;
  reviewerUserId: string | null;
  note: string | null;
}

export interface UpsertReviewResult {
  workspaceId: string;
  messageId: string;
  verdict: ProactiveReviewVerdict;
  reviewerUserId: string | null;
  note: string | null;
  /** Previous verdict on this `(workspaceId, messageId)` — null on first write. */
  previousVerdict: ProactiveReviewVerdict | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// public-dataset (#2297)
// ---------------------------------------------------------------------------

/** Discoverability rollup row returned by `summarizePublicRefused`. */
export interface PublicRefusedRollupRow {
  /** Entity name reported by the refusal event. */
  entityName: string;
  /** Count of refusal events in the lookback window. */
  count: number;
}

// ---------------------------------------------------------------------------
// pause-registry (#2295)
// ---------------------------------------------------------------------------

/** Row shape read from `proactive_pauses`. */
export interface PauseRow {
  id: string;
  workspaceId: string;
  channelId: string | null;
  userId: string | null;
  layer: PauseLayer;
  /** Epoch ms when the row expires; `null` = indefinite. */
  expiresAt: number | null;
}

export interface PauseWriteInput {
  workspaceId: string;
  /** Required for channel-scoped layers; null for workspace/user. */
  channelId: string | null;
  /** Required for `user-optout`; null otherwise. */
  userId: string | null;
  layer: PauseLayer;
  /** ms from `requestedAt`; null means indefinite. */
  durationMs: number | null;
  /** Epoch ms baseline for `expires_at`. */
  requestedAt: number;
}

export interface IsPausedInput {
  workspaceId: string;
  channelId: string;
  userId?: string;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
  /**
   * Opt admin-inspection callers out of the fail-CLOSED posture. When
   * `true`, a DB error rethrows so the surrounding route returns a 500
   * the admin can act on; when omitted (default), the lookup fails
   * CLOSED (synthetic workspace-kill) so runtime callers stay silent
   * during outages. NEVER pass `true` from the runtime listener.
   */
  failOpenOnError?: boolean;
}

export interface ExpirePausesInput {
  workspaceId: string;
  layer: PauseLayer;
  channelId?: string | null;
  userId?: string | null;
}

// ---------------------------------------------------------------------------
// announcement-coordinator (#2300)
// ---------------------------------------------------------------------------

/**
 * Minimal contract the coordinator needs from the chat plugin to post
 * one channel message. The real implementation in the chat plugin fans
 * this out to `adapter.postChannelMessage(channelId, ...)`; tests can
 * pass a noop stub. Returns a structured `{ ok }` rather than throwing
 * so the coordinator never crashes the admin-config save path.
 */
export interface ChatAnnouncer {
  postChannelAnnouncement(input: {
    /** Atlas workspace id (== org id) — surfaces in audit / logs. */
    workspaceId: string;
    /** Platform channel id (Slack `C…`, Teams `19:…`, etc). */
    channelId: string;
    /** Markdown body. Pre-rendered by `buildAnnouncementMessage`. */
    markdown: string;
  }): Promise<{ ok: true; messageId?: string } | { ok: false; reason: string }>;
}

export interface AnnounceActivationInput {
  workspaceId: string;
  /** Channel id from `workspace_proactive_config.announcement_channel_id`. */
  channelId: string;
  /** Host-provided port. Pass an in-memory stub from tests. */
  announcer: ChatAnnouncer;
}

// ---------------------------------------------------------------------------
// quota (#2301)
// ---------------------------------------------------------------------------

/**
 * Local alias. The canonical wire shape is `ProactiveQuotaStatus`; this
 * name is the existing API-side alias preserved for back-compat.
 */
export type WorkspaceQuotaStatus = ProactiveQuotaStatus;
