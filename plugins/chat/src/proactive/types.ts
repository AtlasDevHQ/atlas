/**
 * Shared types for the proactive chat layer.
 *
 * Proactive mode lets Atlas listen to channel messages in opted-in
 * channels, classify them as answerable data questions, and react /
 * eventually answer without an explicit `@atlas` mention. This module
 * holds only the pure shapes — see `classifier.ts`, `policy.ts`, and
 * `listener.ts` for behaviour.
 *
 * Slice #2292 ships the reaction-first tracer: subscribe → classify →
 * react. Slice #2295 layers in the three-tier kill switch + per-user
 * opt-out — types live below.
 */

/** Result of running a message through the question classifier. */
export interface ClassificationResult {
  /** Whether the message looks like an answerable data question. */
  isQuestion: boolean;
  /** Confidence in [0, 1] — 1.0 = certain, 0.0 = certainly not. */
  confidence: number;
  /** Optional short reason from the LLM, useful for audit + tuning. */
  reasoning?: string;
}

/** Three-tier sensitivity preset. Maps to a confidence threshold in policy. */
export type SensitivityPreset = "cautious" | "balanced" | "eager";

/** Workspace-level proactive settings. */
export interface WorkspaceProactiveConfig {
  /** Master toggle. When false, the listener never reacts. */
  enabled: boolean;
  /** Confidence-threshold preset. */
  sensitivity: SensitivityPreset;
  /** Classifier mode. */
  classifierMode: "regex-prefilter" | "classify-all";
}

/** Per-channel override. Absent fields fall back to workspace defaults. */
export interface ChannelProactiveConfig {
  channelId: string;
  /** When false, the channel is denied (Atlas never interjects). */
  allow: boolean;
  /** Optional sensitivity override. */
  sensitivity?: SensitivityPreset;
}

/** Recent interjection activity used for rate limiting. */
export interface RecentActivity {
  /** Epoch ms of the most recent interjection in this channel, if any. */
  lastInterjectionAt?: number;
}

/** Action returned by `decideInterjection`. */
export type InterjectionAction = "react" | "skip";

/** Decision returned by `decideInterjection`. */
export interface InterjectionDecision {
  action: InterjectionAction;
  /** Short tag explaining why — used in audit + tests. */
  reason: string;
}

/**
 * LLM classifier function injected from the host.
 *
 * Keeps the plugin decoupled from the API package and from any specific
 * model wiring. The host passes a function that runs the workspace's
 * configured Atlas model against a question-detection prompt.
 *
 * Implementations should never throw — failures should resolve as
 * `{ isQuestion: false, confidence: 0 }` so the listener fails closed.
 */
export type LLMClassifierFn = (text: string) => Promise<ClassificationResult>;

/**
 * Gate callback injected from the host.
 *
 * Returns true when proactive mode is allowed for this workspace. The
 * host wires this to `isEnterpriseEnabled() && workspaceFlag` so the
 * plugin itself does not import `@atlas/ee`.
 */
export type ProactiveGateFn = () => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// Kill switch (#2295) — three-layer pause + per-user opt-out
// ---------------------------------------------------------------------------

/**
 * Channel-scoped pause layers (`channel_id IS NOT NULL`).
 *
 * Split from `PauseLayer` so the type-system makes a row that says it's
 * `channel-24h` carry a non-null channel id at the type level.
 */
export type ChannelPauseLayer = "channel-24h" | "admin-channel";

/**
 * The four pause shapes recognised by the registry.
 *
 * - `channel-24h`     — in-channel `@atlas pause` (channel-scoped, 24h)
 * - `admin-channel`   — per-channel admin deny (channel-scoped, indefinite)
 * - `workspace-kill`  — admin "pause all proactive" (workspace-wide, indefinite)
 * - `user-optout`     — DM `unsubscribe` (per-user, workspace-wide, indefinite)
 */
export type PauseLayer =
  | ChannelPauseLayer
  | "workspace-kill"
  | "user-optout";

/**
 * Host-supplied callback that records a pause row.
 *
 * The listener never writes to the database directly — it builds the
 * request shape (`@atlas pause` → 24h channel-scoped, DM `unsubscribe`
 * → indefinite user-scoped) and hands it off to the host.
 *
 * Implementations may throw; the listener catches and logs at warn —
 * a failed pause write must never crash the SDK event loop.
 *
 * `durationMs: null` ⇒ indefinite (no `expires_at`).
 */
export type OnPauseRequestFn = (request: {
  workspaceId: string;
  /** Channel id for channel-scoped pauses; null for workspace/user pauses. */
  channelId: string | null;
  userId: string;
  layer: PauseLayer;
  /** ms from `requestedAt`; null means indefinite. */
  durationMs: number | null;
  /** Epoch ms when the request was generated — passed through so the host
   *  can compute `expires_at` deterministically in tests. */
  requestedAt: number;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Meter event (#2296)
// ---------------------------------------------------------------------------

/** Lifecycle stages tracked by the answer meter. */
export type ProactiveMeterEventType =
  | "classify"
  | "react"
  | "offer"
  | "accept"
  | "feedback";

/** Outcome values captured on `feedback` events. */
export type ProactiveMeterOutcome =
  | "helpful"
  | "not-helpful"
  | "wrong-data"
  | "no-feedback";

/**
 * Event emitted from the listener whenever the proactive flow advances
 * a lifecycle stage. The plugin stays decoupled from `@atlas/api`; the
 * host wires this callback into the AnswerMeter service.
 */
export interface ProactiveMeterEvent {
  workspaceId: string;
  channelId: string;
  messageId?: string | null;
  eventType: ProactiveMeterEventType;
  outcome?: ProactiveMeterOutcome | null;
  tokens?: number;
  costMicroUsd?: number;
  confidence?: number | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Host-injected meter callback. The plugin never persists meter rows
 * itself — it emits an event and the host wires it to the API's
 * `AnswerMeter` service (which writes to `proactive_meter_events`).
 *
 * Implementations should never throw. Failures are swallowed inside
 * the listener so the Chat SDK event loop never crashes.
 */
export type ProactiveMeterEventFn = (
  event: ProactiveMeterEvent,
) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Monthly quota cap (#2301)
// ---------------------------------------------------------------------------

/**
 * Quota snapshot returned by the host. Mirrors `WorkspaceQuotaStatus`
 * from `@atlas/api/lib/proactive/quota` shape-by-shape — declared
 * here so the plugin doesn't import `@atlas/api`.
 */
export interface ProactiveQuotaStatus {
  /** Cap value persisted on the workspace config. Null = unlimited. */
  monthlyClassifierCap: number | null;
  /** Distinct classify rows since the start of the current UTC month. */
  classifyCountThisMonth: number;
  /** True when `classifyCountThisMonth >= monthlyClassifierCap`. */
  capReached: boolean;
}

/**
 * Host-injected quota reader. Consulted BEFORE the classifier on every
 * channel message — pays a single DB read (well-indexed) and short-
 * circuits the LLM call when the workspace has hit its monthly cap.
 *
 * Implementations should never throw. Failures are caught by the
 * listener and treated as "no quota info" (Atlas keeps answering)
 * so a quota outage never crashes the SDK event loop.
 */
export type GetQuotaStatusFn = (input: {
  workspaceId: string;
}) => Promise<ProactiveQuotaStatus>;
