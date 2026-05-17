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
